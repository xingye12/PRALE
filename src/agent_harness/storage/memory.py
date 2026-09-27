import copy
import time
from asyncio import Lock
from collections.abc import Callable, Sequence
from dataclasses import replace

from agent_harness.domain.effects import EffectSpan, UsageRecord, as_usage, normalize_usage
from agent_harness.domain.entries import Entry
from agent_harness.domain.values import ListAddress, ValueAddress
from agent_harness.storage.protocol import (
    AppendList,
    ClearList,
    CommitResult,
    DeleteValue,
    InsertEntry,
    InsertSpan,
    InsertUsage,
    SettleSpan,
    SetValue,
    Storage,
    UsageRow,
    Write,
)


class StorageInvariantError(RuntimeError):
    pass


def _usage_record(row: UsageRow) -> UsageRecord:
    raw = as_usage(row.usage)
    input_tokens, output_tokens, total_tokens = normalize_usage(raw)
    return UsageRecord(
        id=row.id,
        operation_id=row.operation_id,
        entry_id=row.entry_id,
        span_id=row.span_id,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        raw=raw,
    )


class MemoryStorage(Storage):
    """Reference storage implementation. Session serializes all mutation calls."""

    def __init__(self, now_ms: Callable[[], int] | None = None) -> None:
        self._now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._next_seq = 1
        self._entries: dict[str, Entry] = {}
        self._values: dict[str, object] = {}
        self._lists: dict[str, list[object]] = {}
        self._usage: list[tuple[int, UsageRow]] = []
        self._spans: list[EffectSpan] = []
        self._operation_locks: dict[str, Lock] = {}

    def operation_lock(self, key: str) -> Lock:
        return self._operation_locks.setdefault(key, Lock())

    def clone(self) -> "MemoryStorage":
        clone = MemoryStorage(self._now_ms)
        clone._next_seq = self._next_seq
        clone._entries = copy.deepcopy(self._entries)
        clone._values = copy.deepcopy(self._values)
        clone._lists = copy.deepcopy(self._lists)
        clone._usage = copy.deepcopy(self._usage)
        clone._spans = copy.deepcopy(self._spans)
        return clone

    async def commit(self, writes: list[Write]) -> CommitResult:
        self._validate(writes)
        timestamp = self._now_ms()
        first_seq = self._next_seq
        seqs: list[int] = []
        for write in writes:
            seq = self._next_seq
            self._next_seq += 1
            seqs.append(seq)
            match write:
                case InsertEntry(entry):
                    self._entries[entry.id] = Entry(
                        id=entry.id,
                        parent_id=entry.parent_id,
                        seq=seq,
                        timestamp=timestamp,
                        type=entry.type,
                        payload=copy.deepcopy(entry.payload),
                        custom_type=entry.custom_type,
                    )
                case InsertUsage(row):
                    self._usage.append((seq, copy.deepcopy(row)))
                case InsertSpan(span):
                    if any(existing.span_id == span.span_id for existing in self._spans):
                        raise StorageInvariantError(f"effect span {span.span_id!r} already exists")
                    self._spans.append(copy.deepcopy(span))
                case SettleSpan(span_id, ended_at, outcome, error_class):
                    index = self._span_index(span_id)
                    self._spans[index] = replace(
                        self._spans[index], ended_at=ended_at, outcome=outcome, error_class=error_class
                    )
                case SetValue(address, value):
                    self._values[address.key] = copy.deepcopy(value)
                case DeleteValue(address):
                    self._values.pop(address.key, None)
                case AppendList(address, value):
                    self._lists.setdefault(address.key, []).append(copy.deepcopy(value))
                case ClearList(address):
                    self._lists.pop(address.key, None)
        return CommitResult(first_seq=first_seq, seqs=tuple(seqs), timestamp=timestamp)

    def _validate(self, writes: list[Write]) -> None:
        pending_ids: set[str] = set()
        known_ids = set(self._entries)
        pending_spans: set[str] = set()
        pending_span_ids: set[str] = set()
        known_span_ids = {span.span_id for span in self._spans if not span.settled}
        for write in writes:
            if isinstance(write, InsertEntry):
                entry = write.entry
                if entry.id in known_ids or entry.id in pending_ids:
                    raise StorageInvariantError(f"entry {entry.id!r} already exists")
                if entry.parent_id is not None and entry.parent_id not in known_ids | pending_ids:
                    raise StorageInvariantError(f"entry {entry.id!r} references missing parent {entry.parent_id!r}")
                pending_ids.add(entry.id)
            elif isinstance(write, InsertSpan):
                if write.span.span_id in {span.span_id for span in self._spans} | pending_span_ids:
                    raise StorageInvariantError(f"effect span {write.span.span_id!r} already exists")
                pending_span_ids.add(write.span.span_id)
                pending_spans.add(write.span.span_id)
            elif isinstance(write, SettleSpan):
                if write.span_id not in known_span_ids | pending_spans:
                    raise StorageInvariantError(f"effect span {write.span_id!r} is unknown or was already settled")
                pending_spans.discard(write.span_id)

    async def get_entries(self, ids: list[str]) -> dict[str, Entry]:
        return {entry_id: copy.deepcopy(self._entries[entry_id]) for entry_id in ids if entry_id in self._entries}

    async def scan_branch(self, start: str | None) -> list[Entry]:
        result: list[Entry] = []
        current = start
        seen: set[str] = set()
        while current is not None:
            if current in seen:
                raise StorageInvariantError(f"cycle at entry {current!r}")
            seen.add(current)
            entry = self._entries.get(current)
            if entry is None:
                raise StorageInvariantError(f"branch references missing entry {current!r}")
            result.append(copy.deepcopy(entry))
            current = entry.parent_id
        result.reverse()
        return result

    async def get_value(self, address: ValueAddress[object]) -> object | None:
        value = self._values.get(address.key)
        return copy.deepcopy(value)

    async def read_list(self, address: ListAddress[object]) -> list[object]:
        return copy.deepcopy(self._lists.get(address.key, []))

    def _span_index(self, span_id: str) -> int:
        for index, span in enumerate(self._spans):
            if span.span_id == span_id:
                return index
        raise StorageInvariantError(f"effect span {span_id!r} is unknown or was already settled")

    async def list_spans(self, operation_id: str) -> list[EffectSpan]:
        spans = [span for span in self._spans if span.operation_id == operation_id]
        return [copy.deepcopy(span) for span in sorted(spans, key=lambda span: span.started_at)]

    async def list_usage(self, operation_id: str) -> list[UsageRecord]:
        return [_usage_record(row) for _, row in self._usage if row.operation_id == operation_id]

    async def usage_for_entries(self, entry_ids: Sequence[str]) -> list[UsageRecord]:
        wanted = set(entry_ids)
        return [_usage_record(row) for _, row in self._usage if row.entry_id in wanted]
