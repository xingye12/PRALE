"""Durable approvals. Notifications wake waiters; persisted records decide execution."""

import asyncio
import hashlib
import json
from dataclasses import asdict, replace
from typing import TYPE_CHECKING, Any

from agent_harness.domain.approvals import (
    ApprovalConfig,
    ApprovalConflict,
    ApprovalDecision,
    RiskAssessment,
    approval_audit,
    approval_grant,
    approval_grants,
    approval_request,
    approval_requests,
)
from agent_harness.domain.operations import ActiveOperation, OperationState
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.values import operation_state
from agent_harness.runtime.events import EventBus, HarnessEvent
from agent_harness.runtime.tools import invalid_tool_arguments
from agent_harness.storage.protocol import AppendList, SetValue, Write

if TYPE_CHECKING:
    from agent_harness.runtime.lane import Lane


def fingerprint(name: str, arguments: object, assessment: RiskAssessment, subject: str) -> str:
    payload = {"tool": name, "arguments": arguments, "risk": asdict(assessment), "subject": subject}
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


class ApprovalRuntime:
    def __init__(self, session: Session, config: ApprovalConfig, events: EventBus) -> None:
        self.session, self.config, self.events = session, config, events
        self.changed = asyncio.Event()

    def assess(self, lane: "Lane", call: dict[str, Any]) -> RiskAssessment:
        tool = lane.tools.get(call["tool_name"])
        if tool is None:
            return RiskAssessment("deny", "tool is not registered")
        try:
            invalid = invalid_tool_arguments(tool, call["arguments"])
            if invalid is not None:
                return RiskAssessment("deny", invalid)
            if self.config.evaluator is not None:
                result = self.config.evaluator(call["tool_name"], call["arguments"], tool)
                return self._version(tool, result)
            assessor = getattr(tool, "assess_risk", None)
            if callable(assessor):
                return self._version(tool, assessor(call["arguments"]))
            if isinstance(getattr(tool, "control_kind", None), str):
                return RiskAssessment("allow", "capability-limited runtime control")
            return self._version(tool, RiskAssessment("ask", "tool capabilities have not been classified"))
        except Exception:
            return RiskAssessment("deny", "risk assessment failed")

    @staticmethod
    def _version(tool: object, assessment: RiskAssessment) -> RiskAssessment:
        if not isinstance(assessment, RiskAssessment) or assessment.decision not in ("allow", "ask", "deny"):
            return RiskAssessment("deny", "invalid risk assessment")
        identity = f"{type(tool).__module__}.{type(tool).__qualname__}:{getattr(tool, 'risk_version', '1')}"
        return replace(assessment, capability_version=identity + ":" + assessment.capability_version)

    async def records(self, grants: bool = False) -> list[dict[str, Any]]:
        async def read(mutator: SessionMutator) -> list[dict[str, Any]]:
            index = approval_grants() if grants else approval_requests()
            records = []
            for key in await mutator.read_list(index):
                value = await mutator.get_value(approval_grant(key) if grants else approval_request(key))
                if not isinstance(value, dict) or value.get("format_version") != 1:
                    raise RuntimeError("incomplete approval index or unsupported format")
                records.append(value)
            return records

        return await self.session.mutate(read)

    async def decide(self, request_id: str, decision: ApprovalDecision) -> dict[str, Any]:
        if decision not in ("allow_once", "allow_session", "reject"):
            raise ValueError("invalid approval decision")

        async def update(mutator: SessionMutator) -> dict[str, Any]:
            request = await mutator.get_value(approval_request(request_id))
            if not isinstance(request, dict):
                raise ApprovalConflict("unknown approval request")
            if request["status"] != "pending":
                if request.get("decision") == decision and request["status"] in ("allowed", "rejected", "consumed"):
                    return request
                raise ApprovalConflict("approval is no longer pending")
            state = await mutator.get_value(operation_state(request["operation_id"]))
            if not isinstance(state, OperationState) or state.control != "running" or state.at != "tools":
                raise ApprovalConflict("operation is no longer awaiting approval")
            calls = state.data.get("calls", []) if isinstance(state.data, dict) else []
            if not any(c.get("approval_id") == request_id and c.get("status") == "planned" for c in calls):
                raise ApprovalConflict("tool call is no longer awaiting approval")
            updated = {**request, "status": "rejected" if decision == "reject" else "allowed", "decision": decision}
            writes: list[Write] = [
                SetValue(approval_request(request_id), updated),
                AppendList(
                    approval_audit(),
                    {
                        "type": "decided",
                        "approval_id": request_id,
                        "decision": decision,
                    },
                ),
            ]
            if decision == "allow_session":
                grant = {
                    "format_version": 1,
                    "grant_id": request_id,
                    "fingerprint": request["fingerprint"],
                    "subject": request["subject"],
                    "tool_name": request["tool_name"],
                    "arguments": request["arguments"],
                    "cwd": request["cwd"],
                    "revoked": False,
                }
                writes.extend([SetValue(approval_grant(request_id), grant), AppendList(approval_grants(), request_id)])
            await mutator.commit(writes)
            return updated

        result = await self.session.mutate(update)
        self.changed.set()
        await self.events.emit(HarnessEvent("approval_decided", result["lane"], result["operation_id"], result))
        return result

    async def revoke(self, grant_id: str) -> dict[str, Any]:
        async def update(mutator: SessionMutator) -> dict[str, Any]:
            grant = await mutator.get_value(approval_grant(grant_id))
            if not isinstance(grant, dict):
                raise ApprovalConflict("unknown approval grant")
            if grant["revoked"]:
                return grant
            result = {**grant, "revoked": True}
            await mutator.commit(
                [
                    SetValue(approval_grant(grant_id), result),
                    AppendList(
                        approval_audit(),
                        {
                            "type": "revoked",
                            "grant_id": grant_id,
                        },
                    ),
                ]
            )
            return result

        result = await self.session.mutate(update)
        self.changed.set()
        await self.events.emit(HarnessEvent("approval_grant_changed", None, None, result))
        return result

    async def prepare(
        self, lane: "Lane", operation: ActiveOperation, call: dict[str, Any], event: dict[str, Any]
    ) -> dict[str, Any]:
        """Freeze hook output and request in one transaction. Never hold a transaction while waiting."""
        prepared = {**call, "arguments": event.get("arguments", call["arguments"])}
        assessment = self.assess(lane, prepared)
        subject = lane.name  # Internal lanes are stable per agent and never inherit a parent's grant.
        digest = fingerprint(call["tool_name"], prepared["arguments"], assessment, subject)
        old_id = call.get("approval_id")
        old = await self.session.get_value(approval_request(old_id)) if old_id else None
        if (
            isinstance(old, dict)
            and old.get("fingerprint") == digest
            and old["status"] in ("pending", "allowed", "rejected", "unavailable")
            and (assessment.decision != "ask" or (self.config.policy == "ask" and self.config.channel_available))
        ):
            grant_id = old.get("grant_id") or (old_id if old.get("decision") == "allow_session" else None)
            grant = await self.session.get_value(approval_grant(grant_id)) if grant_id else None
            if not grant_id or (isinstance(grant, dict) and not grant["revoked"]):
                return await self.wait(old["approval_id"])
        request_id = lane.new_id()
        status = "allowed" if assessment.decision == "allow" else "pending"
        if event.get("block") or assessment.decision == "deny":
            status = "rejected"
        elif status == "pending" and (self.config.policy == "never" or not self.config.channel_available):
            status = "unavailable" if self.config.policy == "ask" else "rejected"
        request = {
            "format_version": 1,
            "approval_id": request_id,
            "operation_id": operation.meta.operation_id,
            "tool_call_id": call["tool_call_id"],
            "lane": lane.name,
            "subject": subject,
            "tool_name": call["tool_name"],
            "arguments": prepared["arguments"],
            "cwd": assessment.cwd,
            "target": assessment.target,
            "reason": assessment.reason,
            "fingerprint": digest,
            "status": status,
            "risk": asdict(assessment),
            "created_at": lane.now_ms(),
            "source": dict(lane.subagent_context),
        }

        async def persist(mutator: SessionMutator) -> dict[str, Any]:
            state = await mutator.get_value(operation_state(operation.meta.operation_id))
            if state != operation.state:
                raise ApprovalConflict("operation changed during approval preparation")
            if status == "pending":
                for key in await mutator.read_list(approval_grants()):
                    grant = await mutator.get_value(approval_grant(key))
                    if isinstance(grant, dict) and not grant["revoked"] and grant["fingerprint"] == digest:
                        request.update(status="allowed", grant_id=key)
                        break
            frozen = {**prepared, "approval_id": request_id, "prepared_event": event}
            calls = [frozen if c["tool_call_id"] == call["tool_call_id"] else c for c in operation.state.data["calls"]]
            writes: list[Write] = [
                SetValue(approval_request(request_id), request),
                AppendList(approval_requests(), request_id),
                AppendList(approval_audit(), {"type": "asked", **request}),
                SetValue(
                    operation_state(operation.meta.operation_id), OperationState("tools", "running", {"calls": calls})
                ),
            ]
            if isinstance(old, dict) and old["status"] in ("pending", "allowed"):
                writes.extend(
                    [
                        SetValue(approval_request(old["approval_id"]), {**old, "status": "superseded"}),
                        AppendList(approval_audit(), {"type": "superseded", "approval_id": old_id}),
                    ]
                )
            await mutator.commit(writes)
            return request

        request = await self.session.mutate(persist)
        await self.events.emit(HarnessEvent("approval_requested", lane.name, operation.meta.operation_id, request))
        return await self.wait(request_id)

    async def wait(self, request_id: str) -> dict[str, Any]:
        while True:
            self.changed.clear()
            request = await self.session.get_value(approval_request(request_id))
            if not isinstance(request, dict):
                raise ApprovalConflict("missing approval request")
            if request["status"] != "pending":
                return request
            await self.changed.wait()

    async def intent_writes(self, mutator: SessionMutator, call: dict[str, Any], lane: "Lane") -> list[Write]:
        """Called in the SAME mutation as the tool effect intent, including grant validation."""
        request_id = call.get("approval_id")
        if not request_id:
            raise ApprovalConflict("tool execution has no approval assessment")
        request = await mutator.get_value(approval_request(request_id))
        if not isinstance(request, dict) or request["status"] != "allowed":
            raise ApprovalConflict("tool execution is not authorized")
        assessment = self.assess(lane, call)
        if request["fingerprint"] != fingerprint(call["tool_name"], call["arguments"], assessment, lane.name) or (
            assessment.decision == "ask" and (self.config.policy != "ask" or not self.config.channel_available)
        ):
            raise ApprovalConflict("risk context changed before execution")
        grant_id = request.get("grant_id") or (request_id if request.get("decision") == "allow_session" else None)
        if grant_id:
            grant = await mutator.get_value(approval_grant(grant_id))
            if not isinstance(grant, dict) or grant["revoked"]:
                raise ApprovalConflict("session authorization has been revoked")
        return [
            SetValue(approval_request(request_id), {**request, "status": "consumed"}),
            AppendList(approval_audit(), {"type": "used", "approval_id": request_id, "grant_id": grant_id}),
        ]

    async def cancellation_writes(self, mutator: SessionMutator, operation_id: str) -> list[Write]:
        writes: list[Write] = []
        for key in await mutator.read_list(approval_requests()):
            request = await mutator.get_value(approval_request(key))
            if (
                isinstance(request, dict)
                and request["operation_id"] == operation_id
                and request["status"] in ("pending", "allowed")
            ):
                writes.extend(
                    [
                        SetValue(approval_request(key), {**request, "status": "cancelled"}),
                        AppendList(approval_audit(), {"type": "cancelled", "approval_id": key}),
                    ]
                )
        return writes
