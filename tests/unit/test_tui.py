import asyncio

from agent_harness.api.harness import Harness
from agent_harness.api.tui import TuiController
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory import MemoryStorage


class Provider:
    async def generate(self, request: GenerationRequest) -> AssistantResult:
        return AssistantResult(content="ok", usage={})


def test_tui_controller_delegates_commands_to_harness_api() -> None:
    async def scenario() -> None:
        controller = TuiController(await Harness.open("session-1", MemoryStorage()), Provider())

        admitted = await controller.execute("main", "prompt", "hi")
        result = await controller.execute("main", "drive")
        snapshot = await controller.execute("main", "snapshot")

        assert admitted["operation_id"]
        assert result["status"] == "completed"
        assert snapshot["operation_id"] is None

    asyncio.run(scenario())
