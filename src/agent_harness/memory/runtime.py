"""Lifecycle-managed, best-effort dispatcher for durable memory work."""
# ruff: noqa

import asyncio
import hashlib
import json
import re
import time
import uuid
from collections.abc import Callable

from agent_harness.domain.entries import Entry
from agent_harness.domain.memory import (
    GLOBAL_L3_SCOPE,
    MemoryScope,
    MemoryRetentionPolicy,
    RecallBudget,
    RecallBundle,
    RecallQuery,
    SessionTraceArchive,
    TraceItem,
    content_hash,
)
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.values import ListAddress
from agent_harness.memory.protocol import MemoryExtractor, MemoryStore
from agent_harness.storage.protocol import AppendList, ClearList


def _now() -> int:
    return time.time_ns() // 1_000_000


class MemoryRuntime:
    """Owns no Session state; it only consumes frozen session outbox records."""

    def __init__(
        self,
        store: MemoryStore,
        extractor: MemoryExtractor | None = None,
        *,
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
        l1_turn_threshold: int = 5,
        l2_delay_ms: int = 90_000,
        l2_min_interval_ms: int = 15 * 60_000,
        l3_l1_threshold: int = 50,
        max_job_attempts: int = 3,
        max_scenes: int = 20,
        poll_ms: int = 100,
    ) -> None:
        if max_job_attempts < 1:
            raise ValueError("max_job_attempts must be positive")
        self._store, self._extractor = store, extractor
        self._ids, self._now = id_factory or (lambda: str(uuid.uuid4())), now_ms or _now
        self._threshold, self._poll_ms = l1_turn_threshold, poll_ms
        self._l2_delay_ms = l2_delay_ms
        self._l2_min_interval_ms = l2_min_interval_ms
        self._l3_l1_threshold = l3_l1_threshold
        self._max_job_attempts = max_job_attempts
        self._max_scenes = max_scenes
        self._sessions: dict[str, tuple[Session, MemoryScope]] = {}
        self._task: asyncio.Task[None] | None = None
        self._closed = False

    def bind_session(self, session: Session, scope: MemoryScope) -> None:
        self._sessions[session.id] = (session, scope)

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("memory runtime is closed")
        if self._task is None:
            if self._extractor is not None:
                await self._store.register_prompt(
                    getattr(self._extractor, "mode", "code"),
                    getattr(self._extractor, "prompt_id", type(self._extractor).__name__),
                    getattr(self._extractor, "prompt_version", 1),
                )
            self._task = asyncio.create_task(self._worker(), name="memory-runtime")

    async def aclose(self) -> None:
        self._closed = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def recall(self, scope: MemoryScope, query: RecallQuery, budget: RecallBudget) -> RecallBundle:
        started = self._now()
        try:
            bundle = await asyncio.wait_for(self._store.search(scope, query, budget), budget.timeout_ms / 1_000)
            await self._safe_audit(
                scope,
                "recall_completed",
                {
                    "duration_ms": max(0, self._now() - started),
                    "item_ids": [item.id for item in bundle.items],
                    "total_chars": bundle.total_chars,
                    "degraded_reason": bundle.degraded_reason,
                },
            )
            return bundle
        except Exception as error:
            await self._safe_audit(scope, "recall_degraded", {"reason": type(error).__name__})
            return RecallBundle((), content_hash(""), 0, type(error).__name__)

    async def flush(self, scope: MemoryScope, stage: str = "l1") -> None:
        """Explicitly enqueue one promotion stage without depending on an idle timer."""
        if stage not in {"l1", "l2", "l3"}:
            raise ValueError(f"unsupported promotion stage {stage!r}")
        if stage == "l3":
            await self._store.create_or_wake_job(GLOBAL_L3_SCOPE, "l3", self._now(), self._now())
            return
        watermark = (
            await self._store.current_l1_watermark(scope)
            if stage == "l1"
            else await self._store.stage_watermark(scope, "l2" if stage == "l3" else "l1")
        )
        await self._store.create_or_wake_job(scope, stage, watermark, self._now())

    async def replay_capture_dead_letters(self, session_id: str) -> int:
        """Move explicitly selected Session capture dead letters back to the outbox."""
        bound = self._sessions.get(session_id)
        if bound is None:
            raise KeyError(session_id)
        session, scope = bound
        outbox = ListAddress[dict[str, object]]("memory/capture_outbox")
        dead = ListAddress[dict[str, object]]("memory/capture_dead_letters")

        async def replay(mutator: SessionMutator) -> int:
            records = await mutator.read_list(dead)
            if not records:
                return 0
            await mutator.commit([*(AppendList(outbox, item) for item in records), ClearList(dead)])
            return len(records)

        count = await session.mutate(replay)
        if count:
            await self._store.audit(scope, "capture_dead_letters_replayed", {"count": count})
        return count

    async def gc(
        self, scope: MemoryScope, policy: MemoryRetentionPolicy = MemoryRetentionPolicy()
    ) -> dict[str, object]:
        day = 24 * 60 * 60 * 1_000
        now = self._now()
        return await self._store.gc(
            scope,
            l0_before=now - policy.l0_days * day,
            l1_before=now - policy.l1_superseded_days * day,
            l2_before=now - policy.l2_dormant_days * day,
            audit_before=now - policy.audit_days * day,
        )

    async def record_injection(self, scope: MemoryScope, bundle: RecallBundle) -> None:
        """Audit the exact immutable bundle that was admitted into an effect intent."""
        await self._safe_audit(
            scope,
            "recall_injected",
            {
                "bundle_hash": bundle.content_hash,
                "items": [{"id": item.id, "version": item.version} for item in bundle.items],
                "total_chars": bundle.total_chars,
            },
        )

    async def _worker(self) -> None:
        while not self._closed:
            for session, scope in tuple(self._sessions.values()):
                try:
                    await self._dispatch_session(session, scope)
                except Exception as error:
                    await self._safe_audit(scope, "capture_dispatch_error", {"error": type(error).__name__})
            try:
                job = await self._store.claim_job(self._now(), self._ids(), 30_000)
            except Exception:
                job = None
            if job is not None:
                await self._run_job(job)
                continue
            await asyncio.sleep(self._poll_ms / 1_000)

    async def _safe_audit(self, scope: MemoryScope, event: str, data: dict[str, object]) -> None:
        try:
            await self._store.audit(scope, event, data)
        except Exception:
            pass

    async def _dispatch_session(self, session: Session, scope: MemoryScope) -> None:
        outbox = ListAddress[dict[str, object]]("memory/capture_outbox")

        async def read(mutator: SessionMutator) -> list[object]:
            return await mutator.read_list(outbox)

        pending = await session.mutate(read)
        delivered: list[object] = []
        dead_letters: list[object] = []
        for raw in pending:
            if not _scope_matches(raw, scope):
                continue
            try:
                if raw.get("event", "memory_capture_requested") != "memory_capture_requested":
                    raise ValueError("unknown memory outbox event")
                archive = await self._materialize(session, scope, raw)
                _, created = await self._store.capture_archive(archive)
                if created:
                    watermark = await self._store.current_l1_watermark(scope)
                    pending_archives = await self._store.unconsumed_items(scope, watermark)
                    max_seq = max((item.store_seq for item in archive.items), default=watermark)
                    turns = sum(item.role == "user" for candidate in pending_archives for item in candidate.items)
                    if turns >= self._threshold:
                        await self._store.create_or_wake_job(
                            scope,
                            "l1",
                            max_seq,
                            self._now(),
                            input_ids=tuple(item.archive_id for item in pending_archives),
                        )
                delivered.append(raw)
            except Exception as error:
                await self._store.audit(scope, "capture_dead_letter", {"error": type(error).__name__, "outbox": raw})
                dead_letters.append(raw)
        if delivered or dead_letters:

            async def settle(mutator: SessionMutator) -> None:
                current = await mutator.read_list(outbox)
                remaining = [item for item in current if item not in delivered]
                remaining = [item for item in remaining if item not in dead_letters]
                dead = ListAddress[dict[str, object]]("memory/capture_dead_letters")
                await mutator.commit(
                    [
                        ClearList(outbox),
                        *(AppendList(outbox, item) for item in remaining),
                        *(AppendList(dead, item) for item in dead_letters),
                    ]
                )

            await session.mutate(settle)

    async def _materialize(self, session: Session, scope: MemoryScope, raw: dict[str, object]) -> SessionTraceArchive:
        ids = raw.get("source_entry_ids")
        if not isinstance(ids, list) or not all(isinstance(value, str) for value in ids):
            raise ValueError("invalid frozen capture outbox")
        trace_ids = raw.get("trace_entry_ids", [])
        if not isinstance(trace_ids, list) or not all(isinstance(value, str) for value in trace_ids):
            raise ValueError("invalid frozen trace identifiers")
        requested_ids = [*ids, *trace_ids]
        entries = await session._storage.get_entries(requested_ids)  # noqa: SLF001 -- frozen identifiers are intentionally read directly
        if set(entries) != set(requested_ids):
            raise RuntimeError("frozen source entry disappeared")
        ordered = [entries[entry_id] for entry_id in requested_ids]
        digest = hashlib.sha256("\0".join(ids).encode()).hexdigest()
        if digest != raw.get("source_entry_hash"):
            raise RuntimeError("frozen source hash mismatch")
        items = tuple(_trace_item(entry) for entry in ordered)
        return SessionTraceArchive(
            self._ids(),
            scope,
            session.id,
            _required_str(raw, "lane"),
            _required_str(raw, "operation_id"),
            _required_str(raw, "kind"),
            _optional_str(raw, "base_tip_id"),
            _optional_str(raw, "tip_id"),
            tuple(ids),
            digest,
            _required_str(raw, "trace_format_version"),
            self._now(),
            content_hash(json.dumps([item.payload for item in items], sort_keys=True)),
            items,
        )

    async def materialize_capture(
        self, session: Session, scope: MemoryScope, raw: dict[str, object]
    ) -> SessionTraceArchive:
        """Public, shared L0 materializer used by dependent asset dispatchers.

        It intentionally does not capture again: callers consume the same frozen
        identifiers and validation logic while MemoryRuntime remains the sole L0
        authority.
        """
        return await self._materialize(session, scope, raw)

    async def materialized_capture(
        self, scope: MemoryScope, session_id: str, raw: dict[str, object]
    ) -> SessionTraceArchive | None:
        """Read the L0 authority archive referenced by a frozen capture outbox record."""
        tip_id = _optional_str(raw, "tip_id")
        return await self._store.find_archive(
            scope,
            session_id,
            _required_str(raw, "operation_id"),
            tip_id,
            _required_str(raw, "source_entry_hash"),
        )

    async def _run_job(self, job) -> None:
        try:
            if self._extractor is None:
                await self._store.complete_job(job.job_id, job.lease_id or "")
                return
            extractor_mode = getattr(self._extractor, "mode", "code")
            if job.prompt_mode is not None and job.prompt_mode != extractor_mode:
                raise ValueError(f"unsupported persisted memory prompt mode {job.prompt_mode!r}")
            await self._safe_audit(
                job.scope,
                "job_started",
                {
                    "job_id": job.job_id,
                    "stage": job.stage,
                    "attempt": job.attempt,
                    "input_ids": job.input_ids,
                    "prompt_id": job.prompt_id,
                    "prompt_version": job.prompt_version,
                },
            )
            if job.stage == "l1":
                after = await self._store.current_l1_watermark(job.scope)
                archives = await self._store.unconsumed_items(job.scope, after)
                l1_candidates = await self._extractor.extract_l1(archives)
                watermark = max((item.store_seq for archive in archives for item in archive.items), default=after)
                await self._store.apply_candidates(job.scope, l1_candidates, watermark)
                await self._store.complete_job(job.job_id, job.lease_id or "", content_hash(str(l1_candidates)))
                await self._safe_audit(
                    job.scope, "job_completed", {"job_id": job.job_id, "candidates": len(l1_candidates)}
                )
                delay = self._l2_delay_ms
                last_l2 = await self._store.last_completed_at(job.scope, "l2")
                if last_l2 is not None:
                    delay = max(delay, self._l2_min_interval_ms - max(0, self._now() - last_l2))
                await self._store.create_or_wake_job(
                    job.scope,
                    "l2",
                    watermark,
                    self._now() + delay,
                    getattr(self._extractor, "prompt_id", None),
                    getattr(self._extractor, "prompt_version", None),
                    getattr(self._extractor, "mode", "code"),
                    tuple(memory.memory_id for memory in await self._store.read_l1_since(job.scope, after)),
                )
                return
            if job.stage == "l2":
                scenes = await self._store.read_l2(job.scope)
                after = await self._store.stage_watermark(job.scope, "l2")
                l1 = await self._store.read_l1_since(job.scope, after)
                l2_candidates = await self._extractor.extract_l2(l1, scenes)
                for candidate in l2_candidates:
                    await self._store.write_scene(job.scope, candidate, self._max_scenes)
                watermark = max(
                    (candidate.l1_high_watermark for candidate in l2_candidates), default=job.input_high_watermark
                )
                await self._store.advance_watermark(job.scope, "l2", watermark)
                await self._store.complete_job(job.job_id, job.lease_id or "", content_hash(str(l2_candidates)))
                await self._safe_audit(
                    job.scope, "job_completed", {"job_id": job.job_id, "candidates": len(l2_candidates)}
                )
                current_doctrine = await self._store.read_l3(GLOBAL_L3_SCOPE)
                persona_requested = any(candidate.persona_update_request for candidate in l2_candidates)
                # L1 watermarks are repository-local and cannot safely be
                # compared with the global L3 watermark. Every material L2
                # change therefore wakes one deduplicated global synthesis.
                if current_doctrine is None or l2_candidates or persona_requested:
                    await self._store.create_or_wake_job(
                        GLOBAL_L3_SCOPE,
                        "l3",
                        max(watermark, self._now()),
                        self._now(),
                        getattr(self._extractor, "prompt_id", None),
                        getattr(self._extractor, "prompt_version", None),
                        getattr(self._extractor, "mode", "code"),
                        tuple(scene.scene_id for scene in scenes),
                    )
                return
            if job.stage == "l3":
                scenes = await self._store.read_all_l2()
                l3_candidate = await self._extractor.extract_l3(scenes, await self._store.read_l3(GLOBAL_L3_SCOPE))
                if l3_candidate is not None:
                    await self._store.write_doctrine(GLOBAL_L3_SCOPE, l3_candidate)
                await self._store.advance_watermark(GLOBAL_L3_SCOPE, "l3", job.input_high_watermark)
                await self._store.complete_job(job.job_id, job.lease_id or "", content_hash(str(l3_candidate)))
                await self._safe_audit(
                    job.scope, "job_completed", {"job_id": job.job_id, "candidates": int(l3_candidate is not None)}
                )
                return
            raise ValueError(f"unsupported promotion stage {job.stage}")
        except AttributeError:
            # Older extractors are valid L1-only implementations; preserve their completed input.
            await self._store.complete_job(job.job_id, job.lease_id or "")
        except ValueError as error:
            await self._store.fail_job(job.job_id, job.lease_id or "", "schema", None)
            await self._safe_audit(job.scope, "job_dead_letter", {"job_id": job.job_id, "error": str(error)})
        except PermissionError as error:
            await self._store.fail_job(job.job_id, job.lease_id or "", "permission", None)
            await self._safe_audit(job.scope, "job_dead_letter", {"job_id": job.job_id, "error": str(error)})
        except Exception as error:
            try:
                retry_at = (
                    None if job.attempt >= self._max_job_attempts else self._now() + 1_000 * 2 ** (job.attempt - 1)
                )
                await self._store.fail_job(job.job_id, job.lease_id or "", type(error).__name__, retry_at)
                if retry_at is None:
                    await self._safe_audit(
                        job.scope, "job_dead_letter", {"job_id": job.job_id, "error": type(error).__name__}
                    )
            except Exception:
                await self._safe_audit(job.scope, "job_settlement_error", {"job_id": job.job_id})


def _scope_json(scope: MemoryScope) -> dict[str, str | None]:
    return {"repository_id": scope.repository_id}


def _scope_matches(raw: object, scope: MemoryScope) -> bool:
    """Accept pre-repository outbox records during the API migration."""
    if not isinstance(raw, dict):
        return False
    encoded = raw.get("scope")
    if not isinstance(encoded, dict):
        return False
    repository_id = encoded.get("repository_id")
    if isinstance(repository_id, str):
        return repository_id == scope.repository_id
    # Old records used (team, agent, user, task).  Their deterministic legacy
    # constructor mapping is the only safe way to drain them after upgrade.
    team, agent, user = encoded.get("team_id"), encoded.get("agent_id"), encoded.get("user_id")
    if not isinstance(team, str) or not isinstance(agent, str) or (user is not None and not isinstance(user, str)):
        return False
    return MemoryScope(team, agent, user).repository_id == scope.repository_id


def _trace_item(entry: Entry) -> TraceItem:
    payload = dict(entry.payload) if isinstance(entry.payload, dict) else {"value": entry.payload}
    redacted, paths = _redact(payload)
    role, content = payload.get("role"), payload.get("content")
    return TraceItem(
        entry.id,
        entry.seq,
        entry.timestamp,
        entry.type,
        role if isinstance(role, str) else None,
        _redact_text(content) if isinstance(content, str) else None,
        redacted,
        paths,
    )


def _redact(value: object, path: str = "") -> tuple[dict[str, object], tuple[str, ...]]:
    sensitive = {"authorization", "cookie", "password", "secret", "token", "api_key", "private_key"}
    if not isinstance(value, dict):
        return {"value": value}, ()
    result: dict[str, object] = {}
    paths: list[str] = []
    for key, item in value.items():
        current_path = f"{path}.{key}" if path else key
        if key.lower() in sensitive:
            result[key] = _redaction_marker(item)
            paths.append(current_path)
        elif key == "content" and isinstance(item, str):
            redacted_text = _redact_text(item)
            result[key] = redacted_text
            if redacted_text != item:
                paths.append(current_path)
        elif isinstance(item, dict):
            nested, nested_paths = _redact(item, current_path)
            result[key] = nested
            paths.extend(nested_paths)
        elif isinstance(item, list):
            values: list[object] = []
            for index, child in enumerate(item):
                if isinstance(child, dict):
                    nested, nested_paths = _redact(child, f"{current_path}[{index}]")
                    values.append(nested)
                    paths.extend(nested_paths)
                else:
                    values.append(child)
            result[key] = values
        else:
            result[key] = item
    return result, tuple(paths)


def _redact_text(value: str) -> str:
    value = re.sub(r"(?i)(bearer\s+)[^\s]+", r"\1[REDACTED]", value)
    value = re.sub(r"(?i)\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+", r"\1=[REDACTED]", value)
    return value


def _redaction_marker(value: object) -> str:
    digest = hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:12]
    return f"[REDACTED:{digest}]"


def _required_str(raw: dict[str, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str):
        raise ValueError(f"capture outbox lacks {key}")
    return value


def _optional_str(raw: dict[str, object], key: str) -> str | None:
    value = raw.get(key)
    if value is not None and not isinstance(value, str):
        raise ValueError(f"invalid {key}")
    return value
