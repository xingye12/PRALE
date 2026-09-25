from dataclasses import asdict

from agent_harness.api.harness import Harness
from agent_harness.runtime.generation import ChatProvider


class HarnessRpc:
    """Small JSON-RPC-shaped adapter; transport servers can delegate here."""

    def __init__(self, harness: Harness, provider: ChatProvider) -> None:
        self._harness = harness
        self._provider = provider

    @property
    def harness(self) -> Harness:
        """Expose the library facade to transport adapters, never its internals."""

        return self._harness

    async def dispatch(self, method: str, params: dict[str, object]) -> dict[str, object]:
        lane_name = params.get("lane")
        if not isinstance(lane_name, str):
            raise ValueError("lane is required")
        lane = await self._harness.acquire_lane(lane_name)
        if method == "prompt":
            prompt = params.get("prompt")
            if not isinstance(prompt, str):
                raise ValueError("prompt is required")
            supplied_id = params.get("operation_id")
            admission = await lane.prompt(prompt, supplied_id if isinstance(supplied_id, str) else None)
            return asdict(admission)
        if method == "drive":
            return asdict(await lane.drive(self._provider))
        if method == "snapshot":
            return asdict(await lane.snapshot())
        if method == "abort":
            return asdict(await lane.request_abort())
        raise ValueError(f"unknown RPC method {method!r}")
