"""The trace facade answers from durable rows only, and never invents a value.

These tests drive real turns through a real session database, close it, and
then read it back the way the UI does: through the catalog's allow-list and
nothing else.
"""

import asyncio
from pathlib import Path

import pytest

from agent_harness.api.catalog import SessionCatalog
from agent_harness.api.errors import InvalidCursor, SessionNotFound
from agent_harness.api.harness import Harness
from agent_harness.api.pagination import encode_cursor
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.trace import TraceQueryService
from agent_harness.domain.values import lane_state, lane_tip
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.catalog import MemoryCatalogStore
from agent_harness.storage.protocol import InsertUsage, SetValue, UsageRow
from agent_harness.storage.sqlite import SQLiteStorage

REPOSITORY_ID = "git@example.com:owner/repo.git"

# Two turns admitted in the same millisecond are a real possibility, and the
# sort key then decides their order.  Waiting a millisecond keeps a test's
# expectation about "newest first" about time rather than about tie-breaking.
TICK = 0.002


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

    def __init__(self) -> None:
        self.calls = 0

    async def execute(self, arguments):
        self.calls += 1
        return ToolExecutionResult(content={"echo": arguments["value"]})


def _tool_turn(call_id: str) -> AssistantResult:
    return AssistantResult(
        content="",
        usage={},
        tool_calls=(ToolCall(call_id, "echo", {"value": "a"}),),
    )


def _say(text: str, **usage: int) -> AssistantResult:
    return AssistantResult(content=text, usage=dict(usage))


async def _session(tmp_path: Path, session_id: str = "s-1") -> tuple[TraceQueryService, Path]:
    config = ProjectRuntimeConfig(
        project_root=tmp_path,
        repository_id=REPOSITORY_ID,
        sessions_dir=tmp_path / "sessions",
        catalog_db=tmp_path / "catalog.sqlite",
    )
    catalog = SessionCatalog(MemoryCatalogStore(), config)
    await catalog.register(session_id)
    path = await catalog.resolve(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    return TraceQueryService(catalog), path


def test_lanes_are_enumerated_from_their_durable_index(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            harness = await Harness.open("s-1", storage)
            await harness.acquire_lane("main")
            await harness.acquire_lane("review")
        finally:
            storage.close()

        lanes = await trace.list_lanes("s-1")

        assert [lane.name for lane in lanes] == ["main", "review"]
        assert all(lane.operation_id is None for lane in lanes)

    asyncio.run(scenario())


def test_a_lane_that_predates_the_index_is_registered_on_re_attach(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            # A database written before lanes were indexed: state and tip only.
            await storage.commit(
                [
                    SetValue(lane_state("legacy"), {"current_operation_id": None, "last_operation_id": None}),
                    SetValue(lane_tip("legacy"), None),
                ]
            )
            assert await trace.list_lanes("s-1") == ()

            await (await Harness.open("s-1", storage)).acquire_lane("legacy")

            assert [lane.name for lane in await trace.list_lanes("s-1")] == ["legacy"]
        finally:
            storage.close()

    asyncio.run(scenario())


def test_an_empty_lane_reports_no_turns(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            harness = await Harness.open("s-1", storage)
            await harness.acquire_lane("main")
        finally:
            storage.close()

        page = await trace.list_turns("s-1")

        assert page.items == ()
        assert page.next_cursor is None

    asyncio.run(scenario())


def test_turns_come_back_newest_first_with_their_metrics(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage, tools=(EchoTool(),))).acquire_lane("main")
            await lane.prompt("one", operation_id="op-1")
            await lane.drive(Provider([_say("a", input_tokens=3, output_tokens=1)]))
            await asyncio.sleep(TICK)
            await lane.prompt("two", operation_id="op-2")
            await lane.drive(Provider([_tool_turn("call-1"), _say("b", input_tokens=5, output_tokens=2)]))
        finally:
            storage.close()

        page = await trace.list_turns("s-1")

        assert [turn.operation_id for turn in page.items] == ["op-2", "op-1"]
        newest, oldest = page.items
        assert (newest.status, newest.kind, newest.span_count) == ("completed", "run", 3)
        # The first generation of that turn reported no usage at all, so the
        # turn cannot state a total; the detail view still shows each record.
        assert (newest.input_tokens, newest.output_tokens, newest.total_tokens) == (None, None, None)
        assert newest.pending_spans == 0
        assert oldest.span_count == 1
        assert (oldest.input_tokens, oldest.output_tokens, oldest.total_tokens) == (3, 1, 4)
        assert oldest.duration_ms is not None and oldest.duration_ms >= 0
        assert all(turn.session_id == "s-1" and turn.lane == "main" for turn in page.items)

    asyncio.run(scenario())


def test_turns_paginate_without_gaps_or_repeats(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage)).acquire_lane("main")
            for index in range(5):
                await lane.prompt(f"turn {index}", operation_id=f"op-{index}")
                await lane.drive(Provider([_say("ok", input_tokens=1, output_tokens=1)]))
                await asyncio.sleep(TICK)
        finally:
            storage.close()

        seen: list[str] = []
        cursor: str | None = None
        for _ in range(10):
            page = await trace.list_turns("s-1", cursor=cursor, limit=2)
            seen.extend(turn.operation_id for turn in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break

        assert seen == ["op-4", "op-3", "op-2", "op-1", "op-0"]

    asyncio.run(scenario())


def test_turns_can_be_scoped_to_one_lane(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            harness = await Harness.open("s-1", storage)
            main = await harness.acquire_lane("main")
            await main.prompt("hi", operation_id="op-main")
            await main.drive(Provider([_say("ok")]))
            await asyncio.sleep(TICK)
            side = await harness.acquire_lane("side")
            await side.prompt("hi", operation_id="op-side")
            await side.drive(Provider([_say("ok")]))
        finally:
            storage.close()

        page = await trace.list_turns("s-1", lane="main")

        assert [turn.operation_id for turn in page.items] == ["op-main"]
        assert (await trace.list_turns("s-1", lane="missing")).items == ()

    asyncio.run(scenario())


def test_a_running_turn_reports_no_status_and_no_duration(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage)).acquire_lane("main")
            await lane.prompt("hello", operation_id="op-1")

            [running] = (await trace.list_turns("s-1")).items
            assert running.status is None
            assert running.ended_at is None
            assert running.duration_ms is None
            assert running.span_count == 0

            await lane.drive(Provider([_say("ok", input_tokens=2, output_tokens=1)]))
            [settled] = (await trace.list_turns("s-1")).items
            assert settled.status == "completed"
            assert settled.duration_ms is not None
        finally:
            storage.close()

    asyncio.run(scenario())


def test_a_turn_ended_without_a_provable_outcome_reports_no_duration(tmp_path: Path) -> None:
    async def scenario() -> None:
        class BlockingProvider:
            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.release = asyncio.Event()

            async def generate(self, request: GenerationRequest) -> AssistantResult:
                self.started.set()
                await self.release.wait()
                return _say("unreachable")

        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage)).acquire_lane("main")
            await lane.prompt("hello", operation_id="op-1")
            provider = BlockingProvider()
            drive = asyncio.create_task(lane.drive(provider))
            await provider.started.wait()
            await lane.request_abort()
            await drive
            provider.release.set()
        finally:
            storage.close()

        [turn] = (await trace.list_turns("s-1")).items

        assert turn.status == "unknown"
        assert turn.ended_at is not None, "the record was closed; the time it was closed is durable"
        assert turn.duration_ms is None, "a recovery-closed turn must not report the time it took to notice"
        assert turn.pending_spans == 0

    asyncio.run(scenario())


def test_a_running_turn_shows_what_it_has_produced_so_far(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage, tools=(EchoTool(),))).acquire_lane("main")
            await lane.prompt("run it", operation_id="op-1")

            detail = await trace.get_turn("s-1", "op-1")

            # The prompt is already durable, so a turn in flight is readable up
            # to the last entry it wrote; nothing from a later turn is.
            assert [entry.payload.get("content") for entry in detail.entries] == ["run it"]
            assert detail.request == {
                "prompt": "run it",
                "prompt_entry_id": detail.entries[0].id,
                "before_run_messages": [],
            }
            assert detail.summary.status is None
            assert detail.result is None
        finally:
            storage.close()

    asyncio.run(scenario())


def test_a_turn_detail_returns_its_own_entries_in_order(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage)).acquire_lane("main")
            await lane.prompt("first", operation_id="op-1")
            await lane.drive(Provider([_say("answer one", input_tokens=1, output_tokens=1)]))
            await asyncio.sleep(TICK)
            await lane.prompt("second", operation_id="op-2")
            await lane.drive(Provider([_say("answer two", input_tokens=1, output_tokens=1)]))
        finally:
            storage.close()

        first = await trace.get_turn("s-1", "op-1")
        second = await trace.get_turn("s-1", "op-2")

        assert [entry.payload.get("content") for entry in first.entries] == ["first", "answer one"]
        assert [entry.payload.get("content") for entry in second.entries] == ["second", "answer two"]
        # Each turn starts where the previous one stopped: no shared entries.
        assert {entry.id for entry in first.entries}.isdisjoint({entry.id for entry in second.entries})
        assert first.entries[-1].id == second.entries[0].parent_id
        assert first.request == {"prompt": "first", "prompt_entry_id": first.entries[0].id, "before_run_messages": []}
        assert first.result is not None and first.result.status == "completed"

    asyncio.run(scenario())


def test_a_turn_detail_carries_its_spans_and_attributed_usage(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage, tools=(EchoTool(),))).acquire_lane("main")
            await lane.prompt("run it", operation_id="op-1")
            await lane.drive(Provider([_tool_turn("call-1"), _say("done", input_tokens=7, output_tokens=3)]))
        finally:
            storage.close()

        detail = await trace.get_turn("s-1", "op-1")

        assert [span.kind for span in detail.spans] == ["llm", "tool", "llm"]
        assert all(span.operation_id == "op-1" for span in detail.spans)
        # A generation's call id is the assistant entry its intent reserved, and
        # a tool's is the tool call id the provider issued: both name a durable
        # source, so the span does not duplicate names, arguments or results.
        assert [span.call_id for span in detail.spans] == [detail.entries[1].id, "call-1", detail.entries[-1].id]
        assert detail.entries[-2].payload["tool_call_id"] == "call-1"
        assert [record.entry_id for record in detail.usage] == [detail.entries[1].id, detail.entries[-1].id]
        assert [record.input_tokens for record in detail.usage] == [None, 7]
        assert detail.unattributed_usage == ()
        # One of the two generations reported nothing, so the turn stays silent
        # about input and output rather than summing the half it can see.
        assert (detail.summary.input_tokens, detail.summary.output_tokens) == (None, None)
        assert detail.summary.total_tokens is None

    asyncio.run(scenario())


def test_usage_that_cannot_be_attributed_is_shown_apart(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            lane = await (await Harness.open("s-1", storage)).acquire_lane("main")
            await lane.prompt("hello", operation_id="op-1")
            await lane.drive(Provider([_say("ok", input_tokens=4, output_tokens=2)]))
            entries = (await trace.get_turn("s-1", "op-1")).entries
            # A row written before operations were attributable: entry binding only.
            await storage.commit(
                [InsertUsage(UsageRow("legacy-1", {"input_tokens": 9, "output_tokens": 9}, entry_id=entries[-1].id))]
            )
        finally:
            storage.close()

        detail = await trace.get_turn("s-1", "op-1")

        assert len(detail.usage) == 1, "the attributed row is the turn's own"
        assert [record.id for record in detail.unattributed_usage] == ["legacy-1"]
        assert all(record.legacy_unattributed for record in detail.unattributed_usage)
        assert (detail.summary.input_tokens, detail.summary.output_tokens) == (4, 2), (
            "an unattributable row must not be summed into the turn"
        )

    asyncio.run(scenario())


def test_unknown_sessions_operations_and_cursors_are_rejected(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        storage = SQLiteStorage(path)
        try:
            await (await Harness.open("s-1", storage)).acquire_lane("main")
        finally:
            storage.close()

        with pytest.raises(SessionNotFound, match="not part of session"):
            await trace.get_turn("s-1", "never-admitted")
        with pytest.raises(SessionNotFound):
            await trace.list_turns("never-registered")
        for cursor in ("not-a-cursor", encode_cursor(["op-1"]), encode_cursor([1_000, 1_000, 1_000])):
            with pytest.raises(InvalidCursor):
                await trace.list_turns("s-1", cursor=cursor)
        with pytest.raises(ValueError, match="limit"):
            await trace.list_turns("s-1", limit=0)

    asyncio.run(scenario())


def test_a_registered_session_whose_database_is_gone_is_not_recreated(tmp_path: Path) -> None:
    async def scenario() -> None:
        trace, path = await _session(tmp_path)
        assert not path.exists()

        with pytest.raises(SessionNotFound, match="no database"):
            await trace.list_turns("s-1")
        with pytest.raises(SessionNotFound):
            await trace.get_turn("s-1", "op-1")

        assert not path.exists(), "reading must never create a session database"

    asyncio.run(scenario())
