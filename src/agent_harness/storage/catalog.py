"""Application-owned session catalog.

A Session database is the authority for its own content, but it cannot answer
which project a session belongs to, when it was last active, or whether a
caller is allowed to open it at all.  The catalog owns exactly that metadata and
nothing else: every read is an allow-list lookup, so a request parameter never
becomes a filesystem path.
"""

import sqlite3
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class CatalogConflict(RuntimeError):
    """A session id already points at a different immutable location."""


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    session_id: str
    project_id: str
    repository_id: str
    database_path: str
    default_lane: str
    created_at: int
    last_active_at: int


class CatalogStore(Protocol):
    async def register(self, entry: CatalogEntry) -> CatalogEntry: ...

    async def touch(self, session_id: str, at: int) -> None: ...

    async def get(self, session_id: str) -> CatalogEntry | None: ...

    async def list_after(
        self, project_id: str, cursor: tuple[int, str] | None, limit: int
    ) -> tuple[CatalogEntry, ...]: ...


class MemoryCatalogStore:
    """Ephemeral catalog used by tests and single-process embedding."""

    def __init__(self) -> None:
        self._entries: dict[str, CatalogEntry] = {}

    async def register(self, entry: CatalogEntry) -> CatalogEntry:
        existing = self._entries.get(entry.session_id)
        if existing is not None:
            _assert_same_owner(existing, entry)
            entry = CatalogEntry(
                entry.session_id,
                entry.project_id,
                entry.repository_id,
                entry.database_path,
                entry.default_lane,
                existing.created_at,
                max(existing.last_active_at, entry.last_active_at),
            )
        self._entries[entry.session_id] = entry
        return entry

    async def touch(self, session_id: str, at: int) -> None:
        entry = self._entries.get(session_id)
        if entry is None:
            return
        self._entries[session_id] = CatalogEntry(
            entry.session_id,
            entry.project_id,
            entry.repository_id,
            entry.database_path,
            entry.default_lane,
            entry.created_at,
            max(entry.last_active_at, at),
        )

    async def get(self, session_id: str) -> CatalogEntry | None:
        return self._entries.get(session_id)

    async def list_after(self, project_id: str, cursor: tuple[int, str] | None, limit: int) -> tuple[CatalogEntry, ...]:
        rows = [
            entry
            for entry in self._entries.values()
            if entry.project_id == project_id and (cursor is None or (entry.last_active_at, entry.session_id) < cursor)
        ]
        rows.sort(key=lambda entry: (entry.last_active_at, entry.session_id), reverse=True)
        return tuple(rows[:limit])


class SQLiteCatalogStore:
    """Forward-only SQLite catalog; sessions themselves live elsewhere."""

    def __init__(self, path: str | Path, *, now_ms: Callable[[], int] | None = None) -> None:
        self._connection = sqlite3.connect(str(path), isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._now = now_ms or (lambda: time.time_ns() // 1_000_000)
        self._migrate()

    def _migrate(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS session_catalog(
                session_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                repository_id TEXT NOT NULL,
                database_path TEXT NOT NULL,
                default_lane TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_active_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS session_catalog_activity
                ON session_catalog(project_id, last_active_at DESC, session_id DESC);
            INSERT OR IGNORE INTO schema_migrations VALUES(1);
            """
        )

    async def register(self, entry: CatalogEntry) -> CatalogEntry:
        row = self._connection.execute(
            "SELECT * FROM session_catalog WHERE session_id=?", (entry.session_id,)
        ).fetchone()
        if row is not None:
            existing = _entry(row)
            _assert_same_owner(existing, entry)
            self._connection.execute(
                "UPDATE session_catalog SET last_active_at=? WHERE session_id=?",
                (max(existing.last_active_at, entry.last_active_at), entry.session_id),
            )
            return _entry(
                self._connection.execute(
                    "SELECT * FROM session_catalog WHERE session_id=?", (entry.session_id,)
                ).fetchone()
            )
        self._connection.execute(
            "INSERT INTO session_catalog VALUES(?,?,?,?,?,?,?)",
            (
                entry.session_id,
                entry.project_id,
                entry.repository_id,
                entry.database_path,
                entry.default_lane,
                entry.created_at,
                entry.last_active_at,
            ),
        )
        return entry

    async def touch(self, session_id: str, at: int) -> None:
        self._connection.execute(
            "UPDATE session_catalog SET last_active_at=? WHERE session_id=? AND last_active_at<?",
            (at, session_id, at),
        )

    async def get(self, session_id: str) -> CatalogEntry | None:
        row = self._connection.execute("SELECT * FROM session_catalog WHERE session_id=?", (session_id,)).fetchone()
        return None if row is None else _entry(row)

    async def list_after(self, project_id: str, cursor: tuple[int, str] | None, limit: int) -> tuple[CatalogEntry, ...]:
        if cursor is None:
            rows = self._connection.execute(
                """SELECT * FROM session_catalog WHERE project_id=?
                   ORDER BY last_active_at DESC, session_id DESC LIMIT ?""",
                (project_id, limit),
            ).fetchall()
        else:
            rows = self._connection.execute(
                """SELECT * FROM session_catalog
                   WHERE project_id=? AND (last_active_at, session_id) < (?, ?)
                   ORDER BY last_active_at DESC, session_id DESC LIMIT ?""",
                (project_id, cursor[0], cursor[1], limit),
            ).fetchall()
        return tuple(_entry(row) for row in rows)

    def close(self) -> None:
        self._connection.close()


def _entry(row: sqlite3.Row) -> CatalogEntry:
    return CatalogEntry(
        row["session_id"],
        row["project_id"],
        row["repository_id"],
        row["database_path"],
        row["default_lane"],
        row["created_at"],
        row["last_active_at"],
    )


def _assert_same_owner(existing: CatalogEntry, incoming: CatalogEntry) -> None:
    if (
        existing.project_id != incoming.project_id
        or existing.repository_id != incoming.repository_id
        or existing.database_path != incoming.database_path
    ):
        raise CatalogConflict(f"session {existing.session_id!r} is already registered to another project or location")
