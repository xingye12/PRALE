import asyncio

import pytest

from agent_harness.api.errors import LaneBusy, NothingToCompact, OperationAlreadyExists, UnknownTarget
from agent_harness.api.harness import Harness
from agent_harness.domain.values import lane_state, operation_meta, operation_state
from agent_harness.storage.memory import MemoryStorage


def test_prompt_admission_is_durable_before_any_drive_is_started() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        lane = await harness.acquire_lane("main")

        admitted = await lane.prompt("hello", operation_id="op-1")

        assert admitted.operation_id == "op-1"
        assert (await storage.get_value(lane_state("main")))["current_operation_id"] == "op-1"
        request = (await storage.get_value(operation_meta("op-1"))).request
        assert request["prompt"] == "hello"
        assert isinstance(request["prompt_entry_id"], str)
        assert (await storage.get_value(operation_state("op-1"))).at == "starting"

    asyncio.run(scenario())


def test_one_lane_accepts_only_one_operation_even_when_callers_race() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        lane = await harness.acquire_lane("main")

        results = await asyncio.gather(
            lane.prompt("first", operation_id="op-1"),
            lane.prompt("second", operation_id="op-2"),
            return_exceptions=True,
        )

        assert sum(isinstance(result, LaneBusy) for result in results) == 1
        assert sum(not isinstance(result, Exception) for result in results) == 1

    asyncio.run(scenario())


def test_reopening_a_session_restores_the_durable_busy_lane() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        first_harness = await Harness.open("session-1", storage)
        await (await first_harness.acquire_lane("main")).prompt("first", operation_id="op-1")

        reopened_harness = await Harness.open("session-1", storage)
        reopened_lane = await reopened_harness.acquire_lane("main")

        assert (await reopened_lane.snapshot()).operation_id == "op-1"
        with pytest.raises(LaneBusy):
            await reopened_lane.prompt("second", operation_id="op-2")

    asyncio.run(scenario())


def test_navigation_atomically_moves_lane_tip_to_an_existing_entry() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        first = await lane.prompt("first", operation_id="op-1")
        source_tip = (await storage.get_value(operation_meta(first.operation_id))).request["prompt_entry_id"]

        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await lane.navigate(source_tip, operation_id="op-2")
        result = await lane.drive(None)  # type: ignore[arg-type]

        assert result.status == "completed"
        assert (await lane.snapshot()).tip_id == source_tip

    asyncio.run(scenario())


def test_navigation_rejects_unknown_target_with_domain_error() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("first", operation_id="op-1")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await lane.navigate("missing", operation_id="op-2")

        with pytest.raises(UnknownTarget):
            await lane.drive(None)  # type: ignore[arg-type]

    asyncio.run(scenario())


def test_empty_lane_cannot_admit_compaction() -> None:
    async def scenario() -> None:
        lane = await (await Harness.open("session-1", MemoryStorage())).acquire_lane("main")

        with pytest.raises(NothingToCompact):
            await lane.compact(operation_id="op-1")

    asyncio.run(scenario())


def test_navigation_hook_can_append_a_branch_summary_at_the_new_tip() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        lane = await harness.acquire_lane("main")
        first = await lane.prompt("first", operation_id="op-1")
        first_tip = (await storage.get_value(operation_meta(first.operation_id))).request["prompt_entry_id"]
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        harness.on_hook("before_navigation", lambda event: {**event, "branch_summary": "moved"})
        await lane.navigate(first_tip, operation_id="op-2")

        result = await lane.drive(None)  # type: ignore[arg-type]
        entry = (await storage.scan_branch(result.tip_id))[-1]
        assert entry.type == "branch_summary"
        assert entry.payload["summary"] == "moved"

    asyncio.run(scenario())


def test_event_listener_observes_admission_and_cannot_break_it() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        events = []
        harness.subscribe(events.append)
        harness.subscribe(lambda event: (_ for _ in ()).throw(RuntimeError("observer failure")))

        await (await harness.acquire_lane("main")).prompt("hi", operation_id="op-1")

        admission = next(event for event in events if event.type == "operation_admitted")
        assert admission.operation_id == "op-1"

    asyncio.run(scenario())


def test_event_listener_failure_is_observable_as_handler_error() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        events = []
        harness.subscribe(events.append)
        harness.subscribe(lambda event: (_ for _ in ()).throw(RuntimeError("observer failure")))

        await (await harness.acquire_lane("main")).prompt("hi", operation_id="op-1")

        assert any(
            event.type == "handler_error" and event.data["event_type"] == "operation_admitted" for event in events
        )

    asyncio.run(scenario())


def test_before_drive_hooks_are_ordered_and_fail_closed() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        seen = []
        harness.on_hook("before_drive", lambda event: seen.append("first"))
        harness.on_hook("before_drive", lambda event: seen.append("second"))
        lane = await harness.acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        await lane.request_abort()

        await lane.drive(None)  # type: ignore[arg-type]

        assert seen == ["first", "second"]

    asyncio.run(scenario())


def test_watch_returns_a_snapshot_and_filters_to_its_lane() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        main = await harness.acquire_lane("main")
        other = await harness.acquire_lane("other")
        seen = []

        snapshot, unsubscribe = await main.watch(seen.append)
        await other.prompt("ignored", operation_id="other-op")
        await main.prompt("seen", operation_id="main-op")
        unsubscribe()

        assert snapshot.name == "main"
        assert [event.operation_id for event in seen] == ["main-op"]

    asyncio.run(scenario())


def test_operation_id_cannot_be_reused_after_settlement() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("first", operation_id="op-1")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]

        with pytest.raises(OperationAlreadyExists):
            await lane.prompt("second", operation_id="op-1")

    asyncio.run(scenario())


def test_fork_lane_starts_from_the_source_tip_without_mutating_source() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        source = await harness.acquire_lane("main")
        await source.prompt("source", operation_id="op-1")
        source_tip = (await source.snapshot()).tip_id

        fork = await harness.fork_lane("main", "branch")

        assert (await fork.snapshot()).tip_id == source_tip
        assert (await source.snapshot()).tip_id == source_tip

    asyncio.run(scenario())


def test_before_run_messages_are_persisted_with_prompt_admission() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        harness = await Harness.open("session-1", storage)
        harness.on_hook("before_run", lambda event: {**event, "messages": ["injected"]})
        lane = await harness.acquire_lane("main")

        await lane.prompt("original", operation_id="op-1")

        tip = (await lane.snapshot()).tip_id
        assert [entry.payload["content"] for entry in await storage.scan_branch(tip)] == ["original", "injected"]

    asyncio.run(scenario())
