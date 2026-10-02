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
