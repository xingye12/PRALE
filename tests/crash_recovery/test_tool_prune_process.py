"""Real process exits at the new strategy's durable effect boundaries."""

import asyncio
import os
import subprocess
import sys

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.domain.values import lane_tip, operation_state
from agent_harness.runtime.generation import AssistantResult
from agent_harness.storage.sqlite import SQLiteStorage

SCRIPT = r"""
import asyncio, os, sys
from agent_harness.api.harness import Harness
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.domain.entries import NewEntry
from agent_harness.domain.values import lane_tip
from agent_harness.runtime.generation import AssistantResult
from agent_harness.storage.protocol import InsertEntry, SetValue
from agent_harness.storage.sqlite import SQLiteStorage

stage = sys.argv[2]
base = SQLiteStorage(sys.argv[1])
class CrashingStorage:
    def __getattr__(self, name): return getattr(base, name)
    async def commit(self, writes):
        summary = any(isinstance(w, InsertEntry) and w.entry.type == "compaction" for w in writes)
        intent = any(isinstance(w, SetValue) and
            getattr(w.value, "at", None) == "context.global_compaction.effect_pending" for w in writes)
        generation = any(isinstance(w, SetValue) and
            getattr(w.value, "at", None) == "assistant.effect_pending" for w in writes)
        if generation and stage == "before_prune_intent": os._exit(73)
        if summary and stage == "before_settlement": os._exit(73)
        result = await base.commit(writes)
        if intent and stage == "after_intent": os._exit(73)
        if generation and stage == "after_prune_intent": os._exit(73)
        if summary and stage == "after_settlement": os._exit(73)
        return result
class Provider:
    async def generate(self, request):
        with open(sys.argv[3], "a") as f: f.write("effect\n"); f.flush(); os.fsync(f.fileno())
        if stage == "after_effect": os._exit(73)
        return AssistantResult(content="concise summary", usage={"input_tokens": 12})
async def main():
    cfg = ContextManagementConfig(context_window_tokens=30000, reserved_output_tokens=500,
        headroom_tokens=1000, hard_margin_tokens=100)
    harness = await Harness.open("s", CrashingStorage(), context_management=cfg)
    lane = await harness.acquire_lane("main")
    messages = [
        {"role":"user","content":"old"},
        {"role":"assistant","content":"facts "*(0 if "prune_intent" in stage else 10000),
         "tool_calls":[{"id":"old","name":"read","arguments":{}}]},
        {"role":"tool","tool_call_id":"old","content":"A"*70000},
        {"role":"user","content":"current"},
        {"role":"assistant","tool_calls":[{"id":"new","name":"read","arguments":{}}]},
        {"role":"tool","tool_call_id":"new","content":"Z"*16000},
    ]
    writes = [InsertEntry(NewEntry(str(i), str(i-1) if i else None, "message", m))
              for i,m in enumerate(messages)]
    await base.commit([*writes, SetValue(lane_tip("main"),"5")])
    await lane.prompt("continue", operation_id="run")
    await lane.drive(Provider())
asyncio.run(main())
"""


@pytest.mark.parametrize("stage", ["after_intent", "after_effect", "before_settlement", "after_settlement"])
def test_summary_crash_preserves_pruning_originals_and_frozen_retry(tmp_path, stage):
    db = tmp_path / "session.sqlite"
    effects = tmp_path / "effects"
    result = subprocess.run(
        [sys.executable, "-c", SCRIPT, str(db), stage, str(effects)],
        env={**os.environ, "PYTHONPATH": "src"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 73, result.stderr

    async def scenario():
        storage = SQLiteStorage(db)
        try:
            # Deliberately attach with DIFFERENT defaults; pending effects keep frozen policy.
            harness = await Harness.open("s", storage, context_management=ContextManagementConfig())
            lane = await harness.acquire_lane("main")
            state = await storage.get_value(operation_state("run"))
            branch = await storage.scan_branch(await storage.get_value(lane_tip("main")))
            assert branch[2].payload["content"] == "A" * 70000
            assert branch[5].payload["content"] == "Z" * 16000
            assert len([e for e in branch if e.type == "custom" and e.payload.get("kind") == "context_tool_prune"]) == 1

            class Provider:
                async def generate(self, request):
                    return AssistantResult(content="summary", usage={"input_tokens": 3})

            if stage == "after_settlement":
                assert state.at == "assistant.ready"
                assert state.data["context_config"]["context_window_tokens"] == 30000
                assert len([e for e in branch if e.type == "compaction"]) == 1
                assert (await storage.list_spans("run"))[0].outcome == "completed"
                await lane.recover(Provider())  # reclaim the crashed driver's lease without replaying settled effects
            else:
                assert state.at == "context.global_compaction.effect_pending"
                frozen = state.data["messages"]
                await lane.recover()
                retried = await storage.get_value(operation_state("run"))
                assert retried.data["messages"] == frozen
                assert retried.data["retry"] == 1
                assert [s.outcome for s in await storage.list_spans("run")] == ["unknown", "pending"]
                assert not any(e.type == "compaction" for e in branch)

            class Provider:
                async def generate(self, request):
                    return AssistantResult(content="summary", usage={"input_tokens": 3})

            completed = await lane.drive(Provider())
            assert completed.status == "completed"
            final = await storage.scan_branch(completed.tip_id)
            assert len([e for e in final if e.type == "compaction"]) == 1
            assert not any(s.outcome == "pending" for s in await storage.list_spans("run"))
        finally:
            storage.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("stage", ["before_prune_intent", "after_prune_intent"])
def test_prune_and_generation_intent_commit_atomically(tmp_path, stage):
    db = tmp_path / "session.sqlite"
    effects = tmp_path / "effects"
    process = subprocess.run(
        [sys.executable, "-c", SCRIPT, str(db), stage, str(effects)],
        env={**os.environ, "PYTHONPATH": "src"},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 73, process.stderr
    assert not effects.exists()

    async def scenario():
        storage = SQLiteStorage(db)
        try:
            cfg = ContextManagementConfig(
                context_window_tokens=30000, reserved_output_tokens=500, headroom_tokens=1000, hard_margin_tokens=100
            )
            lane = await (await Harness.open("s", storage, context_management=cfg)).acquire_lane("main")
            branch = await storage.scan_branch(await storage.get_value(lane_tip("main")))
            records = [e for e in branch if e.type == "custom" and e.payload.get("kind") == "context_tool_prune"]
            state = await storage.get_value(operation_state("run"))
            if stage == "after_prune_intent":
                assert len(records) == 1
                assert state.at == "assistant.effect_pending"
                assert state.data["messages"][2]["content"].endswith("A" * 1024)
                assert state.data["messages"][5]["content"] == "Z" * 16000
                result = await lane.recover()
                assert result.status == "unknown"  # existing generation policy: never replay unknown output
            else:
                assert records == []
                assert state.at == "assistant.ready"

                class Provider:
                    async def generate(self, request):
                        return AssistantResult(content="answer", usage={})

                result = await lane.recover(Provider())
                assert result.status == "completed"
            assert (await storage.get_entries(["2"]))["2"].payload["content"] == "A" * 70000
            final = await storage.scan_branch(result.tip_id)
            assert len([e for e in final if e.type == "custom" and e.payload.get("kind") == "context_tool_prune"]) == 1
        finally:
            storage.close()

    asyncio.run(scenario())
