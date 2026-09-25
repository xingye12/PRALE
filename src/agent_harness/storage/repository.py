import time
from dataclasses import dataclass
from pathlib import Path

from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.sqlite import SQLiteStorage


@dataclass(frozen=True, slots=True)
class SessionMetadata:
    id: str
    created_at: int


class MemorySessionRepo:
    def __init__(self) -> None:
        self._stores: dict[str, tuple[SessionMetadata, MemoryStorage]] = {}

    async def create(self, session_id: str) -> tuple[SessionMetadata, MemoryStorage]:
        if session_id in self._stores:
            raise ValueError(f"session {session_id!r} already exists")
        metadata = SessionMetadata(session_id, time.time_ns() // 1_000_000)
        store = MemoryStorage()
        self._stores[session_id] = (metadata, store)
        return metadata, store

    async def open(self, session_id: str) -> tuple[SessionMetadata, MemoryStorage]:
        return self._stores[session_id]

    async def list(self) -> list[SessionMetadata]:
        return [metadata for metadata, _ in self._stores.values()]

    async def delete(self, session_id: str) -> None:
        del self._stores[session_id]

    async def fork(self, source_id: str, target_id: str) -> tuple[SessionMetadata, MemoryStorage]:
        if target_id in self._stores:
            raise ValueError(f"session {target_id!r} already exists")
        _, source = await self.open(source_id)
        metadata = SessionMetadata(target_id, time.time_ns() // 1_000_000)
        clone = source.clone()
        self._stores[target_id] = (metadata, clone)
        return metadata, clone


class SQLiteSessionRepo:
    def __init__(self, directory: str | Path) -> None:
        self._directory = Path(directory)
        self._directory.mkdir(parents=True, exist_ok=True)

    async def create(self, session_id: str) -> tuple[SessionMetadata, SQLiteStorage]:
        path = self._path(session_id)
        if path.exists():
            raise ValueError(f"session {session_id!r} already exists")
        metadata = SessionMetadata(session_id, time.time_ns() // 1_000_000)
        storage = SQLiteStorage(path)
        storage.bind_session(session_id, metadata.created_at)
        return metadata, storage

    async def open(self, session_id: str) -> tuple[SessionMetadata, SQLiteStorage]:
        path = self._path(session_id)
        if not path.exists():
            raise KeyError(session_id)
        storage = SQLiteStorage(path)
        return SessionMetadata(session_id, storage.bind_session(session_id)), storage

    async def list(self) -> list[SessionMetadata]:
        sessions: list[SessionMetadata] = []
        for path in self._directory.glob("*.sqlite"):
            storage = SQLiteStorage(path)
            try:
                sessions.append(SessionMetadata(path.stem, storage.bind_session(path.stem)))
            finally:
                storage.close()
        return sessions

    async def delete(self, session_id: str) -> None:
        self._path(session_id).unlink()

    async def fork(self, source_id: str, target_id: str) -> tuple[SessionMetadata, SQLiteStorage]:
        source_path = self._path(source_id)
        target_path = self._path(target_id)
        if not source_path.exists():
            raise KeyError(source_id)
        if target_path.exists():
            raise ValueError(f"session {target_id!r} already exists")
        source = SQLiteStorage(source_path)
        try:
            clone = source.clone_to(target_path)
        finally:
            source.close()
        metadata = SessionMetadata(target_id, time.time_ns() // 1_000_000)
        clone.rebind_session(target_id, metadata.created_at)
        return metadata, clone

    def _path(self, session_id: str) -> Path:
        if not session_id or "/" in session_id or "\\" in session_id:
            raise ValueError("session ID must be a non-empty filename component")
        return self._directory / f"{session_id}.sqlite"
