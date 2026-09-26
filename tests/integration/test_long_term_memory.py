import asyncio

import pytest

from agent_harness.api.errors import PromotionConflict
from agent_harness.api.harness import Harness
from agent_harness.domain.memory import (
    AtomicCandidate,
    DoctrineCandidate,
    MemoryScope,
    RecallBudget,
    RecallQuery,
    SceneCandidate,
)
from agent_harness.domain.values import ListAddress
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
from agent_harness.storage.protocol import AppendList


def test_terminal_settlement_atomically_enqueues_frozen_capture(tmp_path) -> None:
    async def scenario() -> None:
        session_store = MemoryStorage()
        assets = SQLiteMemoryStore(tmp_path / "memory.db")
        runtime = MemoryRuntime(assets)
        scope = MemoryScope("team", "agent", "user")
        harness = await Harness.open("session", session_store, memory_scope=scope, memory_runtime=runtime)
        lane = await harness.acquire_lane("main")
        await lane.prompt("remember this", operation_id="op")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]

        outbox = await session_store.read_list(ListAddress("memory/capture_outbox"))
        assert len(outbox) == 1
        assert outbox[0]["event"] == "memory_capture_requested"
        assert outbox[0]["operation_id"] == "op"
        assert outbox[0]["source_entry_ids"]

    asyncio.run(scenario())


def test_enabled_trace_is_indexed_and_frozen_with_capture(tmp_path) -> None:
    async def scenario() -> None:
        session_store = MemoryStorage()
        assets = SQLiteMemoryStore(tmp_path / "memory.db")
        runtime = MemoryRuntime(assets)
        scope = MemoryScope("team", "agent", "user")
        harness = await Harness.open(
            "session", session_store, memory_scope=scope, memory_runtime=runtime, trace_recorder=True
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("trace", operation_id="op")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        trace_ids = await session_store.read_list(ListAddress("operation/op/trace"))
        outbox = await session_store.read_list(ListAddress("memory/capture_outbox"))
        assert trace_ids
        assert set(trace_ids).issubset(set(outbox[0]["trace_entry_ids"]))

    asyncio.run(scenario())


def test_runtime_start_dispatches_existing_outbox(tmp_path) -> None:
    async def scenario() -> None:
        session_store = MemoryStorage()
        assets = SQLiteMemoryStore(tmp_path / "memory.db")
        runtime = MemoryRuntime(assets, poll_ms=1)
        scope = MemoryScope("team", "agent", "user")
        harness = await Harness.open("session", session_store, memory_scope=scope, memory_runtime=runtime)
        lane = await harness.acquire_lane("main")
        await lane.prompt("persist", operation_id="op")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await runtime.start()
        for _ in range(50):
            if not await session_store.read_list(ListAddress("memory/capture_outbox")):
                break
            await asyncio.sleep(0.001)
        await runtime.aclose()
        assert not await session_store.read_list(ListAddress("memory/capture_outbox"))

    asyncio.run(scenario())


def test_missing_frozen_entry_moves_capture_to_dead_letter(tmp_path) -> None:
    async def scenario() -> None:
        session_store = MemoryStorage()
        assets = SQLiteMemoryStore(tmp_path / "memory.db")
        runtime = MemoryRuntime(assets)
        scope = MemoryScope("team", "agent", "user")
        await Harness.open("session", session_store, memory_scope=scope, memory_runtime=runtime)
        await session_store.commit(
            [
                AppendList(
                    ListAddress("memory/capture_outbox"),
                    {
                        "scope": {"team_id": "team", "agent_id": "agent", "user_id": "user", "task_id": None},
                        "lane": "main",
                        "kind": "run",
                        "operation_id": "op",
                        "base_tip_id": None,
                        "tip_id": "missing",
                        "source_entry_ids": ["missing"],
                        "source_entry_hash": "bad",
                        "trace_format_version": "conversation-v1",
                    },
                )
            ]
        )
        await runtime._dispatch_session(runtime._sessions["session"][0], scope)  # noqa: SLF001
        assert not await session_store.read_list(ListAddress("memory/capture_outbox"))
        assert await session_store.read_list(ListAddress("memory/capture_dead_letters"))

    asyncio.run(scenario())


def test_recall_orders_doctrine_then_scene_then_atomic_memory(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        scene = "\n".join(
            f"{heading}: value"
            for heading in (
                "工作场景",
                "适用条件",
                "核心 SOP",
                "判断逻辑",
                "禁忌与反模式",
                "关键事实依据",
                "相关任务与资产",
                "演化记录",
                "待确认问题",
            )
        )
        doctrine = "\n".join(
            f"{heading}: value"
            for heading in (
                "Operating Thesis",
                "Core Principles",
                "Reusable SOPs",
                "Decision Logic",
                "Boundaries & Anti-patterns",
                "Agent Rules",
            )
        )
        await store.write_scene(scope, SceneCandidate("deploy", scene, "deploy", (), 1))
        await store.write_doctrine(scope, DoctrineCandidate(doctrine, (), 1))
        candidate = AtomicCandidate(
            "work_fact",
            "deployment details",
            "",
            "deploy",
            1,
            1.0,
            {"work_object": "deploy", "status": "active", "activity_start_time": "1", "activity_end_time": "2"},
            ("source",),
        )
        await store.apply_candidates(scope, (candidate,), 1)
        bundle = await store.search(scope, RecallQuery("deploy deployment"), RecallBudget(min_score=0))
        assert [item.level for item in bundle.items[:3]] == ["l3", "l2", "l1"]

    asyncio.run(scenario())


def test_l2_and_l3_jobs_promote_with_persisted_watermarks(tmp_path) -> None:
    class Extractor:
        async def extract_l1(self, archives):
            return ()

        async def extract_l2(self, l1, scenes):
            content = "\n".join(
                f"{heading}: value"
                for heading in (
                    "工作场景",
                    "适用条件",
                    "核心 SOP",
                    "判断逻辑",
                    "禁忌与反模式",
                    "关键事实依据",
                    "相关任务与资产",
                    "演化记录",
                    "待确认问题",
                )
            )
            return (SceneCandidate("deploy", content, "deploy", (), 7),)

        async def extract_l3(self, scenes, current):
            content = "\n".join(
                f"{heading}: value"
                for heading in (
                    "Operating Thesis",
                    "Core Principles",
                    "Reusable SOPs",
                    "Decision Logic",
                    "Boundaries & Anti-patterns",
                    "Agent Rules",
                )
            )
            return DoctrineCandidate(content, tuple(scene.scene_id for scene in scenes), 7)

    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        runtime = MemoryRuntime(store, Extractor(), l2_delay_ms=0, l2_min_interval_ms=0)
        scope = MemoryScope("team", "agent", "user")
        await store.create_or_wake_job(scope, "l2", 7, 0)
        l2 = await store.claim_job(10**15, "worker", 1)
        assert l2 is not None
        await runtime._run_job(l2)  # noqa: SLF001
        assert (await store.read_l2(scope))[0].scenario_key == "deploy"
        assert await store.stage_watermark(scope, "l2") == 7
        l3 = await store.claim_job(10**15, "worker-l3", 1)
        assert l3 is not None and l3.stage == "l3"
        await runtime._run_job(l3)  # noqa: SLF001
        assert await store.read_l3(scope) is not None

    asyncio.run(scenario())


def test_scene_and_doctrine_updates_require_optimistic_versions(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        scene = "\n".join(
            f"{heading}: value"
            for heading in (
                "工作场景",
                "适用条件",
                "核心 SOP",
                "判断逻辑",
                "禁忌与反模式",
                "关键事实依据",
                "相关任务与资产",
                "演化记录",
                "待确认问题",
            )
        )
        await store.write_scene(scope, SceneCandidate("scene", scene, "", (), 1))
        with pytest.raises(PromotionConflict):
            await store.write_scene(scope, SceneCandidate("scene", scene, "", (), 2))
        doctrine = "\n".join(
            f"{heading}: value"
            for heading in (
                "Operating Thesis",
                "Core Principles",
                "Reusable SOPs",
                "Decision Logic",
                "Boundaries & Anti-patterns",
                "Agent Rules",
            )
        )
        await store.write_doctrine(scope, DoctrineCandidate(doctrine, (), 1))
        with pytest.raises(PromotionConflict):
            await store.write_doctrine(scope, DoctrineCandidate(doctrine, (), 2))

    asyncio.run(scenario())


def test_scene_merge_cannot_mutate_another_scope(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        first, second = MemoryScope("team", "agent", "first"), MemoryScope("team", "agent", "second")
        content = "\n".join(
            f"{heading}: value"
            for heading in (
                "工作场景",
                "适用条件",
                "核心 SOP",
                "判断逻辑",
                "禁忌与反模式",
                "关键事实依据",
                "相关任务与资产",
                "演化记录",
                "待确认问题",
            )
        )
        await store.write_scene(first, SceneCandidate("one", content, "", (), 1))
        foreign_scene = (await store.read_l2(first))[0]
        with pytest.raises(PromotionConflict):
            await store.write_scene(
                second, SceneCandidate("two", content, "", (), 1, merge_scene_ids=(foreign_scene.scene_id,))
            )

    asyncio.run(scenario())


def test_recall_failure_and_audit_failure_degrade_to_empty_bundle() -> None:
    class BrokenStore:
        async def search(self, scope, query, budget):
            raise RuntimeError("index unavailable")

        async def audit(self, scope, event, data):
            raise RuntimeError("audit unavailable")

    async def scenario() -> None:
        runtime = MemoryRuntime(BrokenStore())
        bundle = await runtime.recall(MemoryScope("team", "agent", "user"), RecallQuery("query"), RecallBudget())
        assert not bundle.items
        assert bundle.degraded_reason == "RuntimeError"

    asyncio.run(scenario())


def test_navigation_capture_uses_terminal_target_branch_not_previous_lane_tip(tmp_path) -> None:
    async def scenario() -> None:
        session_store = MemoryStorage()
        runtime = MemoryRuntime(SQLiteMemoryStore(tmp_path / "memory.db"))
        scope = MemoryScope("team", "agent", "user")
        lane = await (
            await Harness.open("session", session_store, memory_scope=scope, memory_runtime=runtime)
        ).acquire_lane("main")
        await lane.prompt("first", operation_id="first")
        await lane.request_abort()
        first = await lane.drive(None)  # type: ignore[arg-type]
        await lane.prompt("second", operation_id="second")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        await lane.navigate(first.tip_id, operation_id="navigate")
        await lane.drive(None)  # type: ignore[arg-type]
        outbox = await session_store.read_list(ListAddress("memory/capture_outbox"))
        navigation = next(item for item in outbox if item["operation_id"] == "navigate")
        assert navigation["source_entry_ids"] == []

    asyncio.run(scenario())


def test_scope_filtered_recall_and_scene_validation(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope_a = MemoryScope("team", "agent", "a")
        scope_b = MemoryScope("team", "agent", "b")
        candidate = AtomicCandidate(
            "work_fact",
            "Only scope A knows the deployment port",
            "",
            "deploy",
            5,
            1.0,
            {
                "work_object": "deploy",
                "status": "active",
                "activity_start_time": "1",
                "activity_end_time": "2",
            },
            ("trace-1",),
        )
        await store.apply_candidates(scope_a, (candidate,), 1)
        assert (await store.search(scope_a, RecallQuery("deployment port"), RecallBudget(min_score=0))).items
        assert not (await store.search(scope_b, RecallQuery("deployment port"), RecallBudget(min_score=0))).items
        with pytest.raises(ValueError):
            await store.write_scene(scope_a, SceneCandidate("deploy", "missing required headings", "", (), 1))

    asyncio.run(scenario())


def test_scope_deletion_does_not_affect_other_scope(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        first = MemoryScope("team", "agent", "first")
        second = MemoryScope("team", "agent", "second")
        metadata = {
            "work_object": "repo",
            "status": "active",
            "activity_start_time": "1",
            "activity_end_time": "2",
        }
        candidate = AtomicCandidate("work_fact", "repository fact", "", "repo", 1, 1.0, metadata, ("source",))
        await store.apply_candidates(first, (candidate,), 1)
        await store.apply_candidates(second, (candidate,), 1)
        await store.create_or_wake_job(first, "l1", 1, 0)
        await store.delete_scope(first)
        assert not (await store.search(first, RecallQuery("repository"), RecallBudget(min_score=0))).items
        assert (await store.search(second, RecallQuery("repository"), RecallBudget(min_score=0))).items
        assert await store.current_l1_watermark(first) == 0

    asyncio.run(scenario())


def test_repository_scope_isolates_l0_to_l2_but_shares_l3(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        first, second = MemoryScope("git@example/first"), MemoryScope("git@example/second")
        metadata = {"work_object": "first", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}
        await store.apply_candidates(
            first, (AtomicCandidate("work_fact", "only first repository", "", "first", 1, 1.0, metadata, ("l0",)),), 1
        )
        scene = "\n".join(
            f"{heading}: value"
            for heading in (
                "工作场景",
                "适用条件",
                "核心 SOP",
                "判断逻辑",
                "禁忌与反模式",
                "关键事实依据",
                "相关任务与资产",
                "演化记录",
                "待确认问题",
            )
        )
        await store.write_scene(first, SceneCandidate("first", scene, "", (), 1))
        doctrine = "\n".join(
            f"{heading}: value"
            for heading in (
                "Operating Thesis",
                "Core Principles",
                "Reusable SOPs",
                "Decision Logic",
                "Boundaries & Anti-patterns",
                "Agent Rules",
            )
        )
        await store.write_doctrine(first, DoctrineCandidate(doctrine, (), 1))
        repository_only = RecallBudget(min_score=0, include_l3=False)
        assert (await store.search(first, RecallQuery("only first"), repository_only)).items
        assert not (await store.search(second, RecallQuery("only first"), repository_only)).items
        assert await store.read_l2(second) == ()
        assert (await store.read_l3(first)) == (await store.read_l3(second))

    asyncio.run(scenario())


def test_code_artifact_reference_is_searchable_without_polluting_display_content(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("git@example/repo")
        candidate = AtomicCandidate(
            "work_artifact",
            "The migration contract is documented.",
            "",
            "database",
            80,
            1.0,
            {"artifact_type": "doc", "artifact_ref": "specs/schema-migration.md"},
            ("trace",),
        )
        await store.apply_candidates(scope, (candidate,), 1)
        bundle = await store.search(scope, RecallQuery("schema-migration.md"), RecallBudget(min_score=0))
        assert [item.content for item in bundle.items if item.level == "l1"] == [candidate.content]

    asyncio.run(scenario())
