"""A turn's published facts must describe exactly what was committed.

The Drive publishes only after ``Session.mutate`` has returned, so each fact is
checked against the durable row it describes — the same timestamps, the same
outcomes — and a deployment that observes nothing must behave identically to
one that observes everything.
"""

import asyncio
import contextlib

from agent_harness.api.harness import Harness
from agent_harness.domain.effects import EffectSpan
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.telemetry import GenerationTelemetry, OperationTelemetry, ToolTelemetry
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.memory import MemoryStorage


class Provider:
    def __init__(self, responses: list[AssistantResult]) -> None:
        self._responses = responses
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        return self._responses[min(self.calls - 1, len(self._responses) - 1)]


class FlakyProvider:
    """Fails once, then answers: one failed attempt, then a settled one."""

    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        if self.calls == 1:
            raise TimeoutError("temporary")
        return AssistantResult(content="recovered", usage={"prompt_tokens": 7, "completion_tokens": 2})


class EchoTool:
    name = "echo"
    description = "Return the supplied value."
    input_schema = {"type": "object"}
    replay_policy = "safe"

    def __init__(self, *, fails: bool = False) -> None:
        self._fails = fails

    async def execute(self, arguments):
        if self._fails:
            return ToolExecutionResult(content={"error": "nope"}, is_error=True)
        return ToolExecutionResult(content={"echo": arguments["value"]})


class Collector:
    """A sink that keeps facts in the order the Drive published them."""

    def __init__(self) -> None:
        self.events: list = []

    def record(self, event) -> None:
        self.events.append(event)

    def of(self, kind):
        return [event for event in self.events if isinstance(event, kind)]

    @property
    def operations(self) -> list[OperationTelemetry]:
        return self.of(OperationTelemetry)

    @property
    def generations(self) -> list[GenerationTelemetry]:
        return self.of(GenerationTelemetry)

    @property
    def tools(self) -> list[ToolTelemetry]:
        return self.of(ToolTelemetry)


def _tool_turn(tool_name: str, call_id: str) -> AssistantResult:
    return AssistantResult(
        content="",
        usage={"prompt_tokens": 5, "completion_tokens": 1},
        tool_calls=(ToolCall(call_id, tool_name, {"value": "a"}),),
    )


def _generation_spans(spans: list[EffectSpan]) -> list[EffectSpan]:
    return [span for span in spans if span.kind == "llm"]


def test_a_completed_turn_publishes_its_whole_shape() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        collector = Collector()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="done", usage={})])
        harness = await Harness.open("session-1", storage, tools=(EchoTool(),), telemetry=collector)
        lane = await harness.acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")

        result = await lane.drive(provider)
        await harness.close()

        assert result.status == "completed"
        started, terminal = collector.operations
        assert (started.phase, started.kind, started.operation_id) == ("started", "run", "op-1")
        assert (started.session_id, started.lane) == ("session-1", "main")
        assert started.input == {"prompt": "run it"}
        assert (terminal.phase, terminal.status) == ("terminal", "completed")
        assert terminal.output == {"content": "done", "stop_reason": "stop", "tool_calls": []}
        # The fact that ends the turn is published last: an evaluator reading
        # the trace in order sees the answer only after every attempt.
        assert isinstance(collector.events[-1], OperationTelemetry)
        assert collector.events[-1].phase == "terminal"

        # ``attempt`` counts retries of one intent, so a turn that called the
        # model twice (tool round, then answer) shows two first attempts.
        assert [generation.attempt for generation in collector.generations] == [1, 1]
        assert [generation.finish_reason for generation in collector.generations] == ["stop", "stop"]
        assert collector.generations[-1].output == {"content": "done"}
        assert collector.generations[0].output["tool_calls"] == [
            {"id": "call-1", "name": "echo", "arguments": {"value": "a"}}
        ]
        assert collector.generations[0].usage == {"prompt_tokens": 5, "completion_tokens": 1}

        [tool] = collector.tools
        assert (tool.name, tool.tool_call_id) == ("echo", "call-1")
        assert (tool.is_error, tool.outcome) == (False, "completed")
        assert tool.input == {"value": "a"}

    asyncio.run(scenario())


def test_every_published_fact_carries_the_timestamps_it_was_committed_with() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        collector = Collector()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="done", usage={})])
        lane = await (await Harness.open("session-1", storage, tools=(EchoTool(),), telemetry=collector)).acquire_lane(
            "main"
        )
        await lane.prompt("run it", operation_id="op-1")
        await lane.drive(provider)

        spans = await storage.list_spans("op-1")
        generations = _generation_spans(spans)

        # ``started_at`` can only have been read from the committed intent, and
        # the operation's end can only have been read from its committed result.
        assert [(generation.started_at, generation.ended_at) for generation in collector.generations] == [
            (span.started_at, span.ended_at) for span in generations
        ]
        [(tool_fact, tool_span)] = zip(collector.tools, [span for span in spans if span.kind == "tool"], strict=True)
        assert (tool_fact.started_at, tool_fact.ended_at) == (tool_span.started_at, tool_span.ended_at)

        terminal = collector.operations[-1]
        assert terminal.ended_at == max(span.ended_at for span in spans if span.ended_at)
        assert terminal.started_at <= terminal.ended_at

    asyncio.run(scenario())


def test_a_tool_failure_is_published_as_a_failure() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        collector = Collector()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="recovered", usage={})])
        lane = await (
            await Harness.open("session-1", storage, tools=(EchoTool(fails=True),), telemetry=collector)
        ).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        [tool] = collector.tools
        assert (tool.is_error, tool.outcome, tool.error_class) == (True, "failed", "tool_error")
        assert collector.operations[-1].status == "completed"

    asyncio.run(scenario())


def test_a_failed_attempt_is_published_before_the_one_that_settled() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        collector = Collector()
        provider = FlakyProvider()
        harness = await Harness.open(
            "session-1", storage, retry=RetryPolicy(max_attempts=2, base_delay_ms=0), telemetry=collector
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        assert [(generation.attempt, generation.outcome) for generation in collector.generations] == [
            (1, "failed"),
            (2, "completed"),
        ]
        assert collector.generations[0].error_class == "provider_error"
        assert "temporary" in (collector.generations[0].error or "")
        # The retry is a fact about the turn, not about the answer: only the
        # settled attempt has a result.
        assert collector.operations[-1].output["content"] == "recovered"

    asyncio.run(scenario())


def test_an_interrupted_drive_publishes_an_unknown_effect() -> None:
    async def scenario() -> None:
        class BlockingTool(EchoTool):
            def __init__(self) -> None:
                super().__init__()
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def execute(self, arguments):
                self.started.set()
                await self.release.wait()
                return ToolExecutionResult(content={"echo": arguments["value"]})

        storage = MemoryStorage()
        collector = Collector()
        tool = BlockingTool()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="done", usage={})])
        lane = await (await Harness.open("session-1", storage, tools=(tool,), telemetry=collector)).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")
        drive = asyncio.create_task(lane.drive(provider))
        await tool.started.wait()
        drive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await drive

        tool.release.set()
        result = await lane.recover(provider)

        assert result is not None and result.status == "completed"
        assert [tool_fact.outcome for tool_fact in collector.tools] == ["unknown", "completed"]
        assert collector.operations[-1].status == "completed"

    asyncio.run(scenario())


def test_observing_a_turn_does_not_change_it() -> None:
    async def run(sink) -> tuple:
        storage = MemoryStorage()
        provider = Provider([_tool_turn("echo", "call-1"), AssistantResult(content="done", usage={})])
        lane = await (await Harness.open("session-1", storage, tools=(EchoTool(),), telemetry=sink)).acquire_lane(
            "main"
        )
        await lane.prompt("run it", operation_id="op-1")

        result = await lane.drive(provider)
        # Identifiers and clocks differ between two runs by construction; what a
        # turn produced must not.
        entries = [(entry.type, entry.payload) for entry in await storage.scan_branch(result.tip_id)]
        spans = sorted((span.kind, span.attempt, span.outcome) for span in await storage.list_spans("op-1"))
        usage = [(record.input_tokens, record.output_tokens) for record in await storage.list_usage("op-1")]
        return (result.status, result.error_code), entries, spans, usage

    async def scenario() -> None:
        observed = await run(Collector())
        unobserved = await run(None)

        assert observed == unobserved

    asyncio.run(scenario())


def test_a_sink_that_raises_is_still_only_a_sink() -> None:
    async def scenario() -> None:
        class RudeCollector:
            def record(self, event) -> None:
                raise RuntimeError("the observer is broken")

        storage = MemoryStorage()
        provider = Provider([AssistantResult(content="done", usage={})])
        lane = await (await Harness.open("session-1", storage, telemetry=RudeCollector())).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        [span] = await storage.list_spans("op-1")
        assert span.outcome == "completed"
        branch = await storage.scan_branch(result.tip_id)
        assert branch[-1].payload["content"] == "done"

    asyncio.run(scenario())


def test_the_published_usage_is_the_committed_usage() -> None:
    """A fact is a projection: the durable row stays the authority."""

    async def scenario() -> None:
        storage = MemoryStorage()
        collector = Collector()
        provider = Provider([AssistantResult(content="done", usage={"prompt_tokens": 1, "completion_tokens": 2})])
        lane = await (await Harness.open("session-1", storage, telemetry=collector)).acquire_lane("main")
        await lane.prompt("run it", operation_id="op-1")

        await lane.drive(provider)

        [record] = await storage.list_usage("op-1")
        assert collector.generations[0].usage == record.raw == {"prompt_tokens": 1, "completion_tokens": 2}
        assert (record.input_tokens, record.output_tokens) == (1, 2)

    asyncio.run(scenario())
