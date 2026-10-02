from agent_harness.api.errors import InvalidLane
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.domain.memory import MemoryScope
from agent_harness.domain.session import Session
from agent_harness.domain.skill import SkillScope
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.runtime.events import EventBus, EventListener
from agent_harness.runtime.hooks import HookHandler, HookRegistry
from agent_harness.runtime.lane import Lane
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.telemetry import TelemetrySink
from agent_harness.runtime.tools import AgentTool
from agent_harness.skill.runtime import SkillEvolutionRuntime
from agent_harness.storage.protocol import Storage


class Harness:
    """Transport-neutral facade for a durable single-session harness."""

    def __init__(
        self,
        session: Session,
        tools: tuple[AgentTool, ...] = (),
        retry: RetryPolicy = RetryPolicy(),
        *,
        memory_scope: MemoryScope | None = None,
        memory_runtime: MemoryRuntime | None = None,
        skill_scope: SkillScope | None = None,
        skill_runtime: SkillEvolutionRuntime | None = None,
        trace_recorder: bool = False,
        telemetry: TelemetrySink | None = None,
        context_management: ContextManagementConfig = ContextManagementConfig(),
    ) -> None:
        self._session = session
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
        tools: tuple[AgentTool, ...] = (),
        retry: RetryPolicy = RetryPolicy(),
        *,
        memory_scope: MemoryScope | None = None,
        memory_runtime: MemoryRuntime | None = None,
        skill_scope: SkillScope | None = None,
        skill_runtime: SkillEvolutionRuntime | None = None,
        trace_recorder: bool = False,
        telemetry: TelemetrySink | None = None,
        context_management: ContextManagementConfig = ContextManagementConfig(),
    ) -> "Harness":
        bind_session = getattr(storage, "bind_session", None)
        if callable(bind_session):
            bind_session(session_id)
        return cls(
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
        )

    async def acquire_lane(self, name: str) -> Lane:
        if not name or "\x00" in name:
            raise InvalidLane("lane name must be non-empty and contain no NUL")
        lane = self._lanes.get(name)
        if lane is None:
            lane = Lane(
                name,
                self._session,
                tools=self._tools,
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
        if not target_name or "\x00" in target_name:
            raise InvalidLane("lane name must be non-empty and contain no NUL")
        target = Lane(
            target_name,
            self._session,
            tools=self._tools,
            retry=self._retry,
            events=self._events,
            hooks=self._hooks,
            memory_scope=self._memory_scope,
            memory_runtime=self._memory_runtime,
            skill_scope=self._skill_scope,
            skill_runtime=self._skill_runtime,
            trace_recorder=self._trace_recorder,
            context_management=self._context_management,
        )
        await target.attach(tip_id)
        self._lanes[target_name] = target
        return target

    def subscribe(self, listener: EventListener):
        return self._events.subscribe(listener)

    def on_hook(self, name: str, handler: HookHandler):
        return self._hooks.on(name, handler)

    async def close(self) -> None:
        if self._skill_runtime is not None and self._skill_scope is not None:
            await self._skill_runtime.archive_session_closed(self._skill_scope, self._session.id)
        if self._memory_runtime is not None:
            await self._memory_runtime.aclose()
        if self._skill_runtime is not None:
            await self._skill_runtime.aclose()
