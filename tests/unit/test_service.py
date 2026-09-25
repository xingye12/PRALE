import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.api.rpc import HarnessRpc
from agent_harness.api.service import AuthenticatedHarnessService, AuthenticationError, StaticTokenAuthenticator
from agent_harness.integrations.telemetry import InMemoryTelemetry
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory import MemoryStorage


class Provider:
    async def generate(self, request: GenerationRequest) -> AssistantResult:
        return AssistantResult(content="ok", usage={})


def test_authenticated_service_rejects_bad_credentials_and_streams_lane_events() -> None:
    async def scenario() -> None:
        harness = await Harness.open("session-1", MemoryStorage())
        service = AuthenticatedHarnessService(
            HarnessRpc(harness, Provider()), StaticTokenAuthenticator({"token": "user"})
        )

        with pytest.raises(AuthenticationError):
            await service.dispatch("wrong", "snapshot", {"lane": "main"})

        subscription = await service.subscribe("token", "main")
        await service.dispatch("token", "prompt", {"lane": "main", "prompt": "hi", "operation_id": "op-1"})
        event = await subscription.next()
        subscription.close()

        assert event is not None
        assert event["type"] == "operation_admitted"
        assert await subscription.next() is None

    asyncio.run(scenario())


def test_telemetry_listener_observes_events_without_joining_runtime_state() -> None:
    async def scenario() -> None:
        telemetry = InMemoryTelemetry()
        harness = await Harness.open("session-1", MemoryStorage())
        harness.subscribe(telemetry)
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        await lane.drive(Provider())

        assert telemetry.event_counts["operation_admitted"] == 1
        assert telemetry.operation_counts["run"] == 1

    asyncio.run(scenario())
