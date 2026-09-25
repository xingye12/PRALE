from dataclasses import dataclass
from typing import Literal

from agent_harness.api.models import OperationKind, OperationResult
from agent_harness.domain.entries import JsonValue

ControlStatus = Literal["running", "cancel_requested"]


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


OperationTerminal = OperationResult
