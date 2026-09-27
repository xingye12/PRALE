import asyncio
from collections.abc import Iterator
from pathlib import Path

import pytest

from agent_harness.api.catalog import SessionCatalog
from agent_harness.api.errors import InvalidCursor, SessionNotFound
from agent_harness.api.pagination import encode_cursor
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.storage.catalog import (
    CatalogConflict,
    CatalogEntry,
    CatalogStore,
    MemoryCatalogStore,
    SQLiteCatalogStore,
)
from agent_harness.storage.repository import session_filename

REPOSITORY_ID = "git@example.com:owner/repo.git"


class Clock:
    """Deterministic millisecond clock so activity ordering is reproducible."""

    def __init__(self, start: int = 1_000) -> None:
        self.now = start

    def __call__(self) -> int:
        return self.now

    def advance(self, milliseconds: int) -> None:
        self.now += milliseconds


@pytest.fixture(params=["memory", "sqlite"])
def store(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[CatalogStore]:
    """Both catalog backends must satisfy the same conformance contract."""

    if request.param == "memory":
        yield MemoryCatalogStore()
        return
    sqlite = SQLiteCatalogStore(tmp_path / "catalog.sqlite")
    try:
        yield sqlite
    finally:
        sqlite.close()


def _config(tmp_path: Path, repository_id: str = REPOSITORY_ID, project_id: str | None = None) -> ProjectRuntimeConfig:
    return ProjectRuntimeConfig(
        project_root=tmp_path,
        repository_id=repository_id,
        sessions_dir=tmp_path / "sessions",
        catalog_db=tmp_path / "catalog.sqlite",
        project_id=project_id,
    )


def _catalog(store: CatalogStore, tmp_path: Path, clock: Clock, **config) -> SessionCatalog:
    return SessionCatalog(store, _config(tmp_path, **config), now_ms=clock)


def test_register_then_read_back(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = Clock()
        catalog = _catalog(store, tmp_path, clock)

        summary = await catalog.register("s-1")

        assert summary.session_id == "s-1"
        assert summary.project_id == REPOSITORY_ID
        assert summary.repository_id == REPOSITORY_ID
        assert summary.default_lane == "main"
        assert summary.created_at == clock.now
        assert summary.last_active_at == clock.now
        assert not hasattr(summary, "database_path"), "the database location must stay server-side"

        page = await catalog.list_sessions()
        assert [item.session_id for item in page.items] == ["s-1"]
        assert page.next_cursor is None

        entry = await store.get("s-1")
        assert entry is not None
        assert entry.database_path == session_filename("s-1")

    asyncio.run(scenario())


def test_register_is_idempotent_and_keeps_creation_time(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = Clock()
        catalog = _catalog(store, tmp_path, clock)

        first = await catalog.register("s-1")
        clock.advance(500)
        second = await catalog.register("s-1")

        assert second.created_at == first.created_at
        assert second.last_active_at > first.last_active_at

    asyncio.run(scenario())


def test_register_rejects_a_session_that_changed_repository(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = Clock()

        await _catalog(store, tmp_path, clock).register("s-1")
        with pytest.raises(CatalogConflict):
            await _catalog(store, tmp_path, clock, repository_id="git@example.com:owner/other.git").register("s-1")

    asyncio.run(scenario())


def test_touch_moves_a_session_to_the_front(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = Clock()
        catalog = _catalog(store, tmp_path, clock)
        for session_id in ("s-1", "s-2", "s-3"):
            await catalog.register(session_id)
            clock.advance(1_000)

        clock.advance(1_000)
        await catalog.touch("s-1")

        page = await catalog.list_sessions()
        assert [item.session_id for item in page.items] == ["s-1", "s-3", "s-2"]

    asyncio.run(scenario())


def test_touch_ignores_an_unregistered_session(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        await _catalog(store, tmp_path, Clock()).touch("ghost")

        assert await store.get("ghost") is None

    asyncio.run(scenario())


def test_list_sessions_paginates_without_gaps_or_repeats(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = Clock()
        catalog = _catalog(store, tmp_path, clock)
        expected: list[str] = []
        for index in range(5):
            expected.append((await catalog.register(f"s-{index}")).session_id)
            clock.advance(1_000)
        expected.reverse()

        seen: list[str] = []
        cursor: str | None = None
        for _ in range(10):
            page = await catalog.list_sessions(cursor, limit=2)
            seen.extend(item.session_id for item in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break

        assert seen == expected

    asyncio.run(scenario())


def test_list_sessions_scopes_to_the_project(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        clock = Clock()
        await _catalog(store, tmp_path, clock).register("s-1")
        clock.advance(1_000)
        await _catalog(
            store, tmp_path, clock, repository_id="git@example.com:owner/other.git", project_id="other-project"
        ).register("s-2")

        page = await _catalog(store, tmp_path, clock).list_sessions()
        assert [item.session_id for item in page.items] == ["s-1"]

    asyncio.run(scenario())


def test_list_sessions_rejects_an_out_of_range_limit(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        catalog = _catalog(store, tmp_path, Clock())
        for limit in (0, 201):
            with pytest.raises(ValueError, match="limit"):
                await catalog.list_sessions(limit=limit)

    asyncio.run(scenario())


def test_list_sessions_rejects_a_foreign_cursor(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        catalog = _catalog(store, tmp_path, Clock())
        await catalog.register("s-1")

        for cursor in ("not-a-cursor", encode_cursor(["s-1"]), encode_cursor([1_000, 1_000, 1_000])):
            with pytest.raises(InvalidCursor):
                await catalog.list_sessions(cursor)

    asyncio.run(scenario())


def test_resolve_returns_a_path_inside_the_session_directory(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        catalog = _catalog(store, tmp_path, Clock())
        await catalog.register("s-1")

        resolved = await catalog.resolve("s-1")

        assert resolved == (tmp_path / "sessions" / "s-1.sqlite").resolve()
        assert resolved.is_relative_to((tmp_path / "sessions").resolve())

    asyncio.run(scenario())


def test_resolve_rejects_unregistered_sessions(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        catalog = _catalog(store, tmp_path, Clock())

        with pytest.raises(SessionNotFound):
            await catalog.resolve("never-registered")
        with pytest.raises(SessionNotFound):
            await catalog.resolve("../catalog")

    asyncio.run(scenario())


def test_resolve_refuses_a_catalog_row_pointing_outside_the_directory(store: CatalogStore, tmp_path: Path) -> None:
    async def scenario() -> None:
        outside = tmp_path / "outside.sqlite"
        await store.register(CatalogEntry("s-1", REPOSITORY_ID, REPOSITORY_ID, str(outside), "main", 1_000, 1_000))

        with pytest.raises(SessionNotFound, match="outside the session directory"):
            await _catalog(store, tmp_path, Clock()).resolve("s-1")

    asyncio.run(scenario())


def test_session_filename_rejects_path_traversal() -> None:
    assert session_filename("s-1") == "s-1.sqlite"
    for session_id in ("", "../escape", "nested/session", "back\\slash"):
        with pytest.raises(ValueError):
            session_filename(session_id)
