from typing import Literal

type OperationKind = Literal["run", "compaction", "navigation"]
type OperationStatus = Literal["completed", "declined", "aborted", "failed", "unknown"]
"""``unknown`` is written when an operation ended without a provable outcome:
the effect was issued, its result was never persisted, and no party can prove
whether the remote side completed it."""
