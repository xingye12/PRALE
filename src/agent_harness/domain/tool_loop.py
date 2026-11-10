"""Pure consecutive-error detection, scoped to a single durable operation."""

import hashlib
import json
from typing import Any

from agent_harness.domain.entries import JsonValue


def fingerprint(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


def action_key(name: str, arguments: JsonValue) -> str:
    return fingerprint([name, arguments])


def blocked_result(state: dict[str, Any], action: str) -> dict[str, Any] | None:
    if action not in state.get("blocked", []):
        return None
    return {
        "content": "Tool loop blocked: this action failed identically three times. Change the request or stop.",
        "is_error": True,
        "error_code": "tool_loop_detected",
        "terminate": not state.get("recovery_pending", False),
    }


def observe(
    state: dict[str, Any], name: str, arguments: JsonValue, result: dict[str, Any], outcome: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    if result.get("error_code") == "tool_loop_detected":
        return state, result
    if not result.get("is_error") or outcome == "unknown":
        return {**state, "signature": None, "count": 0}, result
    action = action_key(name, arguments)
    signature = fingerprint([action, result.get("content"), result.get("error_code")])
    count = state.get("count", 0) + 1 if state.get("signature") == signature else 1
    state = {**state, "signature": signature, "count": count}
    if count < 3:
        return state, result
    blocked = list(state.get("blocked", []))
    if action not in blocked:
        blocked.append(action)
    exhausted = state.get("recovery_used", False) and not state.get("recovery_pending", False)
    state = {**state, "blocked": blocked, "recovery_used": True, "recovery_pending": not exhausted}
    return state, {
        **result,
        "content": {
            "error": result.get("content"),
            "loop_recovery": "The same tool, arguments and error occurred three times. Change the request or stop. "
            "This action is blocked; only one recovery opportunity is allowed.",
        },
        "error_code": "tool_loop_detected" if exhausted else result.get("error_code"),
        "terminate": bool(result.get("terminate")) or exhausted,
    }
