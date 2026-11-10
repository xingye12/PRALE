import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import RiskAssessment
from agent_harness.domain.tool_loop import observe
from agent_harness.domain.values import operation_tool_loop
from agent_harness.runtime.drive import Drive
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


@pytest.mark.parametrize("boundary", ["before_effect", "after_effect", "after_settlement"])
def test_third_error_quarantine_is_atomic_and_survives_recovery(tmp_path, monkeypatch, boundary):
    class Crash(BaseException):
        pass

    class Tool:
        name = "fail"
        description = "test"
        input_schema = {"type": "object"}
        replay_policy = "safe"
        calls = 0

        def assess_risk(self, arguments):
            return RiskAssessment("allow", "test")

        async def execute(self, arguments):
            self.calls += 1
            return ToolExecutionResult(content="err", is_error=True)

    class Provider:
        calls = 0

        async def generate(self, request):
            self.calls += 1
            assert self.calls <= 2
            return AssistantResult(content="", usage={}, tool_calls=(ToolCall(f"call-{self.calls}", "fail", {}),))

    async def scenario():
        path = tmp_path / "loop.sqlite"
        tool = Tool()
        provider = Provider()
        harness = await Harness.open("session", SQLiteStorage(path), tools=(tool,))
        lane = await harness.acquire_lane("main")
        await lane.prompt("go", operation_id="op")
        state = {}
        for _ in range(2):
            state, _ = observe(state, "fail", {}, {"content": "err", "is_error": True}, "failed")

        async def seed(mutator):
            await mutator.commit([SetValue(operation_tool_loop("op"), state)])

        await harness._session.mutate(seed)
        method = "_transition_tool" if boundary == "before_effect" else "_settle_tool"
        original = getattr(Drive, method)

        async def interrupt(self, *args, **kwargs):
            if boundary in ("before_effect", "after_settlement"):
                await original(self, *args, **kwargs)
            raise Crash

        with monkeypatch.context() as patch:
            patch.setattr(Drive, method, interrupt)
            with pytest.raises(Crash):
                await lane.drive(provider)
        reopened = await Harness.open("session", SQLiteStorage(path), tools=(tool,))
        persisted = await reopened._session.get_value(operation_tool_loop("op"))
        assert persisted["count"] == (3 if boundary == "after_settlement" else 2)
        recovered_lane = await reopened.acquire_lane("main")
        result = await recovered_lane.recover(provider)
        assert result.status == "failed"
        assert result.error_code == "tool_loop_detected"
        assert tool.calls == (2 if boundary == "after_effect" else 1)
        persisted = await reopened._session.get_value(operation_tool_loop("op"))
        assert persisted["count"] == 3
        assert persisted["blocked"]
        assert persisted["recovery_used"] is True
        assert persisted["recovery_pending"] is False

    asyncio.run(scenario())
