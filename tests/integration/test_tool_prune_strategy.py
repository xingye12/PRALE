"""The new strategy preserves originals and reduces only the old conversation prefix."""

import asyncio
from dataclasses import replace

import pytest

from agent_harness.api.errors import ContextBudgetExceeded
from agent_harness.api.harness import Harness
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.domain.entries import NewEntry
from agent_harness.domain.tool_prune import context_view
from agent_harness.domain.values import lane_tip
from agent_harness.runtime.generation import AssistantResult
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import InsertEntry, SetValue


def config(**values):
    return ContextManagementConfig(
        context_window_tokens=20_000,
        reserved_output_tokens=500,
        headroom_tokens=1000,
        hard_margin_tokens=100,
        **values,
    )


class Provider:
    def __init__(self, summaries=None):
        self.requests = []
        self.summaries = list(summaries or [])

    async def generate(self, request):
        self.requests.append(request)
        summary_call = request.messages and request.messages[0].get("content", "").startswith("You compact")
        content = self.summaries.pop(0) if summary_call and self.summaries else "continued"
        return AssistantResult(content=content, usage={"input_tokens": 10})


async def seed(storage, cfg, *, large_tool=True, tools=()):
    harness = await Harness.open("s", storage, context_management=cfg, tools=tools)
    lane = await harness.acquire_lane("main")
    messages = [
        {"role": "user", "content": "old task"},
        {
            "role": "assistant",
            "tool_calls": [{"id": "old", "name": "read", "arguments": {}}],
            "content": "" if large_tool else "important facts " * 3000,
        },
        {"role": "tool", "tool_call_id": "old", "content": "A" * (70_000 if large_tool else 100)},
        {"role": "user", "content": "current task"},
        {"role": "assistant", "tool_calls": [{"id": "recent", "name": "read", "arguments": {}}]},
        {"role": "tool", "tool_call_id": "recent", "content": "Z" * 10_000},
    ]
    writes = [InsertEntry(NewEntry(str(i), str(i - 1) if i else None, "message", m)) for i, m in enumerate(messages)]
    await storage.commit([*writes, SetValue(lane_tip("main"), "5")])
    return harness, lane, messages


def test_pruning_alone_persists_and_preserves_retained_tool_verbatim():
    async def scenario():
        storage = MemoryStorage()
        cfg = config()
        _, lane, originals = await seed(storage, cfg)
        await lane.prompt("continue", operation_id="run")
        provider = Provider()
        result = await lane.drive(provider)
        assert len(provider.requests) == 1
        sent = provider.requests[0].messages
        assert sent[2]["content"].startswith("A" * 4096)
        assert sent[2]["content"].endswith("A" * 1024)
        assert sent[5] == originals[5]
        branch = await storage.scan_branch(result.tip_id)
        assert branch[2].payload == originals[2]
        records = [e for e in branch if e.type == "custom" and e.payload.get("kind") == "context_tool_prune"]
        assert len(records) == 1
        assert context_view(branch, cfg).messages[2] == sent[2]
        # A larger protected tail restores the original; old decisions do not override protection.
        expanded = context_view(branch, replace(cfg, retain_ratio=0.79))
        assert expanded.messages[2] == originals[2]
        await lane.prompt("next", operation_id="next")
        await lane.drive(provider)
        assert (
            len(
                [
                    e
                    for e in await storage.scan_branch((await lane.snapshot()).tip_id)
                    if e.type == "custom" and e.payload.get("kind") == "context_tool_prune"
                ]
            )
            == 1
        )

    asyncio.run(scenario())


def test_pruning_insufficient_summarizes_only_prefix_and_keeps_tool_tail():
    async def scenario():
        storage = MemoryStorage()
        _, lane, originals = await seed(storage, config(), large_tool=False)
        await lane.prompt("continue", operation_id="run")
        provider = Provider()
        result = await lane.drive(provider)
        assert len(provider.requests) == 2
        assert all(m != originals[5] for m in provider.requests[0].messages)
        assert originals[5] in provider.requests[1].messages
        assert provider.requests[0].tools == ()
        branch = await storage.scan_branch(result.tip_id)
        summary = next(e for e in branch if e.type == "compaction")
        assert summary.payload["retained_message_ids"] == ["4", "5", branch[6].id]
        assert summary.payload["covered_entry_ids"] == ["0", "1", "2", "3"]
        assert [s.outcome for s in await storage.list_spans("run")] == ["completed", "completed"]

    asyncio.run(scenario())


def test_oversized_protected_request_is_not_pruned_or_sent():
    async def scenario():
        storage = MemoryStorage()
        harness = await Harness.open("s", storage, context_management=config())
        lane = await harness.acquire_lane("main")
        await lane.prompt("X" * 80_000, operation_id="run")
        provider = Provider()
        with pytest.raises(ContextBudgetExceeded):
            await lane.drive(provider)
        assert provider.requests == []

    asyncio.run(scenario())


def test_invalid_summary_retries_with_shorter_instruction_and_is_bounded():
    async def scenario():
        storage = MemoryStorage()
        _, lane, _ = await seed(storage, config(), large_tool=False)
        await lane.prompt("continue", operation_id="run")
        provider = Provider(["", ""])
        result = await lane.drive(provider)
        assert result.status == "unknown"
        assert len(provider.requests) == 2
        assert "shorter" in provider.requests[1].messages[-1]["content"]
        assert not any(e.type == "compaction" for e in await storage.scan_branch(result.tip_id))
        assert [s.outcome for s in await storage.list_spans("run")] == ["failed", "failed"]

    asyncio.run(scenario())


def test_manual_compact_uses_prefix_and_protected_original_tail():
    async def scenario():
        storage = MemoryStorage()
        _, lane, originals = await seed(storage, config(), large_tool=False)
        await lane.compact(operation_id="manual")
        provider = Provider()
        result = await lane.drive(provider)
        assert result.status == "completed"
        assert len(provider.requests) == 1
        assert originals[5] not in provider.requests[0].messages
        branch = await storage.scan_branch(result.tip_id)
        assert branch[-1].payload["retained_message_ids"] == ["3", "4", "5"]
        assert context_view(branch, config()).messages[-1] == originals[5]

    asyncio.run(scenario())


def test_system_hook_and_tool_schema_are_included_in_final_budget():
    async def scenario():
        class LargeTool:
            name = "large"
            description = "D" * 80_000
            input_schema = {"type": "object"}
            replay_policy = "safe"

            async def execute(self, arguments):
                raise AssertionError("not called")

        storage = MemoryStorage()
        harness = await Harness.open("s", storage, context_management=config(), tools=(LargeTool(),))
        lane = await harness.acquire_lane("main")
        await lane.prompt("short", operation_id="run")
        provider = Provider()
        with pytest.raises(ContextBudgetExceeded):
            await lane.drive(provider)
        assert not provider.requests
        other = MemoryStorage()
        harness = await Harness.open("s", other, context_management=config())
        harness.on_hook(
            "before_payload",
            lambda event: {
                **event,
                "messages": [
                    *event["messages"],
                    {"role": "system", "content": "S" * 80_000},
                ],
            },
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("short", operation_id="run")
        with pytest.raises(ContextBudgetExceeded):
            await lane.drive(provider)
        assert not provider.requests

    asyncio.run(scenario())


def test_cancellation_settles_summary_span_without_publishing_summary():
    async def scenario():
        entered = asyncio.Event()

        class Blocking:
            async def generate(self, request):
                entered.set()
                await asyncio.Event().wait()

        storage = MemoryStorage()
        _, lane, _ = await seed(storage, config(), large_tool=False)
        await lane.prompt("continue", operation_id="run")
        task = asyncio.create_task(lane.drive(Blocking()))
        await asyncio.wait_for(entered.wait(), 2)
        await lane.request_abort()
        result = await asyncio.wait_for(task, 2)
        assert result.status == "aborted"
        assert [s.outcome for s in await storage.list_spans("run")] == ["unknown"]
        assert not any(e.type == "compaction" for e in await storage.scan_branch(result.tip_id))

    asyncio.run(scenario())
