"""Framework-free command adapter for terminal UIs."""

from dataclasses import asdict

from agent_harness.api.harness import Harness
from agent_harness.runtime.generation import ChatProvider


class TuiController:
    """Maps small terminal commands onto the transport-neutral library API."""

    def __init__(self, harness: Harness, provider: ChatProvider) -> None:
        self._harness = harness
        self._provider = provider

    async def execute(self, lane_name: str, command: str, argument: str | None = None) -> dict[str, object]:
        lane = await self._harness.acquire_lane(lane_name)
        if command == "prompt":
            if not argument:
                raise ValueError("prompt command requires text")
            return asdict(await lane.prompt(argument))
        if command == "drive":
            return asdict(await lane.drive(self._provider))
        if command == "abort":
            return asdict(await lane.request_abort())
        if command == "snapshot":
            return asdict(await lane.snapshot())
        raise ValueError(f"unknown TUI command {command!r}")
