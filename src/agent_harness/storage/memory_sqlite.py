"""SQLite authority store for long-term memory assets.

The database deliberately has no dependency on Session storage: capture data is
already frozen by the session outbox before it reaches this component.
"""
# ruff: noqa

import json
import re
import sqlite3
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING

from agent_harness.domain.memory import (
    ArchiveSummary,
    AtomicCandidate,
    AtomicMemory,
    DoctrineCandidate,
    GLOBAL_L3_SCOPE,
    MemoryAuditRecord,
    MemoryScope,
    PromotionJob,
    PromotionConflict,
    RecallBudget,
    RecallBundle,
    RecallItem,
    RecallQuery,
    SessionTraceArchive,
    SceneCandidate,
    TraceItem,
    WorkSceneMemory,
    content_hash,
    validate_atomic_candidate,
    validate_doctrine_content,
    validate_scene_content,
)

if TYPE_CHECKING:
    from agent_harness.memory.protocol import EmbeddingProvider


def _scope(scope: MemoryScope) -> tuple[str, str, str]:
    # The physical columns predate repository ownership.  v4 stores the
    # repository key in their first component and fixes the deprecated identity
    # components to empty strings; all predicates remain database-side.
    return scope.storage_key


def _now() -> int:
    return time.time_ns() // 1_000_000


_CODE_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_REPOSITORY_PATH = re.compile(r"(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+")


def _search_terms(query: RecallQuery) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Keep code identifiers searchable even when punctuation splits FTS tokens."""
    text = f"{query.text}\n{query.context_summary}".lower()
    terms = tuple(dict.fromkeys(token for token in _CODE_TOKEN.findall(text) if len(token) > 1))
    paths = tuple(dict.fromkeys(_REPOSITORY_PATH.findall(text)))
    return terms, paths


def _indexable_memory_text(content: str, metadata: dict[str, object]) -> str:
    """Index stable code references without changing the displayed memory text."""
    references = [
        str(metadata[key])
        for key in ("artifact_ref", "work_object", "scope", "symbol", "path", "test_ref")
        if isinstance(metadata.get(key), str)
    ]
    return "\n".join((content, *references))


class SQLiteMemoryStore:
    def __init__(
        self,
        path: str | Path,
        *,
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
        embedding_provider: "EmbeddingProvider | None" = None,
    ) -> None:
        self._conn = sqlite3.connect(str(path), isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._ids = id_factory or (lambda: str(uuid.uuid4()))
        self._now = now_ms or _now
        self._embeddings = embedding_provider
        self._migrate()

    def _migrate(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS memory_scopes(team_id TEXT, agent_id TEXT, user_id TEXT, created_at INTEGER,
              PRIMARY KEY(team_id,agent_id,user_id));
            CREATE TABLE IF NOT EXISTS trace_archives(
              archive_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
              session_id TEXT NOT NULL, lane TEXT NOT NULL, operation_id TEXT NOT NULL, operation_kind TEXT NOT NULL,
              base_tip_id TEXT, tip_id TEXT, source_entry_hash TEXT NOT NULL, trace_format_version TEXT NOT NULL,
              created_at INTEGER NOT NULL, content_hash TEXT NOT NULL, parent_archive_id TEXT, parent_gap INTEGER NOT NULL DEFAULT 0,
              UNIQUE(session_id,operation_id,tip_id,source_entry_hash));
            CREATE TABLE IF NOT EXISTS trace_items(
              archive_id TEXT NOT NULL REFERENCES trace_archives(archive_id), source_entry_id TEXT NOT NULL,
              source_seq INTEGER NOT NULL, timestamp INTEGER NOT NULL, type TEXT NOT NULL, role TEXT, content TEXT,
              payload TEXT NOT NULL, redacted_paths TEXT NOT NULL, store_seq INTEGER NOT NULL,
              PRIMARY KEY(archive_id,source_entry_id));
            DROP INDEX IF EXISTS trace_item_scope_seq;
            CREATE INDEX IF NOT EXISTS trace_item_archive_seq ON trace_items(archive_id, store_seq);
            CREATE TABLE IF NOT EXISTS atomic_memories(
              memory_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, agent_id TEXT NOT NULL, user_id TEXT NOT NULL,
              version INTEGER NOT NULL, status TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, background TEXT NOT NULL,
              scene_key TEXT NOT NULL, priority INTEGER NOT NULL, confidence REAL NOT NULL, metadata TEXT NOT NULL,
              source_hash TEXT NOT NULL, supersedes_ids TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              last_confirmed_at INTEGER NOT NULL, content_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS atomic_memory_sources(memory_id TEXT, source_record_id TEXT,
              PRIMARY KEY(memory_id,source_record_id));
            CREATE TABLE IF NOT EXISTS work_scene_memories(scene_id TEXT PRIMARY KEY, team_id TEXT, agent_id TEXT, user_id TEXT,
              scenario_key TEXT, version INTEGER, status TEXT, content TEXT, summary TEXT, heat REAL, l1_ids TEXT,
              l1_high_watermark INTEGER, created_at INTEGER, updated_at INTEGER, content_hash TEXT, persona_update_request INTEGER);
            CREATE TABLE IF NOT EXISTS operating_doctrines(doctrine_id TEXT PRIMARY KEY, team_id TEXT, agent_id TEXT, user_id TEXT,
              version INTEGER, content TEXT, l2_ids TEXT, l2_high_watermark INTEGER, created_at INTEGER, updated_at INTEGER, content_hash TEXT);
            CREATE TABLE IF NOT EXISTS memory_jobs(job_id TEXT PRIMARY KEY, team_id TEXT, agent_id TEXT, user_id TEXT, stage TEXT,
              input_high_watermark INTEGER, status TEXT, not_before INTEGER, attempt INTEGER, created_at INTEGER, updated_at INTEGER,
              input_ids TEXT, input_hash TEXT, lease_id TEXT, lease_until INTEGER, error_class TEXT, output_hash TEXT,
              UNIQUE(team_id,agent_id,user_id,stage,input_high_watermark));
            CREATE TABLE IF NOT EXISTS memory_job_attempts(job_id TEXT, attempt INTEGER, created_at INTEGER, error_class TEXT,
              PRIMARY KEY(job_id,attempt));
            CREATE TABLE IF NOT EXISTS memory_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT, agent_id TEXT, user_id TEXT,
              created_at INTEGER, event TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS memory_stage_watermarks(team_id TEXT, agent_id TEXT, user_id TEXT, stage TEXT,
              watermark INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(team_id,agent_id,user_id,stage));
            CREATE TABLE IF NOT EXISTS memory_prompt_registry(mode TEXT NOT NULL, prompt_id TEXT NOT NULL, version INTEGER NOT NULL,
              created_at INTEGER NOT NULL, PRIMARY KEY(mode,prompt_id,version));
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(memory_id UNINDEXED, team_id UNINDEXED, agent_id UNINDEXED, user_id UNINDEXED, content);
            CREATE TABLE IF NOT EXISTS memory_embeddings(memory_id TEXT NOT NULL, model_id TEXT NOT NULL, content_hash TEXT NOT NULL,
              vector TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(memory_id,model_id));
            INSERT OR IGNORE INTO schema_migrations VALUES(1);
            CREATE INDEX IF NOT EXISTS atomic_memories_scope_active ON atomic_memories(team_id,agent_id,user_id,status,updated_at);
            CREATE INDEX IF NOT EXISTS memory_jobs_due ON memory_jobs(status,not_before,lease_until);
            CREATE INDEX IF NOT EXISTS memory_audit_scope_time ON memory_audit(team_id,agent_id,user_id,created_at);
            INSERT OR IGNORE INTO schema_migrations VALUES(2);
            """
        )
        columns = {row[1] for row in self._conn.execute("PRAGMA table_info(trace_archives)")}
        if "ancestor_item_ids" not in columns:
            self._conn.execute("ALTER TABLE trace_archives ADD COLUMN ancestor_item_ids TEXT NOT NULL DEFAULT '[]'")
        job_columns = {row[1] for row in self._conn.execute("PRAGMA table_info(memory_jobs)")}
        if "prompt_id" not in job_columns:
            self._conn.execute("ALTER TABLE memory_jobs ADD COLUMN prompt_id TEXT")
            self._conn.execute("ALTER TABLE memory_jobs ADD COLUMN prompt_version INTEGER")
        if "prompt_mode" not in job_columns:
            self._conn.execute("ALTER TABLE memory_jobs ADD COLUMN prompt_mode TEXT")
        if "input_hash" not in job_columns:
            self._conn.execute("ALTER TABLE memory_jobs ADD COLUMN input_hash TEXT")
        self._conn.execute("INSERT OR IGNORE INTO schema_migrations VALUES(3)")
        # v4 changes the meaning of the historical three-part storage key to
        # (repository_id, '', '').  Existing rows cannot be automatically
        # remapped because they contain no repository identity.
        self._conn.execute("INSERT OR IGNORE INTO schema_migrations VALUES(4)")
        # v5 makes code references stored in L1 metadata searchable. FTS is a
        # derived index, so rebuilding it is safe and keeps old databases equal
        # to newly written memories.
        if self._conn.execute("SELECT 1 FROM schema_migrations WHERE version=5").fetchone() is None:
            self._conn.execute("DELETE FROM memory_fts")
            self._conn.execute(
                "INSERT INTO memory_fts SELECT memory_id,team_id,agent_id,user_id,content || ' ' || metadata FROM atomic_memories WHERE status='active'"
            )
            self._conn.execute("INSERT INTO schema_migrations VALUES(5)")

    async def capture_archive(self, archive: SessionTraceArchive) -> tuple[SessionTraceArchive, bool]:
        sk = _scope(archive.scope)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT archive_id FROM trace_archives WHERE session_id=? AND operation_id=? AND tip_id IS ? AND source_entry_hash=?",
                (*archive.capture_key,),
            ).fetchone()
            if row:
                conn.execute("COMMIT")
                stored = await self._read_archive(str(row[0]))
                await self.audit(
                    archive.scope,
                    "capture_deduplicated",
                    {"archive_id": stored.archive_id, "operation_id": archive.operation_id},
                )
                return stored, False
            conn.execute("INSERT OR IGNORE INTO memory_scopes VALUES(?,?,?,?)", (*sk, archive.created_at))
            parent = conn.execute(
                """SELECT a.archive_id FROM trace_archives a LEFT JOIN trace_items i ON i.archive_id=a.archive_id
                WHERE a.team_id=? AND a.agent_id=? AND a.user_id=? GROUP BY a.archive_id
                ORDER BY COALESCE(MAX(i.store_seq), 0) DESC LIMIT 1""",
                sk,
            ).fetchone()
            ancestor_ids: tuple[str, ...] = ()
            if parent is not None:
                ancestor_rows = conn.execute(
                    "SELECT source_entry_id FROM trace_items WHERE archive_id=? ORDER BY store_seq DESC LIMIT 50",
                    (parent[0],),
                ).fetchall()
                ancestor_ids = tuple(str(row[0]) for row in reversed(ancestor_rows))
            max_seq = conn.execute(
                """SELECT COALESCE(MAX(i.store_seq), 0) FROM trace_items i
                JOIN trace_archives a ON a.archive_id = i.archive_id
                WHERE a.team_id=? AND a.agent_id=? AND a.user_id=?""",
                sk,
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO trace_archives(archive_id,team_id,agent_id,user_id,session_id,lane,operation_id,operation_kind,base_tip_id,tip_id,source_entry_hash,trace_format_version,created_at,content_hash,parent_archive_id,parent_gap,ancestor_item_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    archive.archive_id,
                    *sk,
                    archive.session_id,
                    archive.lane,
                    archive.operation_id,
                    archive.operation_kind,
                    archive.base_tip_id,
                    archive.tip_id,
                    archive.source_entry_hash,
                    archive.trace_format_version,
                    archive.created_at,
                    archive.content_hash,
                    str(parent[0]) if parent else None,
                    int(archive.parent_gap),
                    json.dumps(ancestor_ids),
                ),
            )
            items = []
            for offset, item in enumerate(archive.items, 1):
                seq = max_seq + offset
                items.append(
                    TraceItem(
                        item.source_entry_id,
                        item.source_seq,
                        item.timestamp,
                        item.type,
                        item.role,
                        item.content,
                        item.payload,
                        item.redacted_paths,
                        seq,
                    )
                )
                conn.execute(
                    "INSERT INTO trace_items VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        archive.archive_id,
                        item.source_entry_id,
                        item.source_seq,
                        item.timestamp,
                        item.type,
                        item.role,
                        item.content,
                        json.dumps(item.payload, sort_keys=True),
                        json.dumps(item.redacted_paths),
                        seq,
                    ),
                )
            conn.execute("COMMIT")
            stored = SessionTraceArchive(
                archive.archive_id,
                archive.scope,
                archive.session_id,
                archive.lane,
                archive.operation_id,
                archive.operation_kind,
                archive.base_tip_id,
                archive.tip_id,
                archive.source_entry_ids,
                archive.source_entry_hash,
                archive.trace_format_version,
                archive.created_at,
                archive.content_hash,
                tuple(items),
                str(parent[0]) if parent else None,
                ancestor_ids,
                archive.parent_gap,
                await self._read_ancestor_items(archive.scope, ancestor_ids),
            )
            await self.audit(
                archive.scope,
                "capture_stored",
                {
                    "archive_id": archive.archive_id,
                    "item_count": len(items),
                    "capture_latency_ms": max(0, self._now() - archive.created_at),
                },
            )
            return stored, True
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def find_archive(
        self, scope: MemoryScope, session_id: str, operation_id: str, tip_id: str | None, source_hash: str
    ) -> SessionTraceArchive | None:
        row = self._conn.execute(
            """SELECT archive_id FROM trace_archives WHERE team_id=? AND agent_id=? AND user_id=?
            AND session_id=? AND operation_id=? AND tip_id IS ? AND source_entry_hash=?""",
            (*_scope(scope), session_id, operation_id, tip_id, source_hash),
        ).fetchone()
        return await self._read_archive(str(row[0])) if row else None

    async def list_l0(
        self, scope: MemoryScope, after: tuple[int, str] | None, limit: int
    ) -> tuple[ArchiveSummary, ...]:
        """Archives of this repository, newest first, without their items."""
        sql = """SELECT a.*, (SELECT COUNT(*) FROM trace_items i WHERE i.archive_id=a.archive_id) AS item_count
            FROM trace_archives a WHERE a.team_id=? AND a.agent_id=? AND a.user_id=?"""
        params: list[object] = list(_scope(scope))
        if after is not None:
            sql += " AND (a.created_at<? OR (a.created_at=? AND a.archive_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY a.created_at DESC, a.archive_id DESC LIMIT ?"
        params.append(limit)
        return tuple(
            ArchiveSummary(
                row["archive_id"],
                MemoryScope(row["team_id"], row["agent_id"], row["user_id"] or None),
                row["session_id"],
                row["lane"],
                row["operation_id"],
                row["operation_kind"],
                row["tip_id"],
                row["trace_format_version"],
                row["created_at"],
                row["item_count"],
                row["parent_archive_id"],
            )
            for row in self._conn.execute(sql, params).fetchall()
        )

    async def read_archive(self, archive_id: str) -> SessionTraceArchive | None:
        """One archive with its captured items, or ``None`` if it is unknown."""
        try:
            return await self._read_archive(archive_id)
        except KeyError:
            return None

    async def _refresh_embeddings(self, scope: MemoryScope) -> None:
        """Refresh only the derived side index; failures intentionally leave it stale."""
        provider = self._embeddings
        if provider is None:
            return
        rows = self._conn.execute(
            """SELECT m.memory_id,m.content,m.content_hash FROM atomic_memories m
            LEFT JOIN memory_embeddings e ON e.memory_id=m.memory_id AND e.model_id=?
            WHERE m.team_id=? AND m.agent_id=? AND m.user_id=? AND m.status='active'
              AND (e.memory_id IS NULL OR e.content_hash<>m.content_hash)""",
            (provider.model_id, *_scope(scope)),
        ).fetchall()
        if not rows:
            return
        try:
            vectors = await provider.embed(tuple(str(row["content"]) for row in rows))
            if len(vectors) != len(rows) or any(not vector for vector in vectors):
                raise ValueError("embedding response shape")
            now = self._now()
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                for row, vector in zip(rows, vectors, strict=True):
                    self._conn.execute(
                        """INSERT INTO memory_embeddings(memory_id,model_id,content_hash,vector,updated_at) VALUES(?,?,?,?,?)
                        ON CONFLICT(memory_id,model_id) DO UPDATE SET content_hash=excluded.content_hash,
                        vector=excluded.vector,updated_at=excluded.updated_at""",
                        (row["memory_id"], provider.model_id, row["content_hash"], json.dumps(vector), now),
                    )
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        except Exception as error:
            await self.audit(scope, "embedding_index_degraded", {"reason": type(error).__name__})

    async def _read_archive(self, archive_id: str) -> SessionTraceArchive:
        row = self._conn.execute("SELECT * FROM trace_archives WHERE archive_id=?", (archive_id,)).fetchone()
        if row is None:
            raise KeyError(archive_id)
        items = self._conn.execute(
            "SELECT * FROM trace_items WHERE archive_id=? ORDER BY store_seq", (archive_id,)
        ).fetchall()
        scope = MemoryScope(row["team_id"], row["agent_id"], row["user_id"] or None)
        traces = tuple(
            TraceItem(
                i["source_entry_id"],
                i["source_seq"],
                i["timestamp"],
                i["type"],
                i["role"],
                i["content"],
                json.loads(i["payload"]),
                tuple(json.loads(i["redacted_paths"])),
                i["store_seq"],
            )
            for i in items
        )
        ancestor_ids = tuple(json.loads(row["ancestor_item_ids"]))
        return SessionTraceArchive(
            row["archive_id"],
            scope,
            row["session_id"],
            row["lane"],
            row["operation_id"],
            row["operation_kind"],
            row["base_tip_id"],
            row["tip_id"],
            tuple(i.source_entry_id for i in traces),
            row["source_entry_hash"],
            row["trace_format_version"],
            row["created_at"],
            row["content_hash"],
            traces,
            row["parent_archive_id"],
            ancestor_ids,
            bool(row["parent_gap"]),
            await self._read_ancestor_items(scope, ancestor_ids),
        )

    async def _read_ancestor_items(self, scope: MemoryScope, ids: tuple[str, ...]) -> tuple[TraceItem, ...]:
        """Resolve frozen ancestor IDs from L0 only; never fall back to Session."""
        if not ids:
            return ()
        rows = self._conn.execute(
            f"""SELECT i.* FROM trace_items i JOIN trace_archives a ON a.archive_id=i.archive_id
            WHERE i.source_entry_id IN ({",".join("?" for _ in ids)})
              AND a.team_id=? AND a.agent_id=? AND a.user_id=?""",
            (*ids, *_scope(scope)),
        ).fetchall()
        by_id = {
            str(item["source_entry_id"]): TraceItem(
                item["source_entry_id"],
                item["source_seq"],
                item["timestamp"],
                item["type"],
                item["role"],
                item["content"],
                json.loads(item["payload"]),
                tuple(json.loads(item["redacted_paths"])),
                item["store_seq"],
            )
            for item in rows
        }
        return tuple(by_id[item_id] for item_id in ids if item_id in by_id)

    async def create_or_wake_job(
        self,
        scope: MemoryScope,
        stage: str,
        watermark: int,
        not_before: int,
        prompt_id: str | None = None,
        prompt_version: int | None = None,
        prompt_mode: str | None = None,
        input_ids: tuple[str, ...] = (),
    ) -> PromotionJob:
        sk, now = _scope(scope), self._now()
        inserted = self._conn.execute(
            "INSERT OR IGNORE INTO memory_jobs(job_id,team_id,agent_id,user_id,stage,input_high_watermark,status,not_before,attempt,created_at,updated_at,input_ids,input_hash,prompt_id,prompt_version,prompt_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                self._ids(),
                *sk,
                stage,
                watermark,
                "queued" if not_before <= now else "scheduled",
                not_before,
                0,
                now,
                now,
                json.dumps(input_ids),
                content_hash("\0".join(input_ids)),
                prompt_id,
                prompt_version,
                prompt_mode,
            ),
        ).rowcount
        if not inserted:
            # A new signal may make a delayed/retry job due sooner.  Never disturb
            # a running lease or overwrite its frozen input set.
            self._conn.execute(
                """UPDATE memory_jobs SET not_before=MIN(not_before,?),
                status=CASE WHEN status IN ('scheduled','retry_wait') AND MIN(not_before,?)<=? THEN 'queued' ELSE status END,
                updated_at=? WHERE team_id=? AND agent_id=? AND user_id=? AND stage=? AND input_high_watermark=?
                AND status IN ('scheduled','queued','retry_wait')""",
                (not_before, not_before, now, now, *sk, stage, watermark),
            )
        row = self._conn.execute(
            "SELECT * FROM memory_jobs WHERE team_id=? AND agent_id=? AND user_id=? AND stage=? AND input_high_watermark=?",
            (*sk, stage, watermark),
        ).fetchone()
        return self._job(row)

    async def claim_job(self, now: int, lease_id: str, lease_ms: int) -> PromotionJob | None:
        row = self._conn.execute(
            "SELECT * FROM memory_jobs WHERE status IN ('scheduled','queued','retry_wait','running') AND not_before<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY not_before,created_at LIMIT 1",
            (now, now),
        ).fetchone()
        if row is None:
            return None
        changed = self._conn.execute(
            "UPDATE memory_jobs SET status='running', lease_id=?, lease_until=?, attempt=attempt+1, updated_at=? WHERE job_id=? AND (lease_until IS NULL OR lease_until<=?)",
            (lease_id, now + lease_ms, now, row["job_id"], now),
        ).rowcount
        if not changed:
            return None
        self._conn.execute(
            "INSERT OR REPLACE INTO memory_job_attempts VALUES(?,?,?,NULL)", (row["job_id"], row["attempt"] + 1, now)
        )
        return self._job(self._conn.execute("SELECT * FROM memory_jobs WHERE job_id=?", (row["job_id"],)).fetchone())

    async def complete_job(self, job_id: str, lease_id: str, output_hash: str | None = None) -> None:
        now = self._now()
        changed = self._conn.execute(
            "UPDATE memory_jobs SET status='completed', lease_id=NULL, lease_until=NULL, output_hash=?, updated_at=? WHERE job_id=? AND lease_id=?",
            (output_hash, now, job_id, lease_id),
        ).rowcount
        if not changed:
            raise RuntimeError("promotion lease lost")

    async def fail_job(self, job_id: str, lease_id: str, error_class: str, retry_at: int | None) -> None:
        now = self._now()
        status = "dead_letter" if retry_at is None else "retry_wait"
        changed = self._conn.execute(
            "UPDATE memory_jobs SET status=?, not_before=?, lease_id=NULL, lease_until=NULL,error_class=?,updated_at=? WHERE job_id=? AND lease_id=?",
            (status, retry_at or now, error_class, now, job_id, lease_id),
        ).rowcount
        if not changed:
            raise RuntimeError("promotion lease lost")
        attempt = self._conn.execute("SELECT attempt FROM memory_jobs WHERE job_id=?", (job_id,)).fetchone()
        if attempt is not None:
            self._conn.execute(
                "UPDATE memory_job_attempts SET error_class=? WHERE job_id=? AND attempt=?",
                (error_class, job_id, attempt[0]),
            )

    async def unconsumed_items(self, scope: MemoryScope, after_store_seq: int) -> tuple[SessionTraceArchive, ...]:
        rows = self._conn.execute(
            "SELECT DISTINCT archive_id FROM trace_archives a JOIN trace_items i USING(archive_id) WHERE a.team_id=? AND a.agent_id=? AND a.user_id=? AND i.store_seq>? ORDER BY i.store_seq",
            (*_scope(scope), after_store_seq),
        ).fetchall()
        return tuple([await self._read_archive(str(row[0])) for row in rows])

    async def current_l1_watermark(self, scope: MemoryScope) -> int:
        return await self.stage_watermark(scope, "l1")

    async def stage_watermark(self, scope: MemoryScope, stage: str) -> int:
        row = self._conn.execute(
            "SELECT watermark FROM memory_stage_watermarks WHERE team_id=? AND agent_id=? AND user_id=? AND stage=?",
            (*_scope(scope), stage),
        ).fetchone()
        return 0 if row is None else int(row[0])

    async def last_completed_at(self, scope: MemoryScope, stage: str) -> int | None:
        row = self._conn.execute(
            "SELECT MAX(updated_at) FROM memory_jobs WHERE team_id=? AND agent_id=? AND user_id=? AND stage=? AND status='completed'",
            (*_scope(scope), stage),
        ).fetchone()
        return None if row is None or row[0] is None else int(row[0])

    async def advance_watermark(self, scope: MemoryScope, stage: str, watermark: int) -> None:
        self._conn.execute(
            """INSERT INTO memory_stage_watermarks(team_id,agent_id,user_id,stage,watermark,updated_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,agent_id,user_id,stage)
            DO UPDATE SET watermark=MAX(watermark, excluded.watermark), updated_at=excluded.updated_at""",
            (*_scope(scope), stage, watermark, self._now()),
        )

    async def register_prompt(self, mode: str, prompt_id: str, version: int) -> None:
        if mode != "code":
            raise ValueError("unsupported prompt mode")
        self._conn.execute(
            "INSERT OR IGNORE INTO memory_prompt_registry(mode,prompt_id,version,created_at) VALUES(?,?,?,?)",
            (mode, prompt_id, version, self._now()),
        )

    async def read_l1_since(self, scope: MemoryScope, watermark: int) -> tuple[AtomicMemory, ...]:
        rows = self._conn.execute(
            "SELECT * FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='active' AND CAST(json_extract(metadata,'$.input_high_watermark') AS INTEGER)>? ORDER BY updated_at",
            (*_scope(scope), watermark),
        ).fetchall()
        return tuple(self._atomic_memory(scope, row) for row in rows)

    async def list_l1(
        self,
        scope: MemoryScope,
        status: str | None,
        after: tuple[int, str] | None,
        limit: int,
    ) -> tuple[AtomicMemory, ...]:
        """Atomic memories for the browse view, newest first.

        This is deliberately not a promotion read: it keeps every status, so a
        memory the pipeline superseded or rejected stays visible instead of
        disappearing from the UI along with the decision that removed it.
        """
        sql = "SELECT * FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=?"
        params: list[object] = list(_scope(scope))
        if status is not None:
            sql += " AND status=?"
            params.append(status)
        if after is not None:
            sql += " AND (updated_at<? OR (updated_at=? AND memory_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY updated_at DESC, memory_id DESC LIMIT ?"
        params.append(limit)
        return tuple(self._atomic_memory(scope, row) for row in self._conn.execute(sql, params).fetchall())

    def _atomic_memory(self, scope: MemoryScope, row: sqlite3.Row) -> AtomicMemory:
        return AtomicMemory(
            row["memory_id"],
            scope,
            row["version"],
            row["status"],
            row["type"],
            row["content"],
            row["background"],
            row["scene_key"],
            row["priority"],
            row["confidence"],
            json.loads(row["metadata"]),
            tuple(
                item[0]
                for item in self._conn.execute(
                    "SELECT source_record_id FROM atomic_memory_sources WHERE memory_id=?", (row["memory_id"],)
                )
            ),
            row["source_hash"],
            tuple(json.loads(row["supersedes_ids"])),
            row["created_at"],
            row["updated_at"],
            row["last_confirmed_at"],
            row["content_hash"],
        )

    async def apply_candidates(
        self, scope: MemoryScope, candidates: tuple[AtomicCandidate, ...], input_watermark: int
    ) -> None:
        now, sk = self._now(), _scope(scope)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            for candidate in candidates:
                validate_atomic_candidate(candidate)
                if candidate.decision == "no_op":
                    await self.audit(
                        scope,
                        "l1_no_op",
                        {"reason": candidate.decision_reason, "source_record_ids": candidate.source_record_ids},
                    )
                    continue
                candidate_hash = content_hash(candidate.content)
                duplicate = conn.execute(
                    "SELECT memory_id FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='active' AND type=? AND content_hash=?",
                    (*sk, candidate.type, candidate_hash),
                ).fetchone()
                if duplicate:
                    await self.audit(scope, "l1_no_op", {"memory_id": duplicate[0], "reason": "same content"})
                    continue
                same_scene = conn.execute(
                    "SELECT memory_id FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='active' AND scene_key=? AND type=?",
                    (*sk, candidate.scene_key, candidate.type),
                ).fetchall()
                inferred = tuple(str(r[0]) for r in same_scene)
                supersedes = candidate.supersedes_ids or inferred
                decision = candidate.decision
                if decision == "create" and supersedes:
                    decision = "merge" if len(supersedes) > 1 else "supersede"
                if supersedes:
                    visible = conn.execute(
                        f"SELECT memory_id FROM atomic_memories WHERE memory_id IN ({','.join('?' for _ in supersedes)}) AND team_id=? AND agent_id=? AND user_id=? AND status='active'",
                        (*supersedes, *sk),
                    ).fetchall()
                    if {str(row[0]) for row in visible} != set(supersedes):
                        raise ValueError("candidate supersedes inaccessible or inactive memory")
                memory_id = self._ids()
                metadata = {**candidate.metadata, "input_high_watermark": input_watermark}
                conn.execute(
                    "INSERT INTO atomic_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        memory_id,
                        *sk,
                        1,
                        "active",
                        candidate.type,
                        candidate.content,
                        candidate.background,
                        candidate.scene_key,
                        candidate.priority,
                        candidate.confidence,
                        json.dumps(metadata, sort_keys=True),
                        content_hash("|".join(candidate.source_record_ids)),
                        json.dumps(supersedes),
                        now,
                        now,
                        now,
                        candidate_hash,
                    ),
                )
                for source_id in candidate.source_record_ids:
                    conn.execute("INSERT INTO atomic_memory_sources VALUES(?,?)", (memory_id, source_id))
                for old in supersedes:
                    conn.execute(
                        "UPDATE atomic_memories SET status='superseded',updated_at=? WHERE memory_id=?", (now, old)
                    )
                conn.execute(
                    "INSERT INTO memory_fts VALUES(?,?,?,?,?)",
                    (memory_id, *sk, _indexable_memory_text(candidate.content, candidate.metadata)),
                )
                conn.execute(
                    "INSERT INTO memory_audit(team_id,agent_id,user_id,created_at,event,data) VALUES(?,?,?,?,?,?)",
                    (
                        *sk,
                        now,
                        "l1_" + decision,
                        json.dumps(
                            {
                                "memory_id": memory_id,
                                "supersedes_ids": supersedes,
                                "reason": candidate.decision_reason,
                            }
                        ),
                    ),
                )
            conn.execute(
                """INSERT INTO memory_stage_watermarks(team_id,agent_id,user_id,stage,watermark,updated_at)
                VALUES(?,?,?,?,?,?) ON CONFLICT(team_id,agent_id,user_id,stage)
                DO UPDATE SET watermark=MAX(watermark, excluded.watermark), updated_at=excluded.updated_at""",
                (*sk, "l1", input_watermark, now),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        await self._refresh_embeddings(scope)

    async def search(self, scope: MemoryScope, query: RecallQuery, budget: RecallBudget) -> RecallBundle:
        words, paths = _search_terms(query)
        rows = []
        fts_scores: dict[str, float] = {}
        fts_ranks: dict[str, int] = {}
        if words:
            expression = " OR ".join(f'"{word.replace(chr(34), "")}"' for word in words)
            try:
                ranked = self._conn.execute(
                    """SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts
                    JOIN atomic_memories m ON m.memory_id=memory_fts.memory_id
                    WHERE memory_fts MATCH ? AND m.team_id=? AND m.agent_id=? AND m.user_id=? AND m.status='active'""",
                    (expression, *_scope(scope)),
                ).fetchall()
                rows = ranked
                fts_scores = {str(row["memory_id"]): 1 / (1 + max(float(row["rank"]), 0)) for row in ranked}
                fts_ranks = {str(row["memory_id"]): index for index, row in enumerate(ranked, start=1)}
            except sqlite3.OperationalError:
                await self.audit(scope, "recall_fts_degraded", {"reason": "fts_error"})
        if not rows:
            rows = self._conn.execute(
                "SELECT * FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='active' ORDER BY last_confirmed_at DESC",
                _scope(scope),
            ).fetchall()
        all_rows = {str(row["memory_id"]): row for row in rows}
        vector_ranks: dict[str, int] = {}
        provider = self._embeddings
        if provider is not None and query.text.strip():
            try:
                query_vector = (await provider.embed((query.text,)))[0]
                candidates = self._conn.execute(
                    """SELECT m.*,e.vector FROM atomic_memories m JOIN memory_embeddings e ON e.memory_id=m.memory_id
                    WHERE m.team_id=? AND m.agent_id=? AND m.user_id=? AND m.status='active' AND e.model_id=?
                    AND e.content_hash=m.content_hash""",
                    (*_scope(scope), provider.model_id),
                ).fetchall()
                for row in candidates:
                    all_rows[str(row["memory_id"])] = row

                def cosine(row: sqlite3.Row) -> float:
                    vector = tuple(float(value) for value in json.loads(row["vector"]))
                    if len(vector) != len(query_vector):
                        return -1.0
                    numerator = sum(left * right for left, right in zip(query_vector, vector, strict=True))
                    left_norm = sum(left * left for left in query_vector) ** 0.5
                    right_norm = sum(right * right for right in vector) ** 0.5
                    return numerator / (left_norm * right_norm) if left_norm and right_norm else -1.0

                vector_ranks = {
                    str(row["memory_id"]): index
                    for index, row in enumerate(sorted(candidates, key=cosine, reverse=True), start=1)
                    if cosine(row) >= 0
                }
            except Exception as error:
                await self.audit(scope, "recall_embedding_degraded", {"reason": type(error).__name__})
        scored = []
        for memory_id, row in all_rows.items():
            haystack = f"{row['content']} {row['metadata']}".lower()
            keyword_score = sum(word in haystack for word in words) / max(len(words), 1)
            path_score = sum(path in haystack for path in paths) / max(len(paths), 1)
            # RRF keeps keyword and semantic rankings comparable without trusting either score scale.
            rrf = sum(60 / (60 + rank) for rank in (fts_ranks.get(memory_id), vector_ranks.get(memory_id)) if rank)
            score = max(keyword_score, path_score, fts_scores.get(memory_id, 0.0), rrf)
            if score >= budget.min_score:
                scored.append((score, row))
        scored.sort(key=lambda item: (item[0], item[1]["priority"], item[1]["last_confirmed_at"]), reverse=True)
        items: list[RecallItem] = []
        total = 0
        if budget.include_l3:
            doctrine = await self.read_l3(scope)
            if doctrine is not None and len(doctrine.content) <= budget.max_total_chars:
                items.append(
                    RecallItem(doctrine.doctrine_id, doctrine.version, "l3", doctrine.content, 1.0, doctrine.l2_ids)
                )
                total += len(doctrine.content)
        if budget.include_l2:
            scenes = await self.read_l2(scope)
            for scene in scenes:
                score = sum(word in scene.content.lower() for word in words) / max(len(words), 1)
                text = scene.content[: budget.max_item_chars]
                if score < budget.min_score or total + len(text) > budget.max_total_chars:
                    continue
                items.append(RecallItem(scene.scene_id, scene.version, "l2", text, float(score), scene.l1_ids))
                total += len(text)
        quotas = dict(budget.type_quotas)
        for score, row in scored:
            if sum(item.level == "l1" for item in items) >= budget.max_l1_items:
                break
            typ = row["type"]
            if typ in quotas and quotas[typ] <= 0:
                continue
            text = row["content"][: budget.max_item_chars]
            if total + len(text) > budget.max_total_chars:
                continue
            items.append(
                RecallItem(
                    row["memory_id"],
                    row["version"],
                    "l1",
                    text,
                    float(score),
                    tuple(
                        r[0]
                        for r in self._conn.execute(
                            "SELECT source_record_id FROM atomic_memory_sources WHERE memory_id=?", (row["memory_id"],)
                        )
                    ),
                )
            )
            total += len(text)
            quotas[typ] = quotas.get(typ, 999999) - 1
        if len(items) < budget.max_l1_items and total < budget.max_total_chars and words:
            clauses = " OR ".join("LOWER(i.content) LIKE ?" for _ in words)
            l0_rows = self._conn.execute(
                f"""SELECT a.archive_id, i.source_entry_id, i.content FROM trace_items i
                JOIN trace_archives a ON a.archive_id=i.archive_id
                WHERE a.team_id=? AND a.agent_id=? AND a.user_id=? AND i.content IS NOT NULL AND ({clauses})
                ORDER BY i.store_seq DESC""",
                (*_scope(scope), *(f"%{word}%" for word in words)),
            ).fetchall()
            for row in l0_rows:
                text = str(row["content"])[: budget.max_item_chars]
                if total + len(text) > budget.max_total_chars:
                    continue
                items.append(
                    RecallItem(
                        f"{row['archive_id']}:{row['source_entry_id']}", 1, "l0", text, 0.3, (row["source_entry_id"],)
                    )
                )
                total += len(text)
                if total >= budget.max_total_chars:
                    break
        digest = content_hash("".join(f"{item.id}:{item.version}:{item.content}" for item in items))
        return RecallBundle(tuple(items), digest, total)

    async def read_l2(self, scope: MemoryScope) -> tuple[WorkSceneMemory, ...]:
        """Current scenes by heat, which is the order recall reads them in."""
        rows = self._conn.execute(
            "SELECT * FROM work_scene_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='current' ORDER BY heat DESC",
            _scope(scope),
        ).fetchall()
        return tuple(self._scene(scope, row) for row in rows)

    async def list_l2(
        self, scope: MemoryScope, status: str | None, after: tuple[int, str] | None, limit: int
    ) -> tuple[WorkSceneMemory, ...]:
        """Scene memories for the browse view, newest first.

        ``read_l2`` answers "what is current right now" for recall; browsing
        also has to reach a scene the pipeline has since marked dormant.
        """
        sql = "SELECT * FROM work_scene_memories WHERE team_id=? AND agent_id=? AND user_id=?"
        params: list[object] = list(_scope(scope))
        if status is not None:
            sql += " AND status=?"
            params.append(status)
        if after is not None:
            sql += " AND (updated_at<? OR (updated_at=? AND scene_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY updated_at DESC, scene_id DESC LIMIT ?"
        params.append(limit)
        return tuple(self._scene(scope, row) for row in self._conn.execute(sql, params).fetchall())

    def _scene(self, scope: MemoryScope, row: sqlite3.Row) -> WorkSceneMemory:
        return WorkSceneMemory(
            row["scene_id"],
            scope,
            row["scenario_key"],
            row["version"],
            row["status"],
            row["content"],
            row["summary"],
            row["heat"],
            tuple(json.loads(row["l1_ids"])),
            row["l1_high_watermark"],
            row["created_at"],
            row["updated_at"],
            row["content_hash"],
            bool(row["persona_update_request"]),
        )

    async def read_all_l2(self):
        """Current L2 scenes from every repository, for global L3 synthesis."""
        rows = self._conn.execute(
            "SELECT * FROM work_scene_memories WHERE status='current' ORDER BY updated_at DESC"
        ).fetchall()
        return tuple(
            self._scene(MemoryScope(row["team_id"], row["agent_id"], row["user_id"] or None), row) for row in rows
        )

    async def read_l3(self, scope: MemoryScope):
        row = self._conn.execute(
            "SELECT * FROM operating_doctrines WHERE team_id=? AND agent_id=? AND user_id=? ORDER BY version DESC LIMIT 1",
            _scope(GLOBAL_L3_SCOPE),
        ).fetchone()
        if row is None:
            return None
        from agent_harness.domain.memory import OperatingDoctrine

        return OperatingDoctrine(
            row["doctrine_id"],
            GLOBAL_L3_SCOPE,
            row["version"],
            row["content"],
            tuple(json.loads(row["l2_ids"])),
            row["l2_high_watermark"],
            row["created_at"],
            row["updated_at"],
            row["content_hash"],
        )

    async def write_scene(self, scope: MemoryScope, candidate: SceneCandidate, max_scenes: int = 20) -> None:
        validate_scene_content(candidate.content)
        now, sk = self._now(), _scope(scope)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            self._write_scene_in_transaction(scope, candidate, max_scenes, now, sk)
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    def _write_scene_in_transaction(
        self, scope: MemoryScope, candidate: SceneCandidate, max_scenes: int, now: int, sk: tuple[str, str, str]
    ) -> None:
        """Apply all L2 visibility changes atomically; caller owns the transaction."""
        if candidate.merge_scene_ids:
            placeholders = ",".join("?" for _ in candidate.merge_scene_ids)
            visible = self._conn.execute(
                f"SELECT scene_id FROM work_scene_memories WHERE scene_id IN ({placeholders}) AND team_id=? AND agent_id=? AND user_id=? AND status='current'",
                (*candidate.merge_scene_ids, *sk),
            ).fetchall()
            if {str(row[0]) for row in visible} != set(candidate.merge_scene_ids):
                raise PromotionConflict("merged scene is unavailable in this scope")
        current = self._conn.execute(
            "SELECT * FROM work_scene_memories WHERE team_id=? AND agent_id=? AND user_id=? AND scenario_key=? AND status='current'",
            (*sk, candidate.scenario_key),
        ).fetchone()
        if current is not None:
            if candidate.expected_version is None or current["version"] != candidate.expected_version:
                raise PromotionConflict("scene version changed")
            self._conn.execute(
                "UPDATE work_scene_memories SET version=?,content=?,summary=?,heat=heat+1,l1_ids=?,l1_high_watermark=?,updated_at=?,content_hash=?,persona_update_request=? WHERE scene_id=?",
                (
                    current["version"] + 1,
                    candidate.content,
                    candidate.summary,
                    json.dumps(candidate.l1_ids),
                    candidate.l1_high_watermark,
                    now,
                    content_hash(candidate.content),
                    int(candidate.persona_update_request),
                    current["scene_id"],
                ),
            )
            event = "l2_update"
        else:
            count = self._conn.execute(
                "SELECT COUNT(*) FROM work_scene_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='current'",
                sk,
            ).fetchone()[0]
            if count + 1 >= (max_scenes * 4 + 4) // 5:
                self._audit_in_transaction(
                    scope,
                    "l2_capacity_warning",
                    {
                        "count": count + 1,
                        "max_scenes": max_scenes,
                        "level": "full" if count + 1 >= max_scenes else "80_percent",
                    },
                    now,
                )
            if count >= max_scenes:
                evict = self._conn.execute(
                    "SELECT scene_id FROM work_scene_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='current' ORDER BY heat,updated_at LIMIT 1",
                    sk,
                ).fetchone()
                self._conn.execute(
                    "UPDATE work_scene_memories SET status='dormant',updated_at=? WHERE scene_id=?", (now, evict[0])
                )
                self._audit_in_transaction(
                    scope, "l2_capacity_evicted", {"scene_id": evict[0], "max_scenes": max_scenes}, now
                )
            scene_id = self._ids()
            self._conn.execute(
                "INSERT INTO work_scene_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    scene_id,
                    *sk,
                    candidate.scenario_key,
                    1,
                    "current",
                    candidate.content,
                    candidate.summary,
                    1.0,
                    json.dumps(candidate.l1_ids),
                    candidate.l1_high_watermark,
                    now,
                    now,
                    content_hash(candidate.content),
                    int(candidate.persona_update_request),
                ),
            )
            event = "l2_create"
        for scene_id in candidate.merge_scene_ids:
            changed = self._conn.execute(
                "UPDATE work_scene_memories SET status='dormant',updated_at=? WHERE scene_id=? AND team_id=? AND agent_id=? AND user_id=? AND status='current'",
                (now, scene_id, *sk),
            ).rowcount
            if not changed:
                raise PromotionConflict("merged scene is unavailable in this scope")
        self._audit_in_transaction(
            scope, event, {"scenario_key": candidate.scenario_key, "merged": candidate.merge_scene_ids}, now
        )

    async def write_doctrine(self, scope: MemoryScope, candidate: DoctrineCandidate) -> None:
        validate_doctrine_content(candidate.content)
        now, sk = self._now(), _scope(GLOBAL_L3_SCOPE)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = conn.execute(
                "SELECT version FROM operating_doctrines WHERE team_id=? AND agent_id=? AND user_id=? ORDER BY version DESC LIMIT 1",
                sk,
            ).fetchone()
            if current is not None and (
                candidate.expected_version is None or current["version"] != candidate.expected_version
            ):
                raise PromotionConflict("doctrine version changed")
            version = 1 if current is None else int(current["version"]) + 1
            conn.execute(
                "INSERT INTO operating_doctrines VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    self._ids(),
                    *sk,
                    version,
                    candidate.content,
                    json.dumps(candidate.l2_ids),
                    candidate.l2_high_watermark,
                    now,
                    now,
                    content_hash(candidate.content),
                ),
            )
            self._audit_in_transaction(
                GLOBAL_L3_SCOPE, "l3_update", {"version": version, "l2_ids": candidate.l2_ids}, now
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def replay_dead_letter(self, scope: MemoryScope, job_id: str) -> None:
        changed = self._conn.execute(
            "UPDATE memory_jobs SET status='queued',not_before=?,error_class=NULL WHERE job_id=? AND team_id=? AND agent_id=? AND user_id=? AND status='dead_letter'",
            (self._now(), job_id, *_scope(scope)),
        ).rowcount
        if not changed:
            raise KeyError(job_id)
        await self.audit(scope, "job_replayed", {"job_id": job_id})

    async def delete_scope(self, scope: MemoryScope) -> None:
        """Explicit scope deletion is the only cascading destructive asset operation."""
        sk = _scope(scope)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            archives = [
                row[0]
                for row in conn.execute(
                    "SELECT archive_id FROM trace_archives WHERE team_id=? AND agent_id=? AND user_id=?", sk
                )
            ]
            for archive_id in archives:
                conn.execute("DELETE FROM trace_items WHERE archive_id=?", (archive_id,))
            job_ids = [
                row[0]
                for row in conn.execute(
                    "SELECT job_id FROM memory_jobs WHERE team_id=? AND agent_id=? AND user_id=?", sk
                )
            ]
            for job_id in job_ids:
                conn.execute("DELETE FROM memory_job_attempts WHERE job_id=?", (job_id,))
            conn.execute(
                "DELETE FROM atomic_memory_sources WHERE memory_id IN (SELECT memory_id FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=?)",
                sk,
            )
            for table in (
                "trace_archives",
                "atomic_memories",
                "work_scene_memories",
                "operating_doctrines",
                "memory_jobs",
                "memory_audit",
                "memory_stage_watermarks",
                "memory_scopes",
            ):
                conn.execute(f"DELETE FROM {table} WHERE team_id=? AND agent_id=? AND user_id=?", sk)
            conn.execute("DELETE FROM memory_fts WHERE team_id=? AND agent_id=? AND user_id=?", sk)
            conn.execute("DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT memory_id FROM atomic_memories)")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def rebuild_indexes(self, scope: MemoryScope) -> None:
        """Recreate derived search indexes from authoritative L1 rows only."""
        sk, conn = _scope(scope), self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute("DELETE FROM memory_fts WHERE team_id=? AND agent_id=? AND user_id=?", sk)
            rows = conn.execute(
                "SELECT memory_id,content,metadata FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=? AND status='active'",
                sk,
            ).fetchall()
            for row in rows:
                conn.execute(
                    "INSERT INTO memory_fts VALUES(?,?,?,?,?)",
                    (row["memory_id"], *sk, _indexable_memory_text(row["content"], json.loads(row["metadata"]))),
                )
            conn.execute(
                "DELETE FROM memory_embeddings WHERE memory_id IN (SELECT memory_id FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=?)",
                sk,
            )
            self._audit_in_transaction(scope, "indexes_rebuilt", {"l1_count": len(rows)}, self._now())
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        await self._refresh_embeddings(scope)

    async def gc(
        self, scope: MemoryScope, *, l0_before: int, l1_before: int, l2_before: int, audit_before: int
    ) -> dict[str, object]:
        """Conservative, auditable retention sweep; L3 is intentionally never collected."""
        sk = _scope(scope)
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            l0_ids = [
                row[0]
                for row in conn.execute(
                    """SELECT archive_id FROM trace_archives WHERE team_id=? AND agent_id=? AND user_id=? AND created_at<?
                    AND archive_id NOT IN (SELECT archive_id FROM trace_items WHERE store_seq>(SELECT COALESCE(watermark,0)
                        FROM memory_stage_watermarks WHERE team_id=? AND agent_id=? AND user_id=? AND stage='l1'))""",
                    (*sk, l0_before, *sk),
                )
            ]
            for archive_id in l0_ids:
                # The child retains its frozen ancestor IDs, but records the retention gap rather
                # than attempting an unsafe reconstruction from the mutable Session tree.
                conn.execute("UPDATE trace_archives SET parent_gap=1 WHERE parent_archive_id=?", (archive_id,))
                conn.execute("DELETE FROM trace_items WHERE archive_id=?", (archive_id,))
                conn.execute("DELETE FROM trace_archives WHERE archive_id=?", (archive_id,))
            l1_ids = [
                row[0]
                for row in conn.execute(
                    """SELECT memory_id FROM atomic_memories AS m WHERE team_id=? AND agent_id=? AND user_id=?
                    AND status='superseded' AND updated_at<?
                    AND NOT EXISTS (SELECT 1 FROM work_scene_memories s WHERE s.team_id=m.team_id
                      AND s.agent_id=m.agent_id AND s.user_id=m.user_id AND s.status='current'
                      AND instr(s.l1_ids, m.memory_id)>0)
                    AND NOT EXISTS (SELECT 1 FROM atomic_memories child WHERE child.team_id=m.team_id
                      AND child.agent_id=m.agent_id AND child.user_id=m.user_id
                      AND instr(child.supersedes_ids, m.memory_id)>0)""",
                    (*sk, l1_before),
                )
            ]
            for memory_id in l1_ids:
                conn.execute("DELETE FROM atomic_memory_sources WHERE memory_id=?", (memory_id,))
                conn.execute("DELETE FROM memory_fts WHERE memory_id=?", (memory_id,))
                conn.execute("DELETE FROM memory_embeddings WHERE memory_id=?", (memory_id,))
                conn.execute("DELETE FROM atomic_memories WHERE memory_id=?", (memory_id,))
            l2_ids = [
                row[0]
                for row in conn.execute(
                    """SELECT scene_id FROM work_scene_memories AS s WHERE team_id=? AND agent_id=? AND user_id=?
                    AND status='dormant' AND updated_at<? AND NOT EXISTS (
                      SELECT 1 FROM operating_doctrines d WHERE instr(d.l2_ids, s.scene_id)>0)""",
                    (*sk, l2_before),
                )
            ]
            for scene_id in l2_ids:
                conn.execute("DELETE FROM work_scene_memories WHERE scene_id=?", (scene_id,))
            # Audit rows carry asset identifiers in their payload.  Until the scope has
            # no retained assets, preserve them conservatively rather than risk breaking
            # an audit chain by deleting a row whose referenced object still exists.
            retained_assets = conn.execute(
                """SELECT EXISTS(
                SELECT 1 FROM trace_archives WHERE team_id=? AND agent_id=? AND user_id=?
                UNION ALL SELECT 1 FROM atomic_memories WHERE team_id=? AND agent_id=? AND user_id=?
                UNION ALL SELECT 1 FROM work_scene_memories WHERE team_id=? AND agent_id=? AND user_id=?
                UNION ALL SELECT 1 FROM operating_doctrines WHERE team_id=? AND agent_id=? AND user_id=?
                UNION ALL SELECT 1 FROM memory_jobs WHERE team_id=? AND agent_id=? AND user_id=?)""",
                (*sk, *sk, *sk, *sk, *sk),
            ).fetchone()[0]
            audit = 0
            if not retained_assets:
                audit = conn.execute(
                    "DELETE FROM memory_audit WHERE team_id=? AND agent_id=? AND user_id=? AND created_at<?",
                    (*sk, audit_before),
                ).rowcount
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        l0, l1, l2 = len(l0_ids), len(l1_ids), len(l2_ids)
        counts: dict[str, object] = {"l0": l0, "l1": l1, "l2": l2, "audit": audit}
        await self.audit(scope, "gc", counts)
        return counts

    async def audit(self, scope: MemoryScope, event: str, data: dict[str, object]) -> None:
        self._audit_in_transaction(scope, event, data, self._now())

    def _audit_in_transaction(self, scope: MemoryScope, event: str, data: dict[str, object], created_at: int) -> None:
        """Record an audit row without committing a transaction owned by the caller."""
        self._conn.execute(
            "INSERT INTO memory_audit(team_id,agent_id,user_id,created_at,event,data) VALUES(?,?,?,?,?,?)",
            (*_scope(scope), created_at, event, json.dumps(data, sort_keys=True)),
        )

    def _job(self, row: sqlite3.Row) -> PromotionJob:
        return PromotionJob(
            row["job_id"],
            MemoryScope(row["team_id"], row["agent_id"], row["user_id"] or None),
            row["stage"],
            row["input_high_watermark"],
            row["status"],
            row["not_before"],
            row["attempt"],
            row["created_at"],
            row["updated_at"],
            tuple(json.loads(row["input_ids"])),
            row["lease_id"],
            row["lease_until"],
            row["error_class"],
            row["output_hash"],
            row["prompt_id"],
            row["prompt_version"],
            row["prompt_mode"],
            row["input_hash"],
        )

    async def list_jobs(
        self, scope: MemoryScope, status: str | None, after: tuple[int, str] | None, limit: int
    ) -> tuple[PromotionJob, ...]:
        """Promotion jobs of this repository, newest first.

        ``claim_job`` is a worker taking work; this is the pipeline's status
        board, so it reports every job in every state rather than the due ones.
        """
        sql = "SELECT * FROM memory_jobs WHERE team_id=? AND agent_id=? AND user_id=?"
        params: list[object] = list(_scope(scope))
        if status is not None:
            sql += " AND status=?"
            params.append(status)
        if after is not None:
            sql += " AND (created_at<? OR (created_at=? AND job_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY created_at DESC, job_id DESC LIMIT ?"
        params.append(limit)
        return tuple(self._job(row) for row in self._conn.execute(sql, params).fetchall())

    async def list_audit(
        self, scope: MemoryScope, after: tuple[int] | None, limit: int
    ) -> tuple[MemoryAuditRecord, ...]:
        """Audit rows of this repository, newest first, keyed by insertion order."""
        sql = "SELECT * FROM memory_audit WHERE team_id=? AND agent_id=? AND user_id=?"
        params: list[object] = list(_scope(scope))
        if after is not None:
            sql += " AND id<?"
            params.append(after[0])
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return tuple(
            MemoryAuditRecord(row["id"], scope, row["created_at"], row["event"], json.loads(row["data"]))
            for row in self._conn.execute(sql, params).fetchall()
        )

    def close(self) -> None:
        self._conn.close()
