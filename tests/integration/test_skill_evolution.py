import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.memory import MemoryScope, SessionTraceArchive, TraceItem
from agent_harness.domain.skill import SkillConfig, SkillProposal, SkillScope
from agent_harness.domain.values import ListAddress
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.skill.runtime import SkillEvolutionRuntime
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.memory_memory import InMemoryMemoryStore
from agent_harness.storage.skill_memory import InMemorySkillStore


def test_skill_requires_memory_runtime_and_terminal_writes_shared_snapshot() -> None:
    async def scenario() -> None:
        session = MemoryStorage()
        with pytest.raises(ValueError):
            await Harness.open(
                "s", session, skill_scope=SkillScope("repo"), skill_runtime=SkillEvolutionRuntime(InMemorySkillStore())
            )
        memory = MemoryRuntime(InMemoryMemoryStore())
        skills = SkillEvolutionRuntime(InMemorySkillStore())
        harness = await Harness.open(
            "s",
            session,
            memory_scope=MemoryScope("repo"),
            memory_runtime=memory,
            skill_scope=SkillScope("repo"),
            skill_runtime=skills,
        )
        lane = await harness.acquire_lane("main")
        await lane.prompt("hello", operation_id="op")
        await lane.request_abort()
        await lane.drive(None)  # type: ignore[arg-type]
        memory_outbox = await session.read_list(ListAddress("memory/capture_outbox"))
        skill_outbox = await session.read_list(ListAddress("skill/capture_outbox"))
        assert memory_outbox[0]["source_entry_ids"] == skill_outbox[0]["source_entry_ids"]
        assert memory_outbox[0]["source_entry_hash"] == skill_outbox[0]["source_entry_hash"]

    asyncio.run(scenario())


def test_review_worker_completes_no_op_job() -> None:
    class Reviewer:
        prompt_id = "test-review"
        prompt_version = 1

        async def review(self, archive, candidates):
            return SkillProposal("no_op", reason="not reusable")

    async def scenario() -> None:
        store = InMemorySkillStore()
        source = SessionTraceArchive(
            "l0",
            MemoryScope("repo"),
            "session",
            "main",
            "op",
            "run",
            None,
            "tip",
            (),
            "hash",
            "conversation-v1",
            1,
            "payload",
            (TraceItem("tool", 1, 1, "message", "tool", "ok", {"success": True}),),
        )
        archive = await store.buffer_source(
            SkillScope("repo"), source, tool_threshold=1, byte_threshold=1000, max_bytes=2000
        )
        assert archive is not None
        job = await store.create_job(archive, 0)
        claimed = await store.claim_job(1, "lease", 100)
        assert claimed is not None and claimed.job_id == job.job_id
        runtime = SkillEvolutionRuntime(store, Reviewer(), config=SkillConfig())
        await runtime._run_job(claimed)  # noqa: SLF001
        status = await store.get_job(job.job_id)
        assert status is not None and status.status == "completed"

    asyncio.run(scenario())
