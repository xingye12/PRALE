"""Read-only memory views for one repository.

Scope resolution is server-side (ADR-WEB-003): the service is built with the
deployment's repository scope, so a request can name a memory but never choose
which repository's memories are read.  L3 is the one deliberate exception —
doctrine is synthesized globally — so it is reported as global rather than
being filtered by a scope the caller could ask for.

Reads are paged by the sort key each view is ordered by.  Nothing here derives
a value the pipeline did not record: a scene with no summary stays summary-less,
and a job that never ran reports no output hash.
"""

from agent_harness.api.errors import InvalidCursor
from agent_harness.api.pagination import Page, paginate
from agent_harness.domain.memory import (
    ArchiveSummary,
    AtomicMemory,
    MemoryAuditRecord,
    MemoryScope,
    OperatingDoctrine,
    PromotionJob,
    SessionTraceArchive,
    WorkSceneMemory,
)
from agent_harness.memory.protocol import MemoryStore

_L1_STATUSES: frozenset[str] = frozenset({"active", "superseded", "rejected"})
_L2_STATUSES: frozenset[str] = frozenset({"current", "dormant"})
_JOB_STATUSES: frozenset[str] = frozenset({"scheduled", "queued", "running", "retry_wait", "dead_letter", "completed"})


class MemoryQueryService:
    """One repository's memory assets, read-only."""

    def __init__(self, store: MemoryStore, scope: MemoryScope) -> None:
        self._store = store
        self._scope = scope

    async def list_l0(self, cursor: str | None = None, limit: int = 50) -> Page[ArchiveSummary]:
        """Captured session archives, newest first."""

        async def read(after: tuple[int, str] | None, size: int) -> tuple[ArchiveSummary, ...]:
            return await self._store.list_l0(self._scope, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("archive"), key=_archive_key)

    async def get_l0(self, archive_id: str) -> SessionTraceArchive | None:
        """One archive with its captured items, if this repository owns it."""

        archive = await self._store.read_archive(archive_id)
        return archive if archive is not None and archive.scope == self._scope else None

    async def list_l1(
        self, status: str | None = None, cursor: str | None = None, limit: int = 50
    ) -> Page[AtomicMemory]:
        """Atomic memories of every status, newest first."""

        status_filter = _status_filter(status, _L1_STATUSES, "atomic memory status")

        async def read(after: tuple[int, str] | None, size: int) -> tuple[AtomicMemory, ...]:
            return await self._store.list_l1(self._scope, status_filter, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("memory"), key=_memory_key)

    async def list_l2(
        self, status: str | None = None, cursor: str | None = None, limit: int = 50
    ) -> Page[WorkSceneMemory]:
        """Scene memories of every status, newest first."""

        status_filter = _status_filter(status, _L2_STATUSES, "scene status")

        async def read(after: tuple[int, str] | None, size: int) -> tuple[WorkSceneMemory, ...]:
            return await self._store.list_l2(self._scope, status_filter, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("scene"), key=_scene_key)

    async def get_l3(self) -> OperatingDoctrine | None:
        """The current operating doctrine.

        Doctrine is global: the store reads it under ``GLOBAL_L3_SCOPE`` and
        ignores this repository's scope, so callers must present it as the
        global doctrine rather than as a filtered view of this project.
        """

        return await self._store.read_l3(self._scope)

    async def list_jobs(
        self, status: str | None = None, cursor: str | None = None, limit: int = 50
    ) -> Page[PromotionJob]:
        """The promotion pipeline's jobs, newest first."""

        status_filter = _status_filter(status, _JOB_STATUSES, "job status")

        async def read(after: tuple[int, str] | None, size: int) -> tuple[PromotionJob, ...]:
            return await self._store.list_jobs(self._scope, status_filter, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("job"), key=_job_key)

    async def list_audit(self, cursor: str | None = None, limit: int = 50) -> Page[MemoryAuditRecord]:
        """The pipeline's audit log, newest first."""

        async def read(after: tuple[int] | None, size: int) -> tuple[MemoryAuditRecord, ...]:
            return await self._store.list_audit(self._scope, after, size)

        return await paginate(cursor, limit, read=read, narrow=_id("audit"), key=lambda item: [item.audit_id])


def _status_filter(value: str | None, allowed: frozenset[str], label: str) -> str | None:
    """Reject an unknown filter rather than answering it with an empty page."""

    if value is not None and value not in allowed:
        raise ValueError(f"unknown {label} {value!r}")
    return value


def _pair(label: str):
    def narrow(decoded: list[object] | None) -> tuple[int, str] | None:
        if decoded is None:
            return None
        if len(decoded) != 2 or not isinstance(decoded[0], int) or not isinstance(decoded[1], str):
            raise InvalidCursor(f"{label} cursor must carry (timestamp, id)")
        return decoded[0], decoded[1]

    return narrow


def _id(label: str):
    def narrow(decoded: list[object] | None) -> tuple[int] | None:
        if decoded is None:
            return None
        if len(decoded) != 1 or not isinstance(decoded[0], int) or isinstance(decoded[0], bool):
            raise InvalidCursor(f"{label} cursor must carry a single row id")
        return (decoded[0],)

    return narrow


def _archive_key(item: ArchiveSummary) -> list[object]:
    return [item.created_at, item.archive_id]


def _memory_key(item: AtomicMemory) -> list[object]:
    return [item.updated_at, item.memory_id]


def _scene_key(item: WorkSceneMemory) -> list[object]:
    return [item.updated_at, item.scene_id]


def _job_key(item: PromotionJob) -> list[object]:
    return [item.created_at, item.job_id]


__all__ = ["MemoryQueryService"]
