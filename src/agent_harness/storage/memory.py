import copy
import time
from asyncio import Lock
from collections.abc import Callable

from agent_harness.domain.entries import Entry
from agent_harness.domain.values import ListAddress, ValueAddress
from agent_harness.storage.protocol import (
    AppendList,
    ClearList,
    CommitResult,
    DeleteValue,
    InsertEntry,
    InsertUsage,
    SetValue,
    Storage,
    UsageRow,
    Write,
)


class StorageInvariantError(RuntimeError):
    pass


class MemoryStorage(Storage):
    """Reference storage implementation. Session serializes all mutation calls."""

    def __init__(self, now_ms: Callable[[], int] | None = None) -> None:
        self._now_ms = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._next_seq = 1
        self._entries: dict[str, Entry] = {}
        self._values: dict[str, object] = {}
        self._lists: dict[str, list[object]] = {}
        self._usage: list[tuple[int, UsageRow]] = []
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
        for write in writes:
            if not isinstance(write, InsertEntry):
                continue
            entry = write.entry
            if entry.id in known_ids or entry.id in pending_ids:
                raise StorageInvariantError(f"entry {entry.id!r} already exists")
            if entry.parent_id is not None and entry.parent_id not in known_ids | pending_ids:
                raise StorageInvariantError(f"entry {entry.id!r} references missing parent {entry.parent_id!r}")
            pending_ids.add(entry.id)

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
