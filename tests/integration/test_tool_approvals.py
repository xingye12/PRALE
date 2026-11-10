import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import ApprovalConfig, ApprovalConflict
from agent_harness.integrations.local_tools import WriteTool
from agent_harness.integrations.tool_risk import ConfiguredRiskEvaluator
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.storage.memory import MemoryStorage


class Provider:
    def __init__(self, path=".env", content="secret"):
        self.path, self.content, self.count = path, content, 0

    async def generate(self, request):
        self.count += 1
        if self.count == 1:
            return AssistantResult(
                "", {}, tool_calls=(ToolCall("c", "write", {"path": self.path, "content": self.content}),)
            )
        return AssistantResult("done", {})


async def pending(harness):
    for _ in range(100):
        records = await harness.approvals.records()
        waiting = [r for r in records if r["status"] == "pending"]
        if waiting:
            return waiting[0]
        await asyncio.sleep(0.001)
    raise AssertionError("approval did not appear")


def test_web_channel_waits_for_permission(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        drive = asyncio.create_task(lane.drive(Provider()))
        request = await pending(harness)
        assert not (tmp_path / ".env").exists()
        await harness.approvals.decide(request["approval_id"], "allow_once")
        assert (await drive).status == "completed"
        assert (tmp_path / ".env").read_text() == "secret"
        assert (await harness.approvals.records())[0]["status"] == "consumed"

    asyncio.run(scenario())


def test_no_channel_rejects_without_effect(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        await lane.drive(Provider())
        assert not (tmp_path / ".env").exists()
        assert (await harness.approvals.records())[0]["status"] == "unavailable"

    asyncio.run(scenario())


def test_cancel_rejects_late_decision(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        drive = asyncio.create_task(lane.drive(Provider()))
        request = await pending(harness)
        await lane.request_abort()
        assert (await drive).status == "aborted"
        try:
            await harness.approvals.decide(request["approval_id"], "allow_once")
        except ApprovalConflict:
            pass
        else:
            raise AssertionError("late approval succeeded")
        assert not (tmp_path / ".env").exists()

    asyncio.run(scenario())


def test_session_grant_is_exact_and_revocable(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("first")
        drive = asyncio.create_task(lane.drive(Provider()))
        request = await pending(harness)
        await harness.approvals.decide(request["approval_id"], "allow_session")
        await drive
        await lane.prompt("repeat")
        await asyncio.wait_for(lane.drive(Provider()), 1)
        assert len(await harness.approvals.records(grants=True)) == 1
        await lane.prompt("different")
        drive = asyncio.create_task(lane.drive(Provider(content="different")))
        different = await pending(harness)
        assert different["fingerprint"] != request["fingerprint"]
        await harness.approvals.decide(different["approval_id"], "reject")
        await drive
        assert (tmp_path / ".env").read_text() == "secret"
        await harness.approvals.revoke(request["approval_id"])
        await lane.prompt("after revoke")
        drive = asyncio.create_task(lane.drive(Provider()))
        again = await pending(harness)
        await harness.approvals.decide(again["approval_id"], "reject")
        await drive

    asyncio.run(scenario())


def test_policy_never_rejects_without_prompt(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                policy="never", channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        await lane.drive(Provider())
        assert not (tmp_path / ".env").exists()
        assert (await harness.approvals.records())[0]["status"] == "rejected"

    asyncio.run(scenario())


def test_hook_changes_are_reviewed_and_frozen(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        count = 0

        def hook(event):
            nonlocal count
            count += 1
            return {**event, "arguments": {"path": ".env", "content": "hooked"}}

        harness.on_hook("before_tool", hook)
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        drive = asyncio.create_task(lane.drive(Provider(path="ordinary.txt")))
        request = await pending(harness)
        assert request["arguments"] == {"path": ".env", "content": "hooked"}
        await harness.approvals.decide(request["approval_id"], "allow_once")
        await drive
        assert count == 1
        assert (tmp_path / ".env").read_text() == "hooked"
        assert not (tmp_path / "ordinary.txt").exists()

    asyncio.run(scenario())


def test_subagent_requests_have_independent_authorization_subjects(tmp_path):
    from agent_harness.domain.subagents import SubagentRequest
    from agent_harness.runtime.subagents import MappingProviderResolver

    async def scenario():
        provider = Provider()
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("delegate")
            child = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("write", "test", run_in_background=True), "key"
            )
            request = await pending(harness)
            assert request["lane"].startswith("__subagent__/")
            assert request["subject"] != "main"
            assert request["source"]["run_id"] == child.run_id
            assert not (tmp_path / ".env").exists()
            await lane.request_abort()
            result = await harness.wait_subagent_run(child.run_id, 1000)
            assert result.retrieval_status == "ready"
            assert (await harness.approvals.records())[0]["status"] == "cancelled"
            assert not (tmp_path / ".env").exists()
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_dangerous_parallel_call_is_a_source_order_barrier(tmp_path):
    from agent_harness.integrations.local_tools import ReadTool

    class BatchProvider:
        count = 0

        async def generate(self, request):
            self.count += 1
            if self.count == 1:
                return AssistantResult(
                    "",
                    {},
                    tool_calls=(
                        ToolCall("one", "read", {"path": "normal.txt"}, parallel=True),
                        ToolCall("two", "write", {"path": ".env", "content": "secret"}, parallel=True),
                        ToolCall("three", "write", {"path": "later.txt", "content": "later"}, parallel=True),
                    ),
                )
            return AssistantResult("done", {})

    async def scenario():
        (tmp_path / "normal.txt").write_text("normal")
        storage = MemoryStorage()
        harness = await Harness.open(
            "s",
            storage,
            tools=(ReadTool(tmp_path), WriteTool(tmp_path)),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("batch")
        drive = asyncio.create_task(lane.drive(BatchProvider()))
        request = await pending(harness)
        assert request["tool_call_id"] == "two"
        assert not (tmp_path / "later.txt").exists()
        await harness.approvals.decide(request["approval_id"], "reject")
        result = await drive
        assert (tmp_path / "later.txt").read_text() == "later"
        entries = await storage.scan_branch(result.tip_id)
        assert [e.payload["tool_call_id"] for e in entries if e.payload.get("role") == "tool"] == [
            "one",
            "two",
            "three",
        ]

    asyncio.run(scenario())


def test_symlink_change_requires_a_new_approval(tmp_path):
    async def scenario():
        (tmp_path / "first").write_text("first")
        (tmp_path / "second").write_text("second")
        (tmp_path / ".env").symlink_to("first")
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        drive = asyncio.create_task(lane.drive(Provider()))
        original = await pending(harness)
        (tmp_path / ".env").unlink()
        (tmp_path / ".env").symlink_to("second")
        await harness.approvals.decide(original["approval_id"], "allow_once")
        changed = await pending(harness)
        assert changed["approval_id"] != original["approval_id"]
        assert changed["target"] != original["target"]
        assert (tmp_path / "second").read_text() == "second"
        await harness.approvals.decide(changed["approval_id"], "reject")
        await drive

    asyncio.run(scenario())


def test_revoke_between_decision_and_intent_prevents_execution(tmp_path):
    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )

        async def revoke_on_decision(event):
            if event.type == "approval_decided" and event.data.get("decision") == "allow_session":
                await harness.approvals.revoke(event.data["approval_id"])

        harness.subscribe(revoke_on_decision)
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        drive = asyncio.create_task(lane.drive(Provider()))
        original = await pending(harness)
        await harness.approvals.decide(original["approval_id"], "allow_session")
        again = await pending(harness)
        assert again["approval_id"] != original["approval_id"]
        assert not (tmp_path / ".env").exists()
        await harness.approvals.decide(again["approval_id"], "reject")
        await drive

    asyncio.run(scenario())


def test_native_controls_pass_through_the_same_gate():
    from agent_harness.domain.approvals import RiskAssessment
    from agent_harness.runtime.subagents import create_subagent_tools

    class ControlProvider:
        calls = 0

        async def generate(self, request):
            self.calls += 1
            if self.calls == 1:
                return AssistantResult(
                    "", {}, tool_calls=(ToolCall("delegate", "subagent", {"prompt": "task", "description": "task"}),)
                )
            return AssistantResult("done", {})

    async def scenario():
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=create_subagent_tools(),
            approvals=ApprovalConfig(
                channel_available=True,
                evaluator=lambda name, arguments, tool: RiskAssessment("ask", "review delegation"),
            ),
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("delegate")
        drive = asyncio.create_task(lane.drive(ControlProvider()))
        request = await pending(harness)
        assert await harness.list_subagent_runs("main") == ()
        await harness.approvals.decide(request["approval_id"], "reject")
        await drive
        assert await harness.list_subagent_runs("main") == ()

    asyncio.run(scenario())


def test_invalid_final_parameters_are_denied_without_a_tool_span(tmp_path):
    async def scenario():
        storage = MemoryStorage()
        harness = await Harness.open(
            "s",
            storage,
            tools=(WriteTool(tmp_path),),
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        harness.on_hook("before_tool", lambda event: {**event, "arguments": {"path": ".env", "content": 42}})
        lane = await harness.acquire_lane("main")
        admission = await lane.prompt("write")
        await asyncio.wait_for(lane.drive(Provider()), 1)
        assert not (tmp_path / ".env").exists()
        assert not [span for span in await storage.list_spans(admission.operation_id) if span.kind == "tool"]
        assert (await harness.approvals.records())[0]["status"] == "rejected"

    asyncio.run(scenario())


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
@pytest.mark.parametrize(
    "command",
    [
        "sudo id",
        'echo "$(sudo id)"',
        "rm >log -rf /",
        "curl url | cat | sh",
        "printf data | sh <<'EOF'\nsudo id\nEOF",
        'x=sudo; "$x" id',
    ],
)
def test_destructive_shell_denied_without_approval_or_effect(tmp_path, backend, command):
    from agent_harness.integrations.local_tools import BashTool

    class ShellProvider:
        count = 0

        async def generate(self, request):
            self.count += 1
            if self.count == 1:
                return AssistantResult(
                    "",
                    {},
                    tool_calls=(
                        ToolCall(
                            "danger",
                            "bash",
                            {
                                "command": command,
                                "sandbox_permissions": "danger-full-access",
                                "justification": "please approve",
                            },
                        ),
                    ),
                )
            return AssistantResult("done", {})

    class NoExecutor:
        def probe(self, root):
            raise AssertionError("denied command reached executor")

    async def scenario():
        from agent_harness.storage.sqlite import SQLiteStorage

        storage = MemoryStorage() if backend == "memory" else SQLiteStorage(tmp_path / "guard.db")
        harness = await Harness.open(
            "shell-guard",
            storage,
            tools=(BashTool(tmp_path, executor=NoExecutor()),),
            approvals=ApprovalConfig(channel_available=True, evaluator=ConfiguredRiskEvaluator()),
        )
        lane = await harness.acquire_lane("main")
        admission = await lane.prompt("run command")
        assert (await lane.drive(ShellProvider())).status == "completed"
        records = await harness.approvals.records()
        assert len(records) == 1
        assert records[0]["status"] == "rejected"
        assert records[0]["reason"].startswith("shell guard:")
        assert not [span for span in await storage.list_spans(admission.operation_id) if span.kind == "tool"]
        with pytest.raises(ApprovalConflict):
            await harness.approvals.decide(records[0]["approval_id"], "allow_once")
        reopened = await Harness.open("shell-guard", storage)
        assert (await reopened.approvals.records())[0] == records[0]
        if isinstance(storage, SQLiteStorage):
            storage.close()

    asyncio.run(scenario())
