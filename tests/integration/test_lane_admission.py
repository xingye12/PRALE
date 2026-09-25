import asyncio

import pytest

from agent_harness.api.errors import LaneBusy
from agent_harness.api.harness import Harness
from agent_harness.domain.values import lane_state, operation_meta, operation_state
from agent_harness.storage.memory import MemoryStorage


def test_prompt_admission_is_durable_before_any_drive_is_started() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        lane = await harness.acquire_lane("main")

        admitted = await lane.prompt("hello", operation_id="op-1")

        assert admitted.operation_id == "op-1"
        assert (await storage.get_value(lane_state("main")))["current_operation_id"] == "op-1"
        assert (await storage.get_value(operation_meta("op-1"))).request == {"prompt": "hello"}
        assert (await storage.get_value(operation_state("op-1"))).at == "starting"

    asyncio.run(scenario())


def test_one_lane_accepts_only_one_operation_even_when_callers_race() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        lane = await harness.acquire_lane("main")

        results = await asyncio.gather(
            lane.prompt("first", operation_id="op-1"),
            lane.prompt("second", operation_id="op-2"),
            return_exceptions=True,
        )

        assert sum(isinstance(result, LaneBusy) for result in results) == 1
        assert sum(not isinstance(result, Exception) for result in results) == 1

    asyncio.run(scenario())


def test_reopening_a_session_restores_the_durable_busy_lane() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        first_harness = await Harness.open("session-1", storage)
        await (await first_harness.acquire_lane("main")).prompt("first", operation_id="op-1")

        reopened_harness = await Harness.open("session-1", storage)
        reopened_lane = await reopened_harness.acquire_lane("main")

        assert (await reopened_lane.snapshot()).operation_id == "op-1"
        with pytest.raises(LaneBusy):
            await reopened_lane.prompt("second", operation_id="op-2")

    asyncio.run(scenario())
