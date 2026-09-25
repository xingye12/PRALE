from asyncio import Lock
from dataclasses import dataclass
from typing import Protocol

from agent_harness.domain.entries import Entry, NewEntry
from agent_harness.domain.values import ListAddress, ValueAddress


@dataclass(frozen=True, slots=True)
class UsageRow:
    id: str
    usage: dict[str, int | float]
    entry_id: str | None = None


@dataclass(frozen=True, slots=True)
class InsertEntry:
    entry: NewEntry


@dataclass(frozen=True, slots=True)
class InsertUsage:
    row: UsageRow


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


Write = InsertEntry | InsertUsage | SetValue | DeleteValue | AppendList | ClearList


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
