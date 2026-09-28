import asyncio
import json

import pytest

from agent_harness.domain.memory import MemoryScope, SessionTraceArchive, TraceItem
from agent_harness.domain.skill import SkillArchive, SkillListing, SkillScope
from agent_harness.integrations.skill_reviewer import CodingSkillReviewer
from agent_harness.runtime.generation import AssistantResult
from agent_harness.skill.runtime import SkillEvolutionRuntime
from agent_harness.storage.skill_memory import InMemorySkillStore


class Provider:
    def __init__(self, content: str) -> None:
        self.content = content
        self.request = None

    async def generate(self, request):
        self.request = request
        return AssistantResult(self.content, {})


def _archive() -> SkillArchive:
    trace = SessionTraceArchive(
        "l0",
        MemoryScope("repo"),
        "session",
        "main",
        "operation",
        "run",
        None,
        "tip",
        ("tool-ok",),
        "hash",
        "conversation-v1",
        1,
        "payload",
        (TraceItem("tool-ok", 1, 1, "message", "tool", "pytest passed", {"success": True}),),
    )
    return SkillArchive(
        "archive", SkillScope("repo"), "session", "l0", "payload", "forced", "conversation-v1", (trace,), 1, 1, 0, 1
    )


def test_coding_reviewer_builds_isolated_transcript_and_parses_create() -> None:
    async def scenario() -> None:
        provider = Provider(
            json.dumps(
                {
                    "action": "create",
                    "evidence_entry_ids": ["tool-ok"],
                    "tags": ["testing"],
                    "files": [{"path": "check.txt", "content": "pytest -q"}],
                    "markdown": """---
name: pytest-check
description: Reusable pytest verification
triggers: test, pytest
version: 1
status: active
---
适用范围：测试验证。
前置条件：安装依赖。
步骤：运行测试。
验证：检查测试通过。
失败/回滚：记录失败并停止。
资源使用说明：使用 check.txt。""",
                }
            )
        )
        reviewer = CodingSkillReviewer(provider)
        proposal = await reviewer.review(
            _archive(), (SkillListing("skl-old", "Old", "Old test method", ("test",), 2, "active"),)
        )

        assert proposal.action == "create"
        assert proposal.evidence_entry_ids == ("tool-ok",)
        assert proposal.files[0].content == b"pytest -q"
        assert provider.request is not None
        user_prompt = provider.request.messages[1]["content"]
        assert "<<past-tool" in user_prompt
        assert "<<end-of-transcript>>" in user_prompt
        assert '"skill_id": "skl-old"' in user_prompt
        assert "not a participant" in provider.request.messages[0]["content"]

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        "[]",
        '{"action":"create","evidence_entry_ids":[]}',
        '{"action":"update","skill_id":"skl-1","expected_version":false,"evidence_entry_ids":["x"],"markdown":"x"}',
    ],
)
def test_coding_reviewer_rejects_invalid_structured_output(content: str) -> None:
    async def scenario() -> None:
        with pytest.raises(ValueError):
            await CodingSkillReviewer(Provider(content)).review(_archive(), ())

    asyncio.run(scenario())


def test_coding_reviewer_allows_explicit_no_op() -> None:
    async def scenario() -> None:
        proposal = await CodingSkillReviewer(Provider('{"action":"no_op","reason":"one-off"}')).review(_archive(), ())
        assert proposal.action == "no_op"
        assert proposal.reason == "one-off"

    asyncio.run(scenario())


def test_coding_reviewer_proposal_passes_runtime_quality_gate_and_is_persisted() -> None:
    async def scenario() -> None:
        provider = Provider(
            json.dumps(
                {
                    "action": "create",
                    "evidence_entry_ids": ["tool-ok"],
                    "markdown": """---
name: pytest-check
description: Reusable pytest verification
triggers: test, pytest
version: 1
status: active
---
适用范围：测试验证。
前置条件：安装依赖。
步骤：运行测试。
验证：检查测试通过。
失败/回滚：记录失败并停止。
资源使用说明：无附加资源。""",
                }
            )
        )
        store = InMemorySkillStore()
        archive, _ = await store.append_archive(_archive())
        job = await store.create_job(archive, 0)
        claimed = await store.claim_job(1, "lease", 30_000)
        assert claimed is not None and claimed.job_id == job.job_id

        await SkillEvolutionRuntime(store, CodingSkillReviewer(provider))._run_job(claimed)  # noqa: SLF001

        skills = await store.search(SkillScope("repo"), "pytest", 10)
        assert len(skills) == 1 and skills[0].name == "pytest-check"
        status = await store.get_job(job.job_id)
        assert status is not None and status.status == "completed"

    asyncio.run(scenario())
