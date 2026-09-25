from dataclasses import dataclass
from typing import Literal

OperationKind = Literal["run", "compaction", "navigation"]
OperationStatus = Literal["completed", "declined", "aborted", "failed"]


@dataclass(frozen=True, slots=True)
class OperationAdmission:
    operation_id: str
    kind: OperationKind
    started_at: int


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


@dataclass(frozen=True, slots=True)
class LaneSnapshot:
    name: str
    tip_id: str | None
    operation_id: str | None
    last_operation_id: str | None
