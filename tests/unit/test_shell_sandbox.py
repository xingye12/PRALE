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
