import asyncio
import json

from agent_harness.domain.memory import AtomicCandidate, DoctrineCandidate, MemoryScope, SceneCandidate
from agent_harness.integrations.memory_tools import create_memory_tools
from agent_harness.memory.context import ContextAssembler
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


def _scene(label: str) -> str:
    return "\n".join(
        f"{heading}: {label}"
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


def _doctrine(label: str) -> str:
    return "\n".join(
        f"{heading}: {label}"
        for heading in (
            "Operating Thesis",
            "Core Principles",
            "Reusable SOPs",
            "Decision Logic",
            "Boundaries & Anti-patterns",
            "Agent Rules",
        )
    )


def test_l2_l3_are_file_authoritative_and_scopes_have_separate_indexes(tmp_path) -> None:
    async def scenario() -> None:
        assets = tmp_path / "assets"
        store = SQLiteMemoryStore(tmp_path / "memory.sqlite", assets_dir=assets, now_ms=lambda: 10)
        first, second = MemoryScope("repo-a"), MemoryScope("repo-b")
        await store.write_scene(first, SceneCandidate("a", _scene("A"), "A scene", ("l1-a",), 1))
        await store.write_scene(second, SceneCandidate("b", _scene("B"), "B scene", ("l1-b",), 1))
        await store.write_doctrine(first, DoctrineCandidate(_doctrine("global"), (), 2))

        first_index = json.loads(await store.read_l2_index(first))
        second_index = json.loads(await store.read_l2_index(second))
        assert first_index["repository_id"] == "repo-a"
        assert second_index["repository_id"] == "repo-b"
        assert first_index["scenes"][0]["scene_id"] != second_index["scenes"][0]["scene_id"]
        assert (assets / "l3" / "operating-doctrine.md").exists()
        assert store._conn.execute("SELECT COUNT(*) FROM work_scene_memories").fetchone()[0] == 0  # noqa: SLF001
        assert store._conn.execute("SELECT COUNT(*) FROM operating_doctrines").fetchone()[0] == 0  # noqa: SLF001

    asyncio.run(scenario())


def test_prompt_injects_only_l3_and_scope_index_and_tools_enforce_scope(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.sqlite", assets_dir=tmp_path / "assets", now_ms=lambda: 10)
        first, second = MemoryScope("repo-a"), MemoryScope("repo-b")
        await store.write_scene(first, SceneCandidate("a", _scene("A"), "A scene", (), 1))
        await store.write_scene(second, SceneCandidate("b", _scene("B"), "B scene", (), 1))
        await store.write_doctrine(first, DoctrineCandidate(_doctrine("global"), (), 2))
        metadata = {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}
        await store.apply_candidates(
            first, (AtomicCandidate("work_fact", "private L1 detail", "", "x", 1, 1, metadata, ("x",)),), 1
        )

        bundle = await MemoryRuntime(store).prompt_memory(first)
        message = ContextAssembler().assemble_prompt_memory(bundle)
        assert message is not None
        assert "private L1 detail" not in message["content"]
        assert "A scene" in message["content"] and "B scene" not in message["content"]
        tools = {tool.name: tool for tool in create_memory_tools(store, first)}
        results = await tools["memory_search"].execute({"query": "private"})
        assert not results.is_error and "private L1 detail" in str(results.content)
        foreign = (await store.read_l2(first))[0].scene_id
        denied = await create_memory_tools(store, second)[2].execute({"scene_id": foreign})
        assert denied.is_error

    asyncio.run(scenario())
