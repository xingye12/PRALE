"""The step reservation survives interruptions at generation effect boundaries."""

import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.values import operation_steps
from agent_harness.runtime.drive import Drive
from agent_harness.runtime.generation import AssistantResult
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


@pytest.mark.parametrize("boundary", ["before_effect", "before_settlement", "after_settlement"])
def test_step_reservation_survives_sqlite_reopen(tmp_path, monkeypatch, boundary):
    class Crash(BaseException):
        pass

    class Provider:
        async def generate(self, request):
            return AssistantResult(content="done", usage={})

    async def scenario():
        path = tmp_path / "steps.sqlite"
        harness = await Harness.open("session", SQLiteStorage(path))
        harness.on_hook("before_run_end", lambda event: {"follow_up": "continue"})
        lane = await harness.acquire_lane("main")
        await lane.prompt("finish", operation_id="op")

        async def seed(mutator):
            await mutator.commit([SetValue(operation_steps("op"), 119)])

        await harness._session.mutate(seed)
        method = "_execute_and_settle" if boundary == "before_effect" else "_settle_assistant"
        original = getattr(Drive, method)

        async def interrupt(self, *args):
            if boundary == "after_settlement":
                await original(self, *args)
            raise Crash

        with monkeypatch.context() as patch:
            patch.setattr(Drive, method, interrupt)
            with pytest.raises(Crash):
                await lane.drive(Provider())

        reopened = await Harness.open("session", SQLiteStorage(path))
        assert await reopened._session.get_value(operation_steps("op")) == 120
        reopened.on_hook("before_run_end", lambda event: {"follow_up": "continue"})
        recovered_lane = await reopened.acquire_lane("main")
        if boundary == "after_settlement":
            result = await recovered_lane.recover(Provider())
        else:
            # Deliberate resume executes the already reserved intent, never a new step.
            result = await recovered_lane.drive(Provider())
        assert result is not None
        assert result.status == "failed"
        assert result.error_code == "step_limit_exceeded"
        assert await reopened._session.get_value(operation_steps("op")) == 120

    asyncio.run(scenario())
