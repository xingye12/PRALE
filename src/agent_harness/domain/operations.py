from dataclasses import dataclass
from typing import Literal

from agent_harness.domain.entries import JsonValue
from agent_harness.domain.types import OperationKind, OperationStatus

ControlStatus = Literal["running", "cancel_requested", "settled"]
"""``settled`` is written by the terminal state itself: an operation that ended
must not keep claiming that a Drive is still running."""


@dataclass(frozen=True, slots=True)
class OperationMeta:
    operation_id: str
    lane: str
    source_tip_id: str | None
    started_at: int
    kind: OperationKind
    request: JsonValue


@dataclass(frozen=True, slots=True)
class OperationState:
    """Whole durable restart point; replace it, never patch it in place."""

    at: str
    control: ControlStatus
    data: JsonValue


@dataclass(frozen=True, slots=True)
class ActiveOperation:
    meta: OperationMeta
    state: OperationState


@dataclass(frozen=True, slots=True)
class OperationResult:
    operation_id: str
    kind: OperationKind
    status: OperationStatus
    from_tip_id: str | None
    tip_id: str | None
    started_at: int
    ended_at: int
    error_code: str | None = None
    error_message: str | None = None
