import asyncio
import contextlib

from agent_harness.api.harness import Harness
from agent_harness.domain.values import operation_state
from agent_harness.runtime.generation import AssistantResult, GenerationDelta, GenerationRequest, ToolCall
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.tools import ToolExecutionResult, ToolRegistry
from agent_harness.storage.memory import MemoryStorage


class SuccessfulProvider:
    def __init__(self) -> None:
        self.requests: list[GenerationRequest] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        return AssistantResult(content="hello", usage={"input_tokens": 3, "output_tokens": 1})


class BlockingProvider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        self.started.set()
        await self.release.wait()
        return AssistantResult(content="unreachable", usage={})


class FailingProvider:
    async def generate(self, request: GenerationRequest) -> AssistantResult:
        raise TimeoutError("provider timed out")


class StreamingBlockingProvider:
    def __init__(self) -> None:
        self.first_frame = asyncio.Event()
        self.release = asyncio.Event()

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        raise AssertionError("streaming capability should be used")

    async def stream(self, request: GenerationRequest):
        yield GenerationDelta("partial")
        self.first_frame.set()
        await self.release.wait()
        yield AssistantResult(content="partial final", usage={})


class FlakyProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        if self.calls == 1:
            raise TimeoutError("temporary")
        return AssistantResult(content="recovered", usage={})


class EchoTool:
    name = "echo"
    description = "Return the supplied value."
    input_schema = {"type": "object"}
    replay_policy = "safe"

    async def execute(self, arguments):
        return ToolExecutionResult(content={"echo": arguments["value"]})


class BlockingSafeTool(EchoTool):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0

    async def execute(self, arguments):
        self.calls += 1
        self.started.set()
        await self.release.wait()
        return ToolExecutionResult(content={"echo": arguments["value"]})


class ToolThenTextProvider:
    def __init__(self) -> None:
        self.requests: list[GenerationRequest] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        if len(self.requests) == 1:
            return AssistantResult(
                content="",
                usage={},
                tool_calls=(ToolCall("call-1", "echo", {"value": "hi"}),),
            )
        return AssistantResult(content="tool completed", usage={})


class ParallelToolProvider:
    def __init__(self) -> None:
        self.requests: list[GenerationRequest] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        if len(self.requests) == 1:
            return AssistantResult(
                content="",
                usage={},
                tool_calls=(
                    ToolCall("call-first", "first", {"value": "a"}, parallel=True),
                    ToolCall("call-second", "second", {"value": "b"}, parallel=True),
                ),
            )
        return AssistantResult(content="done", usage={})


class RecordingTool:
    description = "records its invocation"
    input_schema = {"type": "object"}
    replay_policy = "safe"

    def __init__(self, name: str, started: list[str]) -> None:
        self.name = name
        self._started = started

    async def execute(self, arguments):
        self._started.append(self.name)
        await asyncio.sleep(0)
        return ToolExecutionResult(content={"tool": self.name, "value": arguments["value"]})


def test_generation_intent_is_settled_atomically_with_message_usage_tip_and_result() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = SuccessfulProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        assert result.tip_id is not None
        assert provider.requests[0].messages == ({"role": "user", "content": "hi"},)
        assert (await lane.snapshot()).operation_id is None
        entries = await storage.scan_branch(result.tip_id)
        assert [entry.payload for entry in entries] == [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello", "stop_reason": "stop"},
        ]

    asyncio.run(scenario())


def test_recovery_marks_an_unknown_provider_outcome_as_unknown_without_replaying_it() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = BlockingProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        task = asyncio.create_task(lane.drive(provider))
        await provider.started.wait()
        intent = await storage.get_value(operation_state("op-1"))
        assert intent.at == "assistant.effect_pending"
        assert intent.data["messages"] == [{"role": "user", "content": "hi"}]

        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

        recovered_lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        result = await recovered_lane.recover()

        assert result is not None
        assert result.status == "unknown"
        entries = await storage.scan_branch(result.tip_id)
        assert entries[-1].payload["stop_reason"] == "aborted"
        assert not provider.release.is_set()

    asyncio.run(scenario())


def test_streamed_content_is_checkpointed_and_preserved_when_the_effect_is_interrupted() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = StreamingBlockingProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        task = asyncio.create_task(lane.drive(provider))
        await provider.first_frame.wait()
        intent = await storage.get_value(operation_state("op-1"))
        assert intent.data["content_checkpoint"] == "partial"
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

        result = await (await (await Harness.open("session-1", storage)).acquire_lane("main")).recover()
        assert result is not None and result.status == "unknown"
        assert (await storage.scan_branch(result.tip_id))[-1].payload["content"] == "partial"

    asyncio.run(scenario())


def test_provider_failure_is_settled_as_unknown_instead_of_being_left_replayable() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        result = await lane.drive(FailingProvider())

        assert result.status == "unknown"
        assert (await lane.snapshot()).operation_id is None
        assert (await lane.recover()) is None

    asyncio.run(scenario())


def test_agent_loop_persists_tool_result_then_makes_the_next_provider_request() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = ToolThenTextProvider()
        harness = await Harness.open("session-1", storage, tools=(EchoTool(),))
        lane = await harness.acquire_lane("main")
        await lane.prompt("use echo", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        assert len(provider.requests) == 2
        assert provider.requests[0].tools[0].name == "echo"
        assert provider.requests[1].messages[-1] == {
            "role": "tool",
            "tool_call_id": "call-1",
            "content": {"echo": "hi"},
            "is_error": False,
            "terminate": False,
        }

    asyncio.run(scenario())


def test_parallel_tool_batch_settles_entries_in_assistant_source_order() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        started: list[str] = []
        provider = ParallelToolProvider()
        lane = await (
            await Harness.open(
                "session-1",
                storage,
                tools=(RecordingTool("first", started), RecordingTool("second", started)),
            )
        ).acquire_lane("main")
        await lane.prompt("run both", operation_id="op-1")

        result = await lane.drive(provider)
        entries = await storage.scan_branch(result.tip_id)

        assert set(started) == {"first", "second"}
        assert [entry.payload.get("tool_call_id") for entry in entries if entry.payload.get("role") == "tool"] == [
            "call-first",
            "call-second",
        ]
        tool_messages = [message for message in provider.requests[1].messages if message.get("role") == "tool"]
        assert [message["tool_call_id"] for message in tool_messages] == [
            "call-first",
            "call-second",
        ]

    asyncio.run(scenario())


def test_two_harness_instances_do_not_execute_the_same_operation_twice() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = BlockingProvider()
        first_lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await first_lane.prompt("hi", operation_id="op-1")
        second_lane = await (await Harness.open("session-1", storage)).acquire_lane("main")

        first = asyncio.create_task(first_lane.drive(provider))
        await provider.started.wait()
        second = asyncio.create_task(second_lane.drive(provider))
        await asyncio.sleep(0)
        assert not second.done()
        provider.release.set()
        first_result, second_result = await asyncio.gather(first, second)

        assert provider.calls == 1
        assert first_result.operation_id == second_result.operation_id == "op-1"

    asyncio.run(scenario())


def test_abort_before_effect_prevents_the_provider_request() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = SuccessfulProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        assert (await lane.request_abort()).newly_requested
        result = await lane.drive(provider)

        assert result.status == "aborted"
        assert provider.requests == []

    asyncio.run(scenario())


def test_abort_during_provider_effect_cancels_local_drive_and_settles_interrupted() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = BlockingProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        drive = asyncio.create_task(lane.drive(provider))
        await provider.started.wait()
        assert (await lane.request_abort()).newly_requested
        result = await drive

        assert result.status == "unknown"
        assert result.error_code == "interrupted"

    asyncio.run(scenario())


def test_provider_failure_retries_from_durable_retry_wait_state() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = FlakyProvider()
        harness = await Harness.open("session-1", storage, retry=RetryPolicy(max_attempts=2, base_delay_ms=0))
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        assert provider.calls == 2

    asyncio.run(scenario())


def test_queued_steering_is_consumed_into_the_next_provider_context() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = SuccessfulProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.queue_steer("queued")
        await lane.prompt("initial", operation_id="op-1")

        await lane.drive(provider)

        assert provider.requests[0].messages == (
            {"role": "user", "content": "initial"},
            {"role": "user", "content": "queued"},
        )

    asyncio.run(scenario())


def test_compaction_uses_a_separate_summary_effect_and_commits_a_compaction_entry() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = SuccessfulProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("context", operation_id="op-1")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await lane.compact(operation_id="op-2")

        result = await lane.drive(provider)
        entries = await storage.scan_branch(result.tip_id)

        assert result.kind == "compaction"
        assert entries[-1].type == "compaction"
        assert entries[-1].payload["summary"] == "hello"
        assert entries[-1].payload["retained_message_ids"]

    asyncio.run(scenario())


def test_compaction_hook_can_decline_or_supply_a_durable_summary_without_provider_io() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        lane = await harness.acquire_lane("main")
        await lane.prompt("context", operation_id="op-1")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        harness.on_hook("before_compaction", lambda event: {**event, "summary": "custom"})
        await lane.compact(operation_id="op-2")

        result = await lane.drive(None)  # type: ignore[arg-type]
        assert result.status == "completed"
        payload = (await storage.scan_branch(result.tip_id))[-1].payload
        assert payload["summary"] == "custom"
        assert payload["retained_message_ids"]

    asyncio.run(scenario())


def test_generation_after_compaction_uses_summary_projection_instead_of_full_history() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = SuccessfulProvider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("old", operation_id="op-1")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await lane.compact(operation_id="op-2")
        await lane.drive(provider)
        await lane.prompt("new", operation_id="op-3")

        await lane.drive(provider)

        messages = provider.requests[-1].messages
        assert messages[0] == {"role": "system", "content": "Conversation summary:\nhello"}
        assert messages[-1] == {"role": "user", "content": "new"}

    asyncio.run(scenario())


def test_request_and_response_hooks_are_consumed_by_the_generation_effect() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        harness.on_hook(
            "before_request",
            lambda event: {"messages": [*event["messages"], {"role": "system", "content": "x"}]},
        )
        harness.on_hook("after_response", lambda event: {**event, "content": "rewritten"})
        provider = SuccessfulProvider()
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        result = await lane.drive(provider)
        entries = await storage.scan_branch(result.tip_id)

        assert provider.requests[0].messages[-1] == {"role": "system", "content": "x"}
        assert entries[-1].payload["content"] == "rewritten"

    asyncio.run(scenario())


def test_context_and_payload_hooks_are_durably_consumed_before_provider_effect() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        harness.on_hook("transform_context", lambda event: {"messages": [{"role": "system", "content": "context"}]})
        harness.on_hook(
            "before_payload", lambda event: {"messages": [*event["messages"], {"role": "system", "content": "payload"}]}
        )
        provider = SuccessfulProvider()
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        await lane.drive(provider)

        assert provider.requests[0].messages == (
            {"role": "system", "content": "context"},
            {"role": "system", "content": "payload"},
        )
        intent = await storage.get_value(operation_state("op-1"))
        assert intent.at == "terminal"

    asyncio.run(scenario())


def test_safe_tool_effect_is_replayed_after_interruption() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        tool = BlockingSafeTool()
        provider = ToolThenTextProvider()
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        await lane.prompt("use echo", operation_id="op-1")

        first = asyncio.create_task(lane.drive(provider))
        await tool.started.wait()
        first.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await first

        tool.release.set()
        result = await lane.resume(provider)

        assert result.status == "completed"
        assert tool.calls == 2
        assert len(provider.requests) == 2

    asyncio.run(scenario())


def test_before_tool_hook_failure_blocks_the_tool_instead_of_executing_it() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        tool = BlockingSafeTool()
        harness = await Harness.open("session-1", storage, tools=(tool,))
        harness.on_hook("before_tool", lambda event: (_ for _ in ()).throw(RuntimeError("policy unavailable")))
        lane = await harness.acquire_lane("main")
        await lane.prompt("use echo", operation_id="op-1")

        result = await lane.drive(ToolThenTextProvider())

        assert result.status == "completed"
        assert tool.calls == 0
        entries = await storage.scan_branch(result.tip_id)
        assert entries[-1].payload["is_error"] is True

    asyncio.run(scenario())


def test_recover_replays_a_safe_tool_effect_instead_of_marking_it_unknown() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        tool = BlockingSafeTool()
        provider = ToolThenTextProvider()
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        await lane.prompt("use echo", operation_id="op-1")

        first = asyncio.create_task(lane.drive(provider))
        await tool.started.wait()
        first.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await first
        tool.release.set()

        result = await (await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")).recover(
            provider
        )
        assert result is not None and result.status == "completed"
        assert tool.calls == 2

    asyncio.run(scenario())


def test_before_run_end_follow_up_continues_the_agent_loop() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        called = False

        def follow_up(event):
            nonlocal called
            if called:
                return event
            called = True
            return {"follow_up": "continue"}

        harness.on_hook("before_run_end", follow_up)
        provider = SuccessfulProvider()
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        assert len(provider.requests) == 2
        assert provider.requests[1].messages[-1] == {"role": "user", "content": "continue"}

    asyncio.run(scenario())


def test_parallel_tool_registry_returns_results_in_source_order() -> None:
    async def scenario() -> None:
        first = BlockingSafeTool()
        first.name = "slow"
        second = EchoTool()
        first.release.set()
        registry = ToolRegistry((first, second))

        results = await registry.execute_parallel((("slow", {"value": "first"}), ("echo", {"value": "second"})))

        assert [result.content for result in results] == [{"echo": "first"}, {"echo": "second"}]

    asyncio.run(scenario())
