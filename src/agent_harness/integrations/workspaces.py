"""Conservative, replayable local Git worktree effects; never force or prune."""

import asyncio
import hashlib
import json
import os
from dataclasses import replace
from pathlib import Path

from agent_harness.domain.subagents import SubagentCapabilityUnavailable, SubagentWorkspace
from agent_harness.integrations.local_tools import BashTool, EditTool, ReadTool, WriteTool
from agent_harness.integrations.repository_explorer import RepositoryExplorerTool
from agent_harness.runtime.tools import AgentTool, RuntimeControlTool


class GitWorkspaceManager:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()

    async def _git(self, *args: str, root: Path | None = None, missing: bool = False) -> str:
        try:
            process = await asyncio.create_subprocess_exec(
                "git",
                "-C",
                str(root or self.root),
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as exc:
            raise SubagentCapabilityUnavailable(f"Git unavailable: {exc}") from exc
        # Join the subprocess even on shutdown: recovery must never race a live Git writer.
        task = asyncio.create_task(process.communicate())
        try:
            output, error = await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise
        if process.returncode and not missing:
            raise SubagentCapabilityUnavailable(error.decode(errors="replace").strip())
        return output.decode().strip() if process.returncode == 0 else ""

    async def plan(self, session_id: str, agent_id: str) -> SubagentWorkspace:
        common = str(Path(await self._git("rev-parse", "--path-format=absolute", "--git-common-dir")).resolve())
        base = await self._git("rev-parse", "--verify", "HEAD^{commit}")
        owner = hashlib.sha256(f"{session_id}\0{agent_id}".encode()).hexdigest()
        return SubagentWorkspace(
            "worktree",
            str(Path(common) / "prale" / "worktrees" / owner),
            "prale/subagent/" + owner,
            base,
            common,
            owner,
        )

    async def _registered(self, workspace: SubagentWorkspace) -> bool:
        common = str(Path(await self._git("rev-parse", "--path-format=absolute", "--git-common-dir")).resolve())
        if common != workspace.common_dir:
            raise SubagentCapabilityUnavailable("workspace common directory ownership conflict")
        expected = Path(common) / "prale" / "worktrees" / workspace.owner
        if (
            str(expected) != workspace.path
            or str(expected.resolve()) != workspace.path
            or workspace.branch != "prale/subagent/" + workspace.owner
        ):
            raise SubagentCapabilityUnavailable("workspace path or branch ownership conflict")
        listing = await self._git("worktree", "list", "--porcelain", "-z")
        registered = False
        for block in listing.split("\0\0"):
            fields = block.split("\0")
            if "worktree " + workspace.path in fields:
                if "branch refs/heads/" + workspace.branch not in fields or any(
                    f.startswith("locked") or f.startswith("prunable") for f in fields
                ):
                    raise SubagentCapabilityUnavailable("workspace registration ownership conflict")
                registered = True
            elif "branch refs/heads/" + workspace.branch in fields:
                raise SubagentCapabilityUnavailable("workspace branch registered at another path")
        return registered

    def _ownership(self, workspace: SubagentWorkspace, *, reserve: bool = False) -> None:
        marker = Path(workspace.common_dir) / "prale" / "owners" / (workspace.owner + ".json")
        identity = json.dumps(
            {k: getattr(workspace, k) for k in ("path", "branch", "base_commit", "common_dir", "owner")}, sort_keys=True
        )
        if reserve:
            marker.parent.mkdir(parents=True, exist_ok=True)
            try:
                descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(descriptor, "w") as stream:
                    stream.write(identity)
                    stream.flush()
                    os.fsync(stream.fileno())
        if not marker.is_file() or marker.is_symlink() or marker.read_text() != identity:
            raise SubagentCapabilityUnavailable("workspace ownership marker conflict or missing")

    async def create(self, workspace: SubagentWorkspace) -> None:
        registered = await self._registered(workspace)
        path = Path(workspace.path)
        if registered:
            self._ownership(workspace)
            if path.is_symlink() or not path.is_dir():
                raise SubagentCapabilityUnavailable("registered workspace directory missing")
            actual = await self._git("rev-parse", "--show-toplevel", root=path)
            if actual != workspace.path:
                raise SubagentCapabilityUnavailable("workspace directory ownership conflict")
            return
        if path.exists() or path.is_symlink():
            raise SubagentCapabilityUnavailable("workspace path ownership conflict")
        branch = await self._git("rev-parse", "--verify", "refs/heads/" + workspace.branch, missing=True)
        if branch:
            # A crash may create the owned branch before registering the worktree.
            self._ownership(workspace)
            if branch != workspace.base_commit:
                raise SubagentCapabilityUnavailable("unregistered workspace branch has changes")
            await self._git("worktree", "add", workspace.path, workspace.branch)
            return
        self._ownership(workspace, reserve=True)
        path.parent.mkdir(parents=True, exist_ok=True)
        await self._git("worktree", "add", "-b", workspace.branch, workspace.path, workspace.base_commit)

    async def has_changes(self, workspace: SubagentWorkspace) -> bool:
        if not await self._registered(workspace) or not Path(workspace.path).is_dir():
            raise SubagentCapabilityUnavailable("workspace missing or ownership conflict")
        self._ownership(workspace)
        root = Path(workspace.path)
        if root.is_symlink() or str(root.resolve()) != workspace.path:
            raise SubagentCapabilityUnavailable("workspace path ownership conflict")
        actual_common = await self._git("rev-parse", "--path-format=absolute", "--git-common-dir", root=root)
        actual_branch = await self._git("symbolic-ref", "HEAD", root=root)
        if (
            str(Path(actual_common).resolve()) != workspace.common_dir
            or actual_branch != "refs/heads/" + workspace.branch
        ):
            raise SubagentCapabilityUnavailable("workspace directory ownership conflict")
        head = await self._git("rev-parse", "HEAD", root=root)
        status = await self._git("status", "--porcelain=v1", "--untracked-files=all", "--ignored", root=root)
        return head != workspace.base_commit or bool(status)

    async def remove(self, workspace: SubagentWorkspace) -> None:
        registered = await self._registered(workspace)
        self._ownership(workspace)
        path = Path(workspace.path)
        if registered:
            if await self.has_changes(workspace):
                raise SubagentCapabilityUnavailable("workspace has changes; retained")
            await self._git("worktree", "remove", workspace.path)
        elif path.exists() or path.is_symlink():
            raise SubagentCapabilityUnavailable("workspace removal ownership conflict")
        branch = await self._git("rev-parse", "--verify", "refs/heads/" + workspace.branch, missing=True)
        if branch:
            if branch != workspace.base_commit:
                raise SubagentCapabilityUnavailable("workspace branch has changes; retained")
            # Compare-and-delete only our exact base, without force deletion.
            await self._git("update-ref", "-d", "refs/heads/" + workspace.branch, workspace.base_commit)


class LocalWorkspaceToolFactory:
    """Rebind known concrete tools; names alone never grant cross-workspace access."""

    def validate(self, tools: tuple[AgentTool | RuntimeControlTool, ...]) -> None:
        invalid = [
            t.name
            for t in tools
            if not (
                isinstance(t, (ReadTool, WriteTool, EditTool, BashTool, RepositoryExplorerTool))
                or getattr(t, "workspace_reusable", False) is True
                or callable(getattr(t, "for_workspace", None))
            )
        ]
        if invalid:
            raise SubagentCapabilityUnavailable("tools require workspace binding: " + ", ".join(sorted(invalid)))

    def bind(
        self, workspace: SubagentWorkspace, tools: tuple[AgentTool | RuntimeControlTool, ...]
    ) -> tuple[AgentTool | RuntimeControlTool, ...]:
        self.validate(tools)
        result: list[AgentTool | RuntimeControlTool] = []
        for tool in tools:
            if isinstance(tool, (ReadTool, WriteTool, EditTool, BashTool)):
                result.append(replace(tool, cwd=Path(workspace.path)))
            elif isinstance(tool, RepositoryExplorerTool):
                config = replace(
                    tool.config,
                    workspace_root=Path(workspace.path),
                    cache_dir=Path(workspace.common_dir) / "prale" / "indexes" / workspace.owner,
                )
                result.append(RepositoryExplorerTool(config))
            elif callable(getattr(tool, "for_workspace", None)):
                result.append(tool.for_workspace(workspace))
            else:
                result.append(tool)
        return tuple(result)
