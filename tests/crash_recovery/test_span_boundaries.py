"""An effect's durable record must be as honest after a crash as before one.

A span is written with the intent that authorizes the effect, so at every crash
boundary the surviving rows describe what was issued, what was proved, and what
was lost.  Nothing here may be inferred from the process that died.
"""

import asyncio
from collections.abc import Callable, Sequence

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.effects import EffectSpan, UsageRecord
from agent_harness.domain.entries import Entry
from agent_harness.domain.values import ListAddress, ValueAddress
from agent_harness.integrations.repository_explorer import RepositoryExplorerConfig, RepositoryExplorerTool
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.runtime.retry import RetryPolicy
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import CommitResult, InsertEntry, Storage, Write


class SimulatedProcessDeath(BaseException):
    """Stands in for the process vanishing: nothing after it runs."""


class Provider:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        return AssistantResult(content="remote-success", usage={"input_tokens": 5, "output_tokens": 2})


class CrashAtStorage:
    """Forward every read; die on the first commit whose writes match."""

    def __init__(self, base: MemoryStorage, matches: Callable[[list[Write]], bool]) -> None:
        self._base = base
        self._matches = matches
        self.crashed = False

    def operation_lock(self, key: str):
        return self._base.operation_lock(key)

    async def commit(self, writes: list[Write]) -> CommitResult:
        if not self.crashed and self._matches(writes):
            self.crashed = True
            raise SimulatedProcessDeath("simulated process termination")
        return await self._base.commit(writes)

    async def get_entries(self, ids: list[str]) -> dict[str, Entry]:
        return await self._base.get_entries(ids)

    async def scan_branch(self, start: str | None) -> list[Entry]:
        return await self._base.scan_branch(start)

    async def get_value(self, address: ValueAddress[object]) -> object | None:
        return await self._base.get_value(address)

    async def read_list(self, address: ListAddress[object]) -> list[object]:
        return await self._base.read_list(address)

    async def list_spans(self, operation_id: str) -> list[EffectSpan]:
        return await self._base.list_spans(operation_id)

    async def list_usage(self, operation_id: str) -> list[UsageRecord]:
        return await self._base.list_usage(operation_id)

    async def usage_for_entries(self, entry_ids: Sequence[str]) -> list[UsageRecord]:
        return await self._base.usage_for_entries(entry_ids)


def _commits_a_message(role: str, writes: list[Write]) -> bool:
    return any(
        isinstance(write, InsertEntry)
        and isinstance(write.entry.payload, dict)
        and write.entry.payload.get("role") == role
        for write in writes
    )


def _span_for(spans: list[EffectSpan], call_id: str) -> EffectSpan:
    return next(span for span in spans if span.call_id == call_id)


def test_a_generation_lost_after_its_intent_stays_pending_until_recovery() -> None:
    async def scenario() -> None:
        storage = CrashAtStorage(MemoryStorage(), lambda writes: _commits_a_message("assistant", writes))
        provider = Provider()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")

        with pytest.raises(SimulatedProcessDeath):
            await lane.drive(provider)
        assert provider.calls == 1

        # Between crashes the effect is issued but unsettled: the record says so
        # rather than leaving the turn looking finished or never started.
        [pending] = await storage.list_spans("op-1")
        assert pending.kind == "llm"
        assert pending.outcome == "pending"
        assert pending.ended_at is None
        assert pending.duration_ms is None
        assert await storage.list_usage("op-1") == []

        recovered = await (await Harness.open("session-1", storage)).acquire_lane("main")
        result = await recovered.recover()
        assert result is not None and result.status == "unknown"

        # Recovery proves the outcome is unknowable; it does not invent a duration
        # from the gap between issuing the call and noticing the crash.
        [settled] = await storage.list_spans("op-1")
        assert settled.span_id == pending.span_id
        assert settled.outcome == "unknown"
        assert settled.error_class == "interrupted"
        assert settled.ended_at is not None and settled.ended_at >= pending.started_at
        assert settled.duration_ms is None
        assert provider.calls == 1

    asyncio.run(scenario())


class EchoTool:
    name = "echo"
    description = "Return the supplied value."
    input_schema = {"type": "object"}
    replay_policy = "safe"

    def __init__(self) -> None:
        self.calls = 0

    async def execute(self, arguments):
        self.calls += 1
        return ToolExecutionResult(content={"echo": arguments["value"]})


class UnsafeEchoTool(EchoTool):
    replay_policy = "never"


class DyingTool(UnsafeEchoTool):
    """The process dies while the effect is in flight."""

    async def execute(self, arguments):
        self.calls += 1
        raise SimulatedProcessDeath("simulated process termination mid-call")


class ToolThenTextProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        if self.calls == 1:
            return AssistantResult(content="", usage={}, tool_calls=(ToolCall("call-1", "echo", {"value": "hi"}),))
        return AssistantResult(content="tool completed", usage={})


class RepositoryToolThenTextProvider(ToolThenTextProvider):
    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        if self.calls == 1:
            return AssistantResult(
                content="",
                usage={},
                tool_calls=(ToolCall("call-1", "repository_explore", {"identifiers": ["target"]}),),
            )
        return AssistantResult(content="tool completed", usage={})


async def _open_tool_lane(storage: Storage, tool) -> None:
    lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
    await lane.prompt("use the tool", operation_id="op-1")


async def _recover_tool_lane(storage: Storage, tool, provider):
    lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
    return await lane.recover(provider)


@pytest.mark.parametrize("crash_point", ["an_intent_is_committed", "the_effect_takes_the_process_with_it"])
def test_a_tool_call_that_is_never_replayed_is_closed_as_unknown(crash_point: str) -> None:
    async def scenario() -> None:
        tool = UnsafeEchoTool() if crash_point == "an_intent_is_committed" else DyingTool()
        crash = (
            (lambda writes: _commits_a_message("tool", writes))
            if crash_point == "an_intent_is_committed"
            else (lambda writes: False)
        )
        storage = CrashAtStorage(MemoryStorage(), crash)
        await _open_tool_lane(storage, tool)

        provider = ToolThenTextProvider()
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        with pytest.raises(SimulatedProcessDeath):
            await lane.drive(provider)

        # Both crash points leave the same durable state: the intent survived,
        # the effect's outcome did not.  Nothing else distinguishes them, so
        # nothing downstream may assume which one happened.
        [pending] = [span for span in await storage.list_spans("op-1") if span.kind == "tool"]
        assert pending.call_id == "call-1"
        assert pending.outcome == "pending"
        assert pending.duration_ms is None

        result = await _recover_tool_lane(storage, tool, provider)
        assert result is not None and result.status == "completed"

        tool_spans = [span for span in await storage.list_spans("op-1") if span.kind == "tool"]
        [settled] = tool_spans
        assert settled.span_id == pending.span_id
        assert settled.outcome == "unknown"
        assert settled.error_class == "interrupted"
        assert settled.duration_ms is None
        assert tool.calls == 1
        tip = (await storage.scan_branch(result.tip_id))[-1]
        assert tip.payload["is_error"] is True

    asyncio.run(scenario())


def test_a_replayed_tool_call_keeps_both_attempts_on_the_record() -> None:
    async def scenario() -> None:
        tool = EchoTool()
        storage = CrashAtStorage(MemoryStorage(), lambda writes: _commits_a_message("tool", writes))
        await _open_tool_lane(storage, tool)

        provider = ToolThenTextProvider()
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        with pytest.raises(SimulatedProcessDeath):
            await lane.drive(provider)
        assert tool.calls == 1

        result = await _recover_tool_lane(storage, tool, provider)
        assert result is not None and result.status == "completed"
        assert tool.calls == 2

        # A safe replay is a second attempt, and the lost first one is closed
        # rather than left pending for an effect nothing is waiting on.
        first, second = (span for span in await storage.list_spans("op-1") if span.kind == "tool")
        assert (first.attempt, first.outcome, first.error_class) == (1, "unknown", "interrupted")
        assert first.duration_ms is None
        assert (second.attempt, second.outcome, second.error_class) == (2, "completed", None)
        assert second.call_id == first.call_id == "call-1"

    asyncio.run(scenario())


def test_repository_explorer_safe_attempt_is_replayed_after_settlement_crash(tmp_path) -> None:
    async def scenario() -> None:
        (tmp_path / "target.py").write_text("def target():\n    return 1\n")
        config = RepositoryExplorerConfig(tmp_path, tmp_path.parent / f"{tmp_path.name}-repository-index")
        tool = RepositoryExplorerTool(config)
        assert tool.replay_policy == "safe"
        storage = CrashAtStorage(MemoryStorage(), lambda writes: _commits_a_message("tool", writes))
        await _open_tool_lane(storage, tool)
        provider = RepositoryToolThenTextProvider()
        lane = await (await Harness.open("session-1", storage, tools=(tool,))).acquire_lane("main")
        with pytest.raises(SimulatedProcessDeath):
            await lane.drive(provider)

        result = await _recover_tool_lane(storage, tool, provider)
        assert result is not None and result.status == "completed"
        first, second = (span for span in await storage.list_spans("op-1") if span.kind == "tool")
        assert (first.outcome, first.error_class, second.outcome) == ("unknown", "interrupted", "completed")

    asyncio.run(scenario())


def test_every_attempt_of_a_retried_generation_is_recorded_separately() -> None:
    async def scenario() -> None:
        class FlakyProvider:
            def __init__(self) -> None:
                self.calls = 0

            async def generate(self, request: GenerationRequest) -> AssistantResult:
                self.calls += 1
                if self.calls == 1:
                    raise TimeoutError("temporary")
                return AssistantResult(content="recovered", usage={})

        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage, retry=RetryPolicy(base_delay_ms=0))
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        provider = FlakyProvider()
        result = await lane.drive(provider)

        assert result.status == "completed"
        assert provider.calls == 2
        failed, completed = await storage.list_spans("op-1")
        assert [(span.attempt, span.outcome, span.error_class) for span in (failed, completed)] == [
            (1, "failed", "provider_error"),
            (2, "completed", None),
        ]
        # One call_id for both attempts: they are the same call, retried.
        assert failed.call_id == completed.call_id
        assert failed.span_id != completed.span_id
        assert completed.duration_ms is not None

    asyncio.run(scenario())


def test_a_settled_generation_attributes_its_usage_to_the_attempt() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        result = await lane.drive(Provider())

        assert result.status == "completed"
        [span] = await storage.list_spans("op-1")
        [usage] = await storage.list_usage("op-1")
        assert (usage.operation_id, usage.span_id) == ("op-1", span.span_id)
        assert usage.entry_id is not None
        assert not usage.legacy_unattributed
        assert (usage.input_tokens, usage.output_tokens, usage.total_tokens) == (5, 2, 7)
        assert span.outcome == "completed"
        assert span.duration_ms is not None

    asyncio.run(scenario())
