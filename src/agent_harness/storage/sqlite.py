# ruff: noqa: E501
import sqlite3
import time
from asyncio import Lock
from pathlib import Path
from typing import cast

from agent_harness.domain.entries import Entry, JsonValue
from agent_harness.domain.values import ListAddress, ValueAddress
from agent_harness.storage.codec import dumps, loads
from agent_harness.storage.memory import StorageInvariantError
from agent_harness.storage.protocol import (
    AppendList,
    ClearList,
    CommitResult,
    DeleteValue,
    InsertEntry,
    InsertUsage,
    SetValue,
    Storage,
    Write,
)


class SQLiteStorage(Storage):
    """SQLite implementation of the session-local Storage protocol."""

    def __init__(self, path: str | Path) -> None:
        self._connection = sqlite3.connect(str(path), isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._lock = Lock()
        self._operation_locks: dict[str, Lock] = {}
        self._migrate()

    def bind_session(self, session_id: str, created_at: int | None = None) -> int:
        """Bind this one-session database to its immutable logical session ID."""

        row = self._connection.execute("SELECT id, created_at FROM sessions LIMIT 1").fetchone()
        if row is not None:
            if row["id"] != session_id:
                raise StorageInvariantError(
                    f"database belongs to session {row['id']!r}, not requested session {session_id!r}"
                )
            return int(row["created_at"])
        timestamp = created_at if created_at is not None else time.time_ns() // 1_000_000
        self._connection.execute("INSERT INTO sessions(id, created_at) VALUES (?, ?)", (session_id, timestamp))
        return timestamp

    def rebind_session(self, session_id: str, created_at: int) -> None:
        """Assign a cloned database to its new logical session before exposing it."""

        self._connection.execute("DELETE FROM sessions")
        self.bind_session(session_id, created_at)

    def operation_lock(self, key: str) -> Lock:
        return self._operation_locks.setdefault(key, Lock())

    def _migrate(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS sequence_counter (id INTEGER PRIMARY KEY CHECK(id = 1), next_seq INTEGER NOT NULL);
            INSERT OR IGNORE INTO sequence_counter(id, next_seq) VALUES(1, 1);
            CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY, parent_id TEXT REFERENCES entries(id), seq INTEGER UNIQUE NOT NULL,
                timestamp INTEGER NOT NULL, type TEXT NOT NULL, custom_type TEXT, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS entries_parent ON entries(parent_id);
            CREATE TABLE IF NOT EXISTS values_store (address TEXT PRIMARY KEY, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS list_elements (address TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
                PRIMARY KEY(address, seq));
            CREATE TABLE IF NOT EXISTS usage_rows (id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, entry_id TEXT,
                usage TEXT NOT NULL);
            INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);
            """
        )
        self._connection.executescript(
            """
            CREATE INDEX IF NOT EXISTS values_store_address ON values_store(address);
            CREATE INDEX IF NOT EXISTS list_elements_address_seq ON list_elements(address, seq);
            CREATE INDEX IF NOT EXISTS usage_rows_entry ON usage_rows(entry_id);
            INSERT OR IGNORE INTO schema_migrations(version) VALUES(2);
            """
        )

    async def commit(self, writes: list[Write]) -> CommitResult:
        async with self._lock:
            now = time.time_ns() // 1_000_000
            conn = self._connection
            try:
                conn.execute("BEGIN IMMEDIATE")
                first_seq = conn.execute("SELECT next_seq FROM sequence_counter WHERE id = 1").fetchone()[0]
                next_seq = first_seq
                for write in writes:
                    if isinstance(write, InsertEntry):
                        entry = write.entry
                        if conn.execute("SELECT 1 FROM entries WHERE id = ?", (entry.id,)).fetchone():
                            raise StorageInvariantError(f"entry {entry.id!r} already exists")
                        if (
                            entry.parent_id is not None
                            and not conn.execute("SELECT 1 FROM entries WHERE id = ?", (entry.parent_id,)).fetchone()
                        ):
                            raise StorageInvariantError(
                                f"entry {entry.id!r} references missing parent {entry.parent_id!r}"
                            )
                        conn.execute(
                            "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (
                                entry.id,
                                entry.parent_id,
                                next_seq,
                                now,
                                entry.type,
                                entry.custom_type,
                                dumps(entry.payload),
                            ),
                        )
                    elif isinstance(write, InsertUsage):
                        row = write.row
                        conn.execute(
                            "INSERT INTO usage_rows VALUES (?, ?, ?, ?)",
                            (row.id, next_seq, row.entry_id, dumps(row.usage)),
                        )
                    elif isinstance(write, SetValue):
                        conn.execute(
                            "INSERT INTO values_store(address, payload) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET payload=excluded.payload",
                            (write.address.key, dumps(write.value)),
                        )
                    elif isinstance(write, DeleteValue):
                        conn.execute("DELETE FROM values_store WHERE address = ?", (write.address.key,))
                    elif isinstance(write, AppendList):
                        conn.execute(
                            "INSERT INTO list_elements VALUES (?, ?, ?)",
                            (write.address.key, next_seq, dumps(write.value)),
                        )
                    elif isinstance(write, ClearList):
                        conn.execute("DELETE FROM list_elements WHERE address = ?", (write.address.key,))
                    next_seq += 1
                conn.execute("UPDATE sequence_counter SET next_seq = ? WHERE id = 1", (next_seq,))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
            return CommitResult(first_seq, tuple(range(first_seq, next_seq)), now)

    async def get_entries(self, ids: list[str]) -> dict[str, Entry]:
        if not ids:
            return {}
        rows = self._connection.execute(
            f"SELECT * FROM entries WHERE id IN ({','.join('?' for _ in ids)})", ids
        ).fetchall()
        return {row["id"]: self._entry(row) for row in rows}

    async def scan_branch(self, start: str | None) -> list[Entry]:
        result: list[Entry] = []
        current = start
        while current is not None:
            row = self._connection.execute("SELECT * FROM entries WHERE id = ?", (current,)).fetchone()
            if row is None:
                raise StorageInvariantError(f"branch references missing entry {current!r}")
            entry = self._entry(row)
            result.append(entry)
            current = entry.parent_id
        return list(reversed(result))

    async def get_value(self, address: ValueAddress[object]) -> object | None:
        row = self._connection.execute("SELECT payload FROM values_store WHERE address = ?", (address.key,)).fetchone()
        return None if row is None else loads(row[0])

    async def read_list(self, address: ListAddress[object]) -> list[object]:
        rows = self._connection.execute(
            "SELECT payload FROM list_elements WHERE address = ? ORDER BY seq", (address.key,)
        ).fetchall()
        return [loads(row[0]) for row in rows]

    def _entry(self, row: sqlite3.Row) -> Entry:
        return Entry(
            row["id"],
            row["parent_id"],
            row["seq"],
            row["timestamp"],
            row["type"],
            cast(JsonValue, loads(row["payload"])),
            row["custom_type"],
        )

    def close(self) -> None:
        self._connection.close()

    def clone_to(self, path: str | Path) -> "SQLiteStorage":
        clone = SQLiteStorage(path)
        self._connection.backup(clone._connection)
        return clone
