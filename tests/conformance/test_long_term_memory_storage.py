import asyncio

from agent_harness.domain.memory import (
    AtomicCandidate,
    MemoryScope,
    RecallBudget,
    RecallQuery,
    SessionTraceArchive,
    TraceItem,
)
from agent_harness.storage.memory_memory import InMemoryMemoryStore
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


class _Embeddings:
    model_id = "test-embedding-v1"

    async def embed(self, texts: tuple[str, ...]) -> tuple[tuple[float, ...], ...]:
        return tuple((1.0, 0.0) if "alpha" in text.lower() else (0.0, 1.0) for text in texts)


class _UnavailableEmbeddings:
    model_id = "offline"

    async def embed(self, texts: tuple[str, ...]) -> tuple[tuple[float, ...], ...]:
        raise TimeoutError("embedding unavailable")


def _archive(archive_id: str, scope: MemoryScope, operation_id: str, entry_id: str) -> SessionTraceArchive:
    return SessionTraceArchive(
        archive_id,
        scope,
        "session",
        "lane",
        operation_id,
        "run",
        None,
        entry_id,
        (entry_id,),
        f"hash-{entry_id}",
        "conversation-v1",
        1,
        f"content-{entry_id}",
        (TraceItem(entry_id, 1, 1, "message", "user", entry_id, {}),),
    )


def test_capture_key_is_idempotent_and_store_sequences_are_scope_local(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        first = MemoryScope("team", "agent", "first")
        second = MemoryScope("team", "agent", "second")
        stored, created = await store.capture_archive(_archive("one", first, "op", "entry"))
        repeated, created_again = await store.capture_archive(_archive("duplicate", first, "op", "entry"))
        other, _ = await store.capture_archive(_archive("two", second, "op-other", "entry"))
        assert created and not created_again
        assert repeated.archive_id == stored.archive_id
        assert stored.items[0].store_seq == 1
        assert other.items[0].store_seq == 1

    asyncio.run(scenario())


def test_expired_job_lease_can_be_claimed_by_a_recovery_worker(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db", now_ms=lambda: 100)
        scope = MemoryScope("team", "agent", "user")
        await store.create_or_wake_job(scope, "l1", 1, 0)
        first = await store.claim_job(100, "worker-one", 10)
        assert first is not None
        assert await store.claim_job(105, "worker-two", 10) is None
        replacement = await store.claim_job(110, "worker-two", 10)
        assert replacement is not None
        assert replacement.lease_id == "worker-two"

    asyncio.run(scenario())


def test_create_or_wake_job_makes_an_existing_delayed_job_due(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db", now_ms=lambda: 100)
        scope = MemoryScope("team", "agent", "user")
        await store.create_or_wake_job(scope, "l2", 1, 10_000)
        woken = await store.create_or_wake_job(scope, "l2", 1, 100)
        assert woken.status == "queued" and woken.not_before == 100

    asyncio.run(scenario())


def test_empty_l1_extraction_still_advances_consumption_watermark(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        await store.apply_candidates(scope, (), 42)
        assert await store.current_l1_watermark(scope) == 42

    asyncio.run(scenario())


def test_gc_deletes_consumed_l0_items_before_their_archive(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        await store.capture_archive(_archive("one", scope, "op", "entry"))
        await store.apply_candidates(scope, (), 1)
        counts = await store.gc(scope, l0_before=2, l1_before=0, l2_before=0, audit_before=0)
        assert counts["l0"] == 1
        assert not await store.unconsumed_items(scope, 0)

    asyncio.run(scenario())


def test_recall_can_include_scope_filtered_l0_evidence(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        archive = SessionTraceArchive(
            "archive",
            scope,
            "session",
            "lane",
            "op",
            "run",
            None,
            "entry",
            ("entry",),
            "hash",
            "conversation-v1",
            1,
            "content",
            (TraceItem("entry", 1, 1, "message", "user", "needle evidence", {}),),
        )
        await store.capture_archive(archive)
        result = await store.search(scope, RecallQuery("needle"), RecallBudget(min_score=0))
        assert any(item.level == "l0" for item in result.items)

    asyncio.run(scenario())


def test_in_memory_backend_obeys_capture_and_watermark_contract() -> None:
    async def scenario() -> None:
        store = InMemoryMemoryStore()
        scope = MemoryScope("team", "agent", "user")
        created, inserted = await store.capture_archive(_archive("one", scope, "op", "entry"))
        duplicate, repeated = await store.capture_archive(_archive("two", scope, "op", "entry"))
        assert inserted and not repeated
        assert duplicate.archive_id == created.archive_id
        await store.apply_candidates(scope, (), 1)
        assert await store.current_l1_watermark(scope) == 1

    asyncio.run(scenario())


def test_archive_records_parent_and_bounded_ancestor_item_ids(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        first, _ = await store.capture_archive(_archive("one", scope, "op-one", "entry-one"))
        second, _ = await store.capture_archive(_archive("two", scope, "op-two", "entry-two"))
        assert second.parent_archive_id == first.archive_id
        assert second.ancestor_item_ids == ("entry-one",)
        reread = (await store.unconsumed_items(scope, 0))[-1]
        assert tuple(item.content for item in reread.ancestor_items) == ("entry-one",)

    asyncio.run(scenario())


def test_gc_records_parent_gap_when_an_expired_l0_parent_is_collected(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        first, _ = await store.capture_archive(_archive("one", scope, "op-one", "entry-one"))
        second, _ = await store.capture_archive(_archive("two", scope, "op-two", "entry-two"))
        store._conn.execute("UPDATE trace_archives SET created_at=1 WHERE archive_id=?", (first.archive_id,))  # noqa: SLF001
        store._conn.execute("UPDATE trace_archives SET created_at=2 WHERE archive_id=?", (second.archive_id,))  # noqa: SLF001
        await store.apply_candidates(scope, (), 1)
        counts = await store.gc(scope, l0_before=2, l1_before=0, l2_before=0, audit_before=0)
        assert counts["l0"] == 1
        child = (await store.unconsumed_items(scope, 0))[0]
        assert child.parent_archive_id == first.archive_id and child.parent_gap

    asyncio.run(scenario())


def test_job_persists_prompt_mode_and_version(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        job = await store.create_or_wake_job(scope, "l1", 1, 0, "prompt", 2, "code")
        assert (job.prompt_id, job.prompt_version, job.prompt_mode) == ("prompt", 2, "code")
        assert job.input_hash is not None

    asyncio.run(scenario())


def test_gc_keeps_l1_records_referenced_by_supersedes_chain(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db", now_ms=lambda: 1)
        scope = MemoryScope("team", "agent", "user")
        metadata = {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}
        await store.apply_candidates(
            scope, (AtomicCandidate("work_fact", "old", "", "repo", 1, 1, metadata, ("one",)),), 1
        )
        await store.apply_candidates(
            scope, (AtomicCandidate("work_fact", "new", "", "repo", 1, 1, metadata, ("two",)),), 2
        )
        counts = await store.gc(scope, l0_before=0, l1_before=2, l2_before=0, audit_before=0)
        assert counts["l1"] == 0

    asyncio.run(scenario())


def test_failed_job_records_error_class_on_its_attempt(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        await store.create_or_wake_job(scope, "l1", 1, 0)
        job = await store.claim_job(10**15, "worker", 1)
        assert job is not None
        await store.fail_job(job.job_id, "worker", "schema", None)
        row = store._conn.execute(  # noqa: SLF001
            "SELECT error_class FROM memory_job_attempts WHERE job_id=?", (job.job_id,)
        ).fetchone()
        assert row[0] == "schema"

    asyncio.run(scenario())


def test_embedding_side_index_uses_hybrid_rrf_without_becoming_authoritative(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db", embedding_provider=_Embeddings())
        scope = MemoryScope("team", "agent", "user")
        metadata = {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}
        await store.apply_candidates(
            scope,
            (
                AtomicCandidate("work_fact", "alpha deployment preference", "", "repo", 1, 1, metadata, ("one",)),
                AtomicCandidate("work_fact", "beta unrelated", "", "other", 1, 1, metadata, ("two",)),
            ),
            1,
        )
        result = await store.search(
            scope, RecallQuery("alpha question"), RecallBudget(min_score=0.5, include_l2=False, include_l3=False)
        )
        assert result.items[0].content == "alpha deployment preference"
        assert store._conn.execute("SELECT COUNT(*) FROM memory_embeddings").fetchone()[0] == 2  # noqa: SLF001

    asyncio.run(scenario())


def test_embedding_failure_falls_back_to_fts(tmp_path) -> None:
    async def scenario() -> None:
        scope = MemoryScope("team", "agent", "user")
        metadata = {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}
        writer = SQLiteMemoryStore(tmp_path / "memory.db")
        candidate = AtomicCandidate("work_fact", "needle fact", "", "repo", 1, 1, metadata, ("one",))
        await writer.apply_candidates(scope, (candidate,), 1)
        store = SQLiteMemoryStore(tmp_path / "memory.db", embedding_provider=_UnavailableEmbeddings())
        result = await store.search(scope, RecallQuery("needle"), RecallBudget(include_l2=False, include_l3=False))
        assert result.items and result.items[0].content == "needle fact"

    asyncio.run(scenario())


def test_index_rebuild_derives_fts_from_authoritative_l1_rows(tmp_path) -> None:
    async def scenario() -> None:
        store = SQLiteMemoryStore(tmp_path / "memory.db")
        scope = MemoryScope("team", "agent", "user")
        metadata = {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}
        await store.apply_candidates(
            scope, (AtomicCandidate("work_fact", "rebuildable keyword", "", "repo", 1, 1, metadata, ("one",)),), 1
        )
        store._conn.execute("DELETE FROM memory_fts")  # noqa: SLF001 -- simulate a corrupted derived index
        await store.rebuild_indexes(scope)
        assert store._conn.execute("SELECT COUNT(*) FROM memory_fts").fetchone()[0] == 1  # noqa: SLF001
        result = await store.search(scope, RecallQuery("rebuildable"), RecallBudget(include_l2=False, include_l3=False))
        assert result.items and result.items[0].content == "rebuildable keyword"

    asyncio.run(scenario())
