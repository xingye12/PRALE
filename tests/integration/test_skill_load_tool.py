import asyncio

from agent_harness.api.harness import Harness
from agent_harness.domain.skill import SkillFile, SkillProposal, SkillScope
from agent_harness.integrations.skill_tools import SkillLoadTool
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.skill_sqlite import SQLiteSkillStore


def _proposal() -> SkillProposal:
    return SkillProposal(
        "create",
        evidence_entry_ids=("tool-result",),
        files=(SkillFile("template.txt", b"deploy template"),),
        markdown="""---
name: Deploy
description: Reusable deployment verification procedure
triggers: deploy, release
version: 1
status: active
---
适用范围与不适用范围：已验证的服务发布。
前置条件：有已批准的发布包。
步骤：执行部署并记录结果。
验证：检查健康端点和回滚指标。
失败/回滚处理：停止发布并回滚到上一版本。
资源使用说明：使用附带的模板。
""",
    )


class SkillToolProvider:
    def __init__(self, skill_id: str) -> None:
        self._skill_id = skill_id
        self.requests: list[GenerationRequest] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        if len(self.requests) == 1:
            return AssistantResult(
                content="",
                usage={},
                tool_calls=(ToolCall("skill-call", "skill_load", {"skill_id": self._skill_id, "version": 1}),),
            )
        return AssistantResult(content="loaded", usage={})


def test_skill_load_requires_an_enabled_exact_version_in_its_own_scope() -> None:
    async def scenario() -> None:
        store = SQLiteSkillStore(":memory:")
        owner, other = SkillScope("repo-a"), SkillScope("repo-b")
        asset = await store.create(owner, _proposal(), 1)
        tool = SkillLoadTool(store, owner)

        disabled = await tool.execute({"skill_id": asset.skill_id, "version": 1})
        assert disabled.is_error
        assert disabled.content == "skill version is not available in the current repository scope"

        assert await store.set_state(owner, asset.skill_id, "active")
        loaded = await tool.execute({"skill_id": asset.skill_id, "version": 1})
        assert not loaded.is_error
        assert isinstance(loaded.content, dict)
        skill = loaded.content["skill"]
        assert isinstance(skill, dict)
        assert skill["skill_id"] == asset.skill_id
        assert skill["version"] == 1
        assert skill["markdown"] == _proposal().markdown
        assert isinstance(skill["manifest"], str)
        assert skill["files"] == [
            {
                "path": "template.txt",
                "mime_type": "text/plain",
                "encoding": "utf-8",
                "content": "deploy template",
                "sha256": SkillFile("template.txt", b"deploy template").content_hash,
            }
        ]
        updated = await store.update(
            owner,
            SkillProposal(
                "update",
                skill_id=asset.skill_id,
                expected_version=1,
                evidence_entry_ids=("tool-result",),
                markdown=_proposal().markdown.replace("version: 1", "version: 2").replace(
                    "deployment verification", "deployment rollback"
                ),
            ),
            2,
        )
        assert updated.current_version == 2
        frozen_v1 = await tool.execute({"skill_id": asset.skill_id, "version": 1})
        assert isinstance(frozen_v1.content, dict)
        assert frozen_v1.content["skill"]["version"] == 1
        assert frozen_v1.content["skill"]["markdown"] == _proposal().markdown
        assert (await SkillLoadTool(store, other).execute({"skill_id": asset.skill_id, "version": 1})).is_error
        assert (await tool.execute({"skill_id": asset.skill_id, "version": 3})).is_error
        assert (await tool.execute({"skill_id": asset.skill_id})).is_error
        store.close()

    asyncio.run(scenario())


def test_skill_load_tool_result_enters_the_next_model_request() -> None:
    async def scenario() -> None:
        store = SQLiteSkillStore(":memory:")
        scope = SkillScope("repo-a")
        asset = await store.create(scope, _proposal(), 1)
        assert await store.set_state(scope, asset.skill_id, "active")
        provider = SkillToolProvider(asset.skill_id)
        harness = await Harness.open("session-1", MemoryStorage(), tools=(SkillLoadTool(store, scope),))
        lane = await harness.acquire_lane("main")
        await lane.prompt("deploy this", operation_id="op-1")

        result = await lane.drive(provider)

        assert result.status == "completed"
        assert provider.requests[0].tools[0].name == "skill_load"
        tool_message = provider.requests[1].messages[-1]
        assert tool_message["role"] == "tool"
        assert tool_message["tool_call_id"] == "skill-call"
        assert tool_message["content"]["skill"]["markdown"] == _proposal().markdown
        assert tool_message["content"]["skill"]["files"][0]["content"] == "deploy template"
        store.close()

    asyncio.run(scenario())
