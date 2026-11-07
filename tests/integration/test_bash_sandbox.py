"""Runtime approval boundaries use the same durable path for host escalation."""

import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import ApprovalConfig
from agent_harness.integrations.local_tools import BashTool
from agent_harness.integrations.shell import BubblewrapExecutor, ShellCapability
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.sqlite import SQLiteStorage


class Executor:
    def __init__(self):
        self.identity = "v1"
        self.calls = []

    def probe(self, cwd):
        return ShellCapability(True, self.identity)

    async def launch(self, argv, cwd, env, sandbox):
        self.calls.append(sandbox)
        return await BubblewrapExecutor().launch(argv, cwd, env, False)


class Provider:
    def __init__(self, arguments):
        self.arguments = arguments
        self.done = False

    async def generate(self, request):
        if self.done:
            return AssistantResult("done", {})
        self.done = True
        return AssistantResult("", {}, tool_calls=(ToolCall("c", "bash", self.arguments),))


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
def test_sandbox_auto_and_exact_host_grants_invalidate_on_capability_change(tmp_path, backend):
    async def scenario():
        storage = MemoryStorage() if backend == "memory" else SQLiteStorage(tmp_path / "session.db")
        executor = Executor()
        harness = await Harness.open(
            "s",
            storage,
            tools=(BashTool(tmp_path, executor=executor),),
            approvals=ApprovalConfig(channel_available=True),
        )
        decisions = []

        async def answer(event):
            if event.type == "approval_requested" and event.data["status"] == "pending":
                decisions.append(event.data)
                await harness.approvals.decide(event.data["approval_id"], "allow_session")

        harness.subscribe(answer)
        lane = await harness.acquire_lane("main")

        async def run(arguments):
            await lane.prompt("execute")
            await asyncio.wait_for(lane.drive(Provider(arguments)), 3)

        await run({"command": "echo sandbox"})
        assert not decisions
        arguments = {"command": "echo host", "sandbox_permissions": "danger-full-access", "justification": "test"}
        await run(arguments)
        await run(arguments)
        assert len(decisions) == 1
        executor.identity = "v2"
        await run(arguments)
        assert len(decisions) == 2
        assert decisions[0]["fingerprint"] != decisions[1]["fingerprint"]
        assert "unsandboxed host execution" in decisions[1]["reason"]
        assert executor.calls == [True, False, False, False]
        if backend == "sqlite":
            storage.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("policy,channel", [("ask", False), ("never", True)])
def test_escalation_without_permission_has_no_host_effect(tmp_path, policy, channel):
    async def scenario():
        executor = Executor()
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(BashTool(tmp_path, executor=executor),),
            approvals=ApprovalConfig(policy=policy, channel_available=channel),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("execute")
        await lane.drive(
            Provider(
                {"command": "touch forbidden", "sandbox_permissions": "danger-full-access", "justification": "test"}
            )
        )
        assert not executor.calls
        assert not (tmp_path / "forbidden").exists()

    asyncio.run(scenario())


def test_rejected_escalation_has_no_effect(tmp_path):
    async def scenario():
        executor = Executor()
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(BashTool(tmp_path, executor=executor),),
            approvals=ApprovalConfig(channel_available=True),
        )

        async def reject(event):
            if event.type == "approval_requested" and event.data["status"] == "pending":
                await harness.approvals.decide(event.data["approval_id"], "reject")

        harness.subscribe(reject)
        lane = await harness.acquire_lane("main")
        await lane.prompt("execute")
        await lane.drive(
            Provider(
                {"command": "touch forbidden", "sandbox_permissions": "danger-full-access", "justification": "test"}
            )
        )
        assert not executor.calls

    asyncio.run(scenario())


def test_capability_changed_after_approval_is_reassessed_before_intent(tmp_path):
    async def scenario():
        executor = Executor()
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(BashTool(tmp_path, executor=executor),),
            approvals=ApprovalConfig(channel_available=True),
        )
        requests = []

        async def answer(event):
            if event.type == "approval_requested" and event.data["status"] == "pending":
                requests.append(event.data)
                await harness.approvals.decide(
                    event.data["approval_id"], "allow_once" if len(requests) == 1 else "reject"
                )
                executor.identity = "changed"

        harness.subscribe(answer)
        lane = await harness.acquire_lane("main")
        await lane.prompt("execute")
        await asyncio.wait_for(
            lane.drive(
                Provider(
                    {
                        "command": "touch forbidden",
                        "sandbox_permissions": "danger-full-access",
                        "justification": "test",
                    }
                )
            ),
            3,
        )
        assert len(requests) == 2
        assert requests[0]["fingerprint"] != requests[1]["fingerprint"]
        assert not executor.calls
        assert not (tmp_path / "forbidden").exists()

    asyncio.run(scenario())
