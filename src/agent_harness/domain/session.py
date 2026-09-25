import asyncio
from collections.abc import Awaitable, Callable
from typing import TypeVar

from agent_harness.domain.entries import Entry
from agent_harness.domain.values import ListAddress, ValueAddress
from agent_harness.storage.protocol import CommitResult, Storage, Write

T = TypeVar("T")


class MutationClosedError(RuntimeError):
    pass


class SessionMutator:
    """Callback-scoped capability that permits exactly one storage commit."""

    def __init__(self, storage: Storage) -> None:
        self._storage = storage
        self._committed = False
        self._closed = False

    def _assert_valid(self) -> None:
        if self._closed:
            raise MutationClosedError("session mutation capability is closed")

    async def commit(self, writes: list[Write]) -> CommitResult:
        self._assert_valid()
        if self._committed:
            raise MutationClosedError("a session mutation may commit exactly once")
        self._committed = True
        return await self._storage.commit(writes)

    async def get_entries(self, ids: list[str]) -> dict[str, Entry]:
        self._assert_valid()
        return await self._storage.get_entries(ids)

    async def scan_branch(self, start: str | None) -> list[Entry]:
        self._assert_valid()
        return await self._storage.scan_branch(start)

    async def get_value(self, address: ValueAddress[object]) -> object | None:
        self._assert_valid()
        return await self._storage.get_value(address)

    async def read_list(self, address: ListAddress[object]) -> list[object]:
        self._assert_valid()
        return await self._storage.read_list(address)

    def close(self) -> None:
        self._closed = True


class Session:
    """One session-local mutation line around a storage backend."""

    def __init__(self, session_id: str, storage: Storage) -> None:
        self.id = session_id
        self._storage = storage
        self._mutation_lock = asyncio.Lock()

    async def mutate(self, callback: Callable[[SessionMutator], Awaitable[T]]) -> T:
        async with self._mutation_lock:
            mutator = SessionMutator(self._storage)
            try:
                return await callback(mutator)
            finally:
                mutator.close()

    async def get_entry(self, entry_id: str) -> Entry | None:
        return (await self._storage.get_entries([entry_id])).get(entry_id)

    async def context(self, tip_id: str | None) -> list[Entry]:
        return await self._storage.scan_branch(tip_id)

    async def get_value(self, address: ValueAddress[object]) -> object | None:
        return await self._storage.get_value(address)

    def operation_lock(self, lane: str) -> asyncio.Lock:
        return self._storage.operation_lock(f"session/{self.id}/lane/{lane}")
