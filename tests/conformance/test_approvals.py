"""The same durable approval workflow against both storage implementations."""

import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import ApprovalConfig, ApprovalConflict, approval_audit
from agent_harness.integrations.local_tools import WriteTool
from agent_harness.integrations.tool_risk import ConfiguredRiskEvaluator
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.sqlite import SQLiteStorage


class Provider:
    def __init__(self):
        self.count = 0

    async def generate(self, request):
        self.count += 1
        if self.count == 1:
            return AssistantResult("", {}, tool_calls=(ToolCall("c", "write", {"path": ".env", "content": "value"}),))
        return AssistantResult("done", {})


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
def test_requests_decisions_grants_and_audit_are_durable(tmp_path, backend):
    async def scenario():
        storage = MemoryStorage() if backend == "memory" else SQLiteStorage(tmp_path / "session.db")
        config = ApprovalConfig(channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",)))
        harness = await Harness.open("s", storage, tools=(WriteTool(tmp_path),), approvals=config)
        lane = await harness.acquire_lane("main")
        await lane.prompt("write")
        drive = asyncio.create_task(lane.drive(Provider()))
        for _ in range(100):
            records = await harness.approvals.records()
            if records:
                break
            await asyncio.sleep(0.001)
        request = records[0]
        assert request["status"] == "pending"
        assert not [s for s in await storage.list_spans(request["operation_id"]) if s.kind == "tool"]
        drive.cancel()  # Stop the local process task, preserving the operation and request.
        with pytest.raises(asyncio.CancelledError):
            await drive
        reopened = await Harness.open("s", storage, tools=(WriteTool(tmp_path),), approvals=config)
        assert (await reopened.approvals.records())[0] == request
        decision = await reopened.approvals.decide(request["approval_id"], "allow_session")
        assert await reopened.approvals.decide(request["approval_id"], "allow_session") == decision
        with pytest.raises(ApprovalConflict):
            await reopened.approvals.decide(request["approval_id"], "reject")
        selected = await reopened.acquire_lane("main")
        await selected.recover(ProviderDone())
        assert (tmp_path / ".env").read_text() == "value"
        assert (await reopened.approvals.records())[0]["status"] == "consumed"
        assert len(await reopened.approvals.records(grants=True)) == 1
        await reopened.approvals.revoke(request["approval_id"])
        assert (await reopened.approvals.records(grants=True))[0]["revoked"]
        audit = await storage.read_list(approval_audit())
        assert [r["type"] for r in audit] == ["asked", "decided", "used", "revoked"]
        if backend == "sqlite":
            storage.close()

    asyncio.run(scenario())


class ProviderDone:
    async def generate(self, request):
        return AssistantResult("done", {})


def test_sqlite_session_grant_survives_connection_reopen(tmp_path):
    async def scenario():
        db = tmp_path / "session.db"
        storage = SQLiteStorage(db)
        config = ApprovalConfig(channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",)))
        harness = await Harness.open("s", storage, tools=(WriteTool(tmp_path),), approvals=config)

        async def answer(event):
            if event.type == "approval_requested" and event.data["status"] == "pending":
                await harness.approvals.decide(event.data["approval_id"], "allow_session")

        harness.subscribe(answer)
        lane = await harness.acquire_lane("main")
        await lane.prompt("first")
        await lane.drive(Provider())
        storage.close()
        reopened_storage = SQLiteStorage(db)
        reopened = await Harness.open("s", reopened_storage, tools=(WriteTool(tmp_path),), approvals=config)
        try:
            selected = await reopened.acquire_lane("main")
            await selected.prompt("repeat")
            await asyncio.wait_for(selected.drive(Provider()), 1)
            records = await reopened.approvals.records()
            assert len(records) == 2 and records[-1]["status"] == "consumed"
            assert records[-1]["grant_id"] == records[0]["approval_id"]
        finally:
            reopened_storage.close()

    asyncio.run(scenario())
