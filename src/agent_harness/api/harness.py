from agent_harness.api.errors import InvalidLane
from agent_harness.domain.session import Session
from agent_harness.runtime.lane import Lane
from agent_harness.storage.protocol import Storage


class Harness:
    """Transport-neutral facade for a durable single-session harness."""

    def __init__(self, session: Session) -> None:
        self._session = session
        self._lanes: dict[str, Lane] = {}

    @classmethod
    async def open(cls, session_id: str, storage: Storage) -> "Harness":
        return cls(Session(session_id, storage))

    async def acquire_lane(self, name: str) -> Lane:
        if not name or "\x00" in name:
            raise InvalidLane("lane name must be non-empty and contain no NUL")
        lane = self._lanes.get(name)
        if lane is None:
            lane = Lane(name, self._session)
            await lane.attach()
            self._lanes[name] = lane
        return lane
