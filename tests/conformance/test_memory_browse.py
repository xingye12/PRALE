"""Browse reads must expose the whole store, not just the recall subset.

Every case runs against both memory backends, because the browse paths are now
part of the MemoryStore contract that the ephemeral backend inherits.
"""

import asyncio
from collections.abc import Iterator

import pytest

from agent_harness.domain.memory import (
    AtomicCandidate,
    MemoryScope,
    SceneCandidate,
    SessionTraceArchive,
    TraceItem,
)
from agent_harness.storage.memory_memory import InMemoryMemoryStore
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore

SCOPE = MemoryScope("git@example.com:owner/repo.git")


class Clock:
    """Deterministic millisecond clock so ordering is reproducible."""

    def __init__(self, start: int = 1_000) -> None:
        self.now = start

    def __call__(self) -> int:
        return self.now

    def advance(self, milliseconds: int) -> None:
        self.now += milliseconds


@pytest.fixture(params=["memory", "sqlite"])
def store(request: pytest.FixtureRequest, tmp_path, clock: Clock) -> Iterator[SQLiteMemoryStore]:
    if request.param == "memory":
        yield InMemoryMemoryStore(now_ms=clock)
        return
    sqlite = SQLiteMemoryStore(tmp_path / "memory.db", now_ms=clock)
    try:
        yield sqlite
    finally:
        sqlite.close()


@pytest.fixture
def clock() -> Clock:
    return Clock()


def _archive(archive_id: str, created_at: int, *, items: int = 1, scope: MemoryScope = SCOPE) -> SessionTraceArchive:
    return SessionTraceArchive(
        archive_id,
        scope,
        "session",
        "main",
        f"op-{archive_id}",
        "run",
        None,
        f"tip-{archive_id}",
        (f"entry-{archive_id}",),
        f"hash-{archive_id}",
        "conversation-v1",
        created_at,
        f"content-{archive_id}",
        tuple(
            TraceItem(f"entry-{archive_id}-{index}", index, created_at, "message", "user", "text", {})
            for index in range(items)
        ),
    )


def _metadata() -> dict[str, object]:
    return {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"}


def _fact(content: str, **changes: object) -> AtomicCandidate:
    values: dict[str, object] = {
        "type": "work_fact",
        "content": content,
        "background": "",
        "scene_key": "repo",
        "priority": 1,
        "confidence": 1.0,
        "metadata": _metadata(),
        "source_record_ids": (content,),
    }
    values.update(changes)
    return AtomicCandidate(**values)  # type: ignore[arg-type]


def _scene_text(name: str) -> str:
    return "\n".join(
        f"{heading}: {name}"
        for heading in (
            "工作场景",
            "适用条件",
            "核心 SOP",
            "判断逻辑",
            "禁忌与反模式",
            "关键事实依据",
            "相关任务与资产",
            "演化记录",
            "待确认问题",
        )
    )


def test_archives_are_listed_newest_first_with_their_item_counts(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        await store.capture_archive(_archive("old", 1_000, items=1))
        await store.capture_archive(_archive("new", 3_000, items=3))

        rows = await store.list_l0(SCOPE, None, 50)

        assert [row.archive_id for row in rows] == ["new", "old"]
        assert [row.item_count for row in rows] == [3, 1]
        assert rows[0].session_id == "session"
        assert rows[0].operation_id == "op-new"
        assert rows[0].created_at == 3_000
        assert rows[0].scope == SCOPE

    asyncio.run(scenario())


def test_archive_listing_pages_on_its_own_sort_key(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        for index in range(4):
            await store.capture_archive(_archive(f"a-{index}", 1_000 + index))

        seen: list[str] = []
        after: tuple[int, str] | None = None
        while True:
            rows = await store.list_l0(SCOPE, after, 2)
            if not rows:
                break
            seen.extend(row.archive_id for row in rows)
            after = (rows[-1].created_at, rows[-1].archive_id)

        assert seen == ["a-3", "a-2", "a-1", "a-0"]

    asyncio.run(scenario())


def test_one_archive_reads_back_with_its_items(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        await store.capture_archive(_archive("a-1", 1_000, items=2))

        archive = await store.read_archive("a-1")

        assert archive is not None
        assert [item.source_entry_id for item in archive.items] == ["entry-a-1-0", "entry-a-1-1"]
        assert await store.read_archive("missing") is None

    asyncio.run(scenario())


def test_l1_browsing_keeps_superseded_memories(store: SQLiteMemoryStore, clock: Clock) -> None:
    async def scenario() -> None:
        await store.apply_candidates(SCOPE, (_fact("first"),), 1)
        [first] = await store.list_l1(SCOPE, None, None, 50)
        clock.advance(10)
        await store.apply_candidates(
            SCOPE,
            (_fact("second", decision="supersede", supersedes_ids=(first.memory_id,)),),
            2,
        )

        # Superseding touches the old row, so the two share an updated_at and
        # the browse order between them is the id tie-break, not recency.
        all_rows = await store.list_l1(SCOPE, None, None, 50)
        by_id = {row.memory_id: row for row in all_rows}

        assert sorted(row.content for row in all_rows) == ["first", "second"]
        assert by_id[first.memory_id].status == "superseded"
        assert [row.content for row in all_rows if row.status == "active"] == ["second"]
        superseded = await store.list_l1(SCOPE, "superseded", None, 50)
        assert [row.memory_id for row in superseded] == [first.memory_id]
        assert [row.source_record_ids for row in superseded] == [("first",)]

    asyncio.run(scenario())


def test_l1_browsing_is_newest_first_and_pages_on_its_own_sort_key(store: SQLiteMemoryStore, clock: Clock) -> None:
    async def scenario() -> None:
        # Distinct scene keys, so no memory supersedes another and each keeps
        # its own creation time.
        for index in range(3):
            await store.apply_candidates(SCOPE, (_fact(f"fact-{index}", scene_key=f"key-{index}"),), index + 1)
            clock.advance(10)

        seen: list[str] = []
        after: tuple[int, str] | None = None
        while True:
            page = await store.list_l1(SCOPE, None, after, 2)
            if not page:
                break
            seen.extend(row.content for row in page)
            after = (page[-1].updated_at, page[-1].memory_id)

        assert seen == ["fact-2", "fact-1", "fact-0"]

    asyncio.run(scenario())


def test_l2_browsing_reaches_dormant_scenes(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        for index in range(2):
            await store.write_scene(
                SCOPE, SceneCandidate(f"scene-{index}", _scene_text(f"s{index}"), "", (), index + 1), 1
            )

        assert [scene.scenario_key for scene in await store.read_l2(SCOPE)] == ["scene-1"]
        dormant = await store.list_l2(SCOPE, "dormant", None, 50)

        assert [scene.scenario_key for scene in dormant] == ["scene-0"]
        assert [scene.status for scene in dormant] == ["dormant"]
        assert len(await store.list_l2(SCOPE, None, None, 50)) == 2

    asyncio.run(scenario())


def test_jobs_and_audit_are_listed_newest_first(store: SQLiteMemoryStore, clock: Clock) -> None:
    async def scenario() -> None:
        await store.create_or_wake_job(SCOPE, "l1", 1, 0)
        clock.advance(10)
        await store.create_or_wake_job(SCOPE, "l2", 2, 0)

        jobs = await store.list_jobs(SCOPE, None, None, 50)

        assert [job.stage for job in jobs] == ["l2", "l1"]
        # Both are due at once, so both are queued rather than scheduled.
        assert [job.status for job in jobs] == ["queued", "queued"]
        assert await store.list_jobs(SCOPE, "nonexistent", None, 50) == ()

        await store.audit(SCOPE, "first_event", {"n": 1})
        await store.audit(SCOPE, "second_event", {"n": 2})
        audit = await store.list_audit(SCOPE, None, 50)
        events = [record.event for record in audit]

        # The pipeline records its own events; the browse view returns them in
        # the same newest-first order as everything else.
        assert events[:2] == ["second_event", "first_event"]
        assert audit[0].data == {"n": 2}
        assert [record.audit_id for record in audit] == sorted((r.audit_id for r in audit), reverse=True)

    asyncio.run(scenario())


def test_every_browse_read_is_scoped_to_its_repository(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        other = MemoryScope("git@example.com:owner/other.git")
        await store.capture_archive(_archive("mine", 1_000))
        await store.capture_archive(_archive("theirs", 2_000, scope=other))
        await store.apply_candidates(SCOPE, (_fact("mine"),), 1)
        await store.apply_candidates(other, (_fact("theirs"),), 1)
        await store.create_or_wake_job(SCOPE, "l1", 1, 0)
        await store.create_or_wake_job(other, "l1", 1, 0)
        await store.audit(SCOPE, "mine", {})
        await store.audit(other, "theirs", {})

        events = [row.event for row in await store.list_audit(SCOPE, None, 50)]

        assert [row.archive_id for row in await store.list_l0(SCOPE, None, 50)] == ["mine"]
        assert [row.content for row in await store.list_l1(SCOPE, None, None, 50)] == ["mine"]
        assert "mine" in events and "theirs" not in events
        assert len(await store.list_jobs(SCOPE, None, None, 50)) == 1
        # The scope is not a filter the caller can forget: an archive read by
        # id still belongs to the scope that stored it.
        archive = await store.read_archive("theirs")
        assert archive is not None and archive.scope == other

    asyncio.run(scenario())
