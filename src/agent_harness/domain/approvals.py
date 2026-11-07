"""Transport-neutral tool risk and approval vocabulary."""

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from agent_harness.domain.entries import JsonValue
from agent_harness.domain.values import ListAddress, ValueAddress

ApprovalPolicy = Literal["ask", "never"]
ApprovalDecision = Literal["allow_once", "allow_session", "reject"]


class ApprovalConflict(ValueError):
    """The request is missing, no longer pending, or belongs to another operation."""


@dataclass(frozen=True, slots=True)
class RiskAssessment:
    decision: Literal["allow", "ask", "deny"]
    reason: str
    policy_version: int = 1
    cwd: str = ""
    target: str = ""
    capability_version: str = "1"


class RiskEvaluator(Protocol):
    def __call__(self, name: str, arguments: JsonValue, tool: object) -> RiskAssessment: ...


@dataclass(frozen=True, slots=True)
class ApprovalConfig:
    policy: ApprovalPolicy = "ask"
    channel_available: bool = False
    evaluator: RiskEvaluator | None = None

    def __post_init__(self) -> None:
        if self.policy not in ("ask", "never"):
            raise ValueError("approval policy must be ask or never")


# JSON records have an explicit format_version; they use existing value/list storage.
def approval_request(request_id: str) -> ValueAddress[dict[str, Any]]:
    return ValueAddress(f"approval/request/{request_id}")


def approval_requests() -> ListAddress[str]:
    return ListAddress("approval/requests")


def approval_grant(grant_id: str) -> ValueAddress[dict[str, Any]]:
    return ValueAddress(f"approval/grant/{grant_id}")


def approval_grants() -> ListAddress[str]:
    return ListAddress("approval/grants")


def approval_audit() -> ListAddress[dict[str, Any]]:
    return ListAddress("approval/audit")
