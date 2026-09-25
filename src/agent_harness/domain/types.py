from typing import Literal

type OperationKind = Literal["run", "compaction", "navigation"]
type OperationStatus = Literal["completed", "declined", "aborted", "failed"]
