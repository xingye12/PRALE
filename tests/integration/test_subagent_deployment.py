import asyncio

import pytest

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.serve import build_application
from agent_harness.api.settings import Settings
from agent_harness.domain.subagents import SubagentCapabilityUnavailable
from agent_harness.runtime.generation import AssistantResult, ToolCall


def environment(tmp_path, **extra):
    return {
        "PRALE_PROJECT_ROOT": str(tmp_path),
        "PRALE_REPOSITORY_ID": "repo",
        "PRALE_API_KEY": "test",
        "PRALE_MEMORY": "off",
        "PRALE_SKILLS": "off",
        **extra,
    }


@pytest.mark.parametrize(
    "extra",
    [
        {"PRALE_SUBAGENTS_ENABLED": "false", "PRALE_TOOLS": "subagent"},
        {"PRALE_SUBAGENTS_ENABLED": "maybe"},
        {"PRALE_SUBAGENTS_ENABLED": "true", "PRALE_SUBAGENT_DIRS": "not json"},
        {"PRALE_SUBAGENTS_ENABLED": "true", "PRALE_SUBAGENT_MAX_RUNNING": "0"},
        {"PRALE_SUBAGENTS_ENABLED": "false", "PRALE_SUBAGENT_DIRS": '["agents"]'},
    ],
)
def test_invalid_subagent_config_is_rejected_before_open(tmp_path, extra):
    with pytest.raises(ProjectConfigError):
        Settings.from_environment(environment(tmp_path, **extra))


def test_launcher_registers_only_explicit_control_tools(tmp_path):
    async def scenario():
        settings = Settings.from_environment(
            environment(tmp_path, PRALE_SUBAGENTS_ENABLED="true", PRALE_TOOLS="subagent,subagent_output")
        )
        deployment = build_application(settings)
        try:
            supervisor = deployment.web.supervisor
            session = await supervisor.create_session("s")
            lane = await supervisor.lane(session.session_id, "main")
            assert {t.name for t in lane.tools.definitions()} == {"subagent", "subagent_output"}
            assert (await supervisor.subagent_counts())["active"] == 0
        finally:
            await deployment.web.aclose()
            for store in deployment.stores:
                store.close()

    asyncio.run(scenario())


def test_unknown_model_in_markdown_fails_before_databases_open(tmp_path):
    pytest.importorskip("yaml")
    agents = tmp_path / "agents"
    agents.mkdir()
    (agents / "agent.md").write_text("---\nname: review\ndescription: review\nmodel: absent\n---\nReview")
    settings = Settings.from_environment(
        environment(tmp_path, PRALE_SUBAGENTS_ENABLED="true", PRALE_SUBAGENT_DIRS='["agents"]')
    )
    with pytest.raises(SubagentCapabilityUnavailable):
        build_application(settings)
    assert not settings.catalog_db.exists()


def test_all_control_tools_follow_one_durable_identity(tmp_path):
    from agent_harness.api.harness import Harness
    from agent_harness.domain.subagents import SubagentConfig
    from agent_harness.runtime.subagents import MappingProviderResolver, create_subagent_tools
    from agent_harness.storage.memory import MemoryStorage

    class Provider:
        def __init__(self):
            self.parent_calls = 0

        async def generate(self, request):
            if request.lane != "main":
                return AssistantResult("child", {})
            self.parent_calls += 1
            tools = [m for m in request.messages if isinstance(m, dict) and m.get("role") == "tool"]
            if self.parent_calls == 1:
                call = ToolCall(
                    "start", "subagent", {"prompt": "task", "description": "task", "run_in_background": True}
                )
            elif self.parent_calls == 2:
                call = ToolCall("list", "subagent_list", {})
            elif self.parent_calls == 3:
                run = tools[0]["content"]["run_id"]
                call = ToolCall("output", "subagent_output", {"run_id": run, "timeout_ms": 1000})
            elif self.parent_calls == 4:
                agent = tools[0]["content"]["agent_id"]
                call = ToolCall("continue", "subagent_continue", {"agent_id": agent, "prompt": "more"})
            elif self.parent_calls == 5:
                run = tools[0]["content"]["run_id"]
                call = ToolCall("stop", "subagent_stop", {"run_id": run})
            else:
                return AssistantResult("parent done", {})
            return AssistantResult("", {}, tool_calls=(call,))

    async def scenario():
        provider = Provider()
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            tools=create_subagent_tools(),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            await lane.prompt("task")
            assert (await asyncio.wait_for(lane.drive(provider), 3)).status == "completed"
            runs = await harness.list_subagent_runs("main")
            assert len(runs) == 2 and runs[0].agent_id == runs[1].agent_id
            assert all(r.result.answer == "child" for r in runs)
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_subagents_default_on_and_explicit_tool_allowlist_is_preserved(tmp_path):
    from agent_harness.domain.subagents import CONTROL_NAMES, SubagentConfig

    assert SubagentConfig().enabled
    settings = Settings.from_environment(environment(tmp_path))
    assert settings.subagent_config.enabled
    assert settings.tools == CONTROL_NAMES
    assert Settings.from_environment(environment(tmp_path, PRALE_TOOLS="")).tools == ()
    assert Settings.from_environment(environment(tmp_path, PRALE_TOOLS="read")).tools == ("read",)
    disabled = Settings.from_environment(environment(tmp_path, PRALE_SUBAGENTS_ENABLED="false"))
    assert not disabled.subagent_config.enabled
    assert disabled.tools == ()


def test_default_deployment_registers_all_subagent_tools(tmp_path):
    from agent_harness.domain.subagents import CONTROL_NAMES

    async def scenario():
        deployment = build_application(Settings.from_environment(environment(tmp_path)))
        try:
            session = await deployment.web.supervisor.create_session("s")
            lane = await deployment.web.supervisor.lane(session.session_id, "main")
            assert {t.name for t in lane.tools.definitions()} == set(CONTROL_NAMES)
        finally:
            await deployment.web.aclose()
            for store in deployment.stores:
                store.close()

    asyncio.run(scenario())


def test_default_library_without_control_tools_keeps_provider_per_drive():
    from agent_harness.api.harness import Harness
    from agent_harness.storage.memory import MemoryStorage

    class Provider:
        async def generate(self, request):
            return AssistantResult("done", {})

    async def scenario():
        harness = await Harness.open("s", MemoryStorage())
        try:
            lane = await harness.acquire_lane("main")
            for _ in range(2):
                await lane.prompt("task")
                assert (await lane.drive(Provider())).status == "completed"
        finally:
            await harness.close()

    asyncio.run(scenario())
