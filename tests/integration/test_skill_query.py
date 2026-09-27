"""The skill view is read-only and repository-scoped, and it keeps history.

Two things are being checked here that the storage conformance tests cannot:
that the service resolves the scope itself (ADR-WEB-003 / ADR-WEB-004), and
that a skill the runtime has retired stays visible — a view that only showed
what is currently injected could not explain where a skill went.
"""

import asyncio

import pytest

from agent_harness.api.errors import InvalidCursor
from agent_harness.api.pagination import encode_cursor
from agent_harness.api.skill import SkillQueryService
from agent_harness.domain.skill import SkillArchive, SkillProposal, SkillScope
from agent_harness.storage.skill_sqlite import SQLiteSkillStore

SCOPE = SkillScope("git@example.com:owner/repo.git")
OTHER = SkillScope("git@example.com:owner/other.git")


class Clock:
    def __init__(self, start: int = 1_000) -> None:
        self.now = start

    def __call__(self) -> int:
        return self.now

    def advance(self, milliseconds: int) -> None:
        self.now += milliseconds


def _markdown(name: str = "Deploy", version: int = 1) -> str:
    return f"""---
name: {name}
description: Reusable deployment verification procedure
triggers: deploy, release
version: {version}
status: active
---
适用范围与不适用范围：已验证的服务发布。
前置条件：有已批准的发布包。
步骤：执行部署并记录结果。
验证：检查健康端点和回滚指标。
失败/回滚处理：停止发布并回滚到上一版本。
资源使用说明：使用附带的模板。
"""


def _proposal(**changes: object) -> SkillProposal:
    values: dict[str, object] = {"action": "create", "markdown": _markdown(), "evidence_entry_ids": ("tool-result",)}
    values.update(changes)
    return SkillProposal(**values)  # type: ignore[arg-type]


def _archive(archive_id: str, created_at: int, *, scope: SkillScope = SCOPE) -> SkillArchive:
    return SkillArchive(
        archive_id,
        scope,
        "session",
        f"l0-{archive_id}",
        f"payload-{archive_id}",
        "tool_calls",
        "conversation-v1",
        (),
        128,
        3,
        2,
        created_at,
    )


@pytest.fixture
def store(tmp_path) -> SQLiteSkillStore:
    return SQLiteSkillStore(tmp_path / "skills.db", now_ms=Clock())


def test_the_scope_is_the_deployments_and_not_the_callers(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        service = SkillQueryService(store, SCOPE)
        mine = await store.create(SCOPE, _proposal(), 1_000)
        theirs = await store.create(OTHER, _proposal(), 2_000)
        await store.append_archive(_archive("mine", 1_000))
        await store.append_archive(_archive("theirs", 2_000, scope=OTHER))

        assert [row.skill_id for row in (await service.list_skills()).items] == [mine.skill_id]
        assert await service.get_skill(mine.skill_id) is not None
        assert await service.get_skill(theirs.skill_id) is None
        assert await service.get_archive("mine") is not None
        assert await store.get_archive("theirs") is not None
        assert await service.get_archive("theirs") is None

    asyncio.run(scenario())


def test_a_retired_skill_stays_visible_rather_than_vanishing(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        service = SkillQueryService(store, SCOPE)
        asset = await store.create(SCOPE, _proposal(), 1_000)
        # The only writer that sets any other state today is the evolution
        # runtime, which does not yet disable anything; a disabled skill is
        # therefore seeded the way it would arrive, and must survive the read.
        store._conn.execute("UPDATE skills SET state='disabled' WHERE skill_id=?", (asset.skill_id,))

        assert [row.skill_id for row in (await service.list_skills()).items] == [asset.skill_id]
        assert [row.skill_id for row in (await service.list_skills("disabled")).items] == [asset.skill_id]
        read = await service.get_skill(asset.skill_id)
        assert read is not None and read.state == "disabled"

    asyncio.run(scenario())


def test_versions_and_archives_page_by_cursor(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        service = SkillQueryService(store, SCOPE)
        asset = await store.create(SCOPE, _proposal(), 1_000)
        for version in (2, 3, 4):
            await store.update(
                SCOPE,
                _proposal(
                    action="update",
                    skill_id=asset.skill_id,
                    expected_version=version - 1,
                    markdown=_markdown(version=version),
                ),
                version * 1_000,
            )
        for index in range(4):
            await store.append_archive(_archive(f"a-{index}", 1_000 + index))

        versions = await service.list_versions(asset.skill_id, limit=2)
        archives = await service.list_archives(limit=3)

        rest = await service.list_versions(asset.skill_id, versions.next_cursor)

        assert [row.version for row in versions.items] == [4, 3]
        assert versions.next_cursor is not None
        assert [row.version for row in rest.items] == [2, 1]
        assert [row.archive_id for row in archives.items] == ["a-3", "a-2", "a-1"]
        last = await service.list_archives(archives.next_cursor, limit=3)
        assert [row.archive_id for row in last.items] == ["a-0"]
        assert last.next_cursor is None

    asyncio.run(scenario())


def test_an_unknown_state_or_status_is_rejected_rather_than_answered(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        service = SkillQueryService(store, SCOPE)

        with pytest.raises(ValueError, match="unknown skill state"):
            await service.list_skills("retired")
        with pytest.raises(ValueError, match="unknown job status"):
            await service.list_jobs("done")
        assert (await service.list_skills("archived")).items == ()
        with pytest.raises(InvalidCursor):
            await service.list_versions("skl-1", cursor=encode_cursor([1, "two"]))
        with pytest.raises(InvalidCursor):
            await service.list_archives(cursor=encode_cursor([1]))

    asyncio.run(scenario())


def test_jobs_and_audit_are_listed_for_the_repository(
    store: SQLiteSkillStore,
) -> None:
    async def scenario() -> None:
        service = SkillQueryService(store, SCOPE)
        await store.append_archive(_archive("mine", 1_000))
        await store.append_archive(_archive("theirs", 2_000, scope=OTHER))
        job = await store.create_job(_archive("mine", 1_000), 0)
        await store.create_job(_archive("theirs", 2_000, scope=OTHER), 0)
        await store.audit(SCOPE, "skill_reviewed", {"n": 1})
        await store.audit(OTHER, "skill_reviewed", {"n": 2})

        assert [row.job_id for row in (await service.list_jobs()).items] == [job.job_id]
        assert [row.job_id for row in (await service.list_jobs("scheduled")).items] == [job.job_id]
        assert [row.data for row in (await service.list_audit()).items] == [{"n": 1}]

    asyncio.run(scenario())
