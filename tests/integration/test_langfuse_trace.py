"""The trace Langfuse actually receives, asserted against the real SDK.

Skipped where the extra is not installed, because the runtime does not depend
on it.  The client is built once for the whole module and shared: OpenTelemetry
allows a single global tracer provider per process, so a second client would
export through the first one's exporter and an assertion here could pass
against a trace this file never made.

Everything below is read back out of the SDK's own span objects, after
``aclose()`` has flushed them — the same path a Langfuse deployment sees.
"""

import asyncio
import hashlib
import json
from typing import Any

import pytest

pytest.importorskip("langfuse")

from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter  # noqa: E402

from agent_harness.api.harness import Harness  # noqa: E402
from agent_harness.integrations.langfuse import LangfuseConfig, LangfuseTelemetry  # noqa: E402
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall  # noqa: E402
from agent_harness.runtime.tools import ToolExecutionResult  # noqa: E402
from agent_harness.storage.memory import MemoryStorage  # noqa: E402
from agent_harness.storage.protocol import Storage  # noqa: E402

BASE_URL = "http://langfuse.invalid"
RELEASE = "v0.0.0-test"
ENVIRONMENT = "staging"
MODEL = "prale-test-model"

PROMPT = "summarise the readme"
ANSWER = "The readme describes a durable agent runtime."
FILE_TEXT = "the readme"

_EXPORTER = InMemorySpanExporter()
_CLIENT: Any = None


class ScriptedProvider:
    """Every turn first asks for the file, then answers."""

    model = MODEL

    def __init__(self) -> None:
        self.requests: list[GenerationRequest] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        if len(self.requests) % 2:
            return AssistantResult(
                content="",
                usage={"prompt_tokens": 40, "completion_tokens": 8},
                tool_calls=(ToolCall(f"call-{len(self.requests)}", "read", {"path": "README.md"}),),
            )
        return AssistantResult(content=ANSWER, usage={"prompt_tokens": 60, "completion_tokens": 12})


class ReadTool:
    """A stand-in for the repository reader: the trace shape is what matters."""

    name = "read"
    description = "Read a file."
    input_schema = {"type": "object", "properties": {"path": {"type": "string"}}}
    replay_policy = "safe"

    def __init__(self, *, fails: bool = False) -> None:
        self._fails = fails

    async def execute(self, arguments):
        if self._fails:
            return ToolExecutionResult(content={"error": "no such file"}, is_error=True)
        return ToolExecutionResult(content={"path": arguments["path"], "text": FILE_TEXT})


@pytest.fixture(scope="module", autouse=True)
def _client() -> Any:
    global _CLIENT
    from langfuse import Langfuse

    _CLIENT = Langfuse(
        public_key="pk-lf-test",
        secret_key="sk-lf-test",
        base_url=BASE_URL,
        environment=ENVIRONMENT,
        release=RELEASE,
        span_exporter=_EXPORTER,
        tracing_enabled=True,
    )
    yield _CLIENT


@pytest.fixture(autouse=True)
def _clean_exporter() -> None:
    _EXPORTER.clear()


async def _run(
    *, capture: str = "redacted", tools: tuple = (), turns: int = 1
) -> tuple[Storage, list, LangfuseTelemetry]:
    config = LangfuseConfig(
        public_key="pk-lf-test",
        secret_key="sk-lf-test",
        base_url=BASE_URL,
        capture=capture,
        environment=ENVIRONMENT,
        release=RELEASE,
    )
    sink = LangfuseTelemetry(config, client=_CLIENT)
    storage = MemoryStorage()
    harness = await Harness.open("session-1", storage, tools=tools or (ReadTool(),), telemetry=sink)
    lane = await harness.acquire_lane("main")
    provider = ScriptedProvider()
    results = []
    for turn in range(turns):
        await lane.prompt(f"{PROMPT} #{turn + 1}", operation_id=f"op-{turn + 1}")
        results.append(await lane.drive(provider))
    await harness.close()
    await sink.aclose()
    return storage, results, sink


def _finished() -> list:
    return sorted(_EXPORTER.get_finished_spans(), key=lambda span: span.start_time)


def _root() -> Any:
    return next(span for span in _finished() if span.name == "prale.run")


def _children(root: Any) -> list:
    return [span for span in _finished() if span.parent is not None and span.parent.span_id == root.context.span_id]


def _attributes(span: Any) -> dict:
    """Span attributes with the resource's own on top: what Langfuse stores."""

    return {**dict(span.resource.attributes), **dict(span.attributes)}


def _observation(span: Any, field: str) -> Any:
    """A structured observation field, as Langfuse stores it.

    The SDK serializes anything that is not a scalar into the attribute, so
    this is the decoding a Langfuse reader does on the other side.
    """

    return json.loads(_attributes(span)[f"langfuse.observation.{field}"])


def _duration_ms(span: Any) -> float:
    return (span.end_time - span.start_time) / 1_000_000


def _everything(spans: list) -> str:
    return json.dumps([_attributes(span) for span in spans], default=str)


def test_a_turn_arrives_as_one_trace_with_typed_children() -> None:
    storage, [result], _ = asyncio.run(_run())

    root = _root()
    assert _attributes(root)["langfuse.observation.type"] == "agent"
    assert _attributes(root)["langfuse.internal.is_app_root"] is True
    # The deployment's identity travels with every span in the trace.
    assert _attributes(root)["langfuse.environment"] == ENVIRONMENT
    assert _attributes(root)["langfuse.release"] == RELEASE
    assert _attributes(root)["langfuse.version"] == RELEASE
    assert _attributes(root)["session.id"] == "session-1"
    assert "prale" in _attributes(root)["langfuse.trace.tags"]
    assert _attributes(root)["langfuse.trace.metadata.operation_id"] == "op-1"
    # The trace's input and output are the root observation's, which is what an
    # evaluator binds a dataset item to.
    assert _observation(root, "input") == {"prompt": f"{PROMPT} #1"}
    assert _observation(root, "output")["content"] == ANSWER

    generations = [span for span in _children(root) if span.name == "prale.generate"]
    [tool] = [span for span in _children(root) if span.name.startswith("prale.tool.")]
    assert [span.name for span in _children(root)] == ["prale.generate", "prale.tool.read", "prale.generate"]
    assert [_attributes(span)["langfuse.observation.type"] for span in generations] == ["generation", "generation"]
    assert _attributes(tool)["langfuse.observation.type"] == "tool"
    # The trace's identity is on the children too, not only on the root.
    assert {_attributes(span)["session.id"] for span in _children(root)} == {"session-1"}
    assert result.status == "completed"


def test_a_generation_carries_the_model_the_usage_and_the_answer() -> None:
    asyncio.run(_run())

    root = _root()
    generation, tool, answer = _children(root)

    assert _attributes(generation)["langfuse.observation.model.name"] == MODEL
    assert _observation(generation, "usage_details") == {"input": 40, "output": 8, "total": 48}
    assert _attributes(generation)["langfuse.observation.metadata.attempt"] == 1
    # The requested tool call is in the generation that asked for it, so a
    # reader can see why the run continued without reading the next span.
    assert _observation(generation, "output")["tool_calls"] == [
        {"id": "call-1", "name": "read", "arguments": {"path": "README.md"}}
    ]
    assert _observation(answer, "output")["content"] == ANSWER
    assert _observation(tool, "input") == {"path": "README.md"}
    assert _attributes(tool)["langfuse.observation.metadata.tool_call_id"] == "call-1"
    assert _attributes(tool)["langfuse.observation.level"] == "DEFAULT"


def test_observations_are_timed_by_the_effects_and_not_by_the_exporter() -> None:
    async def scenario() -> None:
        storage, [result], _ = await _run()
        spans = await storage.list_spans("op-1")

        # Every observation lasts exactly as long as the durable effect it
        # reports: a latency dashboard built on these sees the model, not the
        # worker that got around to uploading the fact.
        root = _root()
        children = _children(root)
        assert [span.name for span in children] == ["prale.generate", "prale.tool.read", "prale.generate"]
        assert _duration_ms(root) == result.ended_at - result.started_at
        # A turn's effects can begin inside the same millisecond, so the claim
        # is made about the durations themselves and not about their order.
        assert sorted(_duration_ms(span) for span in children) == sorted(
            span.ended_at - span.started_at for span in spans
        )
        # And each one sits inside the turn it belongs to.
        for child in children:
            assert root.start_time <= child.start_time
            assert child.end_time <= root.end_time

    asyncio.run(scenario())


def test_a_failed_tool_is_an_error_span() -> None:
    asyncio.run(_run(tools=(ReadTool(fails=True),)))

    [_generation, tool, _answer] = _children(_root())
    attributes = _attributes(tool)
    assert attributes["langfuse.observation.level"] == "ERROR"
    assert attributes["langfuse.observation.status_message"] == "tool_error"
    assert attributes["langfuse.observation.metadata.is_error"] is True
    assert _observation(tool, "output")["is_error"] is True


def test_two_turns_share_one_langfuse_session() -> None:
    async def scenario() -> None:
        _storage, results, _ = await _run(turns=2)

        roots = [span for span in _finished() if span.name == "prale.run"]
        assert [result.operation_id for result in results] == ["op-1", "op-2"]
        assert {_attributes(span)["session.id"] for span in roots} == {"session-1"}
        assert {_attributes(span)["langfuse.trace.metadata.operation_id"] for span in roots} == {"op-1", "op-2"}
        # Two turns, one session: four observations each, and the session is the
        # unit an evaluator groups by.
        assert len(_finished()) == 8

    asyncio.run(scenario())


def test_the_metadata_profile_uploads_no_text_from_the_turn() -> None:
    asyncio.run(_run(capture="metadata"))

    uploaded = _everything(_finished())
    for text in (PROMPT, ANSWER, FILE_TEXT, "README.md"):
        assert text not in uploaded
    # It still says *what* was sent, only never the text itself: a length and a
    # stable digest, which is what lets two runs of the same prompt be matched.
    root = _root()
    assert _observation(root, "input")["prompt"] == {
        "chars": len(f"{PROMPT} #1"),
        "sha256": hashlib.sha256(f"{PROMPT} #1".encode()).hexdigest()[:12],
    }
    assert _attributes(root)["langfuse.observation.metadata.capture"] == "metadata"


def test_the_redacted_profile_uploads_the_turn_with_its_numbers() -> None:
    asyncio.run(_run(capture="redacted"))

    uploaded = _everything(_finished())
    assert PROMPT in uploaded
    assert ANSWER in uploaded
    assert FILE_TEXT in uploaded
