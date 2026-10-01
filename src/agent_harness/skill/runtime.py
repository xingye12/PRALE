"""Best-effort Skill capture, archival and controlled review worker."""
# ruff: noqa

import asyncio
import hashlib
import json
import re
import time
import uuid
from collections.abc import Callable

from agent_harness.domain.memory import MemoryScope, SessionTraceArchive
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.skill import (
    ArchiveReason,
    SkillArchive,
    SkillConfig,
    SkillListing,
    SkillLoadout,
    SkillProposal,
    SkillSearchMode,
    SkillScope,
    VersionConflict,
    is_successful_tool_result,
    patch_markdown,
    validate_skill_proposal,
)
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.skill.protocol import SkillReviewer, SkillStore
from agent_harness.storage.protocol import AppendList, ClearList
from agent_harness.domain.values import ListAddress


def _now() -> int:
    return time.time_ns() // 1_000_000


class SkillEvolutionRuntime:
    """Consumes only frozen L0 archives; it never reads mutable operation state."""

    def __init__(
        self,
        store: SkillStore,
        reviewer: SkillReviewer | None = None,
        *,
        config: SkillConfig = SkillConfig(),
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        self._store, self._reviewer, self._config = store, reviewer, config
        self._ids, self._now = id_factory or (lambda: str(uuid.uuid4())), now_ms or _now
        self._sessions: dict[str, tuple[Session, MemoryScope, MemoryRuntime]] = {}
        self._task: asyncio.Task[None] | None = None
        self._closed = False

    def bind_session(self, session: Session, scope: MemoryScope, memory_runtime: MemoryRuntime) -> None:
        self._sessions[session.id] = (session, scope, memory_runtime)

    def _review_prompt(self) -> tuple[str | None, int | None]:
        if self._reviewer is None:
            return None, None
        return getattr(self._reviewer, "prompt_id", type(self._reviewer).__name__), getattr(
            self._reviewer, "prompt_version", 1
        )

    async def _schedule(self, archive: SkillArchive) -> None:
        prompt_id, prompt_version = self._review_prompt()
        await self._store.create_job(archive, self._now(), prompt_id, prompt_version)

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("skill runtime is closed")
        if self._task is None:
            self._task = asyncio.create_task(self._worker(), name="skill-evolution-runtime")

    async def aclose(self) -> None:
        self._closed = True
        task, self._task = self._task, None
        if task:
            # Do not cancel an in-flight reviewer: its finally/exception path
            # must durably settle the lease to retry_wait/dead_letter/completed.
            await task

    async def force_archive(self, scope: SkillScope | MemoryScope, session_id: str) -> str | None:
        bound = self._sessions.get(session_id)
        if bound is None:
            raise KeyError(session_id)
        session, memory_scope, memory_runtime = bound
        if isinstance(scope, MemoryScope):
            scope = SkillScope.from_memory_scope(scope)
        if scope != SkillScope.from_memory_scope(memory_scope):
            raise PermissionError("scope mismatch")
        sealed = await self._store.seal_buffer(scope, session_id, "forced")
        if sealed is not None:
            await self._schedule(sealed)
            return sealed.archive_id
        archives = await self._archives_for_session(memory_scope, session_id)
        if not archives:
            return None
        return await self._archive(scope, archives, "forced")

    async def archive_session_closed(self, scope: SkillScope | MemoryScope, session_id: str) -> str | None:
        """Seal only the pending buffer for an explicit session-close lifecycle event."""
        skill_scope = _skill_scope(scope)
        sealed = await self._store.seal_buffer(skill_scope, session_id, "session_closed")
        if sealed is None:
            return None
        await self._schedule(sealed)
        return sealed.archive_id

    async def listing(
        self,
        scope: SkillScope | MemoryScope,
        query: str,
        budget: int | None = None,
        mode: SkillSearchMode = "keyword",
    ) -> tuple[SkillListing, ...]:
        skill_scope = _skill_scope(scope)
        if mode not in {"keyword", "embedding", "hybrid"}:
            raise ValueError(f"unsupported skill search mode {mode!r}")
        if mode != "keyword":
            await self._safe_audit(
                skill_scope,
                "skill_search_degraded",
                {"requested_mode": mode, "effective_mode": "keyword", "reason": "sqlite_bm25_only"},
            )
        return await self._store.listing(skill_scope, query, budget or self._config.listing_budget)

    async def load(
        self,
        scope: SkillScope | MemoryScope,
        skill_id: str,
        version: int | None = None,
        budget: int | None = None,
    ) -> SkillLoadout | None:
        skill_scope = _skill_scope(scope)
        loadout = await self._store.load(skill_scope, skill_id, version)
        if loadout is None:
            return None
        limit = budget or self._config.loadout_budget
        size = len(loadout.markdown) + sum(len(item.content) for item in loadout.files)
        if size > limit:
            await self._safe_audit(
                skill_scope,
                "skill_loadout_rejected",
                {"skill_id": skill_id, "version": loadout.version, "size": size, "budget": limit},
            )
            return None
        return loadout

    async def review_status(self, archive_or_job_id: str):
        archive = await self._store.get_archive(archive_or_job_id)
        if archive:
            return archive
        return await self._store.get_job(archive_or_job_id)

    async def _worker(self) -> None:
        while not self._closed:
            for session, scope, memory in tuple(self._sessions.values()):
                try:
                    await self._dispatch_session(session, scope, memory)
                except Exception as error:
                    await self._safe_audit(
                        SkillScope.from_memory_scope(scope),
                        "skill_capture_dispatch_error",
                        {"error": type(error).__name__},
                    )
            try:
                job = await self._store.claim_job(self._now(), self._ids(), 30_000)
            except Exception:
                job = None
            if job is not None:
                await self._run_job(job)
                continue
            await asyncio.sleep(self._config.poll_ms / 1000)

    async def _dispatch_session(self, session: Session, scope: MemoryScope, memory: MemoryRuntime) -> None:
        outbox = ListAddress[dict[str, object]]("skill/capture_outbox")
        pending = await session.mutate(lambda m: m.read_list(outbox))
        delivered = []
        dead = []
        for raw in pending:
            try:
                if not isinstance(raw, dict) or raw.get("event") != "skill_capture_requested":
                    raise ValueError("unknown skill outbox event")
                archive = await memory.materialized_capture(scope, session.id, raw)
                if archive is None:
                    # Memory's dispatcher owns L0 materialization. Keeping the
                    # outbox pending is a durable retry, not a direct Session read.
                    continue
                await self._capture_archive(SkillScope.from_memory_scope(scope), archive)
                delivered.append(raw)
            except Exception as error:
                await self._safe_audit(
                    SkillScope.from_memory_scope(scope), "skill_capture_dead_letter", {"error": type(error).__name__}
                )
                dead.append(raw)
        if delivered or dead:

            async def settle(m: SessionMutator) -> None:
                current = await m.read_list(outbox)
                remaining = [x for x in current if x not in delivered and x not in dead]
                deadbox = ListAddress[dict[str, object]]("skill/capture_dead_letters")
                await m.commit(
                    [
                        ClearList(outbox),
                        *(AppendList(outbox, x) for x in remaining),
                        *(AppendList(deadbox, x) for x in dead),
                    ]
                )

            await session.mutate(settle)

    async def _capture_archive(self, scope: SkillScope, source: SessionTraceArchive) -> str | None:
        existing = await self._store.archive_for_source(scope, source.archive_id, source.content_hash)
        if existing is not None:
            return existing.archive_id
        buffer = getattr(self._store, "buffer_source", None)
        if callable(buffer):
            archived = await buffer(
                scope,
                source,
                tool_threshold=self._config.tool_call_threshold,
                byte_threshold=self._config.byte_threshold,
                max_bytes=self._config.archive_max_bytes,
            )
            if archived is None:
                return None
            await self._schedule(archived)
            return archived.archive_id
        return await self._archive(scope, (source,), self._reason(source))

    def _reason(self, archive: SessionTraceArchive) -> ArchiveReason:
        tools = sum(1 for item in archive.items if item.type == "message" and is_successful_tool_result(item))
        raw = sum(len((item.content or "").encode()) for item in archive.items)
        if raw > self._config.archive_max_bytes:
            return "oversize"
        if tools >= self._config.tool_call_threshold:
            return "tool_calls"
        if raw >= self._config.byte_threshold:
            return "bytes"
        return "forced"  # source archive boundaries are durable; a low-volume capture is retained, never discarded.

    async def _archive(
        self, scope: SkillScope, archives: tuple[SessionTraceArchive, ...], reason: ArchiveReason
    ) -> str:
        raw = json.dumps([a.content_hash for a in archives], sort_keys=True)
        payload_hash = hashlib.sha256(raw.encode()).hexdigest()
        items = tuple(item for archive in archives for item in archive.items)
        record = SkillArchive(
            "skarc-" + self._ids(),
            scope,
            archives[-1].session_id,
            archives[-1].archive_id,
            payload_hash,
            reason,
            archives[-1].trace_format_version,
            archives,
            sum(len((i.content or "").encode()) for i in items),
            sum(is_successful_tool_result(item) for item in items),
            sum(i.role == "user" for i in items),
            self._now(),
        )
        stored, created = await self._store.append_archive(record)
        if created:
            await self._schedule(stored)
        return stored.archive_id

    async def _archives_for_session(self, scope: MemoryScope, session_id: str) -> tuple[SessionTraceArchive, ...]:
        # Force archive can only select L0 already materialized by MemoryRuntime's authority store.
        getter = getattr(self._sessions[session_id][2]._store, "unconsumed_items", None)  # noqa: SLF001
        if not callable(getter):
            return ()
        return tuple(item for item in await getter(scope, 0) if item.session_id == session_id)

    async def _run_job(self, job) -> None:
        try:
            archive = await self._store.get_archive(job.archive_id)
            if archive is None:
                raise ValueError("missing skill archive")
            candidates = await self._store.search(job.scope, " ".join(_keywords(archive)), self._config.max_candidates)
            await self._store.record_candidates(job.job_id, candidates)
            if self._reviewer is None:
                await self._store.complete_job(job.job_id, job.lease_id or "", None)
                return
            proposal = await asyncio.wait_for(
                self._reviewer.review(archive, candidates), self._config.review_timeout_ms / 1_000
            )
            if proposal.action != "no_op" and not _has_successful_evidence(archive, proposal.evidence_entry_ids):
                raise ValueError("skill proposal evidence has no successful tool result")
            if proposal.action == "no_op":
                await self._store.audit(
                    job.scope, "skill_review_no_op", {"job_id": job.job_id, "reason": proposal.reason}
                )
            elif proposal.action == "create":
                if not self._config.auto_create:
                    await self._store.audit(job.scope, "skill_rejected", {"reason": "auto_create_disabled"})
                else:
                    validate_skill_proposal(proposal, config=self._config)
                    await self._store.create(job.scope, proposal, self._now())
            else:
                current = await self._store.view(job.scope, proposal.skill_id or "")
                if current is None:
                    raise ValueError("unknown skill")
                if current[0].state == "active" and not self._config.auto_update_active:
                    await self._store.audit(
                        job.scope,
                        "skill_rejected",
                        {"reason": "auto_update_active_disabled", "skill_id": proposal.skill_id},
                    )
                else:
                    if proposal.action == "patch":
                        if proposal.patch_old is None or proposal.patch_new is None:
                            raise ValueError("skill patch needs old and new content")
                        proposal = SkillProposal(
                            action="update",
                            evidence_entry_ids=proposal.evidence_entry_ids,
                            skill_id=current[0].skill_id,
                            expected_version=proposal.expected_version,
                            markdown=re.sub(
                                r"(?m)^version:\s*\d+\s*$",
                                f"version: {current[0].current_version + 1}",
                                patch_markdown(current[1].markdown, proposal.patch_old, proposal.patch_new),
                                count=1,
                            ),
                            files=current[1].files if not proposal.files else proposal.files,
                            tags=proposal.tags or current[0].tags,
                            reason=proposal.reason,
                        )
                    validate_skill_proposal(proposal, config=self._config)
                    await self._store.update(job.scope, proposal, self._now())
            await self._store.complete_job(
                job.job_id, job.lease_id or "", hashlib.sha256(repr(proposal).encode()).hexdigest()
            )
        except Exception as error:
            conflict_exhausted = isinstance(error, VersionConflict) and job.attempt >= 2
            retry = (
                None
                if conflict_exhausted or job.attempt >= self._config.max_job_attempts
                else self._now() + 1000 * (2 ** max(job.attempt - 1, 0))
            )
            await self._safe_audit(
                job.scope, "skill_review_failed", {"job_id": job.job_id, "error": type(error).__name__}
            )
            await self._store.fail_job(job.job_id, job.lease_id or "", type(error).__name__, retry)

    async def _safe_audit(self, scope: SkillScope, event: str, data: dict[str, object]) -> None:
        try:
            await self._store.audit(scope, event, data)
        except Exception:
            pass


def _skill_scope(scope: SkillScope | MemoryScope) -> SkillScope:
    return scope if isinstance(scope, SkillScope) else SkillScope.from_memory_scope(scope)


def _keywords(archive: SkillArchive) -> tuple[str, ...]:
    words: list[str] = []
    for item in archive.archives:
        for trace in item.items:
            words.extend((trace.content or "").lower().split())
    return tuple(dict.fromkeys(word for word in words if len(word) > 3))[:12]


def _has_successful_evidence(archive: SkillArchive, evidence_ids: tuple[str, ...]) -> bool:
    successful = {
        item.source_entry_id for source in archive.archives for item in source.items if is_successful_tool_result(item)
    }
    return bool(successful.intersection(evidence_ids))
