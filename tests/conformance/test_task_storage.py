import asyncio

import pytest

from agent_harness.api import Harness, TaskError
from agent_harness.runtime.tasks import TASK_AUDIT, TASK_STATE
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


@pytest.fixture(params=["memory", "sqlite"])
def storage(request, tmp_path):
    store = MemoryStorage() if request.param == "memory" else SQLiteStorage(tmp_path / "s.sqlite")
    yield store
    if request.param == "sqlite":
        store.close()


def test_tasks_graph_and_transactions(storage):
    async def scenario():
        h = await Harness.open("s", storage)
        tasks = h.tasks
        first, second = await asyncio.gather(tasks.create("first", "details"), tasks.create("second", "details"))
        assert (first.id, second.id) == ("1", "2")
        await tasks.update("2", add_blocked_by=["1"], metadata={"a": {"b": [1]}})
        assert (await tasks.get("1")).blocks == ("2",)
        for kwargs in (
            {"status": "in_progress"},
            {"status": "completed"},
            {"add_blocks": ["1"]},
            {"add_blocked_by": ["2"]},
            {"add_blocks": ["999"]},
        ):
            before = await storage.get_value(TASK_STATE)
            audit = await storage.read_list(TASK_AUDIT)
            with pytest.raises(TaskError):
                await tasks.update("2", **kwargs)
            assert await storage.get_value(TASK_STATE) == before
            assert await storage.read_list(TASK_AUDIT) == audit
        await tasks.update("1", status="completed")
        await tasks.update("2", status="in_progress", owner="worker", activeForm="working")
        with pytest.raises(TaskError):
            await tasks.update("1", status="pending")
        with pytest.raises(TaskError):
            await tasks.update("1", add_blocked_by=["2"])
        await tasks.update("2", status="pending", metadata={"a": None, "x": 4})
        await tasks.update("1", status="pending")
        result = await tasks.get("2")
        assert result.unfinished_blockers == ("1",)
        assert dict(result.metadata) == {"x": 4}
        with pytest.raises(TypeError):
            result.metadata["x"] = 5
        await tasks.update("1", status="deleted")
        assert (await tasks.get("2")).blockedBy == ()
        with pytest.raises(TaskError):
            await tasks.get("1")
        assert (await tasks.create("third", "")).id == "3"
        assert [t["id"] for t in (await tasks.list(limit=1))["tasks"]] == ["2"]
        assert (await tasks.list(limit=1))["next_offset"] == 1
        assert (await tasks.list(offset=1))["tasks"][0]["id"] == "3"
        assert len(await storage.read_list(TASK_AUDIT)) == 9
        await h.close()

    asyncio.run(scenario())


def test_failed_commit_leaves_no_task_or_number(storage):
    async def scenario():
        h = await Harness.open("s", storage)
        original = storage.commit

        async def reject(writes):
            if any(isinstance(w, SetValue) and w.address == TASK_STATE for w in writes):
                raise OSError("failed transaction")
            return await original(writes)

        storage.commit = reject
        with pytest.raises(OSError):
            await h.tasks.create("task", "")
        storage.commit = original
        assert await storage.get_value(TASK_STATE) is None
        assert await storage.read_list(TASK_AUDIT) == []
        assert (await h.tasks.create("task", "")).id == "1"
        await h.close()

    asyncio.run(scenario())


def test_concurrent_updates_use_latest_graph(storage):
    async def scenario():
        h = await Harness.open("s", storage)
        await h.tasks.create("shared", "")
        await asyncio.gather(*(h.tasks.update("1", metadata={str(n): n}) for n in range(20)))
        assert dict((await h.tasks.get("1")).metadata) == {str(n): n for n in range(20)}
        assert len(await storage.read_list(TASK_AUDIT)) == 21
        await h.close()

    asyncio.run(scenario())
