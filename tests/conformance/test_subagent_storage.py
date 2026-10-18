import asyncio

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.subagents import (
    IncompleteSubagentState,
    SubagentCapacityExceeded,
    SubagentConfig,
    SubagentOwnershipError,
    SubagentRequest,
    SubagentsDisabled,
    value,
)
from agent_harness.runtime.generation import AssistantResult
from agent_harness.runtime.subagents import MappingProviderResolver
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.protocol import SetValue
from agent_harness.storage.sqlite import SQLiteStorage


class BlockingProvider:
    async def generate(self, request):
        await asyncio.Event().wait()
        return AssistantResult("", {})


@pytest.fixture(params=["memory", "sqlite"])
def storage(request, tmp_path):
    result = MemoryStorage() if request.param == "memory" else SQLiteStorage(tmp_path / "s.sqlite")
    yield result
    if request.param == "sqlite":
        result.close()


def test_admission_rollback_never_leaves_half_a_child(storage):
    async def scenario():
        harness = await Harness.open(
            "s",
            storage,
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": BlockingProvider()}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            commit = storage.commit

            async def reject(writes):
                if any(isinstance(w, SetValue) and w.address.key.startswith("subagent-run/") for w in writes):
                    raise OSError("commit failed")
                return await commit(writes)

            storage.commit = reject
            with pytest.raises(OSError):
                await harness.start_subagent("main", parent.operation_id, SubagentRequest("task", "task"), "key")
            storage.commit = commit
            assert await harness.list_subagent_runs("main") == ()
            admission = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task"), "key"
            )
            assert len(await harness.list_subagent_runs("main")) == 1
            await harness.stop_subagent_run(admission.run_id)
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_capacity_and_owner_checks_are_atomic(storage):
    async def scenario():
        harness = await Harness.open(
            "s",
            storage,
            subagent_config=SubagentConfig(enabled=True, max_nonterminal=1),
            provider_resolver=MappingProviderResolver({"test": BlockingProvider()}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            admission = await harness.start_subagent(
                "main", parent.operation_id, SubagentRequest("task", "task"), "key"
            )
            with pytest.raises(SubagentCapacityExceeded):
                await harness.start_subagent("main", parent.operation_id, SubagentRequest("task", "task"), "other-key")
            await harness.stop_subagent_run(admission.run_id)
            other_parent = await (await harness.acquire_lane("other")).prompt("task")
            with pytest.raises(SubagentOwnershipError):
                await harness.continue_subagent(
                    admission.agent_id, "other", other_parent.operation_id, "task", True, "key"
                )
            assert len(await harness.list_subagent_runs("main")) == 1
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_corrupted_run_is_not_repaired_from_operation_projection(storage):
    async def scenario():
        harness = await Harness.open(
            "s",
            storage,
            subagent_config=SubagentConfig(enabled=True),
            provider_resolver=MappingProviderResolver({"test": BlockingProvider()}, "test"),
        )
        try:
            lane = await harness.acquire_lane("main")
            parent = await lane.prompt("task")
            child = await harness.start_subagent("main", parent.operation_id, SubagentRequest("task", "task"), "key")
            await harness.stop_subagent_run(child.run_id)
            await storage.commit([SetValue(value(f"subagent-run/{child.run_id}/result"), {"format_version": 99})])
            with pytest.raises(IncompleteSubagentState):
                await harness.get_subagent_run(child.run_id)
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_subagents_disabled_does_not_change_empty_session(storage):
    async def scenario():
        harness = await Harness.open("s", storage, subagent_config=SubagentConfig(enabled=False))
        parent = await (await harness.acquire_lane("main")).prompt("task")
        with pytest.raises(SubagentsDisabled):
            await harness.start_subagent("main", parent.operation_id, SubagentRequest("task", "task"), "key")
        assert await harness.list_subagent_runs("main") == ()
        await harness.close()

    asyncio.run(scenario())


def test_workspace_admission_is_atomic_and_required(storage):
    from agent_harness.integrations.workspaces import LocalWorkspaceToolFactory

    class Manager:
        async def plan(self, *_):
            raise AssertionError("admission must not perform Git effects")

    async def scenario():
        harness = await Harness.open(
            "s",
            storage,
            provider_resolver=MappingProviderResolver({"test": BlockingProvider()}, "test"),
            workspace_manager=Manager(),
            workspace_tool_factory=LocalWorkspaceToolFactory(),
        )

        async def no_schedule():
            pass

        harness._subagents.schedule = no_schedule
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            original_commit = storage.commit

            async def reject(writes):
                if any(isinstance(w, SetValue) and w.address.key.endswith("/workspace") for w in writes):
                    raise OSError("workspace admission failed")
                await original_commit(writes)

            storage.commit = reject
            request = SubagentRequest("task", "task", isolation="worktree")
            with pytest.raises(OSError):
                await harness.start_subagent("main", parent.operation_id, request, "key")
            storage.commit = original_commit
            assert not await harness.list_subagent_runs("main")
            admitted = await harness.start_subagent("main", parent.operation_id, request, "key")
            assert await harness.start_subagent("main", parent.operation_id, request, "key") == admitted
            snapshot = await harness.get_subagent_run(admitted.run_id)
            assert snapshot.workspace.state == "pending"

            async def corrupt(mutator):
                await mutator.commit([SetValue(value(f"subagent/{admitted.agent_id}/workspace"), None)])

            await harness._session.mutate(corrupt)
            with pytest.raises(IncompleteSubagentState):
                await harness.get_subagent_run(admitted.run_id)
        finally:
            await harness.close()

    asyncio.run(scenario())


def test_legacy_shared_request_and_definition_remain_idempotent(storage):
    from agent_harness.runtime.subagents import digest

    async def scenario():
        harness = await Harness.open(
            "s", storage, provider_resolver=MappingProviderResolver({"test": BlockingProvider()}, "test")
        )

        async def no_schedule():
            pass

        harness._subagents.schedule = no_schedule
        try:
            parent = await (await harness.acquire_lane("main")).prompt("task")
            request = SubagentRequest("task", "task")
            admitted = await harness.start_subagent("main", parent.operation_id, request, "key")
            address = value("subagent/request/" + digest(["s", "main", parent.operation_id, "key"]))

            async def legacy(mutator):
                from dataclasses import asdict

                prior = await mutator.get_value(address)
                fields = asdict(request)
                fields.pop("isolation")
                prior["request_hash"] = digest({"request": fields, "agent_id": None})
                meta_address = value(f"subagent/{admitted.agent_id}/meta")
                meta = await mutator.get_value(meta_address)
                meta.pop("isolation")
                meta["definition"].pop("isolation")
                meta["definition_hash"] = digest(meta["definition"])
                await mutator.commit([SetValue(address, prior), SetValue(meta_address, meta)])

            await harness._session.mutate(legacy)
            assert await harness.start_subagent("main", parent.operation_id, request, "key") == admitted
            assert (await harness.get_subagent_run(admitted.run_id)).workspace is None
        finally:
            await harness.close()

    asyncio.run(scenario())
