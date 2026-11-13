import asyncio
from pathlib import Path

import pytest

from agent_harness.integrations.local_tools import BashTool
from agent_harness.integrations.shell import BubblewrapExecutor, ShellCapability
from agent_harness.integrations.tool_risk import ConfiguredRiskEvaluator


class Executor:
    def __init__(self, available=True):
        self.available = available
        self.calls = []

    def probe(self, cwd):
        return ShellCapability(self.available, str(self.available), "namespaces unavailable")

    async def launch(self, argv, cwd, env, sandbox):
        self.calls.append(sandbox)
        raise OSError("wrapper failed")


def test_sandbox_permission_and_capability_fingerprint(tmp_path):
    executor = Executor()
    tool = BashTool(tmp_path, executor=executor)
    arguments = {"command": "rm -rf scratch; curl https://example.com"}
    original = tool.assess_risk(arguments)
    assert original.decision == "allow"
    executor.available = False
    fallback = tool.assess_risk(arguments)
    assert fallback.decision == "ask"
    assert "unsandboxed" in fallback.reason
    assert original.capability_version != fallback.capability_version
    assert tool.assess_risk({**arguments, "sandbox_permissions": "danger-full-access"}).decision == "deny"
    assert (
        tool.assess_risk(
            {**arguments, "sandbox_permissions": "danger-full-access", "justification": "install"}
        ).decision
        == "ask"
    )


@pytest.mark.parametrize("kwargs", [{"sandbox": "off"}, {"command_prefix": ("env",)}])
def test_fallback_requires_approval(tmp_path, kwargs):
    assert BashTool(tmp_path, executor=Executor(), **kwargs).assess_risk({"command": "true"}).decision == "ask"


def test_custom_protection_and_wrapper_failure_never_retry(tmp_path):
    async def scenario():
        executor = Executor()
        tool = BashTool(tmp_path, executor=executor)
        arguments = {"command": "echo test"}
        tool.assess_risk(arguments)
        executor.available = False
        result = await tool.execute(arguments)
        assert result.is_error
        assert executor.calls == []  # A probe change cannot silently switch this invocation to host.
        executor.available = True
        tool.assess_risk(arguments)
        await tool.execute(arguments)
        assert executor.calls == [True]  # Wrapper failure never causes a host retry.
        policy = ConfiguredRiskEvaluator(protected_paths=("private/*",))
        assert policy("bash", arguments, tool).decision == "ask"
        await tool.execute(arguments)
        assert executor.calls == [True, False]

    asyncio.run(scenario())


def test_real_bubblewrap_boundary(tmp_path):
    executor = BubblewrapExecutor()
    root = tmp_path / "workspace"
    root.mkdir()
    capability = executor.probe(root)
    if not capability.available:
        import os

        if os.environ.get("PRALE_REQUIRE_BWRAP") == "1":
            pytest.fail(capability.reason)
        pytest.skip(capability.reason)
    import tempfile

    external = tempfile.TemporaryDirectory(prefix="prale-external-", dir="/var/tmp")
    outside = Path(external.name) / "outside"
    outside.write_text("readable")

    async def scenario():
        tool = BashTool(root, executor=executor)
        result = await tool.execute({"command": f"cat {outside}; echo ok > inside; echo private > /tmp/prale-private"})
        assert not result.is_error
        assert (root / "inside").read_text().strip() == "ok"
        assert "readable" in result.content
        assert not Path("/tmp/prale-private").exists()
        result = await tool.execute({"command": f'python3 -c \'open("{outside}", "w").write("bad")\''})
        assert result.is_error
        assert outside.read_text() == "readable"

    asyncio.run(scenario())


def test_namespace_probe_must_succeed(tmp_path, monkeypatch):
    import subprocess

    monkeypatch.setattr("agent_harness.integrations.shell.shutil.which", lambda name: "/bin/true")
    monkeypatch.setattr(
        "agent_harness.integrations.shell.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 1, b"", b"unshare denied"),
    )
    assert not BubblewrapExecutor().probe(tmp_path).available
    assert BashTool(tmp_path).assess_risk({"command": "true"}).decision == "ask"


def test_real_sandbox_network_and_process_tree_cleanup(tmp_path):
    executor = BubblewrapExecutor()
    capability = executor.probe(tmp_path)
    if not capability.available:
        import os

        if os.environ.get("PRALE_REQUIRE_BWRAP") == "1":
            pytest.fail(capability.reason)
        pytest.skip(capability.reason)

    async def scenario():
        tool = BashTool(tmp_path, executor=executor)

        async def connected(reader, writer):
            writer.write(b"network-ok")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(connected, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        async with server:
            command = (
                "python3 -c 'import socket; "
                f'print(socket.create_connection(("127.0.0.1", {port})).recv(100).decode())' + "'"
            )
            result = await tool.execute({"command": command})
        assert not result.is_error
        assert "network-ok" in result.content
        command = "echo ready > started; (sleep 0.4; echo leaked > leaked) & wait"
        result = await tool.execute({"command": command, "timeout": 0.08})
        assert result.is_error and "timed out" in result.content
        (tmp_path / "started").unlink()
        task = asyncio.create_task(tool.execute({"command": command}))
        for _ in range(100):
            if (tmp_path / "started").exists():
                break
            await asyncio.sleep(0.01)
        assert (tmp_path / "started").exists()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.5)
        assert not (tmp_path / "leaked").exists()

    asyncio.run(scenario())


def test_configuration_mounts_and_capability_identity(tmp_path):
    from agent_harness.integrations.shell import READONLY_WORKSPACE_PATHS

    executor = BubblewrapExecutor()
    for name in READONLY_WORKSPACE_PATHS:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in {".vscode", ".idea", ".git/hooks"}:
            path.mkdir()
        else:
            path.write_text("original")
    mounts = executor._readonly_mounts(tmp_path)
    assert {target.relative_to(tmp_path).as_posix() for _, target in mounts} == set(READONLY_WORKSPACE_PATHS)
    (tmp_path / ".git/config").unlink()
    import shutil

    shutil.rmtree(tmp_path / ".git")
    (tmp_path / ".git").write_text("gitdir: /outside/worktrees/example")
    assert (tmp_path / ".git", tmp_path / ".git") in executor._readonly_mounts(tmp_path)


def test_configuration_wrapper_order(tmp_path, monkeypatch):
    monkeypatch.setattr("agent_harness.integrations.shell.shutil.which", lambda name: "/usr/bin/bwrap")
    config = tmp_path / ".mcp.json"
    config.write_text("{}")
    wrapper = BubblewrapExecutor()._wrapper(tmp_path)
    workspace_index = wrapper.index("--bind")
    protected_index = wrapper.index("--ro-bind", wrapper.index("--ro-bind") + 1)
    assert protected_index > workspace_index
    assert wrapper[protected_index + 1 : protected_index + 3] == (str(config), str(config))


def test_real_configuration_mounts_are_readonly(tmp_path):
    from agent_harness.integrations.shell import READONLY_WORKSPACE_PATHS

    for name in READONLY_WORKSPACE_PATHS:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name in {".vscode", ".idea", ".git/hooks"}:
            path.mkdir()
            (path / "config").write_text("original")
        else:
            path.write_text("original")
    capability = BubblewrapExecutor().probe(tmp_path)
    if not capability.available:
        import os

        if os.environ.get("PRALE_REQUIRE_BWRAP") == "1":
            pytest.fail(capability.reason)
        pytest.skip(capability.reason)

    async def scenario():
        import shlex

        tool = BashTool(tmp_path)
        for name in READONLY_WORKSPACE_PATHS:
            quoted = shlex.quote(name)
            target = name + "/config" if (tmp_path / name).is_dir() else name
            result = await tool.execute({"command": f"echo changed > {shlex.quote(target)}"})
            assert result.is_error, name
            assert (tmp_path / target).read_text() == "original"
            for command in (f"rm -rf -- {quoted}", f"mv -- {quoted} moved"):
                assert (await tool.execute({"command": command})).is_error, name
        assert not (await tool.execute({"command": "echo ok > normal.txt"})).is_error

    asyncio.run(scenario())


def test_protected_path_changes_invalidate_capability(tmp_path, monkeypatch):
    import subprocess

    monkeypatch.setattr("agent_harness.integrations.shell.shutil.which", lambda name: "/bin/true")
    monkeypatch.setattr(
        "agent_harness.integrations.shell.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, b"", b""),
    )
    executor = BubblewrapExecutor()
    original = executor.probe(tmp_path)
    config = tmp_path / ".mcp.json"
    config.write_text("{}")
    created = executor.probe(tmp_path)
    assert original.available and created.available
    assert original.identity != created.identity
    replacement = tmp_path / "replacement"
    replacement.write_text("{}")
    replacement.replace(config)
    assert executor.probe(tmp_path).identity != created.identity


def test_real_worktree_pointer_and_symlink_target_are_readonly(tmp_path):
    pointer = tmp_path / ".git"
    pointer.write_text("gitdir: /outside/worktrees/example")
    target = tmp_path / "actual-config"
    target.write_text("original")
    (tmp_path / ".mcp.json").symlink_to(target)
    capability = BubblewrapExecutor().probe(tmp_path)
    if not capability.available:
        import os

        if os.environ.get("PRALE_REQUIRE_BWRAP") == "1":
            pytest.fail(capability.reason)
        pytest.skip(capability.reason)

    async def scenario():
        tool = BashTool(tmp_path)
        for command in (
            "echo bad > .git",
            "rm .git",
            "mv .git moved",
            "echo bad > .mcp.json",
            "echo bad > actual-config",
        ):
            assert (await tool.execute({"command": command})).is_error, command
        assert pointer.read_text() == "gitdir: /outside/worktrees/example"
        assert target.read_text() == "original"

    asyncio.run(scenario())


def test_hidden_directories_are_masked_after_workspace_bind(tmp_path, monkeypatch):
    monkeypatch.setattr("agent_harness.integrations.shell.shutil.which", lambda name: "/usr/bin/bwrap")
    hidden = tmp_path / ".eval-state"
    hidden.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    wrapper = BubblewrapExecutor(hidden_paths=(hidden,))._wrapper(workspace)
    index = wrapper.index(str(hidden), wrapper.index("--bind") + 3)
    assert wrapper[index - 1 : index + 3] == ("--tmpfs", str(hidden), "--remount-ro", str(hidden))


def test_hidden_configuration_changes_capability_and_rejects_hidden_workspace(tmp_path, monkeypatch):
    import subprocess

    monkeypatch.setattr("agent_harness.integrations.shell.shutil.which", lambda name: "/bin/true")
    monkeypatch.setattr(
        "agent_harness.integrations.shell.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, b"", b""),
    )
    hidden = tmp_path / ".eval-state"
    hidden.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    executor = BubblewrapExecutor(hidden_paths=(hidden,))
    assert executor.probe(workspace).identity != BubblewrapExecutor().probe(workspace).identity
    assert not executor.probe(hidden / "nested").available


def test_real_hidden_state_is_unreadable_through_absolute_paths_and_symlinks(tmp_path):
    import shlex
    import tempfile

    # /var/tmp is necessary: the existing private /tmp would hide test files anyway.
    with tempfile.TemporaryDirectory(prefix="prale-state-mask-", dir="/var/tmp") as external:
        hidden = Path(external) / ".eval-state"
        hidden.mkdir()
        (hidden / "memory.sqlite").write_text("private-memory")
        (tmp_path / "state-link").symlink_to(hidden, target_is_directory=True)
        executor = BubblewrapExecutor(hidden_paths=(hidden,))
        capability = executor.probe(tmp_path)
        if not capability.available:
            import os

            if os.environ.get("PRALE_REQUIRE_BWRAP") == "1":
                pytest.fail(capability.reason)
            pytest.skip(capability.reason)

        async def scenario():
            tool = BashTool(tmp_path, executor=executor)
            result = await tool.execute({"command": f"ls -A {shlex.quote(str(hidden))}"})
            assert not result.is_error
            assert not result.content.strip()
            for command in (
                f"cat {shlex.quote(str(hidden / 'memory.sqlite'))}",
                "cat state-link/memory.sqlite",
                f"echo bad > {shlex.quote(str(hidden / 'new-file'))}",
            ):
                assert (await tool.execute({"command": command})).is_error
            assert not (await tool.execute({"command": "echo ok > workspace-file"})).is_error

        asyncio.run(scenario())
        assert (hidden / "memory.sqlite").read_text() == "private-memory"
        assert not (hidden / "new-file").exists()


def test_hidden_parent_subsumes_nested_state_and_canonicalizes_alias(tmp_path):
    hidden = tmp_path / ".eval-state"
    hidden.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(hidden, target_is_directory=True)
    executor = BubblewrapExecutor(hidden_paths=(hidden / "run", hidden, alias))
    assert executor._hidden_directories() == (hidden.resolve(),)
