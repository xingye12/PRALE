"""Allow-list session resolution and the session picker's read model."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from agent_harness.api.errors import InvalidCursor, SessionNotFound
from agent_harness.api.pagination import Page, paginate
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.storage.catalog import CatalogEntry, CatalogStore
from agent_harness.storage.repository import session_filename


@dataclass(frozen=True, slots=True)
class SessionSummary:
    """Session metadata for the picker; the database location stays server-side."""

    session_id: str
    project_id: str
    repository_id: str
    default_lane: str
    created_at: int
    last_active_at: int


class SessionCatalog:
    """The only way a session database is located, opened, or authorized."""

    def __init__(
        self, store: CatalogStore, config: ProjectRuntimeConfig, *, now_ms: Callable[[], int] | None = None
    ) -> None:
        self._store = store
        self._config = config
        self._now = now_ms or (lambda: time.time_ns() // 1_000_000)

    async def register(self, session_id: str, *, lane: str | None = None) -> SessionSummary:
        """Register a session atomically before it can be opened by any request."""

        now = self._now()
        entry = CatalogEntry(
            session_id,
            self._config.project.project_id,
            self._config.repository_id,
            session_filename(session_id),
            lane or self._config.default_lane,
            now,
            now,
        )
        return _summary(await self._store.register(entry))

    async def touch(self, session_id: str) -> None:
        await self._store.touch(session_id, self._now())

    async def list_sessions(self, cursor: str | None = None, limit: int = 50) -> Page[SessionSummary]:
        async def read(after: tuple[int, str] | None, size: int) -> tuple[SessionSummary, ...]:
            rows = await self._store.list_after(self._config.project.project_id, after, size)
            return tuple(_summary(row) for row in rows)

        return await paginate(
            cursor,
            limit,
            read=read,
            narrow=_sort_key,
            key=lambda item: [item.last_active_at, item.session_id],
        )

    async def resolve(self, session_id: str) -> Path:
        """Map an authorized session id onto its database path.

        The allow-list lookup happens first, so a client-supplied id can never
        become an arbitrary SQLite filename.
        """

        entry = await self._store.get(session_id)
        if entry is None:
            raise SessionNotFound(f"session {session_id!r} is not registered in this project")
        candidate = (self._config.sessions_dir / entry.database_path).resolve()
        root = self._config.sessions_dir.resolve()
        if not candidate.is_relative_to(root):
            raise SessionNotFound(f"session {session_id!r} resolves outside the session directory")
        return candidate


def _sort_key(decoded: list[object] | None) -> tuple[int, str] | None:
    """Narrow the opaque cursor onto this read's stable sort key."""

    if decoded is None:
        return None
    if len(decoded) != 2 or not isinstance(decoded[0], int) or not isinstance(decoded[1], str):
        raise InvalidCursor("session cursor must carry (last_active_at, session_id)")
    return decoded[0], decoded[1]


def _summary(entry: CatalogEntry) -> SessionSummary:
    return SessionSummary(
        entry.session_id,
        entry.project_id,
        entry.repository_id,
        entry.default_lane,
        entry.created_at,
        entry.last_active_at,
    )
