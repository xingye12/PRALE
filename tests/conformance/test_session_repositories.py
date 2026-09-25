import asyncio

from agent_harness.storage.repository import MemorySessionRepo, SQLiteSessionRepo


def test_memory_session_repo_preserves_store_identity() -> None:
    async def scenario() -> None:
        repo = MemorySessionRepo()
        metadata, created = await repo.create("session-1")
        reopened_metadata, reopened = await repo.open("session-1")

        assert metadata == reopened_metadata
        assert created is reopened
        assert await repo.list() == [metadata]

    asyncio.run(scenario())


def test_sqlite_session_repo_creates_and_opens_session_files(tmp_path) -> None:
    async def scenario() -> None:
        repo = SQLiteSessionRepo(tmp_path)
        metadata, storage = await repo.create("session-1")
        storage.close()
        reopened_metadata, reopened = await repo.open("session-1")

        assert reopened_metadata == metadata
        assert [item.id for item in await repo.list()] == ["session-1"]
        reopened.close()

    asyncio.run(scenario())


def test_memory_session_repo_fork_has_independent_storage() -> None:
    async def scenario() -> None:
        repo = MemorySessionRepo()
        _, source = await repo.create("source")
        _, target = await repo.fork("source", "target")

        assert source is not target
        assert [item.id for item in await repo.list()] == ["source", "target"]

    asyncio.run(scenario())
