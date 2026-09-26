import asyncio
import hashlib

from agent_harness.api.harness import Harness
from agent_harness.domain.entries import NewEntry
from agent_harness.domain.memory import MemoryScope, SessionTraceArchive, TraceItem
from agent_harness.domain.values import ListAddress
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
from agent_harness.storage.protocol import AppendList, InsertEntry


def test_recovery_after_archive_write_before_outbox_settlement_is_idempotent(tmp_path) -> None:
    async def scenario() -> None:
        session_store = MemoryStorage(now_ms=lambda: 1)
        assets = SQLiteMemoryStore(tmp_path / "memory.db")
        runtime = MemoryRuntime(assets)
        scope = MemoryScope("team", "agent", "user")
        await Harness.open("session", session_store, memory_scope=scope, memory_runtime=runtime)
        await session_store.commit(
            [InsertEntry(NewEntry("entry", None, "message", {"role": "user", "content": "hello"}))]
        )
        digest = hashlib.sha256(b"entry").hexdigest()
        archive = SessionTraceArchive(
            "archive",
            scope,
            "session",
            "main",
            "operation",
            "run",
            None,
            "entry",
            ("entry",),
            digest,
            "conversation-v1",
            1,
            "content",
            (TraceItem("entry", 1, 1, "message", "user", "hello", {}),),
        )
        await assets.capture_archive(archive)
        await session_store.commit(
            [
                AppendList(
                    ListAddress("memory/capture_outbox"),
                    {
                        "scope": {"team_id": "team", "agent_id": "agent", "user_id": "user", "task_id": None},
                        "lane": "main",
                        "kind": "run",
                        "operation_id": "operation",
                        "base_tip_id": None,
                        "tip_id": "entry",
                        "source_entry_ids": ["entry"],
                        "source_entry_hash": digest,
                        "trace_format_version": "conversation-v1",
                        "trace_entry_ids": [],
                    },
                )
            ]
        )
        await runtime._dispatch_session(runtime._sessions["session"][0], scope)  # noqa: SLF001
        assert not await session_store.read_list(ListAddress("memory/capture_outbox"))
        archives = await assets.unconsumed_items(scope, 0)
        assert len(archives) == 1

    asyncio.run(scenario())
