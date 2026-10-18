"""Process exits around every workspace intent/effect/settlement boundary."""

import asyncio
import multiprocessing
import os
import subprocess

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.subagents import SubagentRequest
from agent_harness.domain.values import lane_inbox
from agent_harness.integrations.workspaces import GitWorkspaceManager, LocalWorkspaceToolFactory
from agent_harness.runtime.generation import AssistantResult
from agent_harness.runtime.subagents import MappingProviderResolver
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


class Provider:
    async def generate(self, request):
        return AssistantResult("durable answer", {})


class CrashStorage(SQLiteStorage):
    def __init__(self, path, stage):
        super().__init__(path)
        self.stage = stage

    async def commit(self, writes):
        result = await super().commit(writes)
        for write in writes:
            if isinstance(write, SetValue) and isinstance(write.value, dict):
                if write.address.key.endswith("/workspace") and write.value.get("state") == self.stage:
                    os._exit(73)
                if self.stage == "result" and write.address.key.endswith("/result") and write.value.get("workspace"):
                    os._exit(73)
        return result


class CrashManager(GitWorkspaceManager):
    def __init__(self, root, stage):
        super().__init__(root)
        self.stage = stage

    async def create(self, workspace):
        await super().create(workspace)
        if self.stage == "create_effect":
            os._exit(73)

    async def remove(self, workspace):
        await super().remove(workspace)
        if self.stage == "remove_effect":
            os._exit(73)


def worker(root, database, stage):
    async def run():
        harness = await Harness.open(
            "s",
            CrashStorage(database, stage),
            provider_resolver=MappingProviderResolver({"test": Provider()}, "test"),
            workspace_manager=CrashManager(root, stage),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )
        parent = await (await harness.acquire_lane("main")).prompt("task")
        admission = await harness.start_subagent(
            "main",
            parent.operation_id,
            SubagentRequest("task", "task", isolation="worktree", run_in_background=True),
            "key",
        )
        await harness.wait_subagent_run(admission.run_id, 10000)
        await asyncio.sleep(0.1)
        raise AssertionError("did not reach crash boundary")

    asyncio.run(run())


@pytest.mark.parametrize(
    "stage",
    [
        "pending",
        "planned",
        "creating",
        "create_effect",
        "ready",
        "checking",
        "checked",
        "removing",
        "remove_effect",
        "removed",
        "result",
    ],
)
def test_workspace_process_recovery(tmp_path, stage):
    root = tmp_path / "repo"
    root.mkdir()

    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()

    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    (root / "file").write_text("base")
    git("add", ".")
    git("commit", "-qm", "base")
    database = tmp_path / "session.db"
    process = multiprocessing.get_context("spawn").Process(target=worker, args=(root, database, stage))
    process.start()
    process.join(20)
    if process.is_alive():
        process.kill()
        process.join()
    assert process.exitcode == 73

    async def recover():
        storage = SQLiteStorage(database)
        harness = await Harness.open(
            "s",
            storage,
            provider_resolver=MappingProviderResolver({"test": Provider()}, "test"),
            workspace_manager=GitWorkspaceManager(root),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )
        try:
            snapshots = await harness.list_subagent_runs("main")
            snapshot = (await harness.wait_subagent_run(snapshots[0].run_id, 10000)).snapshot
            assert snapshot.result.answer == "durable answer"
            assert snapshot.result.workspace.state == "removed", snapshot.result.workspace.error
            await harness.recover_subagents()
            await harness.recover_subagents()
            assert len(await storage.read_list(lane_inbox("main"))) == 1
            assert len(git("worktree", "list", "--porcelain").split("worktree ")) == 2
            assert not git("branch", "--list", "prale/subagent/*")
            assert all(span.settled for span in await storage.list_spans(snapshot.operation_id))
        finally:
            await harness.close()
            storage.close()

    asyncio.run(recover())
