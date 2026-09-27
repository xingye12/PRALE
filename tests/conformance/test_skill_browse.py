"""Browse reads must describe a skill's whole history, not just its head.

Both backends are the same storage implementation, but the ephemeral one is a
separate entry point into it, so every case runs against each.
"""

import asyncio
from collections.abc import Iterator

import pytest

from agent_harness.domain.skill import SkillArchive, SkillProposal, SkillScope
from agent_harness.storage.skill_memory import InMemorySkillStore
from agent_harness.storage.skill_sqlite import SQLiteSkillStore

SCOPE = SkillScope("git@example.com:owner/repo.git")


class Clock:
    """Deterministic millisecond clock so ordering is reproducible."""

    def __init__(self, start: int = 1_000) -> None:
        self.now = start

    def __call__(self) -> int:
        return self.now

    def advance(self, milliseconds: int) -> None:
        self.now += milliseconds


@pytest.fixture(params=["memory", "sqlite"])
def store(request: pytest.FixtureRequest, tmp_path, clock: Clock) -> Iterator[SQLiteSkillStore]:
    if request.param == "memory":
        yield InMemorySkillStore(now_ms=clock)
        return
    yield SQLiteSkillStore(tmp_path / "skills.db", now_ms=clock)


@pytest.fixture
def clock() -> Clock:
    return Clock()


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


def _set_state(store: SQLiteSkillStore, skill_id: str, state: str) -> None:
    """Move an asset to a state no writer currently produces.

    The evolution runtime only ever writes ``active``; the schema and the browse
    view both allow the others, and a UI that could not show a skill once the
    runtime learns to disable one would be a silent regression.  So the state is
    set directly here, which is the only way to reach it today.
    """

    store._conn.execute("UPDATE skills SET state=? WHERE skill_id=?", (state, skill_id))


def test_skills_are_listed_newest_first_and_page_cleanly(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        created = []
        for index in range(3):
            created.append(await store.create(SCOPE, _proposal(markdown=_markdown(f"Deploy {index}")), 1_000 + index))

        rows = await store.list_skills(SCOPE, None, None, 50)

        assert [row.name for row in rows] == ["Deploy 2", "Deploy 1", "Deploy 0"]
        assert [row.skill_id for row in rows] == [asset.skill_id for asset in reversed(created)]

        seen: list[str] = []
        after: tuple[int, str] | None = None
        while True:
            page = await store.list_skills(SCOPE, None, after, 2)
            if not page:
                break
            seen.extend(row.skill_id for row in page)
            after = (page[-1].updated_at, page[-1].skill_id)
        assert seen == [asset.skill_id for asset in reversed(created)]

    asyncio.run(scenario())


def test_skill_state_filter_reaches_assets_that_are_no_longer_injected(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        asset = await store.create(SCOPE, _proposal(), 1_000)
        _set_state(store, asset.skill_id, "disabled")

        assert [row.skill_id for row in await store.list_skills(SCOPE, None, None, 50)] == [asset.skill_id]
        disabled = await store.list_skills(SCOPE, "disabled", None, 50)
        assert [row.state for row in disabled] == ["disabled"]
        assert await store.list_skills(SCOPE, "active", None, 50) == ()

        read = await store.get_skill(SCOPE, asset.skill_id)
        assert read is not None and read.state == "disabled" and read.current_version == asset.current_version
        assert await store.get_skill(SCOPE, "missing") is None

    asyncio.run(scenario())


def test_versions_page_newest_first_and_stay_with_their_owner(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        asset = await store.create(SCOPE, _proposal(), 1_000)
        await store.update(
            SCOPE,
            _proposal(action="update", skill_id=asset.skill_id, expected_version=1, markdown=_markdown(version=2)),
            2_000,
        )

        versions = await store.list_versions(SCOPE, asset.skill_id, None, 50)

        assert [version.version for version in versions] == [2, 1]
        assert versions[0].markdown.startswith("---\nname: Deploy")
        assert [version.version for version in await store.list_versions(SCOPE, asset.skill_id, (2,), 50)] == [1]
        assert await store.list_versions(SkillScope("git@example.com:owner/other.git"), asset.skill_id, None, 50) == ()

    asyncio.run(scenario())


def test_archives_are_listed_without_their_payload(store: SQLiteSkillStore) -> None:
    async def scenario() -> None:
        await store.append_archive(_archive("old", 1_000))
        await store.append_archive(_archive("new", 2_000))

        rows = await store.list_archives(SCOPE, None, 50)

        assert [row.archive_id for row in rows] == ["new", "old"]
        assert [row.created_at for row in rows] == [2_000, 1_000]
        assert rows[0].reason == "tool_calls"
        assert (rows[0].bytes_count, rows[0].successful_tool_calls, rows[0].turn_count) == (128, 3, 2)
        assert not hasattr(rows[0], "archives")

        full = await store.get_archive("new")
        assert full is not None and full.payload_hash == "payload-new"
        assert await store.get_archive("missing") is None

    asyncio.run(scenario())


def test_jobs_and_audit_are_listed_newest_first(store: SQLiteSkillStore, clock: Clock) -> None:
    async def scenario() -> None:
        await store.append_archive(_archive("a-1", 1_000))
        await store.append_archive(_archive("a-2", 1_000))
        first = await store.create_job(_archive("a-1", 1_000), 1_000)
        clock.advance(10)
        second = await store.create_job(_archive("a-2", 1_000), 1_000)

        jobs = await store.list_jobs(SCOPE, None, None, 50)

        assert [job.job_id for job in jobs] == [second.job_id, first.job_id]
        assert [job.status for job in jobs] == ["scheduled", "scheduled"]
        assert await store.list_jobs(SCOPE, "nonexistent", None, 50) == ()

        await store.audit(SCOPE, "first_event", {"n": 1})
        await store.audit(SCOPE, "second_event", {"n": 2})
        audit = await store.list_audit(SCOPE, None, 50)

        assert [record.event for record in audit] == ["second_event", "first_event"]
        assert audit[0].data == {"n": 2}
        assert [record.audit_id for record in await store.list_audit(SCOPE, (audit[0].audit_id,), 50)] == [
            audit[1].audit_id
        ]

    asyncio.run(scenario())


def test_every_browse_read_is_scoped_to_its_repository(store: SQLiteSkillStore, clock: Clock) -> None:
    async def scenario() -> None:
        other = SkillScope("git@example.com:owner/other.git")
        mine = await store.create(SCOPE, _proposal(), 1_000)
        theirs = await store.create(other, _proposal(), 2_000)
        await store.append_archive(_archive("mine-archive", 1_000))
        await store.append_archive(_archive("their-archive", 2_000, scope=other))
        job = await store.create_job(_archive("mine-archive", 1_000), 0)
        their_job = await store.create_job(_archive("their-archive", 2_000, scope=other), 0)
        clock.advance(10)
        await store.audit(SCOPE, "mine", {})
        await store.audit(other, "theirs", {})

        assert [row.skill_id for row in await store.list_skills(SCOPE, None, None, 50)] == [mine.skill_id]
        assert await store.get_skill(SCOPE, theirs.skill_id) is None
        assert [row.archive_id for row in await store.list_archives(SCOPE, None, 50)] == ["mine-archive"]
        assert [row.job_id for row in await store.list_jobs(SCOPE, None, None, 50)] == [job.job_id]
        assert their_job.job_id != job.job_id
        assert [row.event for row in await store.list_audit(SCOPE, None, 50)] == ["mine"]

    asyncio.run(scenario())
