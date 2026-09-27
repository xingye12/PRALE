"""Both storage backends must answer effect-history reads identically."""

import asyncio
from collections.abc import Iterator

import pytest

from agent_harness.domain.effects import EffectSpan
from agent_harness.storage.memory import MemoryStorage, StorageInvariantError
from agent_harness.storage.protocol import InsertSpan, InsertUsage, SettleSpan, Storage, UsageRow
from agent_harness.storage.sqlite import SQLiteStorage


@pytest.fixture(params=["memory", "sqlite"])
def storage(request: pytest.FixtureRequest, tmp_path) -> Iterator[Storage]:
    if request.param == "memory":
        yield MemoryStorage()
        return
    store = SQLiteStorage(tmp_path / "session.sqlite")
    try:
        yield store
    finally:
        store.close()


def _span(span_id: str, *, operation_id: str = "op-1", call_id: str = "call-1", started_at: int = 1_000) -> EffectSpan:
    return EffectSpan(
        span_id=span_id,
        operation_id=operation_id,
        call_id=call_id,
        kind="llm",
        lane="main",
        attempt=1,
        started_at=started_at,
    )


def test_a_span_starts_pending_with_no_provable_duration(storage: Storage) -> None:
    async def scenario() -> None:
        span = _span("span-1")

        await storage.commit([InsertSpan(span)])
        [stored] = await storage.list_spans("op-1")

        assert stored == span
        assert stored.outcome == "pending"
        assert stored.ended_at is None
        assert not stored.settled
        assert stored.duration_ms is None

    asyncio.run(scenario())


def test_settling_records_the_outcome_class_and_duration(storage: Storage) -> None:
    async def scenario() -> None:
        await storage.commit([InsertSpan(_span("span-1", started_at=1_000))])
        await storage.commit([SettleSpan("span-1", 1_250, "failed", "provider_error")])

        [stored] = await storage.list_spans("op-1")

        assert stored.outcome == "failed"
        assert stored.error_class == "provider_error"
        assert stored.ended_at == 1_250
        assert stored.duration_ms == 250

    asyncio.run(scenario())


def test_an_unknown_outcome_never_reports_a_duration(storage: Storage) -> None:
    async def scenario() -> None:
        # Recovery closes the record long after the effect stopped, so the
        # difference between the two timestamps is not a call duration.
        await storage.commit([InsertSpan(_span("span-1", started_at=1_000))])
        await storage.commit([SettleSpan("span-1", 900_000, "unknown", "interrupted")])

        [stored] = await storage.list_spans("op-1")

        assert stored.ended_at == 900_000
        assert stored.duration_ms is None

    asyncio.run(scenario())


def test_spans_are_read_per_operation_in_start_order(storage: Storage) -> None:
    async def scenario() -> None:
        await storage.commit(
            [
                InsertSpan(_span("span-late", call_id="call-late", started_at=2_000)),
                InsertSpan(_span("span-early", call_id="call-early", started_at=1_000)),
                InsertSpan(_span("span-other", operation_id="op-2", call_id="call-other", started_at=1_500)),
                # Same millisecond: parallel calls must still keep a stable order.
                InsertSpan(_span("span-tie-a", call_id="call-tie-a", started_at=3_000)),
                InsertSpan(_span("span-tie-b", call_id="call-tie-b", started_at=3_000)),
            ]
        )

        spans = await storage.list_spans("op-1")

        assert [span.span_id for span in spans] == ["span-early", "span-late", "span-tie-a", "span-tie-b"]

    asyncio.run(scenario())


def test_a_span_is_only_settled_once(storage: Storage) -> None:
    async def scenario() -> None:
        await storage.commit([InsertSpan(_span("span-1"))])
        await storage.commit([SettleSpan("span-1", 1_100, "completed")])

        with pytest.raises(StorageInvariantError, match="already settled"):
            await storage.commit([SettleSpan("span-1", 1_200, "completed")])
        with pytest.raises(StorageInvariantError, match="unknown or was already settled"):
            await storage.commit([SettleSpan("span-missing", 1_200, "completed")])

        [stored] = await storage.list_spans("op-1")
        assert stored.ended_at == 1_100

    asyncio.run(scenario())


def test_a_span_id_cannot_be_reused(storage: Storage) -> None:
    async def scenario() -> None:
        await storage.commit([InsertSpan(_span("span-1"))])

        with pytest.raises(StorageInvariantError, match="already exists"):
            await storage.commit([InsertSpan(_span("span-1"))])

    asyncio.run(scenario())


def test_usage_is_normalized_and_attributed_to_its_operation(storage: Storage) -> None:
    async def scenario() -> None:
        await storage.commit(
            [
                InsertUsage(
                    UsageRow(
                        "usage-1",
                        {"prompt_tokens": 12, "completion_tokens": 3},
                        entry_id="entry-1",
                        operation_id="op-1",
                        span_id="span-1",
                    )
                )
            ]
        )

        [record] = await storage.list_usage("op-1")

        assert (record.input_tokens, record.output_tokens, record.total_tokens) == (12, 3, 15)
        assert record.raw == {"prompt_tokens": 12, "completion_tokens": 3}
        assert (record.operation_id, record.entry_id, record.span_id) == ("op-1", "entry-1", "span-1")
        assert not record.legacy_unattributed
        assert await storage.list_usage("op-2") == []

    asyncio.run(scenario())


def test_usage_written_before_attribution_is_marked_legacy(storage: Storage) -> None:
    async def scenario() -> None:
        # Only an entry binding: which turn spent these tokens cannot be proven.
        await storage.commit([InsertUsage(UsageRow("usage-old", {"total_tokens": 7}, entry_id="entry-old"))])

        assert await storage.list_usage("op-1") == []
        [record] = await storage.usage_for_entries(["entry-old"])

        assert record.legacy_unattributed
        assert record.entry_id == "entry-old"
        assert (record.input_tokens, record.output_tokens, record.total_tokens) == (None, None, 7)
        assert await storage.usage_for_entries([]) == []

    asyncio.run(scenario())
