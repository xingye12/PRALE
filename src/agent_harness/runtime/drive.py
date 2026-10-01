"""Durable Agent loop, retry handling, and interruption recovery."""

import asyncio
import time
from collections.abc import Mapping, Sequence

from agent_harness.api.errors import ProviderNotConfigured, UnknownTarget
from agent_harness.api.models import OperationResult
from agent_harness.domain.compaction import select_compaction_window
from agent_harness.domain.context import project_messages
from agent_harness.domain.effects import EffectKind, EffectOutcome, EffectSpan, ErrorClass
from agent_harness.domain.entries import JsonValue, NewEntry
from agent_harness.domain.operations import ActiveOperation, OperationState
from agent_harness.domain.session import SessionMutator
from agent_harness.domain.types import OperationStatus
from agent_harness.domain.values import (
    lane_inbox,
    lane_state,
    lane_tip,
    operation_lease,
    operation_result,
    operation_state,
)
from agent_harness.runtime.generation import AssistantResult, ChatProvider, GenerationDelta, GenerationRequest, ToolCall
from agent_harness.runtime.lane import Lane
from agent_harness.runtime.telemetry import (
    EffectStatus,
    GenerationTelemetry,
    OperationTelemetry,
    TelemetryEvent,
    ToolTelemetry,
    publish,
)
from agent_harness.storage.protocol import (
    ClearList,
    DeleteValue,
    InsertEntry,
    InsertSpan,
    InsertUsage,
    SettleSpan,
    SetValue,
    UsageRow,
    Write,
)

_TERMINAL_OUTCOME: dict[OperationStatus, EffectOutcome] = {
    "completed": "completed",
    "declined": "aborted",
    "aborted": "aborted",
    "failed": "failed",
    "unknown": "unknown",
}


def _tool_outcome(result: dict[str, object]) -> tuple[EffectOutcome, ErrorClass | None]:
    if result.get("is_error"):
        return "failed", "tool_error"
    return "completed", None


def _text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _text_length(value: object) -> int:
    return len(value) if isinstance(value, str) else 0


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _required_text(value: object) -> str:
    """Durable tool call state always carries these; recovery of an older
    operation may not, and a telemetry read must not be what fails a turn."""

    return value if isinstance(value, str) else ""


class Drive:
    def __init__(self, lane: Lane, provider: ChatProvider | None) -> None:
        self._lane = lane
        self._provider = provider

    def _open_span(
        self, operation: ActiveOperation, call_id: str, kind: EffectKind, attempt: int
    ) -> tuple[EffectSpan, InsertSpan]:
        """Reserve the durable record of one effect attempt.

        The caller commits it in the same transaction as the intent that
        authorizes the effect, so a crash can never leave an effect whose
        attempt was never recorded.
        """

        span = EffectSpan(
            span_id=self._lane.new_id(),
            operation_id=operation.meta.operation_id,
            call_id=call_id,
            kind=kind,
            lane=self._lane.name,
            attempt=attempt,
            started_at=self._lane.now_ms(),
        )
        return span, InsertSpan(span)

    def _settle_span(
        self,
        span_id: object,
        outcome: EffectOutcome,
        error_class: ErrorClass | None = None,
        ended_at: int | None = None,
    ) -> list[Write]:
        """Close one attempt; intents written before spans existed close nothing.

        ``ended_at`` lets a caller settling a span next to an operation result
        or a published fact use one reading of the clock for all of them, so an
        effect, its span and its trace cannot carry three different end times.
        """

        if not isinstance(span_id, str):
            return []
        return [SettleSpan(span_id, self._lane.now_ms() if ended_at is None else ended_at, outcome, error_class)]

    # Telemetry -----------------------------------------------------------------
    #
    # Each publisher below is called *after* the transaction that settled what it
    # reports, and only reads durable state.  A fact is therefore never announced
    # before the Session can prove it, and an observer can never change a turn.

    def _publish(self, event: TelemetryEvent) -> None:
        publish(self._lane.telemetry, event)

    def _operation_started(self, operation: ActiveOperation) -> OperationTelemetry:
        request = operation.meta.request if isinstance(operation.meta.request, dict) else {}
        # The turn's input contract: the prompt a run was admitted with, the
        # target of a navigation, nothing for a compaction.
        prompt = request.get("prompt")
        target = request.get("target_id")
        admitted: JsonValue = None
        if isinstance(prompt, str):
            admitted = {"prompt": prompt}
        elif isinstance(target, str):
            admitted = {"target_id": target}
        return OperationTelemetry(
            session_id=self._lane.session_id,
            lane=self._lane.name,
            operation_id=operation.meta.operation_id,
            kind=operation.meta.kind,
            phase="started",
            input=admitted,
            started_at=operation.meta.started_at,
        )

    def _operation_terminal(self, result: OperationResult, output: JsonValue) -> OperationTelemetry:
        return OperationTelemetry(
            session_id=self._lane.session_id,
            lane=self._lane.name,
            operation_id=result.operation_id,
            kind=result.kind,
            phase="terminal",
            output=output,
            status=result.status,
            error_code=result.error_code,
            error_message=result.error_message,
            started_at=result.started_at,
            ended_at=result.ended_at,
        )

    def _generation_telemetry(
        self,
        operation: ActiveOperation,
        intent: Mapping[str, object],
        *,
        content: JsonValue,
        usage: Mapping[str, int | float],
        finish_reason: str | None,
        tool_calls: Sequence[ToolCall] = (),
        outcome: EffectStatus,
        error_class: str | None = None,
        error: str | None = None,
        ended_at: int | None = None,
    ) -> GenerationTelemetry:
        attempt = intent.get("attempt", 1)
        output: JsonValue = {"content": content}
        if tool_calls:
            output = {
                "content": content,
                "tool_calls": [{"id": call.id, "name": call.name, "arguments": call.arguments} for call in tool_calls],
            }
        return GenerationTelemetry(
            session_id=self._lane.session_id,
            lane=self._lane.name,
            operation_id=operation.meta.operation_id,
            attempt=attempt if isinstance(attempt, int) else 1,
            model=intent.get("model") if isinstance(intent.get("model"), str) else None,
            input=intent.get("messages") if isinstance(intent.get("messages"), list) else [],
            output=output,
            usage=usage,
            finish_reason=finish_reason,
            outcome=outcome,
            error_class=error_class,
            error=error,
            started_at=_optional_int(intent.get("span_started_at")),
            ended_at=self._lane.now_ms() if ended_at is None else ended_at,
            metadata=self._loadout_metadata(intent),
        )

    def _tool_telemetry(
        self,
        operation: ActiveOperation,
        call: Mapping[str, object],
        result: Mapping[str, object],
        outcome: EffectStatus,
        error_class: ErrorClass | None,
    ) -> ToolTelemetry:
        arguments = call.get("arguments")
        attempt = call.get("attempt")
        return ToolTelemetry(
            session_id=self._lane.session_id,
            lane=self._lane.name,
            operation_id=operation.meta.operation_id,
            tool_call_id=_required_text(call.get("tool_call_id")),
            name=_required_text(call.get("tool_name")),
            attempt=attempt if isinstance(attempt, int) else 1,
            input=arguments
            if isinstance(arguments, (dict, list, str, int, float, bool)) or arguments is None
            else None,
            output=dict(result),
            is_error=bool(result.get("is_error", False)),
            outcome=outcome,
            error_class=error_class,
            started_at=_optional_int(call.get("span_started_at")),
            ended_at=self._lane.now_ms(),
        )

    def _loadout_metadata(self, intent: Mapping[str, object]) -> dict[str, JsonValue]:
        """What a call was given, as identity rather than text.

        A regression usually comes from a change in the retrieved memory or the
        loaded Skills, so their ids, versions and hashes are published even in
        the profiles that never upload their bodies.
        """

        metadata: dict[str, JsonValue] = {}
        bundle_hash = intent.get("memory_bundle_hash")
        if isinstance(bundle_hash, str):
            metadata["memory_bundle_hash"] = bundle_hash
        items = intent.get("memory_items")
        if isinstance(items, list):
            metadata["memory_item_count"] = len(items)
            metadata["memory_items"] = [
                {
                    "id": _text(item.get("id")),
                    "level": _text(item.get("level")),
                    "chars": _text_length(item.get("content")),
                }
                for item in items
                if isinstance(item, dict)
            ]
        listing = intent.get("skill_listing")
        if isinstance(listing, list):
            metadata["skill_listing"] = [
                {
                    "skill_id": _text(item.get("skill_id")),
                    "version": _optional_int(item.get("version")),
                    "name": _text(item.get("name")),
                }
                for item in listing
                if isinstance(item, dict)
            ]
        loadout = intent.get("skill_loadout")
        if isinstance(loadout, list):
            metadata["skill_loadout"] = [
                {
                    "skill_id": _text(item.get("skill_id")),
                    "version": _optional_int(item.get("version")),
                    "content_hash": _text(item.get("content_hash")),
                    "budget": _optional_int(item.get("budget")),
                }
                for item in loadout
                if isinstance(item, dict)
            ]
        return metadata

    async def run(self) -> OperationResult:
        initial = await self._required_operation()
        await self._lane.hooks.run(
            "before_drive",
            {"lane": self._lane.name, "operation_id": initial.meta.operation_id, "kind": initial.meta.kind},
            fail_closed=True,
        )
        await self._lane.emit("operation_started", initial.meta.operation_id, {"kind": initial.meta.kind})
        self._publish(self._operation_started(initial))
        while True:
            operation = await self._required_operation()
            if operation.meta.kind == "navigation":
                return await self._run_navigation(operation)
            if operation.meta.kind == "compaction":
                return await self._run_compaction(operation)
            if operation.meta.kind != "run":
                raise RuntimeError(f"operation kind {operation.meta.kind!r} requires its structural Drive")
            if operation.state.control == "cancel_requested":
                return await self._settle_cancelled(operation)
            match operation.state.at:
                case "starting":
                    await self._transition(operation, OperationState(at="checkpoint", control="running", data={}))
                case "checkpoint":
                    await self._consume_inbox()
                    await self._transition(operation, OperationState(at="assistant.ready", control="running", data={}))
                case "assistant.ready":
                    await self._persist_generation_intent(operation)
                case "assistant.effect_pending":
                    if self._provider is None:
                        raise ProviderNotConfigured("a chat provider is required to execute a generation intent")
                    result = await self._execute_and_settle(operation)
                    if result is not None:
                        return result
                case "assistant.retry_wait":
                    await self._wait_for_retry(operation)
                case "tools":
                    result = await self._run_next_tool(operation)
                    if result is not None:
                        return result
                case "terminal":
                    result = await self._lane.get_result(operation.meta.operation_id)
                    if result is None:
                        raise RuntimeError("terminal operation has no terminal result")
                    return result
                case state:
                    raise RuntimeError(f"cannot drive operation from state {state!r}")

    async def recover(self) -> OperationResult | None:
        operation = await self._lane.active_operation()
        if operation is None:
            return None
        if operation.state.at == "summary.effect_pending":
            return await self._settle_interrupted_compaction(operation)
        if operation.state.at != "assistant.effect_pending":
            if operation.state.at == "tools":
                data = operation.state.data
                if isinstance(data, dict) and isinstance(data.get("calls"), list):
                    pending = next(
                        (
                            call
                            for call in data["calls"]
                            if isinstance(call, dict) and call.get("status") == "effect_pending"
                        ),
                        None,
                    )
                    if pending is not None:
                        tool = self._lane.tools.get(pending["tool_name"])
                        if tool is not None and tool.replay_policy == "safe":
                            return await self.run()
                        await self._settle_tool(
                            operation,
                            pending,
                            {
                                "content": "tool execution interrupted; outcome is unknown",
                                "is_error": True,
                                "terminate": True,
                            },
                            outcome="unknown",
                            error_class="interrupted",
                        )
            return await self.run()
        return await self._settle_interrupted(operation)

    async def _required_operation(self) -> ActiveOperation:
        operation = await self._lane.active_operation()
        if operation is None:
            raise RuntimeError(f"lane {self._lane.name!r} has no active operation")
        return operation

    async def _run_navigation(self, operation: ActiveOperation) -> OperationResult:
        if operation.state.at != "starting":
            raise RuntimeError(f"cannot navigate from state {operation.state.at!r}")
        if not isinstance(operation.meta.request, dict):
            raise RuntimeError("navigation request is invalid")
        target_id = operation.meta.request.get("target_id")
        if target_id is not None and not isinstance(target_id, str):
            raise RuntimeError("navigation target is invalid")
        navigation = await self._lane.hooks.run("before_navigation", {"target_id": target_id})
        if (
            not isinstance(navigation, dict)
            or navigation.get("target_id") is not None
            and not isinstance(navigation.get("target_id"), str)
        ):
            raise RuntimeError("before_navigation must return a string-or-null target")
        target_id = navigation.get("target_id")
        summary = navigation.get("branch_summary")
        if summary is not None and not isinstance(summary, str):
            raise RuntimeError("before_navigation branch_summary must be a string")

        async def navigate(mutator: SessionMutator) -> OperationResult:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("navigation operation changed while Drive was running")
            if target_id is not None and target_id not in await mutator.get_entries([target_id]):
                raise UnknownTarget(f"unknown navigation target {target_id!r}")
            next_tip = target_id
            writes: list[Write] = []
            if summary is not None:
                summary_id = self._lane.new_id()
                writes.append(
                    InsertEntry(
                        NewEntry(
                            summary_id,
                            target_id,
                            "branch_summary",
                            {"summary": summary, "from_tip_id": operation.meta.source_tip_id},
                        )
                    )
                )
                next_tip = summary_id
            result = self._terminal_result(operation, next_tip, "completed")
            writes.extend([SetValue(lane_tip(self._lane.name), next_tip)])
            terminal_ids = (summary_id,) if summary is not None else ()
            writes.extend(
                await self._lane.memory_capture_writes(mutator, result, terminal_ids, branch_tip_id=target_id)
            )
            writes.extend(self._terminal_writes(operation, result, "completed"))
            await mutator.commit(writes)
            return result

        result = await self._lane._session.mutate(navigate)  # noqa: SLF001
        self._publish(self._operation_terminal(result, {"target_id": target_id, "branch_summary": summary}))
        return result

    async def _run_compaction(self, operation: ActiveOperation) -> OperationResult:
        if operation.state.at == "starting":
            context = await self._lane._session.context(await self._lane._session.get_value(lane_tip(self._lane.name)))  # noqa: SLF001
            window = select_compaction_window(context, retain_recent=4)
            retained_message_ids = [entry.id for entry in window.retain if entry.type == "message"]
            hook_context = await self._lane.hooks.run(
                "before_compaction",
                {"messages": project_messages(context), "retained_message_ids": retained_message_ids},
            )
            if not isinstance(hook_context, dict):
                raise RuntimeError("before_compaction must return a messages object")
            if hook_context.get("decline"):
                return await self._settle_terminal_at_tip(operation, "completed")
            custom_summary = hook_context.get("summary")
            if custom_summary is not None:
                if not isinstance(custom_summary, str):
                    raise RuntimeError("before_compaction summary must be a string")
                return await self._settle_compaction_summary(
                    operation, custom_summary, {}, retained_message_ids=retained_message_ids
                )
            if not isinstance(hook_context.get("messages"), list):
                raise RuntimeError("before_compaction must return a messages object")
            entry_id = self._lane.new_id()
            span, span_write = self._open_span(operation, entry_id, "llm", attempt=1)
            intent = {
                "entry_id": entry_id,
                "usage_id": self._lane.new_id(),
                "span_id": span.span_id,
                "messages": hook_context["messages"],
                "retained_message_ids": retained_message_ids,
            }
            await self._transition(operation, OperationState("summary.effect_pending", "running", intent), [span_write])
            operation = await self._required_operation()
        if operation.state.at != "summary.effect_pending":
            raise RuntimeError(f"cannot compact from state {operation.state.at!r}")
        if self._provider is None:
            raise ProviderNotConfigured("a chat provider is required to compact a session")
        data = operation.state.data
        assert isinstance(data, dict) and isinstance(data.get("messages"), list)
        response = await self._provider.generate(
            GenerationRequest(
                self._lane._session.id,  # noqa: SLF001
                self._lane.name,
                operation.meta.operation_id,
                tuple(data["messages"]),
            )
        )
        entry_id = data["entry_id"]
        usage_id = data["usage_id"]
        assert isinstance(entry_id, str) and isinstance(usage_id, str)

        return await self._settle_compaction_summary(operation, response.content, response.usage)

    async def _settle_compaction_summary(
        self,
        operation: ActiveOperation,
        summary: str,
        usage: dict[str, int | float],
        *,
        retained_message_ids: list[str] | None = None,
    ) -> OperationResult:
        data = operation.state.data
        span_id: object = None
        if operation.state.at == "starting":
            entry_id = self._lane.new_id()
            usage_id = self._lane.new_id()
            retained_ids = retained_message_ids or []
        else:
            if not isinstance(data, dict):
                raise RuntimeError("compaction intent is invalid")
            entry_id = data.get("entry_id")
            usage_id = data.get("usage_id")
            span_id = data.get("span_id")
            if not isinstance(entry_id, str) or not isinstance(usage_id, str):
                raise RuntimeError("compaction intent is invalid")
            retained_ids = data.get("retained_message_ids", [])
            if not isinstance(retained_ids, list) or not all(isinstance(entry_id, str) for entry_id in retained_ids):
                raise RuntimeError("compaction retained_message_ids are invalid")

        async def settle(mutator: SessionMutator) -> OperationResult:
            if await mutator.get_value(operation_state(operation.meta.operation_id)) != operation.state:
                raise RuntimeError("compaction intent was already settled")
            parent = await mutator.get_value(lane_tip(self._lane.name))
            result = self._terminal_result(operation, entry_id, "completed")
            await mutator.commit(
                [
                    InsertEntry(
                        NewEntry(
                            entry_id,
                            parent,
                            "compaction",
                            {"summary": summary, "retained_message_ids": retained_ids},
                        )
                    ),
                    InsertUsage(
                        UsageRow(
                            usage_id,
                            usage,
                            entry_id=entry_id,
                            operation_id=operation.meta.operation_id,
                            span_id=span_id if isinstance(span_id, str) else None,
                        )
                    ),
                    *self._settle_span(span_id, "completed"),
                    SetValue(lane_tip(self._lane.name), entry_id),
                    *await self._lane.memory_capture_writes(mutator, result, (entry_id,)),
                    *self._terminal_writes(operation, result, "completed"),
                ]
            )
            return result

        result = await self._lane._session.mutate(settle)  # noqa: SLF001
        self._publish(self._operation_terminal(result, {"summary": summary, "retained_message_ids": retained_ids}))
        return result

    async def _settle_interrupted_compaction(self, operation: ActiveOperation) -> OperationResult:
        data = operation.state.data
        if (
            not isinstance(data, dict)
            or not isinstance(data.get("entry_id"), str)
            or not isinstance(data.get("usage_id"), str)
        ):
            raise RuntimeError("compaction intent is invalid")
        entry_id = data["entry_id"]
        usage_id = data["usage_id"]
        span_id = data.get("span_id")

        async def settle(mutator: SessionMutator) -> OperationResult:
            if await mutator.get_value(operation_state(operation.meta.operation_id)) != operation.state:
                raise RuntimeError("compaction intent was already settled")
            parent = await mutator.get_value(lane_tip(self._lane.name))
            result = self._terminal_result(
                operation,
                entry_id,
                "unknown",
                error_code="interrupted",
                error_message="compaction outcome is unknown after process interruption",
            )
            await mutator.commit(
                [
                    InsertEntry(NewEntry(entry_id, parent, "compaction", {"summary": "[compaction interrupted]"})),
                    InsertUsage(
                        UsageRow(
                            usage_id,
                            {},
                            entry_id=entry_id,
                            operation_id=operation.meta.operation_id,
                            span_id=span_id if isinstance(span_id, str) else None,
                        )
                    ),
                    *self._settle_span(span_id, "unknown", "interrupted"),
                    SetValue(lane_tip(self._lane.name), entry_id),
                    *await self._lane.memory_capture_writes(mutator, result, (entry_id,)),
                    *self._terminal_writes(operation, result, "unknown"),
                ]
            )
            return result

        result = await self._lane._session.mutate(settle)  # noqa: SLF001
        self._publish(self._operation_terminal(result, {"summary_interrupted": True}))
        return result

    async def _consume_inbox(self) -> None:
        async def consume(mutator: SessionMutator) -> None:
            inbox = await mutator.read_list(lane_inbox(self._lane.name))
            if not inbox:
                return
            tip = await mutator.get_value(lane_tip(self._lane.name))
            writes = []
            for item in inbox:
                if (
                    not isinstance(item, dict)
                    or not isinstance(item.get("id"), str)
                    or not isinstance(item.get("prompt"), str)
                ):
                    raise RuntimeError("invalid lane inbox item")
                writes.append(
                    InsertEntry(NewEntry(item["id"], tip, "message", {"role": "user", "content": item["prompt"]}))
                )
                tip = item["id"]
            writes.extend([SetValue(lane_tip(self._lane.name), tip), ClearList(lane_inbox(self._lane.name))])
            await mutator.commit(writes)

        await self._lane._session.mutate(consume)  # noqa: SLF001

    async def _transition(
        self,
        operation: ActiveOperation,
        next_state: OperationState,
        extra: Sequence[Write] = (),
        *,
        trace: bool = True,
    ) -> None:
        async def transition(mutator: SessionMutator) -> None:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("operation state changed while Drive was running")
            writes = [*extra]
            if trace:
                writes.extend(
                    self._lane.trace_writes(
                        operation.meta.operation_id,
                        "state_transition",
                        {
                            "from": operation.state.at,
                            "to": next_state.at,
                            # Intent, retry and tool-call details are part of the durable execution trace.
                            # Lane redaction runs before this custom entry is committed.
                            "state_data": next_state.data,
                        },
                    )
                )
            writes.append(SetValue(operation_state(operation.meta.operation_id), next_state))
            await mutator.commit(writes)

        await self._lane._session.mutate(transition)  # noqa: SLF001

    async def _persist_generation_intent(self, operation: ActiveOperation) -> None:
        context = await self._lane._session.context(await self._lane._session.get_value(lane_tip(self._lane.name)))  # noqa: SLF001
        transformed = await self._lane.hooks.run("transform_context", {"messages": project_messages(context)})
        if not isinstance(transformed, dict) or not isinstance(transformed.get("messages"), list):
            raise RuntimeError("transform_context must return a request object with messages")
        prompt = operation.meta.request.get("prompt", "") if isinstance(operation.meta.request, dict) else ""
        bundle = await self._lane.prompt_memory()
        skills = await self._lane.available_skills(prompt if isinstance(prompt, str) else "")
        if bundle is not None and bundle.items:
            from agent_harness.memory.context import ContextAssembler

            memory_message = ContextAssembler().assemble_prompt_memory(bundle)
            assert memory_message is not None
            transformed = {
                **transformed,
                "messages": [*transformed["messages"], memory_message],
            }
            assert self._lane._memory_runtime is not None and self._lane._memory_scope is not None  # noqa: SLF001
            await self._lane._memory_runtime.record_injection(self._lane._memory_scope, bundle)  # noqa: SLF001
        if skills:
            listing = "\n".join(
                f"- {item.skill_id}@{item.version}: {item.name} — {item.description}; "
                f"triggers: {', '.join(item.triggers)}"
                for item in skills
            )
            transformed = {
                **transformed,
                "messages": [
                    *transformed["messages"],
                    {"role": "system", "content": f"<available_skills>\n{listing}\n</available_skills>"},
                ],
            }
        request = await self._lane.hooks.run(
            "before_request",
            transformed,
        )
        if not isinstance(request, dict) or not isinstance(request.get("messages"), list):
            raise RuntimeError("before_request must return a request object with messages")
        payload = await self._lane.hooks.run(
            "before_payload",
            {"messages": request["messages"], "tool_names": [tool.name for tool in self._lane.tools.definitions()]},
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("messages"), list):
            raise RuntimeError("before_payload must return a payload object with messages")
        selected = payload.get("selected_skills", [])
        if not isinstance(selected, list):
            selected = []
        loadouts = []
        for selected_item in selected:
            if not isinstance(selected_item, dict) or not isinstance(selected_item.get("skill_id"), str):
                continue
            requested_version = selected_item.get("version")
            if not isinstance(requested_version, int):
                requested_version = None
            loadout = await self._lane.load_skill(selected_item["skill_id"], requested_version)
            if loadout is not None:
                loadouts.append(loadout)
        if loadouts:
            payload = {
                **payload,
                "messages": [
                    *payload["messages"],
                    *(
                        {
                            "role": "system",
                            "content": f'<skill id="{loadout.skill_id}" version="{loadout.version}">\n'
                            f"{loadout.markdown}\n</skill>",
                        }
                        for loadout in loadouts
                    ),
                ],
            }
        assistant_entry_id = self._lane.new_id()
        usage_id = self._lane.new_id()
        span, span_write = self._open_span(operation, assistant_entry_id, "llm", attempt=1)
        intent = {
            "assistant_entry_id": assistant_entry_id,
            "usage_id": usage_id,
            "span_id": span.span_id,
            # The durable span is the effect's own record; this copy lets the
            # telemetry published at settlement carry the attempt's real start.
            "span_started_at": span.started_at,
            "messages": payload["messages"],
            "attempt": 1,
            "model": getattr(self._provider, "model", type(self._provider).__name__) if self._provider else None,
            "stream_options": {"checkpoint": "content"},
            "content_checkpoint": "",
            "memory_bundle_hash": bundle.content_hash if bundle is not None else None,
            "memory_items": [
                {"id": item.id, "version": item.version, "level": item.level, "content": item.content}
                for item in bundle.items
            ]
            if bundle is not None
            else [],
            "skill_listing": [
                {"skill_id": item.skill_id, "version": item.version, "name": item.name} for item in skills
            ],
            "skill_loadout": [
                {
                    "skill_id": loadout.skill_id,
                    "version": loadout.version,
                    "content_hash": loadout.content_hash,
                    "resource_hashes": list(loadout.resource_hashes),
                    "budget": sum(
                        len(loadout.markdown) + sum(len(item.content) for item in loadout.files) for loadout in loadouts
                    ),
                }
                for loadout in loadouts
            ],
        }
        await self._transition(
            operation,
            OperationState(at="assistant.effect_pending", control="running", data=intent),
            [span_write],
        )

    async def _execute_and_settle(self, operation: ActiveOperation) -> OperationResult | None:
        intent = operation.state.data
        if not isinstance(intent, dict):
            raise RuntimeError("generation intent must be an object")
        messages = intent.get("messages")
        if not isinstance(messages, list):
            raise RuntimeError("generation intent has no messages")
        assert self._provider is not None
        try:
            await self._lane.emit("message_start", operation.meta.operation_id, {"role": "assistant"})
            request = GenerationRequest(
                session_id=self._lane._session.id,  # noqa: SLF001
                lane=self._lane.name,
                operation_id=operation.meta.operation_id,
                messages=tuple(messages),
                tools=self._lane.tools.definitions(),
            )
            stream = getattr(self._provider, "stream", None)
            if callable(stream):
                response = await self._stream_response(operation, request, stream)
            else:
                response = await self._provider.generate(request)
        except Exception as error:
            # A provider exception cannot prove that the remote side did not receive the request.
            return await self._retry_or_abort(operation, str(error))
        response_event = await self._lane.hooks.run(
            "after_response",
            {
                "content": response.content,
                "finish_reason": response.finish_reason,
                "tool_calls": [
                    {"id": call.id, "name": call.name, "arguments": call.arguments} for call in response.tool_calls
                ],
            },
        )
        if not isinstance(response_event, dict) or not isinstance(response_event.get("content"), str):
            raise RuntimeError("after_response must return an assistant response object")
        response = AssistantResult(
            content=response_event["content"],
            usage=response.usage,
            finish_reason=response_event.get("finish_reason", response.finish_reason),
            tool_calls=response.tool_calls,
        )
        latest = await self._required_operation()
        if latest.state.control == "cancel_requested":
            return await self._settle_interrupted(latest)
        settled = await self._settle_assistant(latest, response)
        await self._lane.emit(
            "message_end",
            operation.meta.operation_id,
            {"role": "assistant", "has_tool_calls": bool(response.tool_calls)},
        )
        return settled

    async def _stream_response(
        self, operation: ActiveOperation, request: GenerationRequest, stream: object
    ) -> AssistantResult:
        if not callable(stream):  # defensive: ``getattr`` is dynamic provider capability detection
            raise RuntimeError("provider stream is not callable")
        content = ""
        final: AssistantResult | None = None
        async for frame in stream(request):
            if isinstance(frame, GenerationDelta):
                content += frame.content
                await self._checkpoint_generation(operation, content)
                await self._lane.emit(
                    "message_update",
                    operation.meta.operation_id,
                    # ``GenerationDelta.content`` is append-only.  Keep the
                    # durable checkpoint cumulative for recovery, but publish
                    # only this frame to observers: clients concatenate update
                    # events and must not render the prior completion again.
                    {"role": "assistant", "content": frame.content},
                )
            elif isinstance(frame, AssistantResult):
                final = frame
            else:
                raise RuntimeError("provider stream yielded an unsupported frame")
        if final is None:
            raise RuntimeError("provider stream ended without a final assistant result")
        return AssistantResult(
            content=final.content or content,
            usage=final.usage,
            finish_reason=final.finish_reason,
            tool_calls=final.tool_calls,
        )

    async def _checkpoint_generation(self, operation: ActiveOperation, content: str) -> None:
        latest = await self._required_operation()
        if latest.meta.operation_id != operation.meta.operation_id or latest.state.at != "assistant.effect_pending":
            return
        data = latest.state.data
        if not isinstance(data, dict):
            raise RuntimeError("generation checkpoint state is invalid")
        await self._transition(
            latest,
            OperationState("assistant.effect_pending", latest.state.control, {**data, "content_checkpoint": content}),
            trace=False,
        )

    async def _retry_or_abort(self, operation: ActiveOperation, error: str) -> OperationResult | None:
        data = operation.state.data
        assert isinstance(data, dict)
        attempt = data.get("attempt", 1)
        if not isinstance(attempt, int):
            raise RuntimeError("generation attempt is invalid")
        next_attempt = attempt + 1
        if next_attempt > self._lane.retry.max_attempts:
            # The provider raised, which cannot prove the remote side never saw
            # the request; the attempt is recorded as failed, the operation as
            # an unprovable outcome.
            return await self._settle_interrupted(operation, span_outcome="failed", span_error_class="provider_error")
        next_data = {
            **data,
            "attempt": next_attempt,
            "not_before": time.time_ns() // 1_000_000 + self._lane.retry.delay_ms(next_attempt),
            "last_error": error,
        }
        ended_at = self._lane.now_ms()
        await self._transition(
            operation,
            OperationState("assistant.retry_wait", "running", next_data),
            self._settle_span(data.get("span_id"), "failed", "provider_error", ended_at=ended_at),
        )
        # The attempt is settled as failed before the retry; reporting it here
        # keeps one generation per model call rather than one per operation.
        checkpoint = data.get("content_checkpoint")
        self._publish(
            self._generation_telemetry(
                operation,
                data,
                content=checkpoint if isinstance(checkpoint, str) else "",
                usage={},
                finish_reason=None,
                outcome="failed",
                error_class="provider_error",
                error=error,
                ended_at=ended_at,
            )
        )
        return None

    async def _wait_for_retry(self, operation: ActiveOperation) -> None:
        data = operation.state.data
        if not isinstance(data, dict) or not isinstance(data.get("not_before"), int):
            raise RuntimeError("retry state is invalid")
        delay = max(0, data["not_before"] - (time.time_ns() // 1_000_000))
        if delay:
            await asyncio.sleep(delay / 1_000)
        # The retry is a new attempt with its own span: its call duration must
        # not include the backoff the turn spent waiting.
        latest = await self._required_operation()
        latest_data = latest.state.data
        if not isinstance(latest_data, dict):
            raise RuntimeError("retry state is invalid")
        attempt = latest_data.get("attempt", 1)
        call_id = latest_data.get("assistant_entry_id")
        if not isinstance(attempt, int) or not isinstance(call_id, str):
            raise RuntimeError("retry state is invalid")
        span, span_write = self._open_span(latest, call_id, "llm", attempt)
        await self._transition(
            latest,
            OperationState(
                "assistant.effect_pending",
                latest.state.control,
                {**latest_data, "span_id": span.span_id, "span_started_at": span.started_at},
            ),
            [span_write],
        )

    async def _settle_assistant(self, operation: ActiveOperation, response: AssistantResult) -> OperationResult | None:
        intent = operation.state.data
        if not isinstance(intent, dict):
            raise RuntimeError("generation intent must be an object")
        assistant_entry_id = intent.get("assistant_entry_id")
        usage_id = intent.get("usage_id")
        if not isinstance(assistant_entry_id, str) or not isinstance(usage_id, str):
            raise RuntimeError("generation intent is missing reserved identifiers")
        run_end = await self._lane.hooks.run("before_run_end", {"follow_up": None})
        if not isinstance(run_end, dict):
            raise RuntimeError("before_run_end must return a result object")
        follow_up = run_end.get("follow_up")
        if follow_up is not None and not isinstance(follow_up, str):
            raise RuntimeError("before_run_end follow_up must be a string")
        follow_up_entry_id = self._lane.new_id() if follow_up else None
        calls = tuple(response.tool_calls)
        call_state = [
            {
                "tool_call_id": call.id,
                "tool_name": call.name,
                "arguments": call.arguments,
                "result_entry_id": self._lane.new_id(),
                "status": "planned",
                "parallel": call.parallel,
            }
            for call in calls
        ]

        # The provider call is over by the time the settlement starts, so one
        # reading serves the span, the operation result and the published fact.
        ended_at = self._lane.now_ms()

        async def settle(mutator: SessionMutator) -> OperationResult | None:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("generation intent was already settled or replaced")
            parent_id = await mutator.get_value(lane_tip(self._lane.name))
            if parent_id is not None and not isinstance(parent_id, str):
                raise RuntimeError("invalid lane tip")
            assistant_payload = {
                "role": "assistant",
                "content": response.content,
                "stop_reason": response.finish_reason,
            }
            if calls:
                assistant_payload["tool_calls"] = [
                    {"id": call.id, "name": call.name, "arguments": call.arguments} for call in calls
                ]
            writes = [
                InsertEntry(NewEntry(assistant_entry_id, parent_id, "message", assistant_payload)),
                InsertUsage(
                    UsageRow(
                        usage_id,
                        response.usage,
                        entry_id=assistant_entry_id,
                        operation_id=operation.meta.operation_id,
                        span_id=intent.get("span_id") if isinstance(intent.get("span_id"), str) else None,
                    )
                ),
                *self._settle_span(intent.get("span_id"), "completed", ended_at=ended_at),
                SetValue(lane_tip(self._lane.name), assistant_entry_id),
            ]
            if calls:
                writes.append(
                    SetValue(
                        operation_state(operation.meta.operation_id),
                        OperationState("tools", "running", {"calls": call_state}),
                    )
                )
                await mutator.commit(writes)
                return None
            if follow_up_entry_id is not None:
                writes.extend(
                    [
                        InsertEntry(
                            NewEntry(
                                follow_up_entry_id,
                                assistant_entry_id,
                                "message",
                                {"role": "user", "content": follow_up},
                            )
                        ),
                        SetValue(lane_tip(self._lane.name), follow_up_entry_id),
                        SetValue(
                            operation_state(operation.meta.operation_id),
                            OperationState("checkpoint", "running", {}),
                        ),
                    ]
                )
                await mutator.commit(writes)
                return None
            result = self._terminal_result(operation, assistant_entry_id, "completed", ended_at=ended_at)
            writes.extend(await self._lane.memory_capture_writes(mutator, result, (assistant_entry_id,)))
            writes.extend(self._terminal_writes(operation, result, "completed"))
            await mutator.commit(writes)
            return result

        result = await self._lane._session.mutate(settle)  # noqa: SLF001
        self._publish(
            self._generation_telemetry(
                operation,
                intent,
                content=response.content,
                usage=response.usage,
                finish_reason=response.finish_reason,
                tool_calls=response.tool_calls,
                outcome="completed",
                ended_at=ended_at,
            )
        )
        if result is not None:
            self._publish(
                self._operation_terminal(
                    result,
                    {
                        "content": response.content,
                        "stop_reason": response.finish_reason,
                        "tool_calls": [call.name for call in response.tool_calls],
                    },
                )
            )
        return result

    async def _run_next_tool(self, operation: ActiveOperation) -> OperationResult | None:
        data = operation.state.data
        if not isinstance(data, dict) or not isinstance(data.get("calls"), list):
            raise RuntimeError("tool state is invalid")
        calls = data["calls"]
        if any(
            isinstance(call, dict) and call.get("status") == "completed" and call.get("terminate") for call in calls
        ):
            return await self._settle_terminal_at_tip(operation, "completed")
        pending = next(
            (call for call in calls if isinstance(call, dict) and call.get("status") == "effect_pending"),
            None,
        )
        if pending is not None:
            tool = self._lane.tools.get(pending["tool_name"])
            if tool is not None and tool.replay_policy == "safe":
                # The replay is a new attempt.  Close the lost one as unknown in
                # the same transaction that authorizes the retry, so a span is
                # never left pending for an effect that nothing is waiting on.
                ended_at = self._lane.now_ms()
                await self._transition_tool(
                    operation,
                    pending,
                    "planned",
                    extra=self._settle_span(pending.get("span_id"), "unknown", "interrupted", ended_at=ended_at),
                )
                # The lost attempt is a fact in its own right: an evaluator must
                # see that the tool may have run twice, not only the replay that
                # produced the answer.
                self._publish(
                    self._tool_telemetry(
                        operation,
                        pending,
                        {"content": "tool execution interrupted; outcome is unknown", "is_error": True},
                        "unknown",
                        "interrupted",
                    )
                )
                return
            await self._settle_tool(
                operation,
                pending,
                {"content": "tool execution interrupted; outcome is unknown", "is_error": True, "terminate": True},
                outcome="unknown",
                error_class="interrupted",
            )
            return
        planned = next((call for call in calls if isinstance(call, dict) and call.get("status") == "planned"), None)
        if planned is None:
            await self._transition(operation, OperationState("checkpoint", "running", {}))
            return
        if planned.get("parallel"):
            await self._run_parallel_tools(operation, calls)
            return
        tool_event = await self._lane.hooks.run(
            "before_tool",
            {
                "tool_call_id": planned["tool_call_id"],
                "tool_name": planned["tool_name"],
                "arguments": planned["arguments"],
            },
            block_on_error=True,
        )
        if not isinstance(tool_event, dict):
            raise RuntimeError("before_tool must return a tool request object")
        if "arguments" in tool_event:
            planned = {**planned, "arguments": tool_event["arguments"]}
        attempt = planned.get("attempt", 0) + 1 if isinstance(planned.get("attempt"), int) else 1
        span, span_write = self._open_span(operation, planned["tool_call_id"], "tool", attempt)
        await self._transition_tool(
            operation,
            {**planned, "attempt": attempt, "span_id": span.span_id, "span_started_at": span.started_at},
            "effect_pending",
            extra=[span_write],
        )
        latest = await self._required_operation()
        active = next(call for call in latest.state.data["calls"] if call["tool_call_id"] == planned["tool_call_id"])
        if tool_event.get("block"):
            await self._settle_tool(
                latest,
                active,
                {"content": "tool call blocked by hook", "is_error": True, "terminate": True},
                outcome="aborted",
                error_class="hook_blocked",
            )
            return
        tool = self._lane.tools.get(active["tool_name"])
        if tool is None:
            await self._settle_tool(
                latest,
                active,
                {"content": f"unknown tool: {active['tool_name']}", "is_error": True},
                outcome="aborted",
                error_class="unknown_tool",
            )
            return
        try:
            await self._lane.emit(
                "tool_start",
                operation.meta.operation_id,
                {"tool_call_id": active["tool_call_id"], "tool_name": active["tool_name"]},
            )
            tool_result = await tool.execute(active["arguments"])
            result = {
                "content": tool_result.content,
                "is_error": tool_result.is_error,
                "terminate": tool_result.terminate,
            }
            if tool_result.details is not None:
                result["details"] = tool_result.details
        except Exception as error:
            result = {"content": f"tool failed: {error}", "is_error": True}
        result_event = await self._lane.hooks.run("after_tool", result)
        if not isinstance(result_event, dict):
            raise RuntimeError("after_tool must return a tool result object")
        result = result_event
        await self._settle_tool(latest, active, result, *_tool_outcome(result))
        await self._lane.emit(
            "tool_end",
            operation.meta.operation_id,
            {"tool_call_id": active["tool_call_id"], "is_error": result.get("is_error", False)},
        )

    async def _run_parallel_tools(self, operation: ActiveOperation, calls: list[object]) -> None:
        """Run one contiguous opt-in batch; durable writes retain source order."""

        batch: list[dict] = []
        for call in calls:
            if not isinstance(call, dict) or call.get("status") != "planned":
                continue
            if not call.get("parallel"):
                break
            batch.append(call)
        if not batch:
            return
        prepared: list[tuple[dict, dict]] = []
        for call in batch:
            event = await self._lane.hooks.run(
                "before_tool",
                {"tool_call_id": call["tool_call_id"], "tool_name": call["tool_name"], "arguments": call["arguments"]},
                block_on_error=True,
            )
            if not isinstance(event, dict):
                raise RuntimeError("before_tool must return a tool request object")
            prepared.append(({**call, "arguments": event.get("arguments", call["arguments"])}, event))
        targets: list[dict] = []
        span_writes: list[Write] = []
        for call, _ in prepared:
            attempt = call.get("attempt", 0) + 1 if isinstance(call.get("attempt"), int) else 1
            span, span_write = self._open_span(operation, call["tool_call_id"], "tool", attempt)
            targets.append({**call, "attempt": attempt, "span_id": span.span_id, "span_started_at": span.started_at})
            span_writes.append(span_write)
        await self._transition_tools(operation, targets, "effect_pending", extra=span_writes)
        latest = await self._required_operation()
        latest_calls = latest.state.data["calls"]  # validated by _transition_tools
        active = [
            next(call for call in latest_calls if call["tool_call_id"] == prepared_call["tool_call_id"])
            for prepared_call, _ in prepared
        ]

        async def execute(call: dict, event: dict) -> tuple[dict, EffectOutcome, ErrorClass | None]:
            if event.get("block"):
                return (
                    {"content": "tool call blocked by hook", "is_error": True, "terminate": True},
                    "aborted",
                    ("hook_blocked"),
                )
            tool = self._lane.tools.get(call["tool_name"])
            if tool is None:
                return {"content": f"unknown tool: {call['tool_name']}", "is_error": True}, "aborted", "unknown_tool"
            try:
                await self._lane.emit(
                    "tool_start",
                    operation.meta.operation_id,
                    {"tool_call_id": call["tool_call_id"], "tool_name": call["tool_name"]},
                )
                value = await tool.execute(call["arguments"])
                result = {"content": value.content, "is_error": value.is_error, "terminate": value.terminate}
                if value.details is not None:
                    result["details"] = value.details
            except Exception as error:
                result = {"content": f"tool failed: {error}", "is_error": True}
            after = await self._lane.hooks.run("after_tool", result)
            if not isinstance(after, dict):
                raise RuntimeError("after_tool must return a tool result object")
            outcome, error_class = _tool_outcome(after)
            return after, outcome, error_class

        hook_events = (item[1] for item in prepared)
        executed = await asyncio.gather(*(execute(call, event) for call, event in zip(active, hook_events)))
        results = [result for result, _, _ in executed]
        outcomes = [(outcome, error_class) for _, outcome, error_class in executed]
        await self._settle_tool_batch(latest, active, results, outcomes)
        for call, result in zip(active, results):
            await self._lane.emit(
                "tool_end",
                operation.meta.operation_id,
                {"tool_call_id": call["tool_call_id"], "is_error": result.get("is_error", False)},
            )

    async def _transition_tool(
        self, operation: ActiveOperation, target: dict, status: str, extra: Sequence[Write] = ()
    ) -> None:
        await self._transition_tools(operation, [target], status, extra)

    async def _transition_tools(
        self,
        operation: ActiveOperation,
        targets: list[dict],
        status: str,
        extra: Sequence[Write] = (),
    ) -> None:
        data = operation.state.data
        assert isinstance(data, dict) and isinstance(data.get("calls"), list)
        ids = {target.get("tool_call_id") for target in targets}
        by_id = {target.get("tool_call_id"): target for target in targets}
        calls = [
            {**call, **by_id[call.get("tool_call_id")], "status": status} if call.get("tool_call_id") in ids else call
            for call in data["calls"]
        ]
        await self._transition(operation, OperationState("tools", "running", {"calls": calls}), extra)

    async def _settle_tool(
        self,
        operation: ActiveOperation,
        active: dict,
        result: dict,
        outcome: EffectOutcome = "completed",
        error_class: ErrorClass | None = None,
    ) -> None:
        async def settle(mutator: SessionMutator) -> None:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("tool intent was already settled or replaced")
            data = operation.state.data
            assert isinstance(data, dict) and isinstance(data.get("calls"), list)
            parent_id = await mutator.get_value(lane_tip(self._lane.name))
            calls = [
                {**call, "status": "completed", "terminate": result.get("terminate", False)} if call == active else call
                for call in data["calls"]
            ]
            await mutator.commit(
                [
                    *self._lane.trace_writes(
                        operation.meta.operation_id,
                        "tool_outcome",
                        {"tool_call_id": active["tool_call_id"], "is_error": result.get("is_error", False)},
                    ),
                    *self._settle_span(active.get("span_id"), outcome, error_class),
                    InsertEntry(
                        NewEntry(
                            active["result_entry_id"],
                            parent_id,
                            "message",
                            {"role": "tool", "tool_call_id": active["tool_call_id"], **result},
                        )
                    ),
                    SetValue(lane_tip(self._lane.name), active["result_entry_id"]),
                    SetValue(
                        operation_state(operation.meta.operation_id),
                        OperationState("tools", "running", {"calls": calls}),
                    ),
                ]
            )

        await self._lane._session.mutate(settle)  # noqa: SLF001
        self._publish(self._tool_telemetry(operation, active, result, outcome, error_class))

    async def _settle_tool_batch(
        self,
        operation: ActiveOperation,
        active: list[dict],
        results: list[dict],
        outcomes: list[tuple[EffectOutcome, ErrorClass | None]],
    ) -> None:
        if len(active) != len(results) or len(active) != len(outcomes):
            raise RuntimeError("tool batch results do not match durable calls")

        async def settle(mutator: SessionMutator) -> None:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("tool batch intent was already settled or replaced")
            data = operation.state.data
            assert isinstance(data, dict) and isinstance(data.get("calls"), list)
            active_ids = {call["tool_call_id"] for call in active}
            by_id = {call["tool_call_id"]: result for call, result in zip(active, results)}
            calls = [
                {**call, "status": "completed", "terminate": by_id[call["tool_call_id"]].get("terminate", False)}
                if call.get("tool_call_id") in active_ids
                else call
                for call in data["calls"]
            ]
            parent_id = await mutator.get_value(lane_tip(self._lane.name))
            writes = []
            writes.extend(
                self._lane.trace_writes(
                    operation.meta.operation_id,
                    "tool_batch_outcome",
                    {"tool_call_ids": [call["tool_call_id"] for call in active]},
                )
            )
            for call, (outcome, error_class) in zip(active, outcomes):
                result = by_id[call["tool_call_id"]]
                writes.extend(self._settle_span(call.get("span_id"), outcome, error_class))
                writes.append(
                    InsertEntry(
                        NewEntry(
                            call["result_entry_id"],
                            parent_id,
                            "message",
                            {"role": "tool", "tool_call_id": call["tool_call_id"], **result},
                        )
                    )
                )
                parent_id = call["result_entry_id"]
            writes.extend(
                [
                    SetValue(lane_tip(self._lane.name), parent_id),
                    SetValue(
                        operation_state(operation.meta.operation_id),
                        OperationState("tools", "running", {"calls": calls}),
                    ),
                ]
            )
            await mutator.commit(writes)

        await self._lane._session.mutate(settle)  # noqa: SLF001
        # One observation per call: a parallel batch is a set of independent
        # effects, and a failure in one of them must not be read as the batch's.
        for call, result, (outcome, error_class) in zip(active, results, outcomes):
            self._publish(self._tool_telemetry(operation, call, result, outcome, error_class))

    async def _settle_interrupted(
        self,
        operation: ActiveOperation,
        span_outcome: EffectOutcome = "unknown",
        span_error_class: ErrorClass | None = "interrupted",
    ) -> OperationResult:
        data = operation.state.data
        checkpoint = data.get("content_checkpoint", "") if isinstance(data, dict) else ""
        if not isinstance(checkpoint, str):
            checkpoint = ""
        return await self._settle(
            operation,
            assistant_payload={
                "role": "assistant",
                "content": checkpoint,
                "stop_reason": "aborted",
                "error": "generation interrupted before its outcome could be persisted",
            },
            usage={},
            # The effect was issued and its result is gone: neither success nor
            # failure can be claimed, and the turn must not look replayable.
            status="unknown",
            error_code="interrupted",
            error_message="generation outcome is unknown after process interruption",
            span_outcome=span_outcome,
            span_error_class=span_error_class,
        )

    async def _settle_terminal_at_tip(self, operation: ActiveOperation, status: OperationStatus) -> OperationResult:
        async def settle(mutator: SessionMutator) -> OperationResult:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("operation state changed while terminal result was settling")
            tip_id = await mutator.get_value(lane_tip(self._lane.name))
            if tip_id is not None and not isinstance(tip_id, str):
                raise RuntimeError("invalid lane tip")
            result = self._terminal_result(operation, tip_id, status)
            writes = await self._lane.memory_capture_writes(mutator, result)
            await mutator.commit([*writes, *self._terminal_writes(operation, result, status)])
            return result

        result = await self._lane._session.mutate(settle)  # noqa: SLF001
        # The turn ended on a tool that asked to terminate, so the last
        # assistant content is not at hand here; the tip names what it settled on.
        self._publish(self._operation_terminal(result, {"tip_id": result.tip_id}))
        return result

    async def _settle_cancelled(self, operation: ActiveOperation) -> OperationResult:
        if operation.state.at == "assistant.effect_pending":
            return await self._settle_interrupted(operation)

        async def settle(mutator: SessionMutator) -> OperationResult:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("operation state changed while cancellation was settling")
            tip_id = await mutator.get_value(lane_tip(self._lane.name))
            if tip_id is not None and not isinstance(tip_id, str):
                raise RuntimeError("invalid lane tip")
            result = self._terminal_result(
                operation,
                tip_id,
                "aborted",
                error_code="cancelled",
                error_message="operation cancelled before the next external effect",
            )
            writes = await self._lane.memory_capture_writes(mutator, result)
            await mutator.commit([*writes, *self._terminal_writes(operation, result, "aborted")])
            return result

        result = await self._lane._session.mutate(settle)  # noqa: SLF001
        self._publish(self._operation_terminal(result, {"cancelled": True, "tip_id": result.tip_id}))
        return result

    async def _settle(
        self,
        operation: ActiveOperation,
        *,
        assistant_payload: dict[str, str],
        usage: dict[str, int | float],
        status: OperationStatus,
        error_code: str | None = None,
        error_message: str | None = None,
        span_outcome: EffectOutcome | None = None,
        span_error_class: ErrorClass | None = None,
    ) -> OperationResult:
        intent = operation.state.data
        if not isinstance(intent, dict):
            raise RuntimeError("generation intent must be an object")
        assistant_entry_id = intent.get("assistant_entry_id")
        usage_id = intent.get("usage_id")
        if not isinstance(assistant_entry_id, str) or not isinstance(usage_id, str):
            raise RuntimeError("generation intent is missing reserved identifiers")

        # One clock reading for the whole settlement: the operation result, its
        # effect span and the fact published from them all report the same end.
        ended_at = self._lane.now_ms()

        async def settle(mutator: SessionMutator) -> OperationResult:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("generation intent was already settled or replaced")
            parent_id = await mutator.get_value(lane_tip(self._lane.name))
            if parent_id is not None and not isinstance(parent_id, str):
                raise RuntimeError("invalid lane tip")
            result = OperationResult(
                operation_id=operation.meta.operation_id,
                kind=operation.meta.kind,
                status=status,
                from_tip_id=operation.meta.source_tip_id,
                tip_id=assistant_entry_id,
                started_at=operation.meta.started_at,
                ended_at=ended_at,
                error_code=error_code,
                error_message=error_message,
            )
            span_id = intent.get("span_id")
            await mutator.commit(
                [
                    InsertEntry(NewEntry(assistant_entry_id, parent_id, "message", assistant_payload)),
                    InsertUsage(
                        UsageRow(
                            usage_id,
                            usage,
                            entry_id=assistant_entry_id,
                            operation_id=operation.meta.operation_id,
                            span_id=span_id if isinstance(span_id, str) else None,
                        )
                    ),
                    *self._settle_span(
                        span_id,
                        span_outcome or _TERMINAL_OUTCOME[status],
                        span_error_class,
                        ended_at=ended_at,
                    ),
                    SetValue(lane_tip(self._lane.name), assistant_entry_id),
                    *await self._lane.memory_capture_writes(mutator, result, (assistant_entry_id,)),
                    SetValue(
                        operation_state(operation.meta.operation_id),
                        OperationState("terminal", "settled", {"status": status}),
                    ),
                    SetValue(operation_result(operation.meta.operation_id), result),
                    SetValue(
                        lane_state(self._lane.name),
                        {"current_operation_id": None, "last_operation_id": operation.meta.operation_id},
                    ),
                ]
            )
            return result

        result = await self._lane._session.mutate(settle)  # noqa: SLF001
        # ``span_outcome`` separates the attempt's fate from the operation's:
        # a provider that failed on its last allowed attempt leaves an operation
        # whose outcome nobody can prove, and the generation that failed.
        self._publish(
            self._generation_telemetry(
                operation,
                intent,
                content=assistant_payload["content"],
                usage=usage,
                finish_reason=assistant_payload.get("stop_reason"),
                outcome=span_outcome or _TERMINAL_OUTCOME[status],
                error_class=span_error_class,
                error=error_message,
                ended_at=ended_at,
            )
        )
        self._publish(self._operation_terminal(result, {**assistant_payload, "status": status}))
        return result

    def _terminal_result(
        self,
        operation: ActiveOperation,
        tip_id: str | None,
        status: OperationStatus,
        error_code: str | None = None,
        error_message: str | None = None,
        ended_at: int | None = None,
    ) -> OperationResult:
        return OperationResult(
            operation_id=operation.meta.operation_id,
            kind=operation.meta.kind,
            status=status,
            from_tip_id=operation.meta.source_tip_id,
            tip_id=tip_id,
            started_at=operation.meta.started_at,
            ended_at=self._lane.now_ms() if ended_at is None else ended_at,
            error_code=error_code,
            error_message=error_message,
        )

    def _terminal_writes(
        self, operation: ActiveOperation, result: OperationResult, status: OperationStatus
    ) -> list[Write]:
        return [
            SetValue(
                operation_state(operation.meta.operation_id),
                OperationState("terminal", "settled", {"status": status}),
            ),
            SetValue(operation_result(operation.meta.operation_id), result),
            SetValue(
                lane_state(self._lane.name),
                {"current_operation_id": None, "last_operation_id": operation.meta.operation_id},
            ),
            DeleteValue(operation_lease(operation.meta.operation_id)),
        ]
