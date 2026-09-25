import asyncio

from agent_harness.api.harness import Harness
from agent_harness.api.rpc import HarnessRpc
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory import MemoryStorage


class Provider:
    async def generate(self, request: GenerationRequest) -> AssistantResult:
        return AssistantResult(content="ok", usage={})


def test_rpc_adapter_delegates_to_the_transport_neutral_library_api() -> None:
    async def scenario() -> None:
        rpc = HarnessRpc(await Harness.open("session-1", MemoryStorage()), Provider())

        admitted = await rpc.dispatch("prompt", {"lane": "main", "prompt": "hi", "operation_id": "op-1"})
        result = await rpc.dispatch("drive", {"lane": "main"})
        snapshot = await rpc.dispatch("snapshot", {"lane": "main"})

        assert admitted["operation_id"] == "op-1"
        assert result["status"] == "completed"
        assert snapshot["operation_id"] is None

    asyncio.run(scenario())
