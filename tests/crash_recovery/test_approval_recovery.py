"""Real process termination across approval and effect transaction boundaries."""

import asyncio
import multiprocessing
import os
from pathlib import Path

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import ApprovalConfig, RiskAssessment
from agent_harness.integrations.local_tools import BashTool
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


class DangerousTool:
    name, description, input_schema, replay_policy = "danger", "test effect", {"type": "object"}, "never"

    def __init__(self, marker, crash=False):
        self.marker, self.crash = Path(marker), crash

    def assess_risk(self, arguments):
        return RiskAssessment("ask", "test effect")

    async def execute(self, arguments):
        with self.marker.open("a") as stream:
            stream.write("effect\n")
            stream.flush()
            os.fsync(stream.fileno())
        if self.crash:
            os._exit(73)
        return ToolExecutionResult("done")


class EscalatedBashTool(DangerousTool):
    name = "bash"

    def assess_risk(self, arguments):
        # The test effect deliberately exits the process at the same boundaries
        # as a host command; use the real Bash escalation assessment.
        return BashTool(self.marker.parent, sandbox="off").assess_risk(arguments)


class Provider:
    def __init__(self, finished=False, bash=False):
        self.finished = finished
        self.bash = bash

    async def generate(self, request):
        if self.finished:
            return AssistantResult("done", {})
        self.finished = True
        arguments = {"command": "test effect", "sandbox_permissions": "danger-full-access", "justification": "test"}
        return AssistantResult(
            "", {}, tool_calls=(ToolCall("c", "bash" if self.bash else "danger", arguments if self.bash else {}),)
        )


def worker(db, marker, stage, bash=False):
    async def scenario():
        storage = SQLiteStorage(db)
        original = storage.commit

        async def commit(writes):
            result = await original(writes)
            for write in writes:
                if isinstance(write, SetValue):
                    value = write.value
                    if write.address.key.startswith("approval/request/") and isinstance(value, dict):
                        if (
                            (stage == "request" and value["status"] == "pending")
                            or (stage == "decision" and value["status"] == "allowed")
                            or (stage == "intent" and value["status"] == "consumed")
                        ):
                            os._exit(73)
            if stage == "settlement" and any(
                getattr(w, "entry", None) and getattr(w.entry, "payload", {}).get("role") == "tool" for w in writes
            ):
                os._exit(73)
            return result

        storage.commit = commit
        harness = await Harness.open(
            "s",
            storage,
            tools=((EscalatedBashTool if bash else DangerousTool)(marker, stage == "effect"),),
            approvals=ApprovalConfig(channel_available=True),
        )

        async def answer(event):
            if event.type == "approval_requested" and event.data["status"] == "pending":
                await harness.approvals.decide(event.data["approval_id"], "allow_once")

        harness.subscribe(answer)
        lane = await harness.acquire_lane("main")
        await lane.prompt("execute", operation_id="op")
        await lane.drive(Provider(bash=bash))

    asyncio.run(scenario())


@pytest.mark.parametrize("bash", [False, True])
@pytest.mark.parametrize("stage", ["request", "decision", "intent", "effect", "settlement"])
def test_recovery_preserves_approval_and_never_replays_unknown_effect(tmp_path, stage, bash):
    db, marker = tmp_path / "session.db", tmp_path / "effect.txt"
    process = multiprocessing.get_context("fork").Process(target=worker, args=(str(db), str(marker), stage, bash))
    process.start()
    process.join(5)
    if process.is_alive():
        process.kill()
        process.join()
    assert process.exitcode == 73

    async def scenario():
        storage = SQLiteStorage(db)
        harness = await Harness.open(
            "s",
            storage,
            tools=((EscalatedBashTool if bash else DangerousTool)(marker),),
            approvals=ApprovalConfig(channel_available=True),
        )
        records = await harness.approvals.records()
        assert len(records) == 1
        if stage == "request":
            assert records[0]["status"] == "pending"
            assert not marker.exists()
            await harness.approvals.decide(records[0]["approval_id"], "allow_once")
        lane = await harness.acquire_lane("main")
        result = await asyncio.wait_for(lane.recover(Provider(finished=True)), 2)
        if stage in ("request", "decision"):
            assert marker.read_text() == "effect\n"
        elif stage == "intent":
            assert not marker.exists()
        else:
            assert marker.read_text() == "effect\n"
        entries = await storage.scan_branch(result.tip_id)
        tools = [e.payload for e in entries if e.payload.get("role") == "tool"]
        assert len(tools) == 1
        if stage in ("intent", "effect"):
            assert tools[0]["is_error"] and "unknown" in tools[0]["content"]
        assert all(span.outcome != "pending" for span in await storage.list_spans("op"))
        storage.close()

    asyncio.run(scenario())
