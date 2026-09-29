import asyncio
import hashlib
import re
import time
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING

from agent_harness.api.errors import LaneBusy, NothingToCompact, OperationAlreadyExists
from agent_harness.api.models import AbortResult, LaneSnapshot, OperationAdmission, OperationResult
from agent_harness.domain.entries import NewEntry
from agent_harness.domain.operations import ActiveOperation, OperationMeta, OperationState
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.types import OperationKind
from agent_harness.domain.values import (
    ListAddress,
    lane_inbox,
    lane_operations,
    lane_state,
    lane_tip,
    operation_lease,
    operation_meta,
    operation_result,
    operation_state,
    session_lanes,
)
from agent_harness.runtime.events import EventBus, EventListener, HarnessEvent
from agent_harness.runtime.hooks import HookRegistry
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.telemetry import TelemetrySink
from agent_harness.runtime.tools import AgentTool, ToolRegistry
from agent_harness.storage.protocol import AppendList, DeleteValue, InsertEntry, SetValue, Write

if TYPE_CHECKING:
    from agent_harness.domain.memory import MemoryScope
    from agent_harness.domain.skill import SkillScope
    from agent_harness.memory.runtime import MemoryRuntime
    from agent_harness.runtime.generation import ChatProvider
    from agent_harness.skill.runtime import SkillEvolutionRuntime


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


_UNSET = object()


def _redact_trace(value: object) -> object:
    sensitive = {"authorization", "cookie", "password", "secret", "token", "api_key", "private_key"}
    if isinstance(value, dict):
        return {key: "[REDACTED]" if key.lower() in sensitive else _redact_trace(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_trace(item) for item in value]
    if isinstance(value, str):

        def redact_match(match: re.Match[str]) -> str:
            secret = match.group(2)
            marker = hashlib.sha256(secret.encode()).hexdigest()[:12]
            return f"{match.group(1)}[REDACTED:{marker}]"

        value = re.sub(r"(?i)(bearer\s+)([^\s]+)", redact_match, value)
        value = re.sub(r"(?i)((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;]+)", redact_match, value)
    return value


class Lane:
    """One serial operation lane. Admission is durable; Drive execution comes later."""

    def __init__(
        self,
        name: str,
        session: Session,
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
        tools: tuple[AgentTool, ...] = (),
        retry: RetryPolicy = RetryPolicy(),
        events: EventBus | None = None,
        hooks: HookRegistry | None = None,
        memory_scope: "MemoryScope | None" = None,
        memory_runtime: "MemoryRuntime | None" = None,
        skill_scope: "SkillScope | None" = None,
        skill_runtime: "SkillEvolutionRuntime | None" = None,
        trace_recorder: bool = False,
        telemetry: TelemetrySink | None = None,
    ) -> None:
        self.name = name
        self._session = session
        self._id_factory = id_factory or (lambda: str(uuid.uuid4()))
        self._now_ms = now_ms or _now_ms
        self._tools = ToolRegistry(tools)
        self._retry = retry
        self._events = events or EventBus()
        self._hooks = hooks or HookRegistry()
        self._drive_task: asyncio.Task[object] | None = None
        self._memory_scope = memory_scope
        self._memory_runtime = memory_runtime
        self._skill_scope = skill_scope
        self._skill_runtime = skill_runtime
        self._trace_recorder = trace_recorder
        self._telemetry = telemetry

    async def attach(self, at: str | None = None) -> None:
        """Durably create the lane's idle projection if this is its first attachment."""

        async def create_if_absent(mutator: SessionMutator) -> None:
            writes: list[Write] = []
            if await mutator.get_value(lane_state(self.name)) is None:
                writes.extend(
                    [
                        SetValue(lane_tip(self.name), at),
                        SetValue(lane_state(self.name), {"current_operation_id": None, "last_operation_id": None}),
                    ]
                )
            # Also index lanes that predate the index, so a reader can enumerate them.
            if self.name not in await mutator.read_list(session_lanes()):
                writes.append(AppendList(session_lanes(), self.name))
            if writes:
                await mutator.commit(writes)

        await self._session.mutate(create_if_absent)

    async def snapshot(self) -> LaneSnapshot:
        state = await self._load_lane_state()
        return LaneSnapshot(
            name=self.name,
            tip_id=await self._session.get_value(lane_tip(self.name)),
            operation_id=state["current_operation_id"],
            last_operation_id=state["last_operation_id"],
        )

    async def prompt(self, prompt: str, operation_id: str | None = None) -> OperationAdmission:
        hook_result = await self._hooks.run("before_run", {"prompt": prompt, "messages": []})
        if not isinstance(hook_result, dict) or not isinstance(hook_result.get("messages"), list):
            raise RuntimeError("before_run must return a request object with messages")
        extra_messages = hook_result["messages"]
        if not all(isinstance(message, str) for message in extra_messages):
            raise RuntimeError("before_run messages must be strings")
        return await self._admit("run", {"prompt": prompt, "before_run_messages": extra_messages}, operation_id)

    async def compact(self, operation_id: str | None = None) -> OperationAdmission:
        tip = await self._session.get_value(lane_tip(self.name))
        if tip is None:
            raise NothingToCompact(f"lane {self.name!r} has no history to compact")
        return await self._admit("compaction", {}, operation_id)

    async def queue_steer(self, prompt: str) -> str:
        return await self._queue("steer", prompt)

    async def queue_follow_up(self, prompt: str) -> str:
        return await self._queue("follow_up", prompt)

    async def navigate(self, target_id: str | None, operation_id: str | None = None) -> OperationAdmission:
        return await self._admit("navigation", {"target_id": target_id}, operation_id)

    async def get_result(self, operation_id: str) -> OperationResult | None:
        value = await self._session.get_value(operation_result(operation_id))
        return value if isinstance(value, OperationResult) else None

    async def request_abort(self) -> AbortResult:
        async def abort(mutator: SessionMutator) -> AbortResult:
            state_value = await mutator.get_value(lane_state(self.name))
            if not isinstance(state_value, dict) or state_value.get("current_operation_id") is None:
                raise RuntimeError(f"lane {self.name!r} has no active operation")
            operation_id = state_value["current_operation_id"]
            current = await mutator.get_value(operation_state(operation_id))
            if not isinstance(current, OperationState):
                raise RuntimeError(f"operation {operation_id!r} has incomplete durable state")
            if current.control == "cancel_requested":
                return AbortResult(operation_id, newly_requested=False)
            await mutator.commit(
                [
                    *self.trace_writes(operation_id, "cancel_requested", {"state": current.at}),
                    SetValue(
                        operation_state(operation_id),
                        OperationState(current.at, "cancel_requested", current.data),
                    ),
                ]
            )
            return AbortResult(operation_id, newly_requested=True)

        result = await self._session.mutate(abort)
        task = self._drive_task
        current = asyncio.current_task()
        if result.newly_requested and task is not None and task is not current and not task.done():
            task.cancel()
        return result

    async def drive(self, provider: "ChatProvider") -> OperationResult:
        from agent_harness.runtime.drive import Drive

        async with self._session.operation_lock(self.name):
            active = await self.active_operation()
            if active is None:
                last_operation_id = (await self._load_lane_state())["last_operation_id"]
                if last_operation_id is None:
                    raise RuntimeError(f"lane {self.name!r} has no operation to drive")
                result = await self.get_result(last_operation_id)
                if result is None:
                    raise RuntimeError(f"lane {self.name!r} has no terminal result")
                return result
            lease_id = self._id_factory()
            if not await self._claim_drive(active.meta.operation_id, lease_id):
                return await self._wait_for_driver(active.meta.operation_id)
            task = asyncio.current_task()
            self._drive_task = task
            try:
                return await Drive(self, provider).run()
            except asyncio.CancelledError:
                current = await self.active_operation()
                if current is not None and current.state.control == "cancel_requested":
                    recovered = await Drive(self, None).recover()
                    if recovered is not None:
                        return recovered
                raise
            finally:
                if self._drive_task is task:
                    self._drive_task = None
                await self._release_drive(active.meta.operation_id, lease_id)

    async def recover(self, provider: "ChatProvider | None" = None) -> OperationResult | None:
        """Recover durable state; a provider is needed only when recovery can continue a safe effect."""
        from agent_harness.runtime.drive import Drive

        async with self._session.operation_lock(self.name):
            active = await self.active_operation()
            if active is None:
                return None
            lease_id = self._id_factory()
            await self._claim_drive(active.meta.operation_id, lease_id, replace=True)
            try:
                return await Drive(self, provider).recover()
            finally:
                await self._release_drive(active.meta.operation_id, lease_id)

    async def resume(self, provider: "ChatProvider") -> OperationResult:
        return await self.drive(provider)

    def new_id(self) -> str:
        return self._id_factory()

    def now_ms(self) -> int:
        """The lane clock, so effects and operations share one timeline."""

        return self._now_ms()

    async def memory_capture_writes(
        self,
        mutator: SessionMutator,
        result: OperationResult,
        terminal_entry_ids: tuple[str, ...] = (),
        branch_tip_id: object = _UNSET,
    ) -> list[Write]:
        """Build the frozen capture outbox record in the terminal Session mutation."""
        if self._memory_runtime is None or self._memory_scope is None:
            return []
        import hashlib

        base = await mutator.scan_branch(result.from_tip_id)
        tip = await mutator.get_value(lane_tip(self.name)) if branch_tip_id is _UNSET else branch_tip_id
        if tip is not None and not isinstance(tip, str):
            raise RuntimeError("invalid frozen terminal tip")
        terminal = await mutator.scan_branch(tip)
        base_seq = base[-1].seq if base else 0
        source_ids = tuple(entry.id for entry in terminal if entry.seq > base_seq) + terminal_entry_ids
        digest = hashlib.sha256("\0".join(source_ids).encode()).hexdigest()
        outbox = ListAddress[dict[str, object]]("memory/capture_outbox")
        existing = await mutator.read_list(outbox)
        key = [self._session.id, result.operation_id, result.tip_id, digest]
        if any(isinstance(item, dict) and item.get("key") == key for item in existing):
            return []
        scope = self._memory_scope
        trace_ids = list(await mutator.read_list(ListAddress[str](f"operation/{result.operation_id}/trace")))
        terminal_trace, terminal_trace_ids = self.trace_writes_with_ids(
            result.operation_id, "terminal_settlement", {"status": result.status, "tip_id": result.tip_id}
        )
        trace_ids.extend(terminal_trace_ids)
        writes: list[Write] = [
            *terminal_trace,
            AppendList(
                outbox,
                {
                    "event": "memory_capture_requested",
                    "key": key,
                    "scope": {
                        "repository_id": scope.repository_id,
                    },
                    "lane": self.name,
                    "kind": result.kind,
                    "operation_id": result.operation_id,
                    "base_tip_id": result.from_tip_id,
                    "tip_id": result.tip_id,
                    "source_entry_ids": list(source_ids),
                    "source_entry_hash": digest,
                    "trace_format_version": "execution-v1" if self._trace_recorder else "conversation-v1",
                    "trace_entry_ids": trace_ids,
                },
            ),
        ]
        if self._skill_runtime is not None and self._skill_scope is not None:
            skill_outbox = ListAddress[dict[str, object]]("skill/capture_outbox")
            skill_existing = await mutator.read_list(skill_outbox)
            if not any(isinstance(item, dict) and item.get("key") == key for item in skill_existing):
                writes.append(
                    AppendList(
                        skill_outbox,
                        {
                            "event": "skill_capture_requested",
                            "key": key,
                            "scope": {"repository_id": self._skill_scope.repository_id},
                            "lane": self.name,
                            "kind": result.kind,
                            "operation_id": result.operation_id,
                            "base_tip_id": result.from_tip_id,
                            "tip_id": result.tip_id,
                            "source_entry_ids": list(source_ids),
                            "source_entry_hash": digest,
                            "trace_format_version": "execution-v1" if self._trace_recorder else "conversation-v1",
                            "trace_entry_ids": trace_ids,
                        },
                    )
                )
        return writes

    def trace_writes_with_ids(
        self, operation_id: str, event: str, data: dict[str, object] | None = None
    ) -> tuple[list[Write], tuple[str, ...]]:
        if not self._trace_recorder:
            return [], ()
        trace_id = self._id_factory()
        payload = {"event": event, "data": _redact_trace(data or {})}
        return [
            InsertEntry(NewEntry(trace_id, None, "custom", payload, custom_type="trace_record")),
            AppendList(ListAddress[str](f"operation/{operation_id}/trace"), trace_id),
        ], (trace_id,)

    def trace_writes(self, operation_id: str, event: str, data: dict[str, object] | None = None) -> list[Write]:
        return self.trace_writes_with_ids(operation_id, event, data)[0]

    async def recall_memory(self, prompt: str, context_summary: str = ""):
        if self._memory_runtime is None or self._memory_scope is None:
            return None
        from agent_harness.domain.memory import RecallBudget, RecallQuery

        return await self._memory_runtime.recall(
            self._memory_scope,
            RecallQuery(prompt, context_summary),
            RecallBudget(),
        )

    async def available_skills(self, prompt: str):
        """Best-effort metadata-only Skill discovery; admission never depends on it."""
        if self._skill_runtime is None or self._skill_scope is None:
            return ()
        try:
            return await self._skill_runtime.listing(self._skill_scope, prompt)
        except Exception:
            return ()

    async def load_skill(self, skill_id: str, version: int | None = None):
        if self._skill_runtime is None or self._skill_scope is None:
            return None
        try:
            return await self._skill_runtime.load(self._skill_scope, skill_id, version)
        except Exception:
            return None

    @property
    def session_id(self) -> str:
        return self._session.id

    @property
    def telemetry(self) -> TelemetrySink | None:
        """The deployment's optional observer, or ``None`` for a bare harness."""

        return self._telemetry

    @property
    def tools(self) -> ToolRegistry:
        return self._tools

    @property
    def retry(self) -> RetryPolicy:
        return self._retry

    @property
    def hooks(self) -> HookRegistry:
        return self._hooks

    async def emit(self, event_type: str, operation_id: str | None, data: dict[str, object]) -> None:
        await self._events.emit(HarnessEvent(event_type, self.name, operation_id, data))

    async def watch(self, listener: EventListener) -> tuple[LaneSnapshot, Callable[[], None]]:
        snapshot = await self.snapshot()

        async def filtered(event: HarnessEvent) -> None:
            if event.lane == self.name:
                result = listener(event)
                if hasattr(result, "__await__"):
                    await result

        return snapshot, self._events.subscribe(filtered)

    async def _load_lane_state(self) -> dict[str, str | None]:
        value = await self._session.get_value(lane_state(self.name))
        if value is None:
            return {"current_operation_id": None, "last_operation_id": None}
        if not isinstance(value, dict):
            raise RuntimeError(f"invalid durable lane state for {self.name!r}")
        return {
            "current_operation_id": value.get("current_operation_id"),
            "last_operation_id": value.get("last_operation_id"),
        }

    async def _admit(
        self, kind: OperationKind, request: dict[str, object], supplied_id: str | None
    ) -> OperationAdmission:
        operation_id = supplied_id or self._id_factory()
        started_at = self._now_ms()
        prompt_entry_id = self._id_factory() if kind == "run" else None

        async def admit(mutator: SessionMutator) -> OperationAdmission:
            if await mutator.get_value(operation_meta(operation_id)) is not None:
                raise OperationAlreadyExists(f"operation {operation_id!r} already exists")
            state_value = await mutator.get_value(lane_state(self.name))
            state = state_value or {"current_operation_id": None, "last_operation_id": None}
            current = state.get("current_operation_id")
            if current is not None:
                raise LaneBusy(self.name, current)
            tip = await mutator.get_value(lane_tip(self.name))
            if tip is not None and not isinstance(tip, str):
                raise RuntimeError(f"invalid lane tip for {self.name!r}")
            operation_request = request | ({"prompt_entry_id": prompt_entry_id} if prompt_entry_id is not None else {})
            meta = OperationMeta(operation_id, self.name, tip, started_at, kind, operation_request)
            durable_state = OperationState(at="starting", control="running", data={})
            writes: list[Write] = []
            if prompt_entry_id is not None:
                writes.append(
                    InsertEntry(
                        NewEntry(prompt_entry_id, tip, "message", {"role": "user", "content": request["prompt"]})
                    )
                )
                writes.append(SetValue(lane_tip(self.name), prompt_entry_id))
                parent_id = prompt_entry_id
                for message in request.get("before_run_messages", []):
                    entry_id = self._id_factory()
                    writes.append(
                        InsertEntry(NewEntry(entry_id, parent_id, "message", {"role": "user", "content": message}))
                    )
                    writes.append(SetValue(lane_tip(self.name), entry_id))
                    parent_id = entry_id
            writes.extend(
                [
                    SetValue(operation_meta(operation_id), meta),
                    SetValue(operation_state(operation_id), durable_state),
                    SetValue(
                        lane_state(self.name),
                        {"current_operation_id": operation_id, "last_operation_id": state.get("last_operation_id")},
                    ),
                    # The turn index is written with the admission, in the same
                    # transaction: a reader must never miss an admitted operation.
                    AppendList(
                        lane_operations(self.name),
                        {"operation_id": operation_id, "kind": kind, "started_at": started_at},
                    ),
                ]
            )
            await mutator.commit(writes)
            return OperationAdmission(operation_id=operation_id, kind=kind, started_at=started_at)

        admitted = await self._session.mutate(admit)
        await self.emit("operation_admitted", admitted.operation_id, {"kind": admitted.kind})
        return admitted

    async def _queue(self, kind: str, prompt: str) -> str:
        entry_id = self._id_factory()

        async def queue(mutator: SessionMutator) -> str:
            await mutator.commit([AppendList(lane_inbox(self.name), {"id": entry_id, "kind": kind, "prompt": prompt})])
            return entry_id

        queued = await self._session.mutate(queue)
        await self.emit("input_queued", None, {"kind": kind, "entry_id": queued})
        return queued

    async def active_operation(self) -> ActiveOperation | None:
        state = await self._load_lane_state()
        operation_id = state["current_operation_id"]
        if operation_id is None:
            return None
        meta = await self._session.get_value(operation_meta(operation_id))
        durable_state = await self._session.get_value(operation_state(operation_id))
        if not isinstance(meta, OperationMeta) or not isinstance(durable_state, OperationState):
            raise RuntimeError(f"operation {operation_id!r} has incomplete durable state")
        return ActiveOperation(meta=meta, state=durable_state)

    async def _claim_drive(self, operation_id: str, lease_id: str, *, replace: bool = False) -> bool:
        async def claim(mutator: SessionMutator) -> bool:
            state = await mutator.get_value(lane_state(self.name))
            if not isinstance(state, dict) or state.get("current_operation_id") != operation_id:
                return False
            existing = await mutator.get_value(operation_lease(operation_id))
            if existing is not None and not replace:
                return False
            await mutator.commit([SetValue(operation_lease(operation_id), {"id": lease_id})])
            return True

        return await self._session.mutate(claim)

    async def _release_drive(self, operation_id: str, lease_id: str) -> None:
        async def release(mutator: SessionMutator) -> None:
            lease = await mutator.get_value(operation_lease(operation_id))
            if isinstance(lease, dict) and lease.get("id") == lease_id:
                await mutator.commit([DeleteValue(operation_lease(operation_id))])

        await self._session.mutate(release)

    async def _wait_for_driver(self, operation_id: str) -> OperationResult:
        """Observe a lease holder rather than creating a second Drive/effect."""

        while True:
            result = await self.get_result(operation_id)
            if result is not None:
                return result
            active = await self.active_operation()
            if active is None or active.meta.operation_id != operation_id:
                raise RuntimeError(f"operation {operation_id!r} ended without a terminal result")
            await asyncio.sleep(0.01)
