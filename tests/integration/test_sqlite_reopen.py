import asyncio
import contextlib
import sqlite3

from agent_harness.api.harness import Harness
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.sqlite import SQLiteStorage


class Provider:
    async def generate(self, request: GenerationRequest) -> AssistantResult:
        return AssistantResult(content="persisted", usage={})


class BlockingProvider:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.calls += 1
        self.started.set()
        await self.release.wait()
        return AssistantResult(content="released", usage={})


def test_sqlite_reopens_terminal_result_and_transcript(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "session.sqlite"
        storage = SQLiteStorage(path)
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        completed = await lane.drive(Provider())
        storage.close()

        reopened = SQLiteStorage(path)
        lane = await (await Harness.open("session-1", reopened)).acquire_lane("main")
        assert (await lane.get_result("op-1")) == completed
        entries = await reopened.scan_branch(completed.tip_id)
        assert [entry.payload["role"] for entry in entries] == ["user", "assistant"]
        reopened.close()

    asyncio.run(scenario())


def test_sqlite_rejects_opening_a_single_session_database_under_another_session_id(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "session.sqlite"
        storage = SQLiteStorage(path)
        await Harness.open("session-1", storage)
        storage.close()

        reopened = SQLiteStorage(path)
        try:
            try:
                await Harness.open("session-2", reopened)
            except RuntimeError as error:
                assert "belongs to session" in str(error)
            else:
                raise AssertionError("expected session binding failure")
        finally:
            reopened.close()

    asyncio.run(scenario())


def test_sqlite_reopen_recovers_an_unknown_provider_outcome(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "recovery.sqlite"
        storage = SQLiteStorage(path)
        lane = await (await Harness.open("session-1", storage)).acquire_lane("main")
        await lane.prompt("hi", operation_id="op-1")
        provider = BlockingProvider()
        drive = asyncio.create_task(lane.drive(provider))
        await provider.started.wait()
        drive.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await drive
        storage.close()

        reopened = SQLiteStorage(path)
        recovered = await (await Harness.open("session-1", reopened)).acquire_lane("main")
        result = await recovered.recover()

        assert result is not None
        assert result.status == "unknown"
        reopened.close()

    asyncio.run(scenario())


def test_separate_sqlite_connections_observe_the_durable_drive_lease(tmp_path) -> None:
    async def scenario() -> None:
        path = tmp_path / "lease.sqlite"
        first_storage = SQLiteStorage(path)
        first = await (await Harness.open("session-1", first_storage)).acquire_lane("main")
        await first.prompt("hi", operation_id="op-1")
        second_storage = SQLiteStorage(path)
        second = await (await Harness.open("session-1", second_storage)).acquire_lane("main")
        provider = BlockingProvider()

        first_drive = asyncio.create_task(first.drive(provider))
        await provider.started.wait()
        second_drive = asyncio.create_task(second.drive(provider))
        await asyncio.sleep(0.02)
        assert provider.calls == 1
        provider.release.set()
        one, two = await asyncio.gather(first_drive, second_drive)

        assert one == two
        first_storage.close()
        second_storage.close()

    asyncio.run(scenario())


def test_sqlite_forward_migration_from_v1_is_idempotent(tmp_path) -> None:
    path = tmp_path / "v1.sqlite"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
        INSERT INTO schema_migrations(version) VALUES(1);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE sequence_counter (id INTEGER PRIMARY KEY CHECK(id = 1), next_seq INTEGER NOT NULL);
        INSERT INTO sequence_counter(id, next_seq) VALUES(1, 1);
        CREATE TABLE entries (
            id TEXT PRIMARY KEY, parent_id TEXT REFERENCES entries(id), seq INTEGER UNIQUE NOT NULL,
            timestamp INTEGER NOT NULL, type TEXT NOT NULL, custom_type TEXT, payload TEXT NOT NULL
        );
        CREATE TABLE values_store (address TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE list_elements (address TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY(address, seq));
        CREATE TABLE usage_rows (id TEXT PRIMARY KEY, seq INTEGER UNIQUE NOT NULL, entry_id TEXT, usage TEXT NOT NULL);
        """
    )
    connection.close()

    first = SQLiteStorage(path)
    first.close()
    second = SQLiteStorage(path)
    versions = [row[0] for row in second._connection.execute("SELECT version FROM schema_migrations ORDER BY version")]  # noqa: SLF001
    indexes = {row[1] for row in second._connection.execute("PRAGMA index_list('list_elements')")}  # noqa: SLF001
    span_indexes = {row[1] for row in second._connection.execute("PRAGMA index_list('effect_spans')")}  # noqa: SLF001
    usage_columns = {row[1] for row in second._connection.execute("PRAGMA table_info('usage_rows')")}  # noqa: SLF001
    second.close()

    assert versions == [1, 2, 3, 4]
    assert "list_elements_address_seq" in indexes
    assert "effect_spans_call" in span_indexes
    assert {"operation_id", "span_id"} <= usage_columns
