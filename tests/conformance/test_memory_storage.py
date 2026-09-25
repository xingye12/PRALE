import asyncio

import pytest

from agent_harness.domain.entries import NewEntry
from agent_harness.domain.values import ValueAddress
from agent_harness.storage.memory import MemoryStorage, StorageInvariantError
from agent_harness.storage.protocol import InsertEntry, SetValue


def test_commit_assigns_one_monotonic_sequence_and_branch_is_oldest_first() -> None:
    async def scenario() -> None:
        storage = MemoryStorage(now_ms=lambda: 123)
        result = await storage.commit(
            [
                InsertEntry(NewEntry("one", None, "message", {"text": "one"})),
                InsertEntry(NewEntry("two", "one", "message", {"text": "two"})),
                SetValue(ValueAddress("branch/main"), "two"),
            ]
        )

        assert result.seqs == (1, 2, 3)
        assert [(entry.id, entry.seq, entry.timestamp) for entry in await storage.scan_branch("two")] == [
            ("one", 1, 123),
            ("two", 2, 123),
        ]

    asyncio.run(scenario())


def test_invalid_transaction_does_not_partially_commit() -> None:
    async def scenario() -> None:
        storage = MemoryStorage()
        with pytest.raises(StorageInvariantError, match="missing parent"):
            await storage.commit(
                [
                    InsertEntry(NewEntry("good", None, "message", {"text": "good"})),
                    InsertEntry(NewEntry("bad", "missing", "message", {"text": "bad"})),
                ]
            )

        assert await storage.get_entries(["good", "bad"]) == {}

    asyncio.run(scenario())
