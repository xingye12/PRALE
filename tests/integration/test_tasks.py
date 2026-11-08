import asyncio

import pytest

from agent_harness.api import Harness, create_task_tools
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.tasks import TASK_AUDIT
from agent_harness.storage.memory import MemoryStorage


@pytest.mark.parametrize("strategy", ["layered_v1", "tool_prune_summary_v1"])
def test_model_task_controls_and_shared_context(strategy):
    class Provider:
        def __init__(self):
            self.requests = []

        async def generate(self, request):
            self.requests.append(request)
            steps = [
                ("task_create", {"subject": "Implement", "description": "private full description"}),
                ("task_get", {"task_id": "1"}),
                ("task_update", {"task_id": "1", "status": "completed"}),
                ("task_list", {}),
            ]
            n = len(self.requests) - 1
            if n < len(steps):
                name, args = steps[n]
                return AssistantResult("", {}, tool_calls=(ToolCall(str(n), name, args),))
            return AssistantResult("done", {})

    async def scenario():
        store = MemoryStorage()
        h = await Harness.open(
            "s", store, tools=create_task_tools(), context_management=ContextManagementConfig(strategy=strategy)
        )
        provider = Provider()
        lane = await h.acquire_lane("main")
        await lane.prompt("Implement feature")
        result = await lane.drive(provider)
        assert result.status == "completed"
        assert (await h.tasks.get("1")).status == "completed"
        assert len(await store.read_list(TASK_AUDIT)) == 2
        assert "<session_tasks>" in str(provider.requests[1].messages)
        entries = await h._session.context((await lane.snapshot()).tip_id)
        assert "<session_tasks>" not in str(entries)
        other = await h.fork_lane("main", "other")
        await other.prompt("Check work")
        await other.drive(provider)
        assert "<session_tasks>" in str(provider.requests[-1].messages)
        assert all(not e.payload.get("is_error") for e in entries if e.payload.get("role") == "tool")
        await h.close()

    asyncio.run(scenario())


def test_task_permissions_roles_and_sessions():
    from agent_harness.domain.subagents import SubagentRequest
    from agent_harness.runtime.subagents import MappingProviderResolver

    class Provider:
        async def generate(self, request):
            return AssistantResult("done", {})

    async def scenario():
        provider = Provider()
        h = await Harness.open(
            "s",
            MemoryStorage(),
            tools=create_task_tools(),
            provider_resolver=MappingProviderResolver({"p": provider}, "p"),
        )
        await h.tasks.create("shared", "")
        parent = await h.acquire_lane("main")
        op = await parent.prompt("delegate")
        admission = await h.start_subagent(
            "main", op.operation_id, SubagentRequest("inspect", "inspect", subagent_type="explore"), "key"
        )
        await h.wait_subagent_run(admission.run_id)
        # Inspect the registered child lane, the authority used for model tool definitions.
        child = h._subagents._lanes[admission.run_id]
        assert {t.name for t in child.tools.definitions()} == {"task_get", "task_list"}
        await h.close()
        other = await Harness.open("other", MemoryStorage())
        assert (await other.tasks.list())["total"] == 0
        lane = await other.acquire_lane("main")
        assert lane.tools.definitions() == ()
        assert (await other.tasks.create("own", "")).id == "1"
        await other.close()

    asyncio.run(scenario())


def test_overview_is_bounded_and_prioritizes_active_work():
    from agent_harness.domain.context_management import estimate_messages
    from agent_harness.runtime.tasks import task_overview

    async def scenario():
        h = await Harness.open("s", MemoryStorage(), tools=create_task_tools())
        for n in range(80):
            await h.tasks.create(f"task {n}: " + "内容" * 200, "description never injected")
        await h.tasks.update("80", status="in_progress", owner="worker")
        await h.tasks.update("1", add_blocked_by=["2"])
        version, overview = await task_overview(h._session)
        assert version == 82
        assert estimate_messages([overview]) <= 2000
        assert overview["content"].splitlines()[1].startswith("#80 in_progress")
        assert "description never injected" not in overview["content"]
        assert "Omitted" in overview["content"]
        await h.close()

    asyncio.run(scenario())


def test_generation_retry_keeps_overview_and_task_errors_do_not_mutate():
    from agent_harness.runtime.retry import RetryPolicy
    from agent_harness.runtime.tasks import TASK_AUDIT

    async def scenario():
        h = await Harness.open("s", MemoryStorage(), tools=create_task_tools(), retry=RetryPolicy(base_delay_ms=0))
        await h.tasks.create("frozen title", "")
        requests = []

        class Provider:
            async def generate(self, request):
                requests.append(request)
                if len(requests) == 1:
                    await h.tasks.update("1", subject="changed title")
                    raise OSError("retry")
                if len(requests) == 2:
                    assert requests[0].messages == request.messages
                    return AssistantResult(
                        "", {}, tool_calls=(ToolCall("bad", "task_update", {"task_id": "1", "add_blocks": ["1"]}),)
                    )
                return AssistantResult("done", {})

        lane = await h.acquire_lane("main")
        await lane.prompt("work")
        await lane.drive(Provider())
        assert "changed title" in str(requests[-1].messages)
        assert len(await h._session._storage.read_list(TASK_AUDIT)) == 2
        entries = await h._session.context((await lane.snapshot()).tip_id)
        result = next(e.payload for e in entries if e.payload.get("role") == "tool")
        assert result["is_error"]
        assert result["content"]["error_code"] == "invalid_task_operation"
        await h.close()

    asyncio.run(scenario())
