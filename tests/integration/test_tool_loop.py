import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import RiskAssessment
from agent_harness.domain.values import operation_tool_loop
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.memory import MemoryStorage


class FailingTool:
    name = "fail"
    description = "test"
    input_schema = {"type": "object"}
    replay_policy = "safe"

    def __init__(self):
        self.calls = 0

    def assess_risk(self, arguments):
        return RiskAssessment("allow", "test")

    async def execute(self, arguments):
        self.calls += 1
        return ToolExecutionResult(content="same error", is_error=True)


class Provider:
    def __init__(self, *, change=False, batch=False):
        self.calls = 0
        self.change = change
        self.batch = batch
        self.saw_recovery = False

    async def generate(self, request):
        self.calls += 1
        assert self.calls < 8
        if self.calls == 4 or (self.batch and self.calls == 2):
            self.saw_recovery = any("loop_recovery" in str(message) for message in request.messages)
        if self.change and self.calls == 5:
            return AssistantResult(content="done", usage={})
        value = "changed" if self.change and self.calls == 4 else "same"
        calls = tuple(
            ToolCall(f"{self.calls}-{index}", "fail", {"value": value}, parallel=self.batch)
            for index in range(5 if self.batch and self.calls == 1 else 1)
        )
        return AssistantResult(content="", usage={}, tool_calls=calls)


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize("raises", [False, True])
def test_repeated_errors_quarantine_action_and_allow_one_model_recovery(batch, raises):
    async def scenario():
        tool = FailingTool()
        if raises:

            async def fail(arguments):
                tool.calls += 1
                raise TimeoutError("same error")

            tool.execute = fail
        harness = await Harness.open("session", MemoryStorage(), tools=(tool,))
        lane = await harness.acquire_lane("main")
        await lane.prompt("go", operation_id="op")
        provider = Provider(batch=batch)
        result = await lane.drive(provider)
        assert result.status == "failed"
        assert result.error_code == "tool_loop_detected"
        assert tool.calls == 3
        assert provider.calls == (2 if batch else 4)
        assert provider.saw_recovery
        await lane.prompt("new run", operation_id="next")
        # Quarantine is scoped to the operation.
        assert (await lane.drive(Provider(change=True))).status == "completed"

    asyncio.run(scenario())


def test_changed_arguments_can_recover_after_third_error():
    async def scenario():
        tool = FailingTool()
        harness = await Harness.open("session", MemoryStorage(), tools=(tool,))
        lane = await harness.acquire_lane("main")
        await lane.prompt("go", operation_id="op")
        assert (await lane.drive(Provider(change=True))).status == "completed"
        assert tool.calls == 4
        state = await harness._session.get_value(operation_tool_loop("op"))
        assert state["count"] == 1
        assert state["recovery_used"] is True

    asyncio.run(scenario())


def test_parallel_calls_use_final_hook_arguments_for_quarantine():
    class BatchProvider(Provider):
        async def generate(self, request):
            self.calls += 1
            assert self.calls <= 2
            if self.calls == 2:
                self.saw_recovery = "loop_recovery" in str(request.messages)
            return AssistantResult(
                content="",
                usage={},
                tool_calls=tuple(
                    ToolCall(f"{self.calls}-{index}", "fail", {"index": index}, parallel=True) for index in range(5)
                ),
            )

    async def scenario():
        tool = FailingTool()
        harness = await Harness.open("session", MemoryStorage(), tools=(tool,))
        harness.on_hook("before_tool", lambda event: {**event, "arguments": {"final": True}})
        lane = await harness.acquire_lane("main")
        await lane.prompt("go", operation_id="op")
        provider = BatchProvider()
        result = await lane.drive(provider)
        assert result.error_code == "tool_loop_detected"
        assert tool.calls == 3
        assert provider.saw_recovery

    asyncio.run(scenario())
