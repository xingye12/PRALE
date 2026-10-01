"""Ephemeral conformance backend for long-term memory.

It intentionally reuses the transactional SQLite implementation in an isolated
in-memory database. This keeps the observable MemoryStore contract identical
while making tests fast and leaving no durable filesystem state.
"""

from collections.abc import Callable
from tempfile import TemporaryDirectory

from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


class InMemoryMemoryStore(SQLiteMemoryStore):
    def __init__(self, *, id_factory: Callable[[], str] | None = None, now_ms: Callable[[], int] | None = None) -> None:
        self._asset_directory = TemporaryDirectory(prefix="prale-memory-assets-")
        super().__init__(
            ":memory:",
            id_factory=id_factory,
            now_ms=now_ms,
            assets_dir=self._asset_directory.name,
        )

    def close(self) -> None:
        super().close()
        self._asset_directory.cleanup()
