"""Crash-boundary tests: durable intent must determine recovery, never RAM state."""

import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import InsertEntry, Write


class Provider:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        return AssistantResult(content="remote-success", usage={})


class FailAssistantSettlementStorage:
    """Inject one atomic commit failure after a provider has returned."""

    def __init__(self, base: MemoryStorage) -> None:
        self._base = base
        self._failed = False

    def operation_lock(self, key: str):
        return self._base.operation_lock(key)

    async def commit(self, writes: list[Write]):
        if not self._failed and any(
            isinstance(write, InsertEntry)
            and isinstance(write.entry.payload, dict)
            and write.entry.payload.get("role") == "assistant"
            for write in writes
        ):
            self._failed = True
            raise OSError("simulated process termination before settlement commit")
        return await self._base.commit(writes)

    async def get_entries(self, ids):
        return await self._base.get_entries(ids)

    async def scan_branch(self, start):
        return await self._base.scan_branch(start)

    async def get_value(self, address):
        return await self._base.get_value(address)

    async def read_list(self, address):
        return await self._base.read_list(address)


def test_provider_effect_after_intent_before_settlement_recovers_as_unknown_without_replay() -> None:
    async def scenario() -> None:
        storage = FailAssistantSettlementStorage(MemoryStorage())
        provider = Provider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        with pytest.raises(OSError, match="simulated process termination"):
            await lane.drive(provider)
        assert provider.calls == 1

        # Re-attaching has no access to the original Drive/provider task.
        recovered = await (await Harness.open("session-1", storage)).acquire_lane("main")
        result = await recovered.recover()
        assert result is not None and result.status == "aborted"
        assert provider.calls == 1
        assert (await storage.scan_branch(result.tip_id))[-1].payload["stop_reason"] == "aborted"

    asyncio.run(scenario())
