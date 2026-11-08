"""Real process exits around native task settlement and frozen generation intent."""

import asyncio
import multiprocessing
import os

import pytest

from agent_harness.api import Harness, create_task_tools
from agent_harness.domain.values import operation_state
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.tasks import TASK_AUDIT, TASK_STATE
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


class Provider:
    def __init__(self, kind):
        self.kind = kind

    async def generate(self, request):
        if not any(m.get("role") == "tool" for m in request.messages):
            args = (
                {"subject": "created", "description": ""}
                if self.kind == "task_create"
                else {"task_id": "1", "metadata": {"changed": True}}
            )
            return AssistantResult("", {}, tool_calls=(ToolCall("task-call", self.kind, args),))
        return AssistantResult("done", {})


class CrashStorage(SQLiteStorage):
    def __init__(self, path, boundary):
        super().__init__(path)
        self.boundary = boundary
        self.armed = False

    async def commit(self, writes):
        task = self.armed and any(isinstance(w, SetValue) and w.address == TASK_STATE for w in writes)
        intent = self.armed and any(
            isinstance(w, SetValue) and getattr(w.value, "at", None) == "assistant.effect_pending" for w in writes
        )
        if task and self.boundary == "before":
            os._exit(73)
        result = await super().commit(writes)
        if (task and self.boundary == "after") or (intent and self.boundary == "generation"):
            os._exit(73)
        return result


def child(path, boundary, kind):
    async def scenario():
        store = CrashStorage(path, boundary)
        h = await Harness.open("s", store, tools=create_task_tools())
        if kind == "task_update" or boundary == "generation":
            await h.tasks.create("original", "")
        lane = await h.acquire_lane("main")
        await lane.prompt("work")
        store.armed = True
        await lane.drive(Provider(kind))

    asyncio.run(scenario())


@pytest.mark.parametrize("kind", ["task_create", "task_update"])
@pytest.mark.parametrize("boundary", ["before", "after"])
def test_task_settlement_process_recovery(tmp_path, kind, boundary):
    path = tmp_path / "s.sqlite"
    process = multiprocessing.get_context("spawn").Process(target=child, args=(path, boundary, kind))
    process.start()
    process.join(15)
    assert process.exitcode == 73

    async def scenario():
        store = SQLiteStorage(path)
        h = await Harness.open("s", store, tools=create_task_tools())
        lane = await h.acquire_lane("main")
        operation = await lane.active_operation()
        assert operation is not None
        await lane.recover(Provider(kind))
        assert (await h.tasks.list())["total"] == 1
        task = await h.tasks.get("1")
        assert task.subject == ("created" if kind == "task_create" else "original")
        assert len(await store.read_list(TASK_AUDIT)) == (1 if kind == "task_create" else 2)
        entries = await h._session.context((await lane.snapshot()).tip_id)
        results = [e.payload for e in entries if e.payload.get("role") == "tool"]
        assert len(results) == 1
        assert results[0]["content"]["metadata"] == dict(task.metadata)
        assert all(s.outcome != "pending" for s in await store.list_spans(operation.meta.operation_id))
        await h.close()
        store.close()

    asyncio.run(scenario())


def test_generation_intent_freezes_task_snapshot(tmp_path):
    path = tmp_path / "s.sqlite"
    process = multiprocessing.get_context("spawn").Process(target=child, args=(path, "generation", "task_create"))
    process.start()
    process.join(15)
    assert process.exitcode == 73

    async def scenario():
        store = SQLiteStorage(path)
        h = await Harness.open("s", store, tools=create_task_tools())
        lane = await h.acquire_lane("main")
        operation = await lane.active_operation()
        frozen = operation.state.data
        assert frozen["task_snapshot_version"] == 1
        assert "original" in str(frozen["task_overview"])
        await h.tasks.update("1", subject="new title")
        assert (await store.get_value(operation_state(operation.meta.operation_id))).data == frozen
        await lane.recover(Provider("task_create"))
        assert (await h.tasks.get("1")).subject == "new title"
        await h.close()
        store.close()

    asyncio.run(scenario())
