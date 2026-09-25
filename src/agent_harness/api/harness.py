from agent_harness.api.errors import InvalidLane
from agent_harness.domain.session import Session
from agent_harness.runtime.events import EventBus, EventListener
from agent_harness.runtime.hooks import HookHandler, HookRegistry
from agent_harness.runtime.lane import Lane
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.tools import AgentTool
from agent_harness.storage.protocol import Storage


class Harness:
    """Transport-neutral facade for a durable single-session harness."""

    def __init__(self, session: Session, tools: tuple[AgentTool, ...] = (), retry: RetryPolicy = RetryPolicy()) -> None:
        self._session = session
        self._tools = tools
        self._retry = retry
        self._events = EventBus()
        self._hooks = HookRegistry()
        self._lanes: dict[str, Lane] = {}

    @classmethod
    async def open(
        cls, session_id: str, storage: Storage, tools: tuple[AgentTool, ...] = (), retry: RetryPolicy = RetryPolicy()
    ) -> "Harness":
        bind_session = getattr(storage, "bind_session", None)
        if callable(bind_session):
            bind_session(session_id)
        return cls(Session(session_id, storage), tools, retry)

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
        )
        await target.attach(tip_id)
        self._lanes[target_name] = target
        return target

    def subscribe(self, listener: EventListener):
        return self._events.subscribe(listener)

    def on_hook(self, name: str, handler: HookHandler):
        return self._hooks.on(name, handler)
