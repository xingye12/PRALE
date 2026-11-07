"""Both session stores preserve context-management durable records identically."""

import asyncio
from collections.abc import Iterator

import pytest

from agent_harness.domain.entries import NewEntry
from agent_harness.domain.values import operation_context_reductions
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import AppendList, InsertEntry, Storage
from agent_harness.storage.sqlite import SQLiteStorage


@pytest.fixture(params=["memory", "sqlite"])
def storage(request: pytest.FixtureRequest, tmp_path) -> Iterator[Storage]:
    if request.param == "memory":
        yield MemoryStorage()
        return
    result = SQLiteStorage(tmp_path / "session.sqlite")
    try:
        yield result
    finally:
        result.close()


def test_context_collapse_and_reduction_records_are_atomic_and_readable(storage: Storage) -> None:
    async def scenario() -> None:
        await storage.commit(
            [
                InsertEntry(NewEntry("one", None, "message", {"role": "user", "content": "original"})),
                InsertEntry(
                    NewEntry(
                        "collapse",
                        "one",
                        "context_collapse",
                        {
                            "summary": "summary",
                            "retained_message_ids": [],
                            "covered_entry_ids": ["one"],
                            "prompt_version": 1,
                        },
                    )
                ),
                AppendList(
                    operation_context_reductions("op-1"),
                    {"kind": "request_projection", "source_hashes": ["abc"], "micro_cleared_tool_results": 1},
                ),
            ]
        )

        branch = await storage.scan_branch("collapse")
        records = await storage.read_list(operation_context_reductions("op-1"))

        assert [entry.type for entry in branch] == ["message", "context_collapse"]
        assert records == [{"kind": "request_projection", "source_hashes": ["abc"], "micro_cleared_tool_results": 1}]

    asyncio.run(scenario())


def test_tool_prune_is_branch_local_and_original_tail_overrides_record(storage: Storage) -> None:
    from agent_harness.domain.context_management import ContextManagementConfig
    from agent_harness.domain.tool_prune import context_view, message_hash

    async def scenario() -> None:
        original = {"role": "tool", "tool_call_id": "call", "content": "original" * 3000}
        await storage.commit(
            [
                InsertEntry(NewEntry("call", None, "message", {"role": "assistant", "tool_calls": [{"id": "call"}]})),
                InsertEntry(NewEntry("tool", "call", "message", original)),
                InsertEntry(NewEntry("tail", "tool", "message", {"role": "user", "content": "new" * 4000})),
                InsertEntry(
                    NewEntry(
                        "prune",
                        "tail",
                        "custom",
                        {
                            "kind": "context_tool_prune",
                            "format_version": 1,
                            "source_entry_id": "tool",
                            "source_hash": message_hash(original),
                            "message": {**original, "content": "pruned"},
                        },
                    )
                ),
            ]
        )
        cfg = ContextManagementConfig(
            context_window_tokens=20_000, headroom_tokens=1000, reserved_output_tokens=500, hard_margin_tokens=100
        )
        branch = await storage.scan_branch("prune")
        assert context_view(branch, cfg).messages[1]["content"] == "pruned"
        assert context_view(await storage.scan_branch("tail"), cfg).messages[1] == original
        assert context_view(branch, ContextManagementConfig()).messages[1] == original
        assert (await storage.get_entries(["tool"]))["tool"].payload == original

    asyncio.run(scenario())
