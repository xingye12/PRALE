"""SQLite authority store for immutable, owner-private Skill versions."""
# ruff: noqa

import json
import re
import sqlite3
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from agent_harness.domain.skill import (
    SkillArchive,
    SkillArchiveSummary,
    SkillAsset,
    SkillAuditRecord,
    SkillExtractionJob,
    SkillFile,
    SkillListing,
    SkillLoadout,
    SkillProposal,
    SkillScope,
    SkillVersion,
    VersionConflict,
    is_successful_tool_result,
    skill_content_hash,
    validate_skill_proposal,
)

_FRONTMATTER_VERSION = re.compile(r"(?m)^version:\s*(\d+)\s*$")


def _now() -> int:
    return time.time_ns() // 1_000_000


class SQLiteSkillStore:
    def __init__(
        self, path: str | Path, *, id_factory: Callable[[], str] | None = None, now_ms: Callable[[], int] | None = None
    ) -> None:
        self._conn = sqlite3.connect(str(path), isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._ids, self._now = id_factory or (lambda: str(uuid.uuid4())), now_ms or _now
        self._migrate()

    def close(self) -> None:
        """Release the connection; a store the deployment opened, it also closes."""

        self._conn.close()

    def _migrate(self) -> None:
        self._conn.executescript("""
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS skills(skill_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT NOT NULL, triggers TEXT NOT NULL, tags TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility='private'),
          state TEXT NOT NULL CHECK(state IN ('active','disabled','archived')), current_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS skill_versions(skill_id TEXT NOT NULL REFERENCES skills(skill_id), version INTEGER NOT NULL,
          markdown TEXT NOT NULL, manifest TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY(skill_id,version));
        CREATE TABLE IF NOT EXISTS skill_files(skill_id TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL,
          content BLOB NOT NULL, mime_type TEXT NOT NULL, content_hash TEXT NOT NULL,
          PRIMARY KEY(skill_id,version,path), FOREIGN KEY(skill_id,version) REFERENCES skill_versions(skill_id,version));
        CREATE TABLE IF NOT EXISTS skill_archives(archive_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, session_id TEXT NOT NULL,
          source_archive_id TEXT NOT NULL, payload_hash TEXT NOT NULL, reason TEXT NOT NULL, trace_format_version TEXT NOT NULL,
          payload TEXT NOT NULL, bytes_count INTEGER NOT NULL, successful_tool_calls INTEGER NOT NULL, turn_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL, UNIQUE(repository_id,source_archive_id,payload_hash));
        CREATE TABLE IF NOT EXISTS skill_buffers(repository_id TEXT NOT NULL, session_id TEXT NOT NULL, payload TEXT NOT NULL,
          bytes_count INTEGER NOT NULL, successful_tool_calls INTEGER NOT NULL, turn_count INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(repository_id,session_id));
        CREATE TABLE IF NOT EXISTS skill_extraction_jobs(job_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, archive_id TEXT NOT NULL
          REFERENCES skill_archives(archive_id), status TEXT NOT NULL, not_before INTEGER NOT NULL, attempt INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_id TEXT, lease_until INTEGER, prompt_id TEXT,
          prompt_version INTEGER, candidate_skill_ids TEXT NOT NULL, output_hash TEXT, error_class TEXT,
          UNIQUE(repository_id,archive_id));
        CREATE TABLE IF NOT EXISTS skill_candidates(job_id TEXT NOT NULL, skill_id TEXT NOT NULL, version INTEGER NOT NULL,
          score REAL NOT NULL, PRIMARY KEY(job_id,skill_id,version));
        CREATE TABLE IF NOT EXISTS skill_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS skill_fts USING fts5(skill_id UNINDEXED, repository_id UNINDEXED, name, description, triggers);
        CREATE INDEX IF NOT EXISTS skill_jobs_due ON skill_extraction_jobs(status,not_before,lease_until);
        CREATE INDEX IF NOT EXISTS skill_scope_active ON skills(repository_id,state,updated_at);
        INSERT OR IGNORE INTO schema_migrations VALUES(1);
        """)

    async def append_archive(self, archive: SkillArchive) -> tuple[SkillArchive, bool]:
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT archive_id FROM skill_archives WHERE repository_id=? AND source_archive_id=? AND payload_hash=?",
                (archive.scope.storage_key, archive.source_archive_id, archive.payload_hash),
            ).fetchone()
            if row:
                conn.execute("COMMIT")
                stored = await self.get_archive(str(row[0]))
                if stored is None:
                    raise RuntimeError("skill archive disappeared during deduplication")
                return stored, False
            payload = json.dumps(_archive_data(archive), sort_keys=True)
            conn.execute(
                "INSERT INTO skill_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    archive.archive_id,
                    archive.scope.storage_key,
                    archive.session_id,
                    archive.source_archive_id,
                    archive.payload_hash,
                    archive.reason,
                    archive.trace_format_version,
                    payload,
                    archive.bytes_count,
                    archive.successful_tool_calls,
                    archive.turn_count,
                    archive.created_at,
                ),
            )
            conn.execute("COMMIT")
            return archive, True
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def archive_for_source(
        self, scope: SkillScope, source_archive_id: str, payload_hash: str
    ) -> SkillArchive | None:
        row = self._conn.execute(
            "SELECT archive_id FROM skill_archives WHERE repository_id=? AND source_archive_id=? AND payload_hash=?",
            (scope.storage_key, source_archive_id, payload_hash),
        ).fetchone()
        return await self.get_archive(str(row[0])) if row else None

    async def buffer_source(
        self, scope: SkillScope, source, *, tool_threshold: int, byte_threshold: int, max_bytes: int
    ) -> SkillArchive | None:
        """Atomically append one L0 source to a session buffer and seal at a reproducible threshold."""
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT * FROM skill_buffers WHERE repository_id=? AND session_id=?",
                (scope.storage_key, source.session_id),
            ).fetchone()
            archives = (
                () if row is None else tuple(_trace_archive(item) for item in json.loads(row["payload"])["archives"])
            )
            if any(item.archive_id == source.archive_id for item in archives):
                conn.execute("COMMIT")
                return None
            archives = (*archives, source)
            items = tuple(item for archive in archives for item in archive.items)
            bytes_count = sum(len((item.content or "").encode()) for item in items)
            calls = sum(is_successful_tool_result(item) for item in items)
            turns = sum(item.role == "user" for item in items)
            data = _archive_data(
                SkillArchive(
                    "",
                    scope,
                    source.session_id,
                    source.archive_id,
                    "",
                    "forced",
                    source.trace_format_version,
                    archives,
                    0,
                    0,
                    0,
                    0,
                )
            )
            if bytes_count < byte_threshold and calls < tool_threshold and bytes_count <= max_bytes:
                conn.execute(
                    "INSERT INTO skill_buffers VALUES(?,?,?,?,?,?,?) ON CONFLICT(repository_id,session_id) DO UPDATE SET payload=excluded.payload,bytes_count=excluded.bytes_count,successful_tool_calls=excluded.successful_tool_calls,turn_count=excluded.turn_count,updated_at=excluded.updated_at",
                    (
                        scope.storage_key,
                        source.session_id,
                        json.dumps(data, sort_keys=True),
                        bytes_count,
                        calls,
                        turns,
                        self._now(),
                    ),
                )
                conn.execute("COMMIT")
                return None
            reason = cast(
                Any, "oversize" if bytes_count > max_bytes else "tool_calls" if calls >= tool_threshold else "bytes"
            )
            digest = skill_content_hash("".join(item.content or "" for item in items), ())
            result = SkillArchive(
                "skarc-" + self._ids(),
                scope,
                source.session_id,
                source.archive_id,
                digest,
                reason,
                source.trace_format_version,
                archives,
                bytes_count,
                calls,
                turns,
                self._now(),
            )
            payload = json.dumps(_archive_data(result), sort_keys=True)
            conn.execute(
                "INSERT OR IGNORE INTO skill_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    result.archive_id,
                    scope.storage_key,
                    result.session_id,
                    result.source_archive_id,
                    result.payload_hash,
                    result.reason,
                    result.trace_format_version,
                    payload,
                    result.bytes_count,
                    result.successful_tool_calls,
                    result.turn_count,
                    result.created_at,
                ),
            )
            conn.execute(
                "DELETE FROM skill_buffers WHERE repository_id=? AND session_id=?",
                (scope.storage_key, source.session_id),
            )
            conn.execute("COMMIT")
            return result
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def seal_buffer(self, scope: SkillScope, session_id: str, reason: str) -> SkillArchive | None:
        """Seal a low-volume buffer for an explicit lifecycle event without deleting history."""
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT * FROM skill_buffers WHERE repository_id=? AND session_id=?",
                (scope.storage_key, session_id),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return None
            archives = tuple(_trace_archive(item) for item in json.loads(row["payload"])["archives"])
            if not archives:
                conn.execute(
                    "DELETE FROM skill_buffers WHERE repository_id=? AND session_id=?", (scope.storage_key, session_id)
                )
                conn.execute("COMMIT")
                return None
            items = tuple(item for archive in archives for item in archive.items)
            payload_hash = skill_content_hash("".join(item.content or "" for item in items), ())
            result = SkillArchive(
                "skarc-" + self._ids(),
                scope,
                session_id,
                archives[-1].archive_id,
                payload_hash,
                cast(Any, reason),
                archives[-1].trace_format_version,
                archives,
                int(row["bytes_count"]),
                int(row["successful_tool_calls"]),
                int(row["turn_count"]),
                self._now(),
            )
            existing = conn.execute(
                "SELECT archive_id FROM skill_archives WHERE repository_id=? AND source_archive_id=? AND payload_hash=?",
                (scope.storage_key, result.source_archive_id, result.payload_hash),
            ).fetchone()
            if existing:
                result_id = str(existing[0])
            else:
                conn.execute(
                    "INSERT INTO skill_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        result.archive_id,
                        scope.storage_key,
                        result.session_id,
                        result.source_archive_id,
                        result.payload_hash,
                        result.reason,
                        result.trace_format_version,
                        json.dumps(_archive_data(result), sort_keys=True),
                        result.bytes_count,
                        result.successful_tool_calls,
                        result.turn_count,
                        result.created_at,
                    ),
                )
                result_id = result.archive_id
            conn.execute(
                "DELETE FROM skill_buffers WHERE repository_id=? AND session_id=?", (scope.storage_key, session_id)
            )
            conn.execute("COMMIT")
            return await self.get_archive(result_id)
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def create_job(
        self, archive: SkillArchive, not_before: int, prompt_id: str | None = None, prompt_version: int | None = None
    ) -> SkillExtractionJob:
        now = self._now()
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT * FROM skill_extraction_jobs WHERE repository_id=? AND archive_id=?",
                (archive.scope.storage_key, archive.archive_id),
            ).fetchone()
            if row is None:
                job = SkillExtractionJob(
                    self._ids(),
                    archive.scope,
                    archive.archive_id,
                    "scheduled",
                    not_before,
                    0,
                    now,
                    now,
                    prompt_id=prompt_id,
                    prompt_version=prompt_version,
                )
                conn.execute(
                    "INSERT INTO skill_extraction_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", _job_values(job)
                )
            else:
                job = _job(row)
            conn.execute("COMMIT")
            return job
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def record_candidates(self, job_id: str, candidates: tuple[SkillListing, ...]) -> None:
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                "SELECT candidate_skill_ids FROM skill_extraction_jobs WHERE job_id=?", (job_id,)
            ).fetchone()
            if row is None:
                raise KeyError(job_id)
            conn.execute("DELETE FROM skill_candidates WHERE job_id=?", (job_id,))
            for position, candidate in enumerate(candidates):
                conn.execute(
                    "INSERT INTO skill_candidates(job_id,skill_id,version,score) VALUES(?,?,?,?)",
                    (job_id, candidate.skill_id, candidate.version, float(-position)),
                )
            conn.execute(
                "UPDATE skill_extraction_jobs SET candidate_skill_ids=? WHERE job_id=?",
                (json.dumps(tuple(candidate.skill_id for candidate in candidates)), job_id),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def claim_job(self, now: int, lease_id: str, lease_ms: int) -> SkillExtractionJob | None:
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute(
                """SELECT * FROM skill_extraction_jobs WHERE status IN ('scheduled','queued','retry_wait','running')
              AND not_before<=? AND (status!='running' OR lease_until<?) ORDER BY not_before,created_at LIMIT 1""",
                (now, now),
            ).fetchone()
            if row is None:
                conn.execute("COMMIT")
                return None
            job = _job(row)
            # serialise every owner, even when different archives are due.
            busy = conn.execute(
                "SELECT 1 FROM skill_extraction_jobs WHERE repository_id=? AND status='running' AND lease_until>=? AND job_id!=?",
                (job.scope.storage_key, now, job.job_id),
            ).fetchone()
            if busy:
                conn.execute("COMMIT")
                return None
            conn.execute(
                "UPDATE skill_extraction_jobs SET status='running',attempt=?,updated_at=?,lease_id=?,lease_until=? WHERE job_id=?",
                (job.attempt + 1, now, lease_id, now + lease_ms, job.job_id),
            )
            row = conn.execute("SELECT * FROM skill_extraction_jobs WHERE job_id=?", (job.job_id,)).fetchone()
            conn.execute("COMMIT")
            return _job(row)
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def complete_job(self, job_id: str, lease_id: str, output_hash: str | None = None) -> None:
        now = self._now()
        cursor = self._conn.execute(
            "UPDATE skill_extraction_jobs SET status='completed',updated_at=?,output_hash=?,lease_id=NULL,lease_until=NULL WHERE job_id=? AND lease_id=?",
            (now, output_hash, job_id, lease_id),
        )
        if not cursor.rowcount:
            raise RuntimeError("skill job lease lost")

    async def fail_job(self, job_id: str, lease_id: str, error_class: str, retry_at: int | None) -> None:
        now = self._now()
        status = "dead_letter" if retry_at is None else "retry_wait"
        cursor = self._conn.execute(
            "UPDATE skill_extraction_jobs SET status=?,not_before=?,updated_at=?,error_class=?,lease_id=NULL,lease_until=NULL WHERE job_id=? AND lease_id=?",
            (status, retry_at or now, now, error_class, job_id, lease_id),
        )
        if not cursor.rowcount:
            raise RuntimeError("skill job lease lost")

    async def get_archive(self, archive_id: str) -> SkillArchive | None:
        row = self._conn.execute("SELECT * FROM skill_archives WHERE archive_id=?", (archive_id,)).fetchone()
        if not row:
            return None
        data = json.loads(row["payload"])
        # Archive content is only ever supplied to the reviewer; reconstructing raw SessionTraceArchive is unnecessary here.
        from agent_harness.domain.memory import SessionTraceArchive

        archives = tuple(_trace_archive(item) for item in data["archives"])
        return SkillArchive(
            row["archive_id"],
            SkillScope(row["repository_id"]),
            row["session_id"],
            row["source_archive_id"],
            row["payload_hash"],
            row["reason"],
            row["trace_format_version"],
            archives,
            row["bytes_count"],
            row["successful_tool_calls"],
            row["turn_count"],
            row["created_at"],
        )

    async def get_job(self, job_id: str) -> SkillExtractionJob | None:
        row = self._conn.execute("SELECT * FROM skill_extraction_jobs WHERE job_id=?", (job_id,)).fetchone()
        return _job(row) if row else None

    async def search(self, scope: SkillScope, query: str, limit: int) -> tuple[SkillListing, ...]:
        try:
            rows = self._conn.execute(
                """SELECT s.* FROM skill_fts f JOIN skills s ON s.skill_id=f.skill_id
              WHERE f.repository_id=? AND skill_fts MATCH ? AND s.visibility='private' AND s.state='active'
              ORDER BY bm25(skill_fts) LIMIT ?""",
                (scope.storage_key, query or "*", limit),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = self._conn.execute(
                "SELECT * FROM skills WHERE repository_id=? AND visibility='private' AND state='active' ORDER BY updated_at DESC LIMIT ?",
                (scope.storage_key, limit),
            ).fetchall()
        return tuple(_listing(row) for row in rows)

    async def listing(self, scope: SkillScope, query: str, budget: int) -> tuple[SkillListing, ...]:
        chosen: list[SkillListing] = []
        used = 0
        for item in await self.search(scope, query, 50):
            cost = len(item.skill_id) + len(item.name) + len(item.description) + sum(map(len, item.triggers)) + 40
            if chosen and used + cost > budget:
                break
            if cost <= budget:
                chosen.append(item)
                used += cost
        return tuple(chosen)

    async def load(self, scope: SkillScope, skill_id: str, version: int | None = None) -> SkillLoadout | None:
        asset = self._conn.execute(
            "SELECT * FROM skills WHERE skill_id=? AND repository_id=? AND visibility='private'",
            (skill_id, scope.storage_key),
        ).fetchone()
        if not asset or asset["state"] != "active":
            return None
        version = version or asset["current_version"]
        row = self._conn.execute(
            "SELECT * FROM skill_versions WHERE skill_id=? AND version=?", (skill_id, version)
        ).fetchone()
        if not row:
            return None
        files = tuple(
            SkillFile(file["path"], bytes(file["content"]), file["mime_type"])
            for file in self._conn.execute(
                "SELECT * FROM skill_files WHERE skill_id=? AND version=? ORDER BY path", (skill_id, version)
            )
        )
        return SkillLoadout(
            skill_id,
            version,
            row["markdown"],
            row["manifest"],
            files,
            row["content_hash"],
            tuple((item.path, item.content_hash) for item in files),
        )

    async def view(self, scope: SkillScope, skill_id: str) -> tuple[SkillAsset, SkillVersion] | None:
        asset = self._conn.execute(
            "SELECT * FROM skills WHERE skill_id=? AND repository_id=?", (skill_id, scope.storage_key)
        ).fetchone()
        if not asset:
            return None
        row = self._conn.execute(
            "SELECT * FROM skill_versions WHERE skill_id=? AND version=?", (skill_id, asset["current_version"])
        ).fetchone()
        return _asset(asset), self._version(skill_id, row)

    async def get_skill(self, scope: SkillScope, skill_id: str) -> SkillAsset | None:
        """One asset in any state; a disabled skill must still be readable."""
        row = self._conn.execute(
            "SELECT * FROM skills WHERE skill_id=? AND repository_id=?", (skill_id, scope.storage_key)
        ).fetchone()
        return _asset(row) if row else None

    async def list_skills(
        self, scope: SkillScope, state: str | None, after: tuple[int, str] | None, limit: int
    ) -> tuple[SkillAsset, ...]:
        """Assets for the browse view, newest first.

        Unlike ``search``/``listing`` this is not the prompt's injection view:
        it keeps disabled and archived skills, because a UI that can only see
        what is currently injected cannot explain what happened to the rest.
        """
        sql = "SELECT * FROM skills WHERE repository_id=?"
        params: list[object] = [scope.storage_key]
        if state is not None:
            sql += " AND state=?"
            params.append(state)
        if after is not None:
            sql += " AND (updated_at<? OR (updated_at=? AND skill_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY updated_at DESC, skill_id DESC LIMIT ?"
        params.append(limit)
        return tuple(_asset(row) for row in self._conn.execute(sql, params).fetchall())

    async def list_versions(
        self, scope: SkillScope, skill_id: str, after: tuple[int] | None, limit: int
    ) -> tuple[SkillVersion, ...]:
        """One skill's version history, newest first, files included.

        Pages stay small by construction: every version carries the resource
        files that were stored with it, and the history of one skill is short.
        """
        sql = """SELECT * FROM skill_versions WHERE skill_id=?
            AND EXISTS(SELECT 1 FROM skills WHERE skill_id=? AND repository_id=?)"""
        params: list[object] = [skill_id, skill_id, scope.storage_key]
        if after is not None:
            sql += " AND version<?"
            params.append(after[0])
        sql += " ORDER BY version DESC LIMIT ?"
        params.append(limit)
        return tuple(self._version(skill_id, row) for row in self._conn.execute(sql, params).fetchall())

    def _version(self, skill_id: str, row: sqlite3.Row) -> SkillVersion:
        files = tuple(
            SkillFile(f["path"], bytes(f["content"]), f["mime_type"])
            for f in self._conn.execute(
                "SELECT * FROM skill_files WHERE skill_id=? AND version=?", (skill_id, row["version"])
            )
        )
        return SkillVersion(
            skill_id, row["version"], row["markdown"], row["manifest"], files, row["content_hash"], row["created_at"]
        )

    async def list_archives(
        self, scope: SkillScope, after: tuple[int, str] | None, limit: int
    ) -> tuple[SkillArchiveSummary, ...]:
        """Source archives of this repository, newest first, payload excluded."""
        sql = """SELECT archive_id, repository_id, session_id, source_archive_id, payload_hash, reason,
            trace_format_version, bytes_count, successful_tool_calls, turn_count, created_at
            FROM skill_archives WHERE repository_id=?"""
        params: list[object] = [scope.storage_key]
        if after is not None:
            sql += " AND (created_at<? OR (created_at=? AND archive_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY created_at DESC, archive_id DESC LIMIT ?"
        params.append(limit)
        return tuple(
            SkillArchiveSummary(
                row["archive_id"],
                SkillScope(row["repository_id"]),
                row["session_id"],
                row["source_archive_id"],
                row["payload_hash"],
                row["reason"],
                row["trace_format_version"],
                row["bytes_count"],
                row["successful_tool_calls"],
                row["turn_count"],
                row["created_at"],
            )
            for row in self._conn.execute(sql, params).fetchall()
        )

    async def list_jobs(
        self, scope: SkillScope, status: str | None, after: tuple[int, str] | None, limit: int
    ) -> tuple[SkillExtractionJob, ...]:
        """Extraction jobs of this repository, newest first, in every state."""
        sql = "SELECT * FROM skill_extraction_jobs WHERE repository_id=?"
        params: list[object] = [scope.storage_key]
        if status is not None:
            sql += " AND status=?"
            params.append(status)
        if after is not None:
            sql += " AND (created_at<? OR (created_at=? AND job_id<?))"
            params += [after[0], after[0], after[1]]
        sql += " ORDER BY created_at DESC, job_id DESC LIMIT ?"
        params.append(limit)
        return tuple(_job(row) for row in self._conn.execute(sql, params).fetchall())

    async def list_audit(self, scope: SkillScope, after: tuple[int] | None, limit: int) -> tuple[SkillAuditRecord, ...]:
        """Audit rows of this repository, newest first, keyed by insertion order."""
        sql = "SELECT * FROM skill_audit WHERE repository_id=?"
        params: list[object] = [scope.storage_key]
        if after is not None:
            sql += " AND id<?"
            params.append(after[0])
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        return tuple(
            SkillAuditRecord(row["id"], scope, row["created_at"], row["event"], json.loads(row["data"]))
            for row in self._conn.execute(sql, params).fetchall()
        )

    async def create(self, scope: SkillScope, proposal: SkillProposal, now: int) -> SkillAsset:
        from agent_harness.domain.skill import SkillConfig

        name, description, triggers = validate_skill_proposal(proposal, config=SkillConfig())
        skill_id = "skl-" + self._ids()
        return await self._write(scope, skill_id, None, proposal, name, description, triggers, now)

    async def update(self, scope: SkillScope, proposal: SkillProposal, now: int) -> SkillAsset:
        from agent_harness.domain.skill import SkillConfig

        name, description, triggers = validate_skill_proposal(proposal, config=SkillConfig())
        assert proposal.skill_id is not None
        return await self._write(
            scope, proposal.skill_id, proposal.expected_version, proposal, name, description, triggers, now
        )

    async def _write(
        self,
        scope: SkillScope,
        skill_id: str,
        expected: int | None,
        proposal: SkillProposal,
        name: str,
        description: str,
        triggers: tuple[str, ...],
        now: int,
    ) -> SkillAsset:
        conn = self._conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            current = conn.execute("SELECT * FROM skills WHERE skill_id=?", (skill_id,)).fetchone()
            if current and current["repository_id"] != scope.storage_key:
                raise PermissionError("cross-owner skill write")
            if current is None:
                if expected is not None:
                    raise VersionConflict(0)
                version = 1
                conn.execute(
                    "INSERT INTO skills VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        skill_id,
                        scope.storage_key,
                        name,
                        description,
                        json.dumps(triggers),
                        json.dumps(proposal.tags),
                        "private",
                        "active",
                        version,
                        now,
                        now,
                    ),
                )
            else:
                if expected != current["current_version"]:
                    raise VersionConflict(current["current_version"])
                version = current["current_version"] + 1
                conn.execute(
                    "UPDATE skills SET name=?,description=?,triggers=?,tags=?,current_version=?,updated_at=? WHERE skill_id=?",
                    (name, description, json.dumps(triggers), json.dumps(proposal.tags), version, now, skill_id),
                )
            assert proposal.markdown is not None
            match = _FRONTMATTER_VERSION.search(proposal.markdown)
            if match is None or int(match.group(1)) != version:
                raise ValueError("SKILL.md frontmatter version must match committed version")
            manifest = json.dumps(
                {
                    "files": [
                        {"path": f.path, "sha256": f.content_hash, "mime_type": f.mime_type} for f in proposal.files
                    ]
                },
                sort_keys=True,
            )
            digest = skill_content_hash(proposal.markdown, proposal.files)
            conn.execute(
                "INSERT INTO skill_versions VALUES(?,?,?,?,?,?)",
                (skill_id, version, proposal.markdown, manifest, digest, now),
            )
            for file in proposal.files:
                conn.execute(
                    "INSERT INTO skill_files VALUES(?,?,?,?,?,?)",
                    (skill_id, version, file.path, file.content, file.mime_type, file.content_hash),
                )
            conn.execute("DELETE FROM skill_fts WHERE skill_id=?", (skill_id,))
            conn.execute(
                "INSERT INTO skill_fts VALUES(?,?,?,?,?)",
                (skill_id, scope.storage_key, name, description, " ".join(triggers)),
            )
            row = conn.execute("SELECT * FROM skills WHERE skill_id=?", (skill_id,)).fetchone()
            conn.execute("COMMIT")
            return _asset(row)
        except Exception:
            conn.execute("ROLLBACK")
            raise

    async def audit(self, scope: SkillScope, event: str, data: dict[str, object]) -> None:
        self._conn.execute(
            "INSERT INTO skill_audit(repository_id,created_at,event,data) VALUES(?,?,?,?)",
            (scope.storage_key, self._now(), event, json.dumps(data, sort_keys=True, default=str)),
        )


def _asset(r: sqlite3.Row) -> SkillAsset:
    return SkillAsset(
        r["skill_id"],
        SkillScope(r["repository_id"]),
        r["name"],
        r["description"],
        tuple(json.loads(r["triggers"])),
        tuple(json.loads(r["tags"])),
        r["visibility"],
        r["state"],
        r["current_version"],
        r["created_at"],
        r["updated_at"],
    )


def _listing(r: sqlite3.Row) -> SkillListing:
    return SkillListing(
        r["skill_id"], r["name"], r["description"], tuple(json.loads(r["triggers"])), r["current_version"], r["state"]
    )


def _job(r: sqlite3.Row) -> SkillExtractionJob:
    return SkillExtractionJob(
        r["job_id"],
        SkillScope(r["repository_id"]),
        r["archive_id"],
        r["status"],
        r["not_before"],
        r["attempt"],
        r["created_at"],
        r["updated_at"],
        r["lease_id"],
        r["lease_until"],
        r["prompt_id"],
        r["prompt_version"],
        tuple(json.loads(r["candidate_skill_ids"])),
        r["output_hash"],
        r["error_class"],
    )


def _job_values(j: SkillExtractionJob) -> tuple[object, ...]:
    return (
        j.job_id,
        j.scope.storage_key,
        j.archive_id,
        j.status,
        j.not_before,
        j.attempt,
        j.created_at,
        j.updated_at,
        j.lease_id,
        j.lease_until,
        j.prompt_id,
        j.prompt_version,
        json.dumps(j.candidate_skill_ids),
        j.output_hash,
        j.error_class,
    )


def _archive_data(a: SkillArchive) -> dict[str, object]:
    return {
        "archives": [
            {
                "archive_id": x.archive_id,
                "scope": x.scope.repository_id,
                "session_id": x.session_id,
                "lane": x.lane,
                "operation_id": x.operation_id,
                "operation_kind": x.operation_kind,
                "base_tip_id": x.base_tip_id,
                "tip_id": x.tip_id,
                "source_entry_ids": x.source_entry_ids,
                "source_entry_hash": x.source_entry_hash,
                "trace_format_version": x.trace_format_version,
                "created_at": x.created_at,
                "content_hash": x.content_hash,
                "items": [
                    {
                        "source_entry_id": item.source_entry_id,
                        "source_seq": item.source_seq,
                        "timestamp": item.timestamp,
                        "type": item.type,
                        "role": item.role,
                        "content": item.content,
                        "payload": item.payload,
                        "redacted_paths": item.redacted_paths,
                        "store_seq": item.store_seq,
                    }
                    for item in x.items
                ],
            }
            for x in a.archives
        ]
    }


def _trace_archive(d: dict[str, Any]):
    from agent_harness.domain.memory import MemoryScope, SessionTraceArchive, TraceItem

    items = tuple(
        TraceItem(
            item["source_entry_id"],
            item["source_seq"],
            item["timestamp"],
            item["type"],
            item["role"],
            item["content"],
            item["payload"],
            tuple(item["redacted_paths"]),
            item["store_seq"],
        )
        for item in d["items"]
    )
    return SessionTraceArchive(
        d["archive_id"],
        MemoryScope(d["scope"]),
        d["session_id"],
        d["lane"],
        d["operation_id"],
        d["operation_kind"],
        d["base_tip_id"],
        d["tip_id"],
        tuple(d["source_entry_ids"]),
        d["source_entry_hash"],
        d["trace_format_version"],
        d["created_at"],
        d["content_hash"],
        items,
    )
