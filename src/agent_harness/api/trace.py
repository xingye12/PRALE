"""Read-only projections of a session's durable trace.

A UI asks "what did this turn do, and what did it cost" long after the drive
that produced it is gone.  Every field here therefore comes from durable rows:
the lane's turn index and operation records for the list, the branch segment an
operation appended for its entries, and the effect ledger for per-call detail.

Nothing in this module infers a value it cannot prove.  A turn that has not
settled has no status and no duration, a provider that never reported a token
count yields ``None`` rather than ``0``, and usage rows written before
attribution existed are returned as their own set instead of being folded into
a turn they may not belong to.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast

from agent_harness.api.catalog import SessionCatalog
from agent_harness.api.errors import InvalidCursor, SessionNotFound
from agent_harness.api.models import OperationResult
from agent_harness.api.pagination import Page, decode_cursor, encode_cursor
from agent_harness.domain.effects import EffectSpan, UsageRecord
from agent_harness.domain.entries import Entry
from agent_harness.domain.operations import OperationMeta
from agent_harness.domain.subagents import INTERNAL_PREFIX
from agent_harness.domain.subagents import record as subagent_record
from agent_harness.domain.subagents import value as subagent_value
from agent_harness.domain.types import OperationKind, OperationStatus
from agent_harness.domain.values import (
    lane_operations,
    lane_state,
    lane_tip,
    operation_meta,
    operation_result,
    session_lanes,
)
from agent_harness.storage.memory import StorageInvariantError
from agent_harness.storage.protocol import Storage
from agent_harness.storage.sqlite import SQLiteStorage

_MAX_LIMIT = 200

_DURATION_STATUSES: frozenset[str] = frozenset({"completed", "declined", "aborted", "failed"})
"""Statuses for which ``ended_at - started_at`` is a real elapsed time.

``unknown`` is excluded on purpose: its ``ended_at`` records when a recovery
closed the record, which can be long after the effect stopped, and ``pending``
has not ended at all.  The rule matches ``EffectSpan.duration_ms`` so that a
turn and its calls never disagree about what a duration means.
"""


@dataclass(frozen=True, slots=True)
class LaneSummary:
    """One lane of a session, for the lane selector."""

    name: str
    tip_id: str | None
    operation_id: str | None
    last_operation_id: str | None
    internal: bool = False
    agent_id: str | None = None
    run_id: str | None = None


@dataclass(frozen=True, slots=True)
class TurnSummary:
    """One operation as a UI turn: identity, outcome, aggregate cost.

    ``status`` is ``None`` while the operation has not settled.  That is the
    only thing the durable record can prove: a process that crashed mid-drive
    leaves the same rows as one still working, so liveness belongs to whoever
    is serving the request, not to this projection.
    """

    session_id: str
    operation_id: str
    lane: str
    kind: OperationKind
    status: OperationStatus | None
    started_at: int
    ended_at: int | None
    duration_ms: int | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    span_count: int
    pending_spans: int
    error_code: str | None
    error_message: str | None


@dataclass(frozen=True, slots=True)
class TurnDetail:
    """One turn's full timeline: entries in order, then what the calls cost.

    ``unattributed_usage`` holds rows bound only to an entry.  They are shown
    apart from ``usage`` because they cannot be proven to belong to this turn —
    folding them in would silently misreport both this turn and its neighbours.
    """

    summary: TurnSummary
    request: object
    entries: tuple[Entry, ...]
    spans: tuple[EffectSpan, ...]
    usage: tuple[UsageRecord, ...]
    unattributed_usage: tuple[UsageRecord, ...]
    result: OperationResult | None


class TraceQueryService:
    """Reads one session database at a time, through the catalog's allow-list."""

    def __init__(self, catalog: SessionCatalog) -> None:
        self._catalog = catalog

    async def list_lanes(self, session_id: str) -> tuple[LaneSummary, ...]:
        storage = await self._open(session_id)
        try:
            lanes = []
            for name in await self._lane_names(storage):
                state = await storage.get_value(lane_state(name))
                if not isinstance(state, dict):
                    raise StorageInvariantError(f"lane {name!r} has no durable state")
                internal = name.startswith(INTERNAL_PREFIX)
                agent_id = name.removeprefix(INTERNAL_PREFIX) if internal else None
                run_id = None
                if agent_id:
                    agent_state = subagent_record(await storage.get_value(subagent_value(f"subagent/{agent_id}/state")))
                    run_id = agent_state.get("current_run_id") or agent_state.get("last_run_id")
                lanes.append(
                    LaneSummary(
                        name=name,
                        tip_id=_optional_str(await storage.get_value(lane_tip(name))),
                        operation_id=_optional_str(state.get("current_operation_id")),
                        last_operation_id=_optional_str(state.get("last_operation_id")),
                        internal=internal,
                        agent_id=agent_id,
                        run_id=run_id,
                    )
                )
            return tuple(lanes)
        finally:
            storage.close()

    async def list_turns(
        self,
        session_id: str,
        lane: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> Page[TurnSummary]:
        """Newest turn first, ordered by the same key the cursor carries."""

        if limit < 1 or limit > _MAX_LIMIT:
            raise ValueError(f"limit must be between 1 and {_MAX_LIMIT}")
        storage = await self._open(session_id)
        try:
            lanes = [lane] if lane is not None else await self._lane_names(storage)
            rows: list[tuple[int, str, str, OperationKind]] = []
            for name in lanes:
                for record in await storage.read_list(lane_operations(name)):
                    rows.append(_index_row(name, record))
            rows.sort(key=lambda row: (row[0], row[1]), reverse=True)
            after = _turn_sort_key(decode_cursor(cursor))
            if after is not None:
                rows = [row for row in rows if (row[0], row[1]) < after]
            has_more = len(rows) > limit
            items = tuple([await self._summary(storage, session_id, *row) for row in rows[:limit]])
            next_cursor = None
            if has_more and items:
                last = rows[limit - 1]
                next_cursor = encode_cursor([last[0], last[1]])
            return Page(items, next_cursor)
        finally:
            storage.close()

    async def get_turn(self, session_id: str, operation_id: str) -> TurnDetail:
        storage = await self._open(session_id)
        try:
            meta = await storage.get_value(operation_meta(operation_id))
            if not isinstance(meta, OperationMeta):
                raise SessionNotFound(f"operation {operation_id!r} is not part of session {session_id!r}")
            result = await self._result(storage, operation_id)
            entries = await self._turn_entries(storage, meta, result)
            usage = await storage.list_usage(operation_id)
            spans = await storage.list_spans(operation_id)
            by_entry = await storage.usage_for_entries([entry.id for entry in entries])
            summary = await self._summary(storage, session_id, meta.started_at, operation_id, meta.lane, meta.kind)
            return TurnDetail(
                summary=summary,
                request=meta.request,
                entries=tuple(entries),
                spans=tuple(spans),
                usage=tuple(usage),
                unattributed_usage=tuple(record for record in by_entry if record.legacy_unattributed),
                result=result,
            )
        finally:
            storage.close()

    async def _summary(
        self,
        storage: Storage,
        session_id: str,
        started_at: int,
        operation_id: str,
        lane: str,
        kind: OperationKind,
    ) -> TurnSummary:
        result = await self._result(storage, operation_id)
        usage = await storage.list_usage(operation_id)
        spans = await storage.list_spans(operation_id)
        input_tokens, output_tokens, total_tokens = _aggregate_usage(usage)
        ended_at = None if result is None else result.ended_at
        status = None if result is None else result.status
        return TurnSummary(
            session_id=session_id,
            operation_id=operation_id,
            lane=lane,
            kind=kind,
            status=status,
            started_at=started_at,
            ended_at=ended_at,
            duration_ms=ended_at - started_at if status in _DURATION_STATUSES and ended_at is not None else None,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            span_count=len(spans),
            pending_spans=sum(1 for span in spans if not span.settled),
            error_code=None if result is None else result.error_code,
            error_message=None if result is None else result.error_message,
        )

    async def _turn_entries(self, storage: Storage, meta: OperationMeta, result: OperationResult | None) -> list[Entry]:
        """The branch segment this operation appended on top of its source tip.

        A settled operation names both ends of that segment.  An unsettled one
        names only where it started: its end is the tip of the next operation
        the lane admitted, because operations on a lane are serial and each one
        starts where its predecessor stopped.  With no successor — the normal
        case for the turn in flight — the lane's current tip is that end.
        """

        from_tip_id = meta.source_tip_id
        if result is not None:
            from_tip_id, tip_id = result.from_tip_id, result.tip_id
            branch = await storage.scan_branch(_optional_str(tip_id))
        else:
            branch = await storage.scan_branch(await self._unsettled_tip(storage, meta))
        if from_tip_id is None:
            return branch
        for index, entry in enumerate(branch):
            if entry.id == from_tip_id:
                return branch[index + 1 :]
        raise StorageInvariantError(
            f"operation {meta.operation_id!r} starts at {from_tip_id!r}, which is not on the branch it names"
        )

    async def _unsettled_tip(self, storage: Storage, meta: OperationMeta) -> str | None:
        successor = False
        for record in await storage.read_list(lane_operations(meta.lane)):
            if successor:
                following = await storage.get_value(operation_meta(_index_row(meta.lane, record)[1]))
                if isinstance(following, OperationMeta):
                    return following.source_tip_id
                raise StorageInvariantError(f"lane {meta.lane!r} indexes an operation with no metadata")
            successor = _index_row(meta.lane, record)[1] == meta.operation_id
        state = await storage.get_value(lane_state(meta.lane))
        if not isinstance(state, dict):
            raise StorageInvariantError(f"lane {meta.lane!r} has no durable state")
        if state.get("current_operation_id") != meta.operation_id and not successor:
            # Neither indexed nor in flight: nothing proves where its entries
            # ended, so claim none rather than borrow a later turn's.
            return meta.source_tip_id
        return _optional_str(await storage.get_value(lane_tip(meta.lane)))

    async def _result(self, storage: Storage, operation_id: str) -> OperationResult | None:
        result = await storage.get_value(operation_result(operation_id))
        if result is None:
            return None
        if not isinstance(result, OperationResult):
            raise StorageInvariantError(f"operation {operation_id!r} has an invalid terminal result")
        return result

    async def _lane_names(self, storage: Storage) -> list[str]:
        names = []
        for value in await storage.read_list(session_lanes()):
            if not isinstance(value, str):
                raise StorageInvariantError("the session lane index contains a non-string entry")
            names.append(value)
        return names

    async def _open(self, session_id: str) -> SQLiteStorage:
        """Open an authorized session database, or fail; never create one.

        A registered session whose file is gone is a real error, not an empty
        session: letting SQLite create the file would quietly answer every
        query with nothing.
        """

        path = await self._catalog.resolve(session_id)
        if not path.is_file():
            raise SessionNotFound(f"session {session_id!r} has no database at its registered location")
        return SQLiteStorage(path)


def _index_row(lane: str, record: object) -> tuple[int, str, str, OperationKind]:
    if not isinstance(record, dict):
        raise StorageInvariantError(f"lane {lane!r} has an invalid turn index entry")
    operation_id, kind, started_at = record.get("operation_id"), record.get("kind"), record.get("started_at")
    if not isinstance(operation_id, str) or not isinstance(started_at, int) or not isinstance(kind, str):
        raise StorageInvariantError(f"lane {lane!r} has an invalid turn index entry")
    if kind != "run" and kind != "compaction" and kind != "navigation":
        raise StorageInvariantError(f"lane {lane!r} indexes an unknown operation kind {kind!r}")
    return started_at, operation_id, lane, cast(OperationKind, kind)


def _turn_sort_key(decoded: list[object] | None) -> tuple[int, str] | None:
    """Narrow the opaque cursor onto this read's stable sort key."""

    if decoded is None:
        return None
    if len(decoded) != 2 or not isinstance(decoded[0], int) or not isinstance(decoded[1], str):
        raise InvalidCursor("turn cursor must carry (started_at, operation_id)")
    return decoded[0], decoded[1]


def _aggregate_usage(records: Sequence[UsageRecord]) -> tuple[int | None, int | None, int | None]:
    """Sum a turn's token counts, one component at a time.

    A component is reported only when every usage row of the turn reports it.
    Summing whatever happens to be present would understate the turn while
    looking like a total, so an incomplete component stays ``None`` and the UI
    renders "not reported" instead of a number it cannot stand behind.
    """

    if not records:
        return None, None, None

    def component(name: str) -> int | None:
        values = [getattr(record, name) for record in records]
        return None if any(value is None for value in values) else sum(values)

    return component("input_tokens"), component("output_tokens"), component("total_tokens")


def _optional_str(value: object) -> str | None:
    if value is None or isinstance(value, str):
        return value
    raise StorageInvariantError(f"expected a string or None, got {type(value).__name__}")


__all__ = ["LaneSummary", "TraceQueryService", "TurnDetail", "TurnSummary"]
