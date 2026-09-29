"""The adapter's own behaviour: mapping, queueing, failure containment.

These tests use a stand-in for the SDK, so they run in a deployment that did
not install the extra.  Two things are being asserted throughout: that the
mapping puts each fact where an evaluator will look for it, and that nothing
the adapter does can reach the turn that produced the fact.
"""

import asyncio
import contextlib
import logging
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

from agent_harness.api.errors import ProjectConfigError
from agent_harness.integrations import langfuse as adapter
from agent_harness.integrations.langfuse import LangfuseConfig, LangfuseTelemetry
from agent_harness.runtime.telemetry import GenerationTelemetry, OperationTelemetry, ToolTelemetry

_SRC = Path(__file__).resolve().parents[2] / "src"

MESSAGES = [{"role": "user", "content": "run it"}]


class FakeObservation:
    """Stands in for the SDK's observation: it records what it was told."""

    def __init__(self, **attributes) -> None:
        self.attributes = attributes
        self.children: list[FakeObservation] = []
        self.updates: list[dict] = []
        self.ended = False
        self.ended_at: int | None = None

    @property
    def name(self) -> str:
        return self.attributes["name"]

    def start_observation(self, **attributes) -> "FakeObservation":
        child = FakeObservation(**attributes)
        self.children.append(child)
        return child

    def update(self, **attributes) -> None:
        self.updates.append(attributes)

    def end(self, *, end_time: int | None = None) -> None:
        self.ended = True
        self.ended_at = end_time


class FakeClient:
    """The slice of the SDK the adapter uses, with no SDK installed."""

    def __init__(self, *, refusing: str | None = None, flush_fails: bool = False) -> None:
        self.roots: list[FakeObservation] = []
        self.flushes = 0
        self.shutdowns = 0
        self._refusing = refusing
        self._flush_fails = flush_fails

    def start_observation(self, **attributes) -> FakeObservation:
        if self._refusing == attributes.get("name"):
            raise RuntimeError("the SDK refused this observation")
        root = FakeObservation(**attributes)
        self.roots.append(root)
        return root

    def flush(self) -> None:
        self.flushes += 1
        if self._flush_fails:
            raise RuntimeError("the exporter is unreachable")

    def shutdown(self) -> None:
        self.shutdowns += 1


@pytest.fixture(autouse=True)
def _no_sdk_propagation(monkeypatch: pytest.MonkeyPatch) -> None:
    """Access to the SDK's attribute propagation is tested against the SDK."""

    monkeypatch.setattr(adapter, "_propagate", lambda **attributes: contextlib.nullcontext())


def _config(**overrides) -> LangfuseConfig:
    fields = {"public_key": "pk", "secret_key": "sk", "base_url": "http://localhost", "capture": "redacted"}
    return LangfuseConfig(**{**fields, **overrides})


def _started(operation_id: str = "op-1", *, kind: str = "run", input=({"prompt": "run it"})) -> OperationTelemetry:
    return OperationTelemetry(
        session_id="session-1",
        lane="main",
        operation_id=operation_id,
        kind=kind,
        phase="started",
        input=input,
        started_at=1_000,
    )


def _terminal(operation_id: str = "op-1", *, status: str = "completed", output=({"content": "done"})):
    return OperationTelemetry(
        session_id="session-1",
        lane="main",
        operation_id=operation_id,
        kind="run",
        phase="terminal",
        output=output,
        status=status,
        error_code=None if status == "completed" else "provider_error",
        started_at=1_000,
        ended_at=2_000,
    )


def _generation(*, outcome: str = "completed", attempt: int = 1) -> GenerationTelemetry:
    return GenerationTelemetry(
        session_id="session-1",
        lane="main",
        operation_id="op-1",
        attempt=attempt,
        model="deepseek-flash",
        input=MESSAGES,
        output={"content": "done"},
        usage={"prompt_tokens": 12, "completion_tokens": 3},
        finish_reason="stop",
        outcome=outcome,
        error_class=None if outcome == "completed" else "provider_error",
        started_at=1_100,
        ended_at=1_500,
    )


def _tool(*, is_error: bool = False) -> ToolTelemetry:
    return ToolTelemetry(
        session_id="session-1",
        lane="main",
        operation_id="op-1",
        tool_call_id="call-1",
        name="read",
        attempt=1,
        input={"path": "src/main.py"},
        output={"content": "file text"},
        is_error=is_error,
        outcome="failed" if is_error else "completed",
        error_class="tool_error" if is_error else None,
        started_at=1_600,
        ended_at=1_700,
    )


def test_one_operation_becomes_a_root_with_typed_children() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_started())
        sink.record(_generation())
        sink.record(_tool())
        sink.record(_terminal())
        await sink.aclose()

        [root] = client.roots
        assert (root.name, root.attributes["as_type"]) == ("prale.run", "agent")
        assert root.attributes["input"] == {"prompt": "run it"}
        assert root.attributes["metadata"]["operation_id"] == "op-1"
        assert root.updates[0]["output"] == {"content": "done"}
        assert root.updates[0]["metadata"]["status"] == "completed"

        generation, tool = root.children
        assert (generation.name, generation.attributes["as_type"]) == ("prale.generate", "generation")
        assert generation.attributes["model"] == "deepseek-flash"
        assert generation.attributes["input"] == MESSAGES
        assert generation.attributes["usage_details"] == {"input": 12, "output": 3, "total": 15}
        assert generation.attributes["metadata"]["attempt"] == 1

        assert (tool.name, tool.attributes["as_type"]) == ("prale.tool.read", "tool")
        assert tool.attributes["metadata"]["tool_call_id"] == "call-1"
        assert tool.attributes["metadata"]["is_error"] is False

    asyncio.run(scenario())


def test_an_observation_is_timed_by_the_effect_not_by_the_exporter() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)
        sink.record(_started())
        sink.record(_generation())
        sink.record(_terminal())
        await sink.aclose()

        [root] = client.roots
        assert root.ended_at == 2_000_000_000
        assert root.children[0].ended_at == 1_500_000_000

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("outcome", "level"),
    [("completed", "DEFAULT"), ("failed", "ERROR"), ("aborted", "WARNING"), ("unknown", "ERROR")],
)
def test_a_level_follows_the_outcome(outcome: str, level: str) -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)
        sink.record(_started())
        sink.record(_generation(outcome=outcome))
        await sink.aclose()

        assert client.roots[0].children[0].attributes["level"] == level

    asyncio.run(scenario())


def test_a_generation_without_its_announcement_still_produces_a_closed_trace() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_generation())
        await sink.aclose()

        [root] = client.roots
        assert root.ended
        assert [child.name for child in root.children] == ["prale.generate"]

    asyncio.run(scenario())


def test_a_resumed_drive_does_not_open_a_second_trace() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_started())
        sink.record(_started())
        sink.record(_terminal())
        await sink.aclose()

        assert len(client.roots) == 1
        assert client.roots[0].ended_at is not None

    asyncio.run(scenario())


def test_a_full_queue_keeps_the_ending_and_drops_the_rest() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(queue_size=2), client=client)

        sink.record(_generation(attempt=1))
        sink.record(_generation(attempt=2))
        sink.record(_generation(attempt=3))  # dropped: the queue is full
        sink.record(_terminal())  # accepted: it displaces the oldest fact
        assert sink.dropped == 2
        assert sink.failed == 0

        await sink.aclose()

        [root] = client.roots
        assert [child.attributes["metadata"]["attempt"] for child in root.children] == [2]
        assert root.updates[0]["output"] == {"content": "done"}

    asyncio.run(scenario())


def test_a_refused_observation_costs_a_trace_not_a_turn() -> None:
    async def scenario() -> None:
        client = FakeClient(refusing="prale.run")
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_started())  # must not raise
        sink.record(_terminal())
        await sink.aclose()

        assert (sink.failed, sink.dropped) == (2, 0)
        assert client.roots == []
        assert client.flushes == 1

    asyncio.run(scenario())


def test_a_failing_exporter_does_not_fail_the_close() -> None:
    async def scenario() -> None:
        client = FakeClient(flush_fails=True)
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_started())
        await sink.aclose()  # must not raise

        assert client.flushes == 1
        # The client was injected, so this adapter does not own its shutdown.
        assert client.shutdowns == 0

    asyncio.run(scenario())


def test_the_worker_starts_with_the_first_fact_and_not_with_the_adapter() -> None:
    async def scenario() -> None:
        before = set(asyncio.all_tasks())
        sink = LangfuseTelemetry(_config(), client=FakeClient())
        assert set(asyncio.all_tasks()) == before

        sink.record(_started())
        assert set(asyncio.all_tasks()) != before
        await sink.aclose()

    asyncio.run(scenario())


def test_drain_waits_for_every_fact_to_become_an_observation() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_started())
        sink.record(_generation())
        sink.record(_terminal())
        # The worker is a task and nothing has been awaited since the facts were
        # queued, so this is the state a caller sees before draining.
        assert client.roots == []

        await sink.drain()

        [root] = client.roots
        assert [child.name for child in root.children] == ["prale.generate"]
        assert root.updates[0]["output"] == {"content": "done"}
        await sink.aclose()

    asyncio.run(scenario())


def test_drain_is_a_no_op_when_there_is_nothing_to_drain() -> None:
    async def scenario() -> None:
        sink = LangfuseTelemetry(_config(), client=FakeClient())

        await sink.drain()  # no fact was ever recorded, so no worker exists
        sink.record(_started())
        await sink.aclose()
        await sink.drain()  # the worker is closed, which is also "nothing"

    asyncio.run(scenario())


def test_a_worker_left_on_a_closed_loop_is_replaced_rather_than_reused() -> None:
    """The loop a fact was recorded on is not always the one that closes it.

    The Langfuse experiment runner drives each run on a loop of its own, so a
    worker parked on the previous run's loop would leave every later fact
    queued forever.
    """

    client = FakeClient()
    sink = LangfuseTelemetry(_config(), client=client)

    async def first_run() -> None:
        sink.record(_started())  # the worker is created here, on a loop that ends

    asyncio.run(first_run())

    async def second_run() -> None:
        sink.record(_terminal())
        await sink.drain()

    asyncio.run(second_run())

    [root] = client.roots
    assert root.updates[0]["output"] == {"content": "done"}
    assert sink.dropped == 0


def test_closing_from_another_loop_neither_hangs_nor_loses_a_fact_silently() -> None:
    client = FakeClient()
    sink = LangfuseTelemetry(_config(), client=client)

    async def first_run() -> None:
        sink.record(_started())

    asyncio.run(first_run())
    asyncio.run(sink.aclose())  # must not wait on the closed loop's worker

    assert client.flushes == 1
    # Depending on how far the cancelled worker got, the fact was either mapped
    # or counted as dropped — closing a loop is allowed to lose a trace, but not
    # to lose one without saying so.
    assert len(client.roots) + sink.dropped == 1


def test_closing_twice_flushes_once_and_refuses_later_facts() -> None:
    async def scenario() -> None:
        client = FakeClient()
        sink = LangfuseTelemetry(_config(), client=client)

        sink.record(_started())
        await sink.aclose()
        sink.record(_terminal())  # after close: dropped, never queued
        await sink.aclose()

        assert client.flushes == 1
        assert sink.dropped == 1

    asyncio.run(scenario())


def test_a_second_client_in_one_process_is_reported(monkeypatch: pytest.MonkeyPatch, caplog) -> None:
    # OpenTelemetry allows one global tracer provider per process, so the
    # second client's spans would go out through the first one's exporter.
    monkeypatch.setitem(sys.modules, "langfuse", types.SimpleNamespace(Langfuse=lambda **kwargs: FakeClient()))
    monkeypatch.setattr(adapter, "_clients_built", 0)

    with caplog.at_level(logging.WARNING):
        LangfuseTelemetry(_config())
        LangfuseTelemetry(_config())

    assert "one global tracer provider" in caplog.text


def test_the_sdk_is_only_imported_when_something_is_uploaded() -> None:
    """A deployment that never enables tracing must not import the extra."""

    script = (
        "import sys; import agent_harness.integrations.langfuse as m; "
        "assert 'langfuse' not in sys.modules, 'the adapter imported the SDK'; "
        "assert m.LangfuseConfig.from_environment({}) is None"
    )

    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(_SRC)},
    )

    assert result.returncode == 0, result.stderr


def test_an_enabled_deployment_without_the_sdk_fails_with_an_instruction(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "langfuse", None)  # ``import langfuse`` raises ImportError

    with pytest.raises(ProjectConfigError) as error:
        LangfuseTelemetry(_config())

    assert "prale-agent-harness[langfuse]" in str(error.value)
