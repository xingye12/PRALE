"""Durable workspace orchestration, independent of Operation execution state."""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from typing import TYPE_CHECKING, Any, Protocol, TypeVar

if TYPE_CHECKING:
    from agent_harness.runtime.subagents import SubagentRuntime

from agent_harness.domain.effects import EffectSpan
from agent_harness.domain.session import SessionMutator
from agent_harness.domain.subagents import SubagentCapabilityUnavailable, SubagentWorkspace, record, value
from agent_harness.domain.workspaces import WorkspaceManager
from agent_harness.runtime.tools import AgentTool, RuntimeControlTool
from agent_harness.storage.protocol import InsertSpan, SettleSpan, SetValue, Write

T = TypeVar("T")


class WorkspaceToolFactory(Protocol):
    def validate(self, tools: tuple[AgentTool | RuntimeControlTool, ...]) -> None: ...
    def bind(
        self, workspace: SubagentWorkspace, tools: tuple[AgentTool | RuntimeControlTool, ...]
    ) -> tuple[AgentTool | RuntimeControlTool, ...]: ...


class WorkspaceRuntime:
    def __init__(
        self, runtime: "SubagentRuntime", manager: WorkspaceManager | None, factory: WorkspaceToolFactory | None
    ) -> None:
        self.runtime = runtime
        self.manager, self.factory = manager, factory
        self.locks: dict[str, asyncio.Lock] = {}

    async def read(self, agent_id: str) -> object:
        return await self.runtime.session.get_value(value(f"subagent/{agent_id}/workspace"))

    async def save(self, agent_id: str, data: dict[str, Any], writes: list[Write] | None = None) -> None:
        async def settle(mutator: SessionMutator) -> None:
            await mutator.commit([SetValue(value(f"subagent/{agent_id}/workspace"), data), *(writes or [])])

        await self.runtime.session.mutate(settle)

    async def effect(
        self,
        agent_id: str,
        run: dict[str, Any],
        data: dict[str, Any],
        phase: str,
        action: Callable[[], Awaitable[T]],
    ) -> tuple[dict[str, Any], T, SettleSpan]:
        parent = self.runtime._factory(run["parent_lane"], tuple(self.runtime._tools.values()))
        previous_span = data.get("span_id")
        span = parent.new_id()
        attempts = {**data.get("attempts", {})}
        attempts[phase] = attempts.get(phase, 0) + 1
        data = {**data, "state": phase, "span_id": span, "error": None, "attempts": attempts}
        writes: list[Write] = []
        if previous_span is not None:
            # A prior process may have finished the effect. Reconcile via a new
            # attempt rather than inventing a duration across process downtime.
            writes.append(SettleSpan(previous_span, parent.now_ms(), "unknown", "interrupted"))
        writes.append(
            InsertSpan(
                EffectSpan(
                    span,
                    run["operation_id"],
                    "workspace:" + phase,
                    "tool",
                    "__subagent__/" + agent_id,
                    attempts[phase],
                    parent.now_ms(),
                )
            )
        )
        await self.save(agent_id, data, writes)
        try:
            result = await action()
        except Exception as error:
            data = {**data, "error": f"{type(error).__name__}: {error}"}
            data["span_id"] = None
            await self.save(agent_id, data, [SettleSpan(span, parent.now_ms(), "failed", "tool_error")])
            raise
        return data, result, SettleSpan(span, parent.now_ms(), "completed")

    @staticmethod
    def dto(data: dict[str, Any]) -> SubagentWorkspace:
        return SubagentWorkspace(**{k: data[k] for k in SubagentWorkspace.__dataclass_fields__})

    async def freeze(self, run: dict[str, Any]) -> None:
        agent_id = run["agent_id"]
        async with self.locks.setdefault(agent_id, asyncio.Lock()):
            raw = await self.read(agent_id)
            if raw is None:
                return
            data = record(raw)
            if data["state"] == "pending" or (data["state"] == "removed" and not data["base_commit"]):
                if self.manager is None or self.factory is None:
                    raise SubagentCapabilityUnavailable("workspace adapters unavailable")
                try:
                    workspace = await self.manager.plan(self.runtime.session.id, agent_id)
                except Exception as error:
                    await self.save(agent_id, {**data, "error": f"{type(error).__name__}: {error}"})
                    raise
                await self.save(agent_id, {"format_version": 1, **asdict(workspace), "state": "planned"})

    async def ready(self, run: dict[str, Any]) -> SubagentWorkspace | None:
        await self.freeze(run)
        agent_id = run["agent_id"]
        async with self.locks.setdefault(agent_id, asyncio.Lock()):
            raw = await self.read(agent_id)
            if raw is None:
                return None
            data = record(raw)
            manager = self.manager
            if manager is None:
                raise SubagentCapabilityUnavailable("workspace manager unavailable")
            if data["state"] == "removed":
                data = {**data, "state": "planned", "error": None, "span_id": None}
                await self.save(agent_id, data)
            workspace = self.dto(data)
            if data["state"] in ("planned", "creating"):
                data, _, span = await self.effect(agent_id, run, data, "creating", lambda: manager.create(workspace))
                data = {**data, "state": "ready", "span_id": None, "error": None}
                await self.save(agent_id, data, [span])
            elif data["state"] in ("ready", "retained") or (
                data["state"] == "checking" and data.get("checking_for") == "binding"
            ):
                # Validate ownership and existence; never recreate a retained workspace.
                data = {**data, "checking_for": "binding"}
                data, _, span = await self.effect(
                    agent_id, run, data, "checking", lambda: manager.has_changes(workspace)
                )
                data = {**data, "state": "ready", "error": None, "span_id": None, "checking_for": None}
                await self.save(agent_id, data, [span])
            else:
                raise RuntimeError("workspace finalization is incomplete")
            return self.dto(data)

    async def finish(self, run: dict[str, Any]) -> None:
        agent_id = run["agent_id"]
        async with self.locks.setdefault(agent_id, asyncio.Lock()):
            raw = await self.read(agent_id)
            if raw is None:
                return
            data = record(raw)
            result_key = value(f"subagent-run/{run['run_id']}/result")
            result = record(await self.runtime.session.get_value(result_key))
            if result.get("workspace") is not None and not data.get("error"):
                return
            manager = self.manager
            if manager is None:
                raise SubagentCapabilityUnavailable("workspace manager unavailable")
            try:
                if data["state"] in ("pending", "planned"):
                    data = {**data, "state": "removed"}  # queued cancellation: no resources exist
                elif data["state"] not in ("removed", "retained"):
                    workspace = self.dto(data)
                    if data["state"] in ("planned", "creating"):
                        data, _, span = await self.effect(
                            agent_id, run, data, "creating", lambda: manager.create(workspace)
                        )
                        data = {**data, "state": "ready", "span_id": None, "error": None}
                        await self.save(agent_id, data, [span])
                    if data["state"] == "removing":
                        data, _, span = await self.effect(
                            agent_id, run, data, "removing", lambda: manager.remove(workspace)
                        )
                        data = {**data, "state": "removed", "span_id": None, "error": None}
                        await self.save(agent_id, data, [span])
                    else:
                        data, changed, span = await self.effect(
                            agent_id, run, data, "checking", lambda: manager.has_changes(workspace)
                        )
                        data = {**data, "state": "retained" if changed else "checked", "span_id": None}
                        await self.save(agent_id, data, [span])
                        if not changed:
                            workspace = self.dto(data)
                            data, _, span = await self.effect(
                                agent_id, run, data, "removing", lambda: manager.remove(workspace)
                            )
                            data = {**data, "state": "removed", "span_id": None, "error": None}
                            await self.save(agent_id, data, [span])
            except Exception as error:
                # Keep the successful answer. Unknown ownership/state is never deleted.
                data = {**record(await self.read(agent_id)), "error": f"{type(error).__name__}: {error}"}
            workspace = self.dto(data)
            await self.save(agent_id, data, [SetValue(result_key, {**result, "workspace": asdict(workspace)})])
