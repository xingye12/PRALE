import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.subagents import (
    SubagentBusy,
    SubagentConfig,
    SubagentDefinition,
    SubagentIdempotencyConflict,
    SubagentRequest,
    index,
)
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.runtime.subagents import MappingProviderResolver, create_subagent_tools
from agent_harness.runtime.tools import ToolExecutionResult
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.sqlite import SQLiteStorage


class Provider:
    model = "test"

    def __init__(self):
        self.requests = []
        self.release = None

    async def generate(self, request):
        self.requests.append(request)
        if request.lane.startswith("__subagent__/"):
            if self.release is not None:
                await self.release.wait()
            return AssistantResult("child answer", {"output_tokens": 2})
        if len([r for r in self.requests if r.lane == "main"]) == 1:
            return AssistantResult(
                "",
                {},
                tool_calls=(
                    ToolCall(
                        "delegate",
                        "subagent",
                        {"prompt": "investigate", "description": "investigate code", "subagent_type": "explore"},
                        parallel=True,
                    ),
                ),
            )
        return AssistantResult("parent answer", {})


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
def test_frontend_control_is_durable_and_child_context_is_independent(tmp_path, backend):
    async def scenario():
        storage = MemoryStorage() if backend == "memory" else SQLiteStorage(tmp_path / "session.sqlite")
        provider = Provider()
        harness = await Harness.open(
            "test",
            storage,
            tools=create_subagent_tools(),
            subagent_config=SubagentConfig(enabled=True, max_running=1),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        observations = []
        harness.subscribe(observations.append)
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("private parent history")
            result = await asyncio.wait_for(lane.drive(provider), 3)
            assert result.status == "completed"
            runs = await harness.list_subagent_runs("main")
            assert len(runs) == 1
            assert runs[0].result.answer == "child answer"
            started = next(e for e in observations if e.type == "subagent_started")
            terminal = next(e for e in observations if e.type == "subagent_terminal")
            assert started.data["queued_ms"] >= 0
            assert terminal.data["status"] == "completed"
            child_requests = [r for r in provider.requests if r.lane != "main"]
            assert "private parent history" not in str(child_requests[0].messages)
            assert child_requests[0].messages[0]["role"] == "system"
            assert not any(t.name.startswith("subagent") for t in child_requests[0].tools)
            assert all(s.outcome != "pending" for s in await storage.list_spans(parent.operation_id))
            assert all(s.outcome != "pending" for s in await storage.list_spans(runs[0].operation_id))
            with pytest.raises(Exception):
                await harness.acquire_lane(child_requests[0].lane)
        finally:
            await harness.close()
            if backend == "sqlite":
                storage.close()

    asyncio.run(scenario())


def test_background_idempotency_wait_disconnect_continue_and_notification():
    async def scenario():
        storage, provider = MemoryStorage(), Provider()
        provider.release = asyncio.Event()
        harness = await Harness.open(
            "test",
            storage,
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            request = SubagentRequest("investigate", "investigate", run_in_background=True)
            run = await harness.start_subagent("main", parent.operation_id, request, "key")
            same = await harness.start_subagent("main", parent.operation_id, request, "key")
            assert same == run
            with pytest.raises(SubagentIdempotencyConflict):
                await harness.start_subagent("main", parent.operation_id, SubagentRequest("other", "other"), "key")
            assert (await harness.wait_subagent_run(run.run_id, 0)).retrieval_status == "timeout"
            waiter = asyncio.create_task(harness.wait_subagent_run(run.run_id, 30000))
            await asyncio.sleep(0.02)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            provider.release.set()
            done = await harness.wait_subagent_run(run.run_id, 1000)
            assert done.snapshot.result.answer == "child answer"
            await harness.recover_subagents()
            await harness.recover_subagents()
            from agent_harness.domain.values import lane_inbox

            assert len(await storage.read_list(lane_inbox("main"))) == 1
            continued = await harness.continue_subagent(
                run.agent_id, "main", parent.operation_id, "follow up", True, "continue-key"
            )
            assert continued.run_id != run.run_id
            assert (await harness.wait_subagent_run(continued.run_id, 1000)).retrieval_status == "ready"
            assert (await harness.get_subagent_run(run.run_id)).result.answer == "child answer"
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_parent_abort_cascades_and_stop_is_idempotent():
    async def scenario():
        provider = Provider()
        provider.release = asyncio.Event()
        harness = await Harness.open(
            "test",
            MemoryStorage(),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            child = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task", run_in_background=True), "key"
            )
            await asyncio.sleep(0.02)
            await lane.request_abort()
            assert (await harness.wait_subagent_run(child.run_id, 1000)).snapshot.result.status == "unknown"
            assert (await harness.stop_subagent_run(child.run_id)).status == "already_terminal"
        finally:
            await harness.close()

    asyncio.run(scenario())


class Echo:
    name = "echo"
    description = "echo"
    input_schema = {"type": "object"}
    replay_policy = "safe"

    async def execute(self, arguments):
        return ToolExecutionResult("echo result")


def test_turn_budget_counts_generation_not_tool_and_preserves_usage():
    async def scenario():
        class LoopProvider:
            def __init__(self):
                self.calls = 0

            async def generate(self, request):
                self.calls += 1
                return AssistantResult("working", {"output_tokens": 3}, tool_calls=(ToolCall("echo-call", "echo", {}),))

        storage, provider = MemoryStorage(), LoopProvider()
        harness = await Harness.open(
            "s",
            storage,
            tools=(Echo(),),
            definitions=(SubagentDefinition("limited", "limited", "Do task", max_turns=1),),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            child = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task", "limited"), "key"
            )
            done = await harness.wait_subagent_run(child.run_id, 1000)
            assert done.snapshot.result.error_code == "turn_limit_exceeded"
            assert done.snapshot.result.answer == "working"
            assert provider.calls == 1
            assert len(await storage.list_usage(child.operation_id)) == 1
            assert await storage.list_usage(parent.operation_id) == []
            assert all(s.outcome != "pending" for s in await storage.list_spans(child.operation_id))
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_queued_stop_and_busy_continue_do_not_start_effects():
    async def scenario():
        provider = Provider()
        provider.release = asyncio.Event()
        harness = await Harness.open(
            "s",
            MemoryStorage(),
            subagent_config=SubagentConfig(enabled=True, max_running=1),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            first = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("first", "first"), "first"
            )
            second = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("second", "second"), "second"
            )
            assert (await harness.get_subagent_run(second.run_id)).state == "queued"
            with pytest.raises(SubagentBusy):
                await harness.continue_subagent(
                    first.agent_id, "main", parent.operation_id, "continue", True, "continue"
                )
            assert (await harness.stop_subagent_run(second.run_id)).status == "requested"
            assert (await harness.get_subagent_run(second.run_id)).result.status == "aborted"
            assert (await harness.stop_subagent_run(second.run_id)).status == "already_terminal"
            provider.release.set()
            await harness.wait_subagent_run(first.run_id, 1000)
            assert len(provider.requests) == 1
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_hook_modified_control_parameters_are_revalidated_before_admission():
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
            harness.on_hook("before_tool", lambda e: {**e, "arguments": {**e["arguments"], "parent_lane": "forged"}})
            lane = await harness.acquire_lane("main")
            await lane.prompt("task")
            assert (await lane.drive(provider)).status == "completed"
            assert await harness.list_subagent_runs("main") == ()
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_child_hook_failure_is_terminal_and_background_does_not_drive_idle_parent():
    async def scenario():
        provider, storage = Provider(), MemoryStorage()
        harness = await Harness.open(
            "s",
            storage,
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:

            def fail_child(event):
                if event["lane"].startswith("__subagent__/"):
                    raise ValueError("denied")
                return event

            harness.on_hook("before_drive", fail_child)
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            child = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task", run_in_background=True), "key"
            )
            assert (await harness.wait_subagent_run(child.run_id, 1000)).snapshot.result.status == "declined"
            assert provider.requests == []
            await harness.recover_subagents()
            assert len(await storage.read_list(index("subagent/notification_outbox"))) == 1
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_background_survives_parent_completion_and_notification_is_consumed_once():
    async def scenario():
        class ParentProvider(Provider):
            async def generate(self, request):
                if request.lane == "main":
                    self.requests.append(request)
                    return AssistantResult("done", {})
                return await super().generate(request)

        provider, storage = ParentProvider(), MemoryStorage()
        provider.release = asyncio.Event()
        harness = await Harness.open(
            "s",
            storage,
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("parent task")
            child = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task", run_in_background=True), "key"
            )
            await lane.drive(provider)
            assert (await harness.get_subagent_run(child.run_id)).state != "terminal"
            provider.release.set()
            await harness.wait_subagent_run(child.run_id, 1000)
            await harness.recover_subagents()
            count = len(provider.requests)
            await asyncio.sleep(0.02)
            assert len(provider.requests) == count
            await lane.prompt("next task")
            await lane.drive(provider)
            await lane.prompt("third task")
            await lane.drive(provider)
            entries = await storage.scan_branch((await lane.snapshot()).tip_id)
            notices = [e for e in entries if isinstance(e.payload, dict) and e.payload.get("subagent_notification")]
            assert len(notices) == 1
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_abort_foreground_wait_closes_parent_span_and_pairs_tool_result():
    async def scenario():
        provider, storage = Provider(), MemoryStorage()
        provider.release = asyncio.Event()
        harness = await Harness.open(
            "s",
            storage,
            tools=create_subagent_tools(),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            drive = asyncio.create_task(lane.drive(provider))
            for _ in range(100):
                if any(r.lane.startswith("__subagent__/") for r in provider.requests):
                    break
                await asyncio.sleep(0.005)
            await lane.request_abort()
            assert (await drive).status == "aborted"
            assert all(s.outcome != "pending" for s in await storage.list_spans(parent.operation_id))
            entries = await storage.scan_branch((await lane.snapshot()).tip_id)
            assert entries[-1].payload["role"] == "tool"
            assert entries[-1].payload["tool_call_id"] == "delegate"
            runs = await harness.list_subagent_runs("main")
            assert (await harness.wait_subagent_run(runs[0].run_id, 1000)).snapshot.result.status == "unknown"
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_recovery_and_continuation_keep_original_definition_and_restrict_tools(tmp_path):
    async def scenario():
        provider = Provider()
        storage = SQLiteStorage(tmp_path / "s.sqlite")
        original = SubagentDefinition("custom", "original", "Original frozen instructions", tools=("echo",))
        harness = await Harness.open(
            "s",
            storage,
            tools=(Echo(),),
            definitions=(original,),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        lane = await harness.acquire_lane("main")
        parent = await lane.prompt("task")
        child = await harness.start_subagent(
            "main", parent.operation_id, SubagentRequest("task", "task", "custom"), "key"
        )
        await harness.wait_subagent_run(child.run_id, 1000)
        await harness.close()
        storage.close()
        storage = SQLiteStorage(tmp_path / "s.sqlite")
        changed = SubagentDefinition("custom", "changed", "New instructions", tools=("read",))
        harness = await Harness.open(
            "s",
            storage,
            definitions=(changed,),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            continued = await harness.continue_subagent(
                child.agent_id, "main", parent.operation_id, "more", False, "continue"
            )
            await harness.wait_subagent_run(continued.run_id, 1000)
            requests = [r for r in provider.requests if r.lane.startswith("__subagent__/")]
            assert requests[-1].messages[0]["content"] == "Original frozen instructions"
            assert requests[-1].tools == ()
            assert len(await harness.list_subagent_runs("main")) == 2
        finally:
            await harness.close()
            storage.close()

    asyncio.run(scenario())


def test_incomplete_notification_does_not_block_another_run():
    async def scenario():
        from agent_harness.domain.subagents import value
        from agent_harness.domain.values import lane_inbox
        from agent_harness.storage.protocol import SetValue

        provider, storage = Provider(), MemoryStorage()
        harness = await Harness.open(
            "s",
            storage,
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        deliver = harness._subagents.deliver_notifications

        async def defer():
            return ()

        harness._subagents.deliver_notifications = defer
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            children = [
                await harness.start_subagent(
                    "main", parent.operation_id, SubagentRequest("task", "task", run_in_background=True), str(i)
                )
                for i in range(2)
            ]
            for child in children:
                await harness.wait_subagent_run(child.run_id, 1000)
            await storage.commit([SetValue(value(f"subagent-run/{children[0].run_id}/result"), {"format_version": 99})])
            harness._subagents.deliver_notifications = deliver
            report = await harness.recover_subagents()
            assert report.incomplete == (children[0].run_id,)
            inbox = await storage.read_list(lane_inbox("main"))
            assert len(inbox) == 1 and inbox[0]["run_id"] == children[1].run_id
        finally:
            await harness.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("role", ["explore", "plan"])
def test_readonly_role_override_cannot_add_write_capabilities(role):
    class WriteTool:
        name = "write"
        description = "Write"
        input_schema = {}
        replay_policy = "never"

        async def execute(self, arguments):
            raise AssertionError("readonly role must not write")

    async def scenario():
        storage, provider = MemoryStorage(), Provider()
        harness = await Harness.open(
            "test",
            storage,
            tools=(WriteTool(),),
            definitions=(SubagentDefinition(role, "custom prompt", "Custom readonly task", tools=("*",)),),
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            admission = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("inspect", "inspect", role), "key"
            )
            assert (await harness.wait_subagent_run(admission.run_id, 1000)).retrieval_status == "ready"
            assert not provider.requests[0].tools
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_child_archive_and_telemetry_keep_identity_without_parent_history(tmp_path):
    from agent_harness.domain.memory import MemoryScope
    from agent_harness.domain.skill import SkillScope
    from agent_harness.domain.values import ListAddress
    from agent_harness.memory.runtime import MemoryRuntime
    from agent_harness.runtime.telemetry import GenerationTelemetry, OperationTelemetry
    from agent_harness.skill.runtime import SkillEvolutionRuntime
    from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
    from agent_harness.storage.skill_memory import InMemorySkillStore

    class Collector:
        def __init__(self):
            self.events = []

        def record(self, event):
            self.events.append(event)

    async def scenario():
        storage, provider, collector = MemoryStorage(), Provider(), Collector()
        assets = SQLiteMemoryStore(tmp_path / "assets.sqlite")
        runtime = MemoryRuntime(assets, poll_ms=1)
        skills = SkillEvolutionRuntime(InMemorySkillStore())
        scope = MemoryScope("repository")
        harness = await Harness.open(
            "test",
            storage,
            memory_scope=scope,
            memory_runtime=runtime,
            skill_scope=SkillScope.from_memory_scope(scope),
            skill_runtime=skills,
            telemetry=collector,
            subagent_config=SubagentConfig(enabled=True, max_result_tokens=1),
            provider_resolver=MappingProviderResolver({"test": provider}, "test"),
        )
        try:
            parent = await (await harness.acquire_lane("main")).prompt("private parent content")
            admission = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("inspect", "inspect"), "key"
            )
            ready = await harness.wait_subagent_run(admission.run_id, 1000)
            assert ready.snapshot.result.truncated
            outbox = await storage.read_list(ListAddress("memory/capture_outbox"))
            assert len(outbox) == 1
            assert outbox[0]["subagent"]["run_id"] == admission.run_id
            skill_outbox = await storage.read_list(ListAddress("skill/capture_outbox"))
            assert skill_outbox[0]["subagent"] == outbox[0]["subagent"]
            assert skill_outbox[0]["source_entry_ids"] == outbox[0]["source_entry_ids"]
            await runtime.start()
            for _ in range(100):
                if not await storage.read_list(ListAddress("memory/capture_outbox")):
                    break
                await asyncio.sleep(0.005)
            summaries = await assets.list_l0(scope, None, 10)
            assert len(summaries) == 1
            archive = await assets.read_archive(summaries[0].archive_id)
            assert archive.operation_id == admission.operation_id
            assert "private parent content" not in str(archive.items)
            assert any(item.payload.get("event") == "subagent_run_admitted" for item in archive.items)
            assert any(item.payload.get("content") == "child answer" for item in archive.items)
            facts = [e for e in collector.events if isinstance(e, (GenerationTelemetry, OperationTelemetry))]
            assert facts
            assert all(e.metadata["run_id"] == admission.run_id for e in facts)
            assert all(e.metadata["parent_operation_id"] == parent.operation_id for e in facts)
        finally:
            await harness.close()
            assets.close()

    asyncio.run(scenario())
