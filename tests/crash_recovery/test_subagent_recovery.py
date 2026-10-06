"""Real process exits at delegation/effect/notification transaction boundaries."""

import asyncio
import multiprocessing
import os
from pathlib import Path

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.operations import OperationState
from agent_harness.domain.subagents import SubagentConfig, SubagentRequest
from agent_harness.domain.values import lane_inbox
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.subagents import MappingProviderResolver, create_subagent_tools
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.protocol import InsertEntry, InsertSpan, SetValue
from agent_harness.storage.sqlite import SQLiteStorage


class Tool:
    name = "record"
    description = "record effect"
    input_schema = {"type": "object"}

    def __init__(self, marker, replay_policy="never", crash=False):
        self.marker, self.replay_policy, self.crash = marker, replay_policy, crash

    async def execute(self, arguments):
        with self.marker.open("a") as stream:
            stream.write("effect\n")
            stream.flush()
            os.fsync(stream.fileno())
        if self.crash:
            os._exit(73)
        return ToolExecutionResult("effect done")


class Provider:
    model = "test"

    def __init__(self, with_tool=False, blocking=False, plain_parent=False):
        self.with_tool = with_tool
        self.blocking = blocking
        self.plain_parent = plain_parent
        self.started = None

    async def generate(self, request):
        if request.lane == "main":
            if self.plain_parent:
                return AssistantResult("parent done", {})
            if not any(isinstance(m, dict) and m.get("role") == "tool" for m in request.messages):
                return AssistantResult(
                    "", {}, tool_calls=(ToolCall("delegate", "subagent", {"prompt": "task", "description": "task"}),)
                )
            return AssistantResult("parent done", {})
        if self.blocking:
            self.started.set()
            await asyncio.Event().wait()
        if self.with_tool and not any(isinstance(m, dict) and m.get("role") == "tool" for m in request.messages):
            return AssistantResult("", {}, tool_calls=(ToolCall("effect", "record", {}),))
        return AssistantResult("child done", {"output_tokens": 1})


class CrashStorage(SQLiteStorage):
    def __init__(self, path, stage):
        super().__init__(path)
        self.stage = stage

    async def commit(self, writes):
        result = await super().commit(writes)
        crash = False
        for write in writes:
            if self.stage == "assistant_intent" and isinstance(write, InsertSpan):
                crash |= write.span.lane.startswith("__subagent__/") and write.span.kind == "llm"
            if self.stage == "parent_result" and isinstance(write, InsertEntry):
                payload = write.entry.payload
                crash |= isinstance(payload, dict) and payload.get("tool_call_id") == "delegate"
            if self.stage == "notification_consumed" and isinstance(write, InsertEntry):
                payload = write.entry.payload
                crash |= isinstance(payload, dict) and bool(payload.get("subagent_notification"))
            if self.stage == "child_tool_planned" and isinstance(write, InsertEntry):
                payload = write.entry.payload
                crash |= isinstance(payload, dict) and any(
                    call.get("name") == "record" for call in payload.get("tool_calls", [])
                )
            if not isinstance(write, SetValue):
                continue
            key, data = write.address.key, write.value
            if self.stage == "cancel_requested" and key.startswith("subagent-run/") and key.endswith("/state"):
                crash |= bool(data.get("cancel_requested"))
            if self.stage == "queued":
                crash |= key.startswith("subagent-run/") and key.endswith("/state") and data.get("state") == "queued"
            if self.stage == "parent_intent" and isinstance(data, OperationState) and data.at == "tools":
                crash |= any(call.get("control") for call in data.data.get("calls", []))
            if self.stage == "child_terminal" and key.startswith("subagent-run/") and key.endswith("/result"):
                crash = True
            if self.stage == "notification_delivered" and key.startswith("subagent/notification/"):
                crash |= data.get("state") == "delivered"
        if crash:
            os._exit(73)
        return result


def crash_process(db: str, stage: str, marker: str, replay_policy: str):
    async def scenario():
        storage = CrashStorage(db, stage)
        provider = Provider(
            stage in ("tool_effect", "child_tool_planned"),
            blocking=stage == "cancel_requested",
            plain_parent=stage == "notification_consumed",
        )
        tool = Tool(Path(marker), replay_policy, stage == "tool_effect")
        harness = await Harness.open(
            "test",
            storage,
            tools=(*create_subagent_tools(), tool),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        lane = await harness.acquire_lane("main")
        parent = await lane.prompt("parent", "parent-op")
        if stage in ("notification_delivered", "notification_consumed", "cancel_requested"):
            child = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task", run_in_background=True), "key"
            )
            if stage == "cancel_requested":
                provider.started = asyncio.Event()
                await provider.started.wait()
                await harness.stop_subagent_run(child.run_id)
            else:
                await harness.wait_subagent_run(child.run_id, 1000)
                if stage == "notification_consumed":
                    await lane.drive(provider)
        else:
            await lane.drive(provider)
        await harness.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "stage",
    [
        "queued",
        "parent_intent",
        "assistant_intent",
        "child_terminal",
        "notification_delivered",
        "tool_effect",
        "child_tool_planned",
        "parent_result",
        "notification_consumed",
        "cancel_requested",
    ],
)
@pytest.mark.parametrize("replay_policy", ["safe", "never"])
def test_restart_never_duplicates_delegation_or_loses_notification(tmp_path, stage, replay_policy):
    db, marker = tmp_path / "session.sqlite", tmp_path / "effects.txt"
    process = multiprocessing.get_context("fork").Process(
        target=crash_process, args=(str(db), stage, str(marker), replay_policy)
    )
    process.start()
    process.join(5)
    if process.is_alive():
        process.kill()
        process.join()
    assert process.exitcode == 73

    async def scenario():
        storage = SQLiteStorage(db)
        provider = Provider(
            stage in ("tool_effect", "child_tool_planned"), plain_parent=stage == "notification_consumed"
        )
        harness = await Harness.open(
            "test",
            storage,
            tools=(
                *create_subagent_tools(),
                *((Tool(marker, replay_policy),) if stage != "child_tool_planned" else ()),
            ),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            runs = await harness.list_subagent_runs("main")
            assert len(runs) == 1
            child = await harness.wait_subagent_run(runs[0].run_id, 3000)
            assert child.retrieval_status == "ready"
            assert child.snapshot.result.status == (
                "failed"
                if stage == "child_tool_planned"
                else "unknown"
                if stage in ("assistant_intent", "cancel_requested")
                or (stage == "tool_effect" and replay_policy == "never")
                else "completed"
            )
            if stage not in ("notification_delivered", "cancel_requested"):
                result = await asyncio.wait_for((await harness.acquire_lane("main")).recover(provider), 3)
                assert result.status == "completed"
            else:
                await harness.recover_subagents()
                await harness.recover_subagents()
                assert len(await storage.read_list(lane_inbox("main"))) == 1
            assert len(await harness.list_subagent_runs("main")) == 1
            if stage == "notification_consumed":
                lane = await harness.acquire_lane("main")
                entries = await storage.scan_branch((await lane.snapshot()).tip_id)
                assert (
                    sum(isinstance(e.payload, dict) and bool(e.payload.get("subagent_notification")) for e in entries)
                    == 1
                )
            spans = await storage.list_spans(runs[0].operation_id)
            assert all(span.outcome != "pending" for span in spans)
            if stage == "child_tool_planned":
                assert child.snapshot.result.error_code == "capability_unavailable"
                assert not marker.exists()
            if stage == "tool_effect":
                assert marker.read_text().count("effect") == (2 if replay_policy == "safe" else 1)
        finally:
            await harness.close()
            storage.close()

    asyncio.run(scenario())
