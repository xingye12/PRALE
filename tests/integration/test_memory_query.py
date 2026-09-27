"""The memory facade answers one repository's questions, and only that.

Scope is a property of the deployment (ADR-WEB-003): the service is built with
a repository scope and a caller can name a memory but never a repository.  The
cursor and filter handling is the other half — a browse view that silently
answers a malformed request with an empty page is indistinguishable from one
that has no data.
"""

import asyncio

import pytest

from agent_harness.api.errors import InvalidCursor
from agent_harness.api.memory import MemoryQueryService
from agent_harness.api.pagination import MAX_LIMIT, encode_cursor
from agent_harness.domain.memory import (
    AtomicCandidate,
    DoctrineCandidate,
    MemoryScope,
    SceneCandidate,
    SessionTraceArchive,
    TraceItem,
)
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore

REPOSITORY_ID = "git@example.com:owner/repo.git"
SCOPE = MemoryScope(REPOSITORY_ID)
OTHER = MemoryScope("git@example.com:owner/other.git")


class Clock:
    def __init__(self, start: int = 1_000) -> None:
        self.now = start

    def __call__(self) -> int:
        return self.now

    def advance(self, milliseconds: int) -> None:
        self.now += milliseconds


def _archive(archive_id: str, created_at: int, *, scope: MemoryScope = SCOPE) -> SessionTraceArchive:
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
        (TraceItem(f"entry-{archive_id}", 0, created_at, "message", "user", "text", {}),),
    )


def _fact(content: str, *, scene_key: str = "repo", **changes: object) -> AtomicCandidate:
    values: dict[str, object] = {
        "type": "work_fact",
        "content": content,
        "background": "",
        "scene_key": scene_key,
        "priority": 1,
        "confidence": 1.0,
        "metadata": {"work_object": "repo", "status": "active", "activity_start_time": "1", "activity_end_time": "2"},
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


def _doctrine() -> str:
    return "\n".join(
        f"{heading}: shared operating rule"
        for heading in (
            "Operating Thesis",
            "Core Principles",
            "Reusable SOPs",
            "Decision Logic",
            "Boundaries & Anti-patterns",
            "Agent Rules",
        )
    )


@pytest.fixture
def store(tmp_path) -> SQLiteMemoryStore:
    return SQLiteMemoryStore(tmp_path / "memory.db", now_ms=Clock())


def test_the_scope_is_the_deployments_and_not_the_callers(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)
        await store.capture_archive(_archive("mine", 1_000))
        await store.capture_archive(_archive("theirs", 2_000, scope=OTHER))

        page = await service.list_l0()

        assert [row.archive_id for row in page.items] == ["mine"]
        assert await service.get_l0("mine") is not None
        # The store would return it; the facade will not, because it belongs to
        # a repository this deployment does not serve.
        assert await store.read_archive("theirs") is not None
        assert await service.get_l0("theirs") is None
        assert await service.get_l0("no-such-archive") is None

    asyncio.run(scenario())


def test_pages_advance_by_cursor_without_gaps_or_repeats(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)
        for index in range(5):
            await store.capture_archive(_archive(f"a-{index}", 1_000 + index))

        seen: list[str] = []
        cursor: str | None = None
        while True:
            page = await service.list_l0(cursor=cursor, limit=2)
            seen.extend(row.archive_id for row in page.items)
            cursor = page.next_cursor
            if cursor is None:
                assert len(page.items) <= 2
                break
            assert len(page.items) == 2

        assert seen == ["a-4", "a-3", "a-2", "a-1", "a-0"]

    asyncio.run(scenario())


def test_a_cursor_for_another_view_is_rejected(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)
        await store.capture_archive(_archive("a-1", 1_000))

        # An audit cursor carries one number; the archive list is keyed by a
        # (timestamp, id) pair, and it must not be able to interpret it.
        with pytest.raises(InvalidCursor):
            await service.list_l0(cursor=encode_cursor([1]))
        with pytest.raises(InvalidCursor):
            await service.list_l0(cursor=encode_cursor(["a-1", 1]))
        with pytest.raises(InvalidCursor):
            await service.list_l0(cursor="not-a-cursor")
        with pytest.raises(InvalidCursor):
            await service.list_audit(cursor=encode_cursor([1_000, "a-1"]))

    asyncio.run(scenario())


def test_limits_are_bounded_rather_than_trusted(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)

        assert (await service.list_l0(limit=1)).items == ()
        for limit in (0, -1, MAX_LIMIT + 1):
            with pytest.raises(ValueError):
                await service.list_l1(limit=limit)

    asyncio.run(scenario())


def test_an_unknown_filter_is_rejected_rather_than_answered(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)

        for call in (
            service.list_l1("deleted"),
            service.list_l2("deleted"),
            service.list_jobs("deleted"),
        ):
            with pytest.raises(ValueError, match="unknown"):
                await call
        assert (await service.list_l1("superseded")).items == ()

    asyncio.run(scenario())


def test_status_filters_reach_the_rows_the_pipeline_retired(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)
        await store.apply_candidates(SCOPE, (_fact("first"),), 1)
        [first] = (await service.list_l1()).items
        await store.apply_candidates(
            SCOPE, (_fact("second", decision="supersede", supersedes_ids=(first.memory_id,)),), 2
        )
        await store.write_scene(SCOPE, SceneCandidate("scene-0", _scene_text("s0"), "", (), 1), 1)
        await store.write_scene(SCOPE, SceneCandidate("scene-1", _scene_text("s1"), "", (), 2), 1)

        superseded = await service.list_l1("superseded")

        assert [row.memory_id for row in superseded.items] == [first.memory_id]
        assert [row.scene_id for row in (await service.list_l2("dormant")).items] == [
            row.scene_id for row in (await service.list_l2()).items if row.scenario_key == "scene-0"
        ]
        assert {row.status for row in (await service.list_l2()).items} == {"current", "dormant"}

    asyncio.run(scenario())


def test_jobs_are_visible_in_every_state_including_dead_letter(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)
        job = await store.create_or_wake_job(SCOPE, "l1", 1, 0)
        assert [row.job_id for row in (await service.list_jobs("queued")).items] == [job.job_id]

        claimed = await store.claim_job(999_999, "lease", 1_000)
        assert claimed is not None and claimed.job_id == job.job_id
        await store.fail_job(job.job_id, "lease", "ProviderError", None)

        assert [row.job_id for row in (await service.list_jobs("dead_letter")).items] == [job.job_id]
        assert [row.error_class for row in (await service.list_jobs()).items] == ["ProviderError"]
        assert (await service.list_jobs("completed")).items == ()

    asyncio.run(scenario())


def test_doctrine_is_reported_as_the_global_one(store: SQLiteMemoryStore) -> None:
    async def scenario() -> None:
        service = MemoryQueryService(store, SCOPE)
        assert await service.get_l3() is None

        await store.write_doctrine(SCOPE, DoctrineCandidate(_doctrine(), (), 1))

        # Doctrine is synthesized globally, so the same answer is correct for
        # every repository the deployment serves.
        for scope in (SCOPE, OTHER):
            doctrine = await MemoryQueryService(store, scope).get_l3()
            assert doctrine is not None and doctrine.content == _doctrine()

    asyncio.run(scenario())
