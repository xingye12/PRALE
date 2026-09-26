"""Durable Agent loop, retry handling, and interruption recovery."""

import asyncio
import time

from agent_harness.api.errors import ProviderNotConfigured, UnknownTarget
from agent_harness.api.models import OperationResult
from agent_harness.domain.compaction import select_compaction_window
from agent_harness.domain.context import project_messages
from agent_harness.domain.entries import NewEntry
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
from agent_harness.runtime.generation import AssistantResult, ChatProvider, GenerationDelta, GenerationRequest
from agent_harness.runtime.lane import Lane
from agent_harness.storage.protocol import ClearList, DeleteValue, InsertEntry, InsertUsage, SetValue, UsageRow, Write


class Drive:
    def __init__(self, lane: Lane, provider: ChatProvider | None) -> None:
        self._lane = lane
        self._provider = provider

    async def run(self) -> OperationResult:
        initial = await self._required_operation()
        await self._lane.hooks.run(
            "before_drive",
            {"lane": self._lane.name, "operation_id": initial.meta.operation_id, "kind": initial.meta.kind},
            fail_closed=True,
        )
        await self._lane.emit("operation_started", initial.meta.operation_id, {"kind": initial.meta.kind})
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

        return await self._lane._session.mutate(navigate)  # noqa: SLF001

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
            intent = {
                "entry_id": self._lane.new_id(),
                "usage_id": self._lane.new_id(),
                "messages": hook_context["messages"],
                "retained_message_ids": retained_message_ids,
            }
            await self._transition(operation, OperationState("summary.effect_pending", "running", intent))
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
        if operation.state.at == "starting":
            entry_id = self._lane.new_id()
            usage_id = self._lane.new_id()
            retained_ids = retained_message_ids or []
        else:
            if not isinstance(data, dict):
                raise RuntimeError("compaction intent is invalid")
            entry_id = data.get("entry_id")
            usage_id = data.get("usage_id")
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
                    InsertUsage(UsageRow(usage_id, usage, entry_id=entry_id)),
                    SetValue(lane_tip(self._lane.name), entry_id),
                    *await self._lane.memory_capture_writes(mutator, result, (entry_id,)),
                    *self._terminal_writes(operation, result, "completed"),
                ]
            )
            return result

        return await self._lane._session.mutate(settle)  # noqa: SLF001

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

        async def settle(mutator: SessionMutator) -> OperationResult:
            if await mutator.get_value(operation_state(operation.meta.operation_id)) != operation.state:
                raise RuntimeError("compaction intent was already settled")
            parent = await mutator.get_value(lane_tip(self._lane.name))
            result = self._terminal_result(
                operation,
                entry_id,
                "aborted",
                error_code="interrupted",
                error_message="compaction outcome is unknown after process interruption",
            )
            await mutator.commit(
                [
                    InsertEntry(NewEntry(entry_id, parent, "compaction", {"summary": "[compaction interrupted]"})),
                    InsertUsage(UsageRow(usage_id, {}, entry_id=entry_id)),
                    SetValue(lane_tip(self._lane.name), entry_id),
                    *await self._lane.memory_capture_writes(mutator, result, (entry_id,)),
                    *self._terminal_writes(operation, result, "aborted"),
                ]
            )
            return result

        return await self._lane._session.mutate(settle)  # noqa: SLF001

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

    async def _transition(self, operation: ActiveOperation, next_state: OperationState) -> None:
        async def transition(mutator: SessionMutator) -> None:
            current = await mutator.get_value(operation_state(operation.meta.operation_id))
            if current != operation.state:
                raise RuntimeError("operation state changed while Drive was running")
            await mutator.commit(
                [
                    *self._lane.trace_writes(
                        operation.meta.operation_id,
                        "state_transition",
                        {
                            "from": operation.state.at,
                            "to": next_state.at,
                            # Intent, retry and tool-call details are part of the durable execution trace.
                            # Lane redaction runs before this custom entry is committed.
                            "state_data": next_state.data,
                        },
                    ),
                    SetValue(operation_state(operation.meta.operation_id), next_state),
                ]
            )

        await self._lane._session.mutate(transition)  # noqa: SLF001

    async def _persist_generation_intent(self, operation: ActiveOperation) -> None:
        context = await self._lane._session.context(await self._lane._session.get_value(lane_tip(self._lane.name)))  # noqa: SLF001
        transformed = await self._lane.hooks.run("transform_context", {"messages": project_messages(context)})
        if not isinstance(transformed, dict) or not isinstance(transformed.get("messages"), list):
            raise RuntimeError("transform_context must return a request object with messages")
        prompt = operation.meta.request.get("prompt", "") if isinstance(operation.meta.request, dict) else ""
        bundle = await self._lane.recall_memory(prompt if isinstance(prompt, str) else "")
        if bundle is not None and bundle.items:
            from agent_harness.memory.context import ContextAssembler

            memory_message = ContextAssembler().assemble(bundle)
            assert memory_message is not None
            transformed = {
                **transformed,
                "messages": [*transformed["messages"], memory_message],
            }
            assert self._lane._memory_runtime is not None and self._lane._memory_scope is not None  # noqa: SLF001
            await self._lane._memory_runtime.record_injection(self._lane._memory_scope, bundle)  # noqa: SLF001
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
        assistant_entry_id = self._lane.new_id()
        usage_id = self._lane.new_id()
        intent = {
            "assistant_entry_id": assistant_entry_id,
            "usage_id": usage_id,
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
        }
        await self._transition(operation, OperationState(at="assistant.effect_pending", control="running", data=intent))

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
                    {"role": "assistant", "content": content},
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
        )

    async def _retry_or_abort(self, operation: ActiveOperation, error: str) -> OperationResult | None:
        data = operation.state.data
        assert isinstance(data, dict)
        attempt = data.get("attempt", 1)
        if not isinstance(attempt, int):
            raise RuntimeError("generation attempt is invalid")
        next_attempt = attempt + 1
        if next_attempt > self._lane.retry.max_attempts:
            return await self._settle_interrupted(operation)
        next_data = {
            **data,
            "attempt": next_attempt,
            "not_before": time.time_ns() // 1_000_000 + self._lane.retry.delay_ms(next_attempt),
            "last_error": error,
        }
        await self._transition(operation, OperationState("assistant.retry_wait", "running", next_data))
        return None

    async def _wait_for_retry(self, operation: ActiveOperation) -> None:
        data = operation.state.data
        if not isinstance(data, dict) or not isinstance(data.get("not_before"), int):
            raise RuntimeError("retry state is invalid")
        delay = max(0, data["not_before"] - (time.time_ns() // 1_000_000))
        if delay:
            await asyncio.sleep(delay / 1_000)
        await self._transition(operation, OperationState("assistant.effect_pending", "running", data))

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
                InsertUsage(UsageRow(usage_id, response.usage, entry_id=assistant_entry_id)),
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
            result = self._terminal_result(operation, assistant_entry_id, "completed")
            writes.extend(await self._lane.memory_capture_writes(mutator, result, (assistant_entry_id,)))
            writes.extend(self._terminal_writes(operation, result, "completed"))
            await mutator.commit(writes)
            return result

        return await self._lane._session.mutate(settle)  # noqa: SLF001

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
                await self._transition_tool(operation, pending, "planned")
                return
            await self._settle_tool(
                operation,
                pending,
                {"content": "tool execution interrupted; outcome is unknown", "is_error": True, "terminate": True},
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
        await self._transition_tool(operation, planned, "effect_pending")
        latest = await self._required_operation()
        active = next(call for call in latest.state.data["calls"] if call["tool_call_id"] == planned["tool_call_id"])
        if tool_event.get("block"):
            await self._settle_tool(
                latest,
                active,
                {"content": "tool call blocked by hook", "is_error": True, "terminate": True},
            )
            return
        tool = self._lane.tools.get(active["tool_name"])
        if tool is None:
            await self._settle_tool(
                latest,
                active,
                {"content": f"unknown tool: {active['tool_name']}", "is_error": True},
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
        await self._settle_tool(latest, active, result)
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
        await self._transition_tools(operation, [call for call, _ in prepared], "effect_pending")
        latest = await self._required_operation()
        latest_calls = latest.state.data["calls"]  # validated by _transition_tools
        active = [
            next(call for call in latest_calls if call["tool_call_id"] == prepared_call["tool_call_id"])
            for prepared_call, _ in prepared
        ]

        async def execute(call: dict, event: dict) -> dict:
            if event.get("block"):
                return {"content": "tool call blocked by hook", "is_error": True, "terminate": True}
            tool = self._lane.tools.get(call["tool_name"])
            if tool is None:
                return {"content": f"unknown tool: {call['tool_name']}", "is_error": True}
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
            return after

        hook_events = (item[1] for item in prepared)
        results = await asyncio.gather(*(execute(call, event) for call, event in zip(active, hook_events)))
        await self._settle_tool_batch(latest, active, list(results))
        for call, result in zip(active, results):
            await self._lane.emit(
                "tool_end",
                operation.meta.operation_id,
                {"tool_call_id": call["tool_call_id"], "is_error": result.get("is_error", False)},
            )

    async def _transition_tool(self, operation: ActiveOperation, target: dict, status: str) -> None:
        await self._transition_tools(operation, [target], status)

    async def _transition_tools(self, operation: ActiveOperation, targets: list[dict], status: str) -> None:
        data = operation.state.data
        assert isinstance(data, dict) and isinstance(data.get("calls"), list)
        ids = {target.get("tool_call_id") for target in targets}
        by_id = {target.get("tool_call_id"): target for target in targets}
        calls = [
            {**call, **by_id[call.get("tool_call_id")], "status": status} if call.get("tool_call_id") in ids else call
            for call in data["calls"]
        ]
        await self._transition(operation, OperationState("tools", "running", {"calls": calls}))

    async def _settle_tool(self, operation: ActiveOperation, active: dict, result: dict) -> None:
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

    async def _settle_tool_batch(self, operation: ActiveOperation, active: list[dict], results: list[dict]) -> None:
        if len(active) != len(results):
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
            for call in active:
                result = by_id[call["tool_call_id"]]
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

    async def _settle_interrupted(self, operation: ActiveOperation) -> OperationResult:
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
            status="aborted",
            error_code="interrupted",
            error_message="generation outcome is unknown after process interruption",
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

        return await self._lane._session.mutate(settle)  # noqa: SLF001

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

        return await self._lane._session.mutate(settle)  # noqa: SLF001

    async def _settle(
        self,
        operation: ActiveOperation,
        *,
        assistant_payload: dict[str, str],
        usage: dict[str, int | float],
        status: OperationStatus,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> OperationResult:
        intent = operation.state.data
        if not isinstance(intent, dict):
            raise RuntimeError("generation intent must be an object")
        assistant_entry_id = intent.get("assistant_entry_id")
        usage_id = intent.get("usage_id")
        if not isinstance(assistant_entry_id, str) or not isinstance(usage_id, str):
            raise RuntimeError("generation intent is missing reserved identifiers")

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
                ended_at=self._lane._now_ms(),  # noqa: SLF001
                error_code=error_code,
                error_message=error_message,
            )
            await mutator.commit(
                [
                    InsertEntry(NewEntry(assistant_entry_id, parent_id, "message", assistant_payload)),
                    InsertUsage(UsageRow(usage_id, usage, entry_id=assistant_entry_id)),
                    SetValue(lane_tip(self._lane.name), assistant_entry_id),
                    *await self._lane.memory_capture_writes(mutator, result, (assistant_entry_id,)),
                    SetValue(
                        operation_state(operation.meta.operation_id),
                        OperationState("terminal", "running", {"status": status}),
                    ),
                    SetValue(operation_result(operation.meta.operation_id), result),
                    SetValue(
                        lane_state(self._lane.name),
                        {"current_operation_id": None, "last_operation_id": operation.meta.operation_id},
                    ),
                ]
            )
            return result

        return await self._lane._session.mutate(settle)  # noqa: SLF001

    def _terminal_result(
        self,
        operation: ActiveOperation,
        tip_id: str | None,
        status: OperationStatus,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> OperationResult:
        return OperationResult(
            operation_id=operation.meta.operation_id,
            kind=operation.meta.kind,
            status=status,
            from_tip_id=operation.meta.source_tip_id,
            tip_id=tip_id,
            started_at=operation.meta.started_at,
            ended_at=self._lane._now_ms(),  # noqa: SLF001
            error_code=error_code,
            error_message=error_message,
        )

    def _terminal_writes(
        self, operation: ActiveOperation, result: OperationResult, status: OperationStatus
    ) -> list[Write]:
        return [
            SetValue(
                operation_state(operation.meta.operation_id),
                OperationState("terminal", "running", {"status": status}),
            ),
            SetValue(operation_result(operation.meta.operation_id), result),
            SetValue(
                lane_state(self._lane.name),
                {"current_operation_id": None, "last_operation_id": operation.meta.operation_id},
            ),
            DeleteValue(operation_lease(operation.meta.operation_id)),
        ]
