"""Repository-scoped Skill queries and explicit activation.

The UI cannot alter Skill content, versions, scope, or visibility. It may only
activate/deactivate an already-reviewed private asset; that lifecycle change is
durable and audited by the store.

Unlike the injection views (`search`, `listing`), these reads keep disabled and
archived assets.  A UI that could only see what is currently injected could not
answer "what happened to the skill that used to be here".
"""

from agent_harness.api.errors import InvalidCursor
from agent_harness.api.pagination import Page, paginate
from agent_harness.domain.skill import (
    SkillArchive,
    SkillArchiveSummary,
    SkillAsset,
    SkillAuditRecord,
    SkillExtractionJob,
    SkillScope,
    SkillVersion,
)
from agent_harness.skill.protocol import SkillStore

_STATES: frozenset[str] = frozenset({"active", "disabled", "archived"})
_JOB_STATUSES: frozenset[str] = frozenset({"scheduled", "queued", "running", "retry_wait", "dead_letter", "completed"})


class SkillQueryService:
    """One repository's Skill assets and their activation state."""

    def __init__(self, store: SkillStore, scope: SkillScope) -> None:
        self._store = store
        self._scope = scope

    async def list_skills(
        self, state: str | None = None, cursor: str | None = None, limit: int = 50
    ) -> Page[SkillAsset]:
        """Skill assets in every state, newest first."""

        state_filter = _state_filter(state)

        async def read(after: tuple[int, str] | None, size: int) -> tuple[SkillAsset, ...]:
            return await self._store.list_skills(self._scope, state_filter, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("skill"), key=_skill_key)

    async def get_skill(self, skill_id: str) -> SkillAsset | None:
        """One asset, in whatever state it is in."""

        return await self._store.get_skill(self._scope, skill_id)

    async def set_enabled(self, skill_id: str, enabled: bool) -> SkillAsset | None:
        """Make one owned Skill discoverable (or hide it) without editing it."""
        return await self._store.set_state(self._scope, skill_id, "active" if enabled else "disabled")

    async def list_versions(self, skill_id: str, cursor: str | None = None, limit: int = 50) -> Page[SkillVersion]:
        """One skill's version history, newest first."""

        async def read(after: tuple[int] | None, size: int) -> tuple[SkillVersion, ...]:
            return await self._store.list_versions(self._scope, skill_id, after, size)

        return await paginate(cursor, limit, read=read, narrow=_id("version"), key=lambda item: [item.version])

    async def list_archives(self, cursor: str | None = None, limit: int = 50) -> Page[SkillArchiveSummary]:
        """Source archives of this repository, newest first."""

        async def read(after: tuple[int, str] | None, size: int) -> tuple[SkillArchiveSummary, ...]:
            return await self._store.list_archives(self._scope, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("archive"), key=_archive_key)

    async def get_archive(self, archive_id: str) -> SkillArchive | None:
        """One source archive with its payload, if this repository owns it."""

        archive = await self._store.get_archive(archive_id)
        return archive if archive is not None and archive.scope == self._scope else None

    async def list_jobs(
        self, status: str | None = None, cursor: str | None = None, limit: int = 50
    ) -> Page[SkillExtractionJob]:
        """Extraction jobs in every state, newest first."""

        _validate_status(status, _JOB_STATUSES, "job status")

        async def read(after: tuple[int, str] | None, size: int) -> tuple[SkillExtractionJob, ...]:
            return await self._store.list_jobs(self._scope, status, after, size)

        return await paginate(cursor, limit, read=read, narrow=_pair("job"), key=_job_key)

    async def list_audit(self, cursor: str | None = None, limit: int = 50) -> Page[SkillAuditRecord]:
        """The skill audit log, newest first."""

        async def read(after: tuple[int] | None, size: int) -> tuple[SkillAuditRecord, ...]:
            return await self._store.list_audit(self._scope, after, size)

        return await paginate(cursor, limit, read=read, narrow=_id("audit"), key=lambda item: [item.audit_id])


def _validate_status(value: str | None, allowed: frozenset[str], label: str) -> None:
    if value is not None and value not in allowed:
        raise ValueError(f"unknown {label} {value!r}")


def _state_filter(state: str | None) -> str | None:
    """Reject an unknown state rather than answering it with an empty page."""

    _validate_status(state, _STATES, "skill state")
    return state


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
            raise InvalidCursor(f"{label} cursor must carry a single number")
        return (decoded[0],)

    return narrow


def _skill_key(item: SkillAsset) -> list[object]:
    return [item.updated_at, item.skill_id]


def _archive_key(item: SkillArchiveSummary) -> list[object]:
    return [item.created_at, item.archive_id]


def _job_key(item: SkillExtractionJob) -> list[object]:
    return [item.created_at, item.job_id]


__all__ = ["SkillQueryService"]
