import asyncio
import subprocess
from pathlib import Path

import pytest

from agent_harness.domain.subagents import SubagentRequest
from agent_harness.integrations.workspaces import GitWorkspaceManager


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def repository(tmp_path: Path) -> Path:
    git(tmp_path, "init", "-q")
    git(tmp_path, "config", "user.email", "test@example.com")
    git(tmp_path, "config", "user.name", "Test")
    (tmp_path / "file").write_text("base")
    (tmp_path / ".gitignore").write_text("ignored\n")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-qm", "base")
    return tmp_path


def test_workspace_isolation_and_cleanup(tmp_path):
    async def run():
        root = repository(tmp_path)
        manager = GitWorkspaceManager(root)
        first = await manager.plan("session", "first")
        second = await manager.plan("session", "second")
        (root / "later").write_text("later parent commit")
        git(root, "add", "later")
        git(root, "commit", "-qm", "advance parent")
        (root / "file").write_text("dirty parent")
        (root / "untracked").write_text("parent only")
        await manager.create(first)
        await manager.create(first)  # effect replay
        await manager.create(second)
        assert (Path(first.path) / "file").read_text() == "base"
        assert not (Path(first.path) / "untracked").exists()
        assert not (Path(first.path) / "later").exists()
        assert git(Path(first.path), "rev-parse", "HEAD") == first.base_commit
        (Path(first.path) / "file").write_text("child")
        assert (Path(second.path) / "file").read_text() == "base"
        assert await manager.has_changes(first)
        assert not await manager.has_changes(second)
        await manager.remove(second)
        await manager.remove(second)
        assert not Path(second.path).exists()
        assert (root / "file").read_text() == "dirty parent"

    asyncio.run(run())


@pytest.mark.parametrize("artifact", ["file", "untracked", "ignored", "commit"])
def test_workspace_preserves_artifacts(tmp_path, artifact):
    async def run():
        manager = GitWorkspaceManager(repository(tmp_path))
        workspace = await manager.plan("session", "agent")
        await manager.create(workspace)
        root = Path(workspace.path)
        (root / ("new" if artifact == "commit" else artifact)).write_text("output")
        if artifact == "commit":
            git(root, "add", "new")
            git(root, "commit", "-qm", "child")
        assert await manager.has_changes(workspace)
        with pytest.raises(Exception, match="changes"):
            await manager.remove(workspace)
        assert root.exists()

    asyncio.run(run())


def test_invalid_isolation():
    with pytest.raises(ValueError, match="isolation"):
        SubagentRequest("task", "description", isolation="other")


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
@pytest.mark.parametrize("dirty", [False, True])
def test_runtime_workspace_result_and_continue(tmp_path, backend, dirty):
    from agent_harness.api.harness import Harness
    from agent_harness.integrations.local_tools import create_builtin_tools
    from agent_harness.integrations.workspaces import LocalWorkspaceToolFactory
    from agent_harness.runtime.generation import AssistantResult, ToolCall
    from agent_harness.runtime.subagents import MappingProviderResolver
    from agent_harness.storage.memory import MemoryStorage
    from agent_harness.storage.sqlite import SQLiteStorage

    async def run():
        root = repository(tmp_path / "repo")

        class Provider:
            async def generate(self, request):
                if dirty and not any(m.get("role") == "tool" for m in request.messages):
                    return AssistantResult(
                        "", {}, tool_calls=(ToolCall("write", "write", {"path": "file", "content": "child"}),)
                    )
                return AssistantResult("answer", {})

        provider = Provider()
        storage = MemoryStorage() if backend == "memory" else SQLiteStorage(tmp_path / "state.db")
        harness = await Harness.open(
            "s",
            storage,
            tools=create_builtin_tools(root),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
            workspace_manager=GitWorkspaceManager(root),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            admission = await harness.start_subagent(
                "main",
                parent.operation_id,
                SubagentRequest("task", "task", isolation="worktree", run_in_background=True),
                "key",
            )
            snapshot = (await harness.wait_subagent_run(admission.run_id, 5000)).snapshot
            assert snapshot.result.answer == "answer"
            workspace = snapshot.result.workspace
            assert workspace.state == ("retained" if dirty else "removed")
            assert (root / "file").read_text() == "base"
            continued = await harness.continue_subagent(
                admission.agent_id, "main", parent.operation_id, "again", False, "next"
            )
            result = (await harness.wait_subagent_run(continued.run_id, 5000)).snapshot.result
            assert result.answer == "answer"
            assert result.workspace.path == workspace.path
            assert result.workspace.base_commit == workspace.base_commit
            assert all(span.settled for span in await storage.list_spans(admission.operation_id))
        finally:
            await harness.close()

    (tmp_path / "repo").mkdir()
    asyncio.run(run())


def test_workspace_tool_binding(tmp_path):
    from agent_harness.integrations.local_tools import create_builtin_tools
    from agent_harness.integrations.repository_explorer import RepositoryExplorerConfig, RepositoryExplorerTool
    from agent_harness.integrations.workspaces import LocalWorkspaceToolFactory

    async def run():
        root = repository(tmp_path)
        manager = GitWorkspaceManager(root)
        workspace = await manager.plan("s", "agent")
        await manager.create(workspace)
        explorer = RepositoryExplorerTool(RepositoryExplorerConfig(root, tmp_path.parent / "cache"))
        original = create_builtin_tools(root, repository_explorer=explorer)
        bound = LocalWorkspaceToolFactory().bind(workspace, original)
        for tool in bound[:4]:
            assert Path(tool.cwd) == Path(workspace.path)
        assert bound[4].config.workspace_root == Path(workspace.path)
        assert bound[4].config.cache_dir != explorer.config.cache_dir
        assert all(Path(t.cwd) == root for t in original[:4])
        assert (await bound[0].execute({"path": "file"})).is_error is False
        assert (await bound[3].execute({"command": "pwd"})).content.strip() == workspace.path
        await bound[1].execute({"path": "file", "content": "child"})
        await bound[2].execute({"path": "file", "edits": [{"oldText": "child", "newText": "edited"}]})
        assert (Path(workspace.path) / "file").read_text() == "edited"
        assert (root / "file").read_text() == "base"

    asyncio.run(run())


@pytest.mark.parametrize("fail_cleanup", [False, True])
def test_finalization_blocks_continue_and_preserves_answer(tmp_path, fail_cleanup):
    from agent_harness.api.harness import Harness
    from agent_harness.domain.subagents import SubagentBusy
    from agent_harness.domain.values import lane_inbox
    from agent_harness.integrations.workspaces import LocalWorkspaceToolFactory
    from agent_harness.runtime.generation import AssistantResult
    from agent_harness.runtime.subagents import MappingProviderResolver
    from agent_harness.storage.memory import MemoryStorage

    async def run():
        root = repository(tmp_path)
        entered, release = asyncio.Event(), asyncio.Event()

        class Manager(GitWorkspaceManager):
            async def has_changes(self, workspace):
                entered.set()
                await release.wait()
                return await super().has_changes(workspace)

            async def remove(self, workspace):
                if fail_cleanup and not getattr(self, "failed", False):
                    self.failed = True
                    raise OSError("cleanup unavailable")
                await super().remove(workspace)

        class Provider:
            async def generate(self, request):
                return AssistantResult("answer survives cleanup", {})

        storage = MemoryStorage()
        harness = await Harness.open(
            "s",
            storage,
            provider_resolver=MappingProviderResolver({"test": Provider()}, "test"),
            workspace_manager=Manager(root),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            admission = await harness.start_subagent(
                "main",
                parent.operation_id,
                SubagentRequest("task", "task", isolation="worktree", run_in_background=True),
                "key",
            )
            await asyncio.wait_for(entered.wait(), 5)
            snapshot = await harness.get_subagent_run(admission.run_id)
            assert snapshot.state == "terminal" and snapshot.result is None
            assert not await storage.read_list(lane_inbox("main"))
            with pytest.raises(SubagentBusy):
                await harness.continue_subagent(admission.agent_id, "main", parent.operation_id, "again", False, "next")
            release.set()
            result = (await harness.wait_subagent_run(admission.run_id, 5000)).snapshot.result
            assert result.status == "completed" and result.answer == "answer survives cleanup"
            if fail_cleanup:
                assert "cleanup unavailable" in result.workspace.error
                assert Path(result.workspace.path).exists()
            await harness.recover_subagents()
            final = (await harness.get_subagent_run(admission.run_id)).result
            assert final.workspace.state == "removed"
            assert final.workspace.error is None
            assert len(await storage.read_list(lane_inbox("main"))) == 1
            assert all(s.settled for s in await storage.list_spans(admission.operation_id))
        finally:
            release.set()
            await harness.close()

    asyncio.run(run())


@pytest.mark.parametrize("cancel", [False, True])
def test_shutdown_and_cancel_workspace_lifecycle(tmp_path, cancel):
    from agent_harness.api.harness import Harness
    from agent_harness.integrations.workspaces import LocalWorkspaceToolFactory
    from agent_harness.runtime.generation import AssistantResult
    from agent_harness.runtime.subagents import MappingProviderResolver
    from agent_harness.storage.memory import MemoryStorage

    async def run():
        root = repository(tmp_path)
        entered = asyncio.Event()

        class Provider:
            async def generate(self, request):
                entered.set()
                await asyncio.Event().wait()
                return AssistantResult("", {})

        storage = MemoryStorage()
        options = dict(
            provider_resolver=MappingProviderResolver({"test": Provider()}, "test"),
            workspace_manager=GitWorkspaceManager(root),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )
        harness = await Harness.open("s", storage, **options)
        parent = await (await harness.acquire_lane("main")).prompt("task")
        admitted = await harness.start_subagent(
            "main", parent.operation_id, SubagentRequest("task", "task", isolation="worktree"), "key"
        )
        await asyncio.wait_for(entered.wait(), 5)
        workspace = (await harness.get_subagent_run(admitted.run_id)).workspace
        if cancel:
            await harness.stop_subagent_run(admitted.run_id)
            final = (await harness.wait_subagent_run(admitted.run_id, 5000)).snapshot
            assert final.result.workspace.state == "removed"
            assert not Path(workspace.path).exists()
            await harness.close()
        else:
            await harness.close()
            assert Path(workspace.path).exists()
            # Recovery reconciles an unknown LLM outcome and then cleans the code copy.
            harness = await Harness.open("s", storage, **options)
            try:
                final = (await harness.wait_subagent_run(admitted.run_id, 5000)).snapshot
                assert final.result.workspace.state == "removed"
            finally:
                await harness.close()

    asyncio.run(run())


def test_partial_branch_creation_is_recoverable_and_conflicts_are_preserved(tmp_path):
    async def run():
        manager = GitWorkspaceManager(repository(tmp_path))
        workspace = await manager.plan("s", "a")
        manager._ownership(workspace, reserve=True)
        git(tmp_path, "branch", workspace.branch, workspace.base_commit)
        await manager.create(workspace)
        assert not await manager.has_changes(workspace)
        await manager.remove(workspace)
        other = await manager.plan("s", "b")
        git(tmp_path, "branch", other.branch, other.base_commit)
        with pytest.raises(Exception, match="ownership"):
            await manager.create(other)
        assert git(tmp_path, "rev-parse", other.branch) == other.base_commit

    asyncio.run(run())


@pytest.mark.parametrize("background", [False, True])
def test_model_control_exposes_workspace_and_role_default(tmp_path, background):
    from agent_harness.api.harness import Harness
    from agent_harness.domain.subagents import SubagentDefinition
    from agent_harness.domain.values import lane_inbox
    from agent_harness.integrations.workspaces import LocalWorkspaceToolFactory
    from agent_harness.runtime.generation import AssistantResult, ToolCall
    from agent_harness.runtime.subagents import MappingProviderResolver, create_subagent_tools
    from agent_harness.storage.memory import MemoryStorage

    async def run():
        root = repository(tmp_path)

        class Provider:
            async def generate(self, request):
                if request.lane == "main":
                    if not any(m.get("role") == "tool" for m in request.messages):
                        return AssistantResult(
                            "",
                            {},
                            tool_calls=(
                                ToolCall(
                                    "delegate",
                                    "subagent",
                                    {
                                        "prompt": "task",
                                        "description": "task",
                                        "subagent_type": "isolated",
                                        "run_in_background": background,
                                    },
                                ),
                            ),
                        )
                    return AssistantResult("parent answer", {})
                return AssistantResult("child answer", {})

        provider = Provider()
        storage = MemoryStorage()
        harness = await Harness.open(
            "s",
            storage,
            tools=create_subagent_tools(),
            definitions=(SubagentDefinition("isolated", "isolated role", "Do task", isolation="worktree"),),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
            workspace_manager=GitWorkspaceManager(root),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )
        try:
            parent = await harness.acquire_lane("main")
            await parent.prompt("task")
            await parent.drive(provider)
            runs = await harness.list_subagent_runs("main")
            final = (await harness.wait_subagent_run(runs[0].run_id, 5000)).snapshot
            assert final.result.answer == "child answer"
            assert final.result.workspace.state == "removed"
            if background:
                await harness.recover_subagents()
                inbox = await storage.read_list(lane_inbox("main"))
                assert len(inbox) == 1
                assert "base_commit" in inbox[0]["prompt"] and "removed" in inbox[0]["prompt"]
            else:
                entries = await storage.scan_branch((await parent.snapshot()).tip_id)
                results = [
                    e.payload for e in entries if isinstance(e.payload, dict) and e.payload.get("role") == "tool"
                ]
                assert "removed" in str(results) and "base_commit" in str(results)
        finally:
            await harness.close()

    asyncio.run(run())


@pytest.mark.parametrize("initialized", [False, True])
def test_isolation_requires_valid_git_head(tmp_path, initialized):
    from agent_harness.domain.subagents import SubagentCapabilityUnavailable

    async def run():
        if initialized:
            git(tmp_path, "init", "-q")
        with pytest.raises(SubagentCapabilityUnavailable):
            await GitWorkspaceManager(tmp_path).plan("s", "agent")

    asyncio.run(run())
