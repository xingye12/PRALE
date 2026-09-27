"""Every settled operation must leave a complete, closed effect history.

The UI reads these rows after the drive is gone, so the assertions here are
about what survives: which attempts happened, how they ended, and that no span
is still waiting for an outcome that can never arrive.
"""

import asyncio
import contextlib

from agent_harness.api.harness import Harness
from agent_harness.domain.effects import EffectSpan
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import Storage


class Provider:
    def __init__(self, responses: list[AssistantResult]) -> None:
        self._responses = responses
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        return self._responses[min(self.calls - 1, len(self._responses) - 1)]


class EchoTool:
    name = "echo"
    description = "Return the supplied value."
    input_schema = {"type": "object"}
    replay_policy = "safe"

    def __init__(self, *, name: str = "echo", fails: bool = False) -> None:
        self.name = name
        self._fails = fails
        self.calls = 0

    async def execute(self, arguments):
        self.calls += 1
        if self._fails:
            return ToolExecutionResult(content={"error": "nope"}, is_error=True)
        return ToolExecutionResult(content={"echo": arguments["value"]})


def _tool_turn(tool_name: str, call_id: str, *, parallel: bool = False) -> AssistantResult:
    return AssistantResult(
        content="",
        usage={},
        tool_calls=(ToolCall(call_id, tool_name, {"value": "a"}, parallel=parallel),),
    )


async def _assert_no_pending(storage: Storage, operation_id: str) -> list[EffectSpan]:
    spans = await storage.list_spans(operation_id)
    assert [span.outcome for span in spans] == [span.outcome for span in spans if span.settled]
    return spans


def test_a_parallel_batch_records_one_span_per_call() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        first, second = EchoTool(name="first"), EchoTool(name="second")
        provider = Provider(
            [
                AssistantResult(
                    content="",
                    usage={},
                    tool_calls=(
                        ToolCall("call-first", "first", {"value": "a"}, parallel=True),
                        ToolCall("call-second", "second", {"value": "b"}, parallel=True),
                    ),
                ),
                AssistantResult(content="done", usage={}),
            ]
        )
        lane = await (await Harness.open("session-1", storage, tools=(first, second))).acquire_lane("main")
        await lane.prompt("run both", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        spans = await _assert_no_pending(storage, "op-1")
        tool_spans = [span for span in spans if span.kind == "tool"]
        # Source order is preserved: the UI renders the batch as it was issued.
        assert [span.call_id for span in tool_spans] == ["call-first", "call-second"]
        assert [span.outcome for span in tool_spans] == ["completed", "completed"]
        assert len({span.span_id for span in tool_spans}) == 2
        assert (first.calls, second.calls) == (1, 1)

    asyncio.run(scenario())


def test_a_failing_tool_settles_its_span_as_a_tool_error() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        tool = EchoTool(fails=True)
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="recovered", usage={})])
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        [span] = [span for span in await _assert_no_pending(storage, "op-1") if span.kind == "tool"]
        assert (span.outcome, span.error_class) == ("failed", "tool_error")
        assert span.duration_ms is not None

    asyncio.run(scenario())


def test_a_blocked_or_unknown_tool_never_claims_a_completed_effect() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="blocked", usage={})])

        blocked = await Harness.open("session-1", storage, tools=(EchoTool(),))
        blocked.on_hook("before_tool", lambda event: {**event, "block": True})
        lane = await blocked.acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")
        await lane.drive(provider)

        [span] = [span for span in await _assert_no_pending(storage, "op-1") if span.kind == "tool"]
        assert (span.outcome, span.error_class) == ("aborted", "hook_blocked")

    asyncio.run(scenario())

    async def unknown_tool() -> None:
        storage = MemoryStorage()
        provider = Provider([_tool_turn("gone", "call-1"), AssistantResult(content="done", usage={})])
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-2")

        await lane.drive(provider)

        [span] = [span for span in await _assert_no_pending(storage, "op-2") if span.kind == "tool"]
        assert (span.outcome, span.error_class) == ("aborted", "unknown_tool")

    asyncio.run(unknown_tool())


def test_an_aborted_generation_closes_its_span_instead_of_leaving_it_open() -> None:
    async def scenario() -> None:
        class BlockingProvider:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def generate(self, request: GenerationRequest) -> AssistantResult:
                self.started.set()
                await self.release.wait()
                return AssistantResult(content="unreachable", usage={})

        storage = MemoryStorage()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        provider = BlockingProvider()

        drive = asyncio.create_task(lane.drive(provider))
        await provider.started.wait()
        assert (await lane.request_abort()).newly_requested
        result = await drive
        provider.release.set()

        assert result.status == "unknown"
        [span] = await _assert_no_pending(storage, "op-1")
        assert (span.kind, span.outcome, span.error_class) == ("llm", "unknown", "interrupted")
        assert span.duration_ms is None

    asyncio.run(scenario())


def test_a_compaction_records_its_own_summary_effect() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        provider = Provider([AssistantResult(content="summary text", usage={"input_tokens": 9})])
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("context", operation_id="op-1")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await lane.compact(operation_id="op-2")

        result = await lane.drive(provider)

        assert result.kind == "compaction"
        spans = await _assert_no_pending(storage, "op-2")
        assert [(span.kind, span.outcome) for span in spans] == [("llm", "completed")]
        [usage] = await storage.list_usage("op-2")
        assert usage.span_id == spans[0].span_id
        assert usage.input_tokens == 9

    asyncio.run(scenario())


def test_every_span_of_a_multi_turn_session_names_its_own_operation() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        tool = EchoTool()
        provider = Provider(
            [
                AssistantResult(content="", usage={}, tool_calls=(ToolCall("call-1", "echo", {"value": "a"}),)),
                AssistantResult(content="first turn", usage={"input_tokens": 1}),
                AssistantResult(content="second turn", usage={"input_tokens": 2}),
            ]
        )
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        await lane.prompt("one", operation_id="op-1")
        first = await lane.drive(provider)
        await lane.prompt("two", operation_id="op-2")
        second = await lane.drive(provider)

        assert (first.operation_id, second.operation_id) == ("op-1", "op-2")
        for operation_id in ("op-1", "op-2"):
            spans = await _assert_no_pending(storage, operation_id)
            assert spans, operation_id
            assert {span.operation_id for span in spans} == {operation_id}
        # A turn's spans are its own: nothing from the first turn leaks into the second.
        assert [span.kind for span in await storage.list_spans("op-1")] == ["llm", "tool", "llm"]
        assert [span.kind for span in await storage.list_spans("op-2")] == ["llm"]

    asyncio.run(scenario())


def test_a_cancelled_drive_releases_its_lease_without_stranding_a_span() -> None:
    async def scenario() -> None:
        class BlockingTool(EchoTool):
            def __init__(self) -> None:
                super().__init__()
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def execute(self, arguments):
                self.calls += 1
                self.started.set()
                await self.release.wait()
                return ToolExecutionResult(content={"echo": arguments["value"]})

        storage = MemoryStorage()
        tool = BlockingTool()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="done", usage={})])
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")
        drive = asyncio.create_task(lane.drive(provider))
        await tool.started.wait()
        drive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await drive

        tool.release.set()
        result = await lane.recover(provider)

        assert result is not None and result.status == "completed"
        spans = await _assert_no_pending(storage, "op-1")
        assert [span.outcome for span in spans if span.kind == "tool"] == ["unknown", "completed"]
        assert tool.calls == 2

    asyncio.run(scenario())
