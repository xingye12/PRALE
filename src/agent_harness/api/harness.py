from collections.abc import Callable

from agent_harness.api.errors import InvalidLane
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.domain.memory import MemoryScope
from agent_harness.domain.session import Session
from agent_harness.domain.skill import SkillScope
from agent_harness.domain.subagents import (
    INTERNAL_PREFIX,
    SubagentAdmission,
    SubagentConfig,
    SubagentDefinition,
    SubagentRecoveryReport,
    SubagentRequest,
    SubagentSnapshot,
    SubagentStopResult,
    SubagentWaitResult,
)
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.runtime.events import EventBus, EventListener
from agent_harness.runtime.hooks import HookHandler, HookRegistry
from agent_harness.runtime.lane import Lane
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.subagents import ProviderResolver, SubagentRuntime
from agent_harness.runtime.telemetry import TelemetrySink
from agent_harness.runtime.tools import AgentTool, RuntimeControlTool
from agent_harness.skill.runtime import SkillEvolutionRuntime
from agent_harness.storage.protocol import Storage


class Harness:
    """Transport-neutral facade for a durable single-session harness."""

    def __init__(
        self,
        session: Session,
        tools: tuple[AgentTool | RuntimeControlTool, ...] = (),
        retry: RetryPolicy = RetryPolicy(),
        *,
        memory_scope: MemoryScope | None = None,
        memory_runtime: MemoryRuntime | None = None,
        skill_scope: SkillScope | None = None,
        skill_runtime: SkillEvolutionRuntime | None = None,
        trace_recorder: bool = False,
        telemetry: TelemetrySink | None = None,
        context_management: ContextManagementConfig = ContextManagementConfig(),
        definitions: tuple[SubagentDefinition, ...] = (),
        subagent_config: SubagentConfig = SubagentConfig(),
        provider_resolver: ProviderResolver | None = None,
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> None:
        self._session = session
        self._id_factory = id_factory
        self._now_ms = now_ms
        self._tools = tools
        self._retry = retry
        self._events = EventBus()
        self._hooks = HookRegistry()
        self._lanes: dict[str, Lane] = {}
        self._memory_scope = memory_scope
        self._memory_runtime = memory_runtime
        self._skill_scope = skill_scope
        self._skill_runtime = skill_runtime
        self._trace_recorder = trace_recorder
        self._telemetry = telemetry
        self._context_management = context_management
        self._subagents = SubagentRuntime(
            session, subagent_config, definitions, provider_resolver, tools, self._make_lane
        )
        if (memory_scope is None) != (memory_runtime is None):
            raise ValueError("memory_scope and memory_runtime must be configured together")
        if skill_runtime is not None and memory_runtime is None:
            raise ValueError("skill_runtime requires memory_runtime for L0 archive materialization")
        if (skill_scope is None) != (skill_runtime is None):
            raise ValueError("skill_scope and skill_runtime must be configured together")
        if memory_runtime is not None and memory_scope is not None:
            memory_runtime.bind_session(session, memory_scope)
        if skill_runtime is not None and memory_runtime is not None and memory_scope is not None:
            if skill_scope != SkillScope.from_memory_scope(memory_scope):
                raise ValueError("skill_scope must match memory_scope owner")
            skill_runtime.bind_session(session, memory_scope, memory_runtime)

    @classmethod
    async def open(
        cls,
        session_id: str,
        storage: Storage,
        tools: tuple[AgentTool | RuntimeControlTool, ...] = (),
        retry: RetryPolicy = RetryPolicy(),
        *,
        memory_scope: MemoryScope | None = None,
        memory_runtime: MemoryRuntime | None = None,
        skill_scope: SkillScope | None = None,
        skill_runtime: SkillEvolutionRuntime | None = None,
        trace_recorder: bool = False,
        telemetry: TelemetrySink | None = None,
        context_management: ContextManagementConfig = ContextManagementConfig(),
        definitions: tuple[SubagentDefinition, ...] = (),
        subagent_config: SubagentConfig = SubagentConfig(),
        provider_resolver: ProviderResolver | None = None,
        id_factory: Callable[[], str] | None = None,
        now_ms: Callable[[], int] | None = None,
    ) -> "Harness":
        bind_session = getattr(storage, "bind_session", None)
        if callable(bind_session):
            bind_session(session_id)
        harness = cls(
            Session(session_id, storage),
            tools,
            retry,
            memory_scope=memory_scope,
            memory_runtime=memory_runtime,
            skill_scope=skill_scope,
            skill_runtime=skill_runtime,
            trace_recorder=trace_recorder,
            telemetry=telemetry,
            context_management=context_management,
            definitions=definitions,
            subagent_config=subagent_config,
            provider_resolver=provider_resolver,
            id_factory=id_factory,
            now_ms=now_ms,
        )
        if subagent_config.enabled:
            await harness.recover_subagents()
        return harness

    def _make_lane(self, name: str, tools: tuple[AgentTool | RuntimeControlTool, ...]) -> Lane:
        lane = Lane(
            name,
            self._session,
            id_factory=self._id_factory,
            now_ms=self._now_ms,
            tools=tools,
            retry=self._retry,
            events=self._events,
            hooks=self._hooks,
            memory_scope=self._memory_scope,
            memory_runtime=self._memory_runtime,
            skill_scope=self._skill_scope,
            skill_runtime=self._skill_runtime,
            trace_recorder=self._trace_recorder,
            telemetry=self._telemetry,
            context_management=self._context_management,
        )
        lane.subagents = self._subagents
        return lane

    async def acquire_lane(self, name: str) -> Lane:
        if not name or "\x00" in name or name.startswith(INTERNAL_PREFIX):
            raise InvalidLane("lane name must be non-empty and contain no NUL")
        lane = self._lanes.get(name)
        if lane is None:
            lane = self._make_lane(name, self._tools)
            await lane.attach()
            self._lanes[name] = lane
            await lane.emit("lane_created", None, {"name": name})
        return lane

    async def fork_lane(self, source_name: str, target_name: str) -> Lane:
        if target_name in self._lanes:
            raise InvalidLane(f"lane {target_name!r} already exists")
        source = await self.acquire_lane(source_name)
        tip_id = (await source.snapshot()).tip_id
        if tip_id is not None and await self._session.get_entry(tip_id) is None:
            raise RuntimeError(f"source lane {source_name!r} has an unknown tip")
        if not target_name or "\x00" in target_name or target_name.startswith(INTERNAL_PREFIX):
            raise InvalidLane("lane name must be non-empty and contain no NUL")
        target = self._make_lane(target_name, self._tools)
        await target.attach(tip_id)
        self._lanes[target_name] = target
        return target

    def subscribe(self, listener: EventListener):
        return self._events.subscribe(listener)

    def on_hook(self, name: str, handler: HookHandler):
        return self._hooks.on(name, handler)

    async def start_subagent(
        self,
        parent_lane: str,
        parent_operation_id: str,
        request: SubagentRequest,
        idempotency_key: str,
    ) -> SubagentAdmission:
        parent = await self.acquire_lane(parent_lane)
        return await self._subagents.start(parent, parent_operation_id, request, idempotency_key)

    async def continue_subagent(
        self,
        agent_id: str,
        parent_lane: str,
        parent_operation_id: str,
        prompt: str,
        background: bool,
        idempotency_key: str,
    ) -> SubagentAdmission:
        parent = await self.acquire_lane(parent_lane)
        return await self._subagents.start(
            parent,
            parent_operation_id,
            SubagentRequest(prompt, "Continue delegated task", run_in_background=background),
            idempotency_key,
            agent_id,
        )

    async def get_subagent_run(self, run_id: str) -> SubagentSnapshot:
        return await self._subagents.get(run_id)

    async def list_subagent_runs(self, parent_lane: str) -> tuple[SubagentSnapshot, ...]:
        return await self._subagents.list_runs(parent_lane)

    async def wait_subagent_run(self, run_id: str, timeout_ms: int = 30000) -> SubagentWaitResult:
        return await self._subagents.wait(run_id, timeout_ms)

    async def stop_subagent_run(self, run_id: str) -> SubagentStopResult:
        return await self._subagents.stop(run_id)

    async def recover_subagents(self) -> SubagentRecoveryReport:
        return await self._subagents.recover()

    @property
    def active_subagent_drives(self) -> int:
        return self._subagents.active

    async def queued_subagent_runs(self) -> int:
        from agent_harness.domain.subagents import index

        ids = await self._session._storage.read_list(index("session/subagent_runs"))
        return sum([(await self._subagents.get(str(run_id))).state == "queued" for run_id in ids])

    async def close_subagents(self) -> None:
        await self._subagents.aclose()

    async def close(self) -> None:
        await self.close_subagents()
        if self._skill_runtime is not None and self._skill_scope is not None:
            await self._skill_runtime.archive_session_closed(self._skill_scope, self._session.id)
        if self._memory_runtime is not None:
            await self._memory_runtime.aclose()
        if self._skill_runtime is not None:
            await self._skill_runtime.aclose()
