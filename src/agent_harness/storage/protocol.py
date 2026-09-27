from asyncio import Lock
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from agent_harness.domain.effects import EffectOutcome, EffectSpan, ErrorClass, UsageRecord
from agent_harness.domain.entries import Entry, NewEntry
from agent_harness.domain.values import ListAddress, ValueAddress


@dataclass(frozen=True, slots=True)
class UsageRow:
    """A provider usage report.

    ``operation_id`` and ``span_id`` are absent only on rows written before
    effects were attributable; those can never be proven to belong to a turn.
    """

    id: str
    usage: dict[str, int | float]
    entry_id: str | None = None
    operation_id: str | None = None
    span_id: str | None = None


@dataclass(frozen=True, slots=True)
class InsertEntry:
    entry: NewEntry


@dataclass(frozen=True, slots=True)
class InsertUsage:
    row: UsageRow


@dataclass(frozen=True, slots=True)
class InsertSpan:
    """Start an effect attempt; committed with the intent that authorizes it."""

    span: EffectSpan


@dataclass(frozen=True, slots=True)
class SettleSpan:
    """Record one effect attempt's outcome; a span settles at most once."""

    span_id: str
    ended_at: int
    outcome: EffectOutcome
    error_class: ErrorClass | None = None


@dataclass(frozen=True, slots=True)
class SetValue:
    address: ValueAddress[object]
    value: object


@dataclass(frozen=True, slots=True)
class DeleteValue:
    address: ValueAddress[object]


@dataclass(frozen=True, slots=True)
class AppendList:
    address: ListAddress[object]
    value: object


@dataclass(frozen=True, slots=True)
class ClearList:
    address: ListAddress[object]


Write = InsertEntry | InsertUsage | InsertSpan | SettleSpan | SetValue | DeleteValue | AppendList | ClearList


@dataclass(frozen=True, slots=True)
class CommitResult:
    first_seq: int
    seqs: tuple[int, ...]
    timestamp: int


class Storage(Protocol):
    def operation_lock(self, key: str) -> Lock: ...

    async def commit(self, writes: list[Write]) -> CommitResult: ...

    async def get_entries(self, ids: list[str]) -> dict[str, Entry]: ...

    async def scan_branch(self, start: str | None) -> list[Entry]: ...

    async def get_value(self, address: ValueAddress[object]) -> object | None: ...

    async def read_list(self, address: ListAddress[object]) -> list[object]: ...

    async def list_spans(self, operation_id: str) -> list[EffectSpan]: ...

    async def list_usage(self, operation_id: str) -> list[UsageRecord]: ...

    async def usage_for_entries(self, entry_ids: Sequence[str]) -> list[UsageRecord]:
        """Read usage by entry, which is the only binding rows written before
        operation attribution ever had. Returns those rows marked legacy."""
        ...
