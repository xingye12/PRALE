from agent_harness.domain.memory import PromotionConflict

__all__ = ["PromotionConflict"]


class HarnessError(Exception):
    """Base class for domain-level harness errors."""


class LaneBusy(HarnessError):
    def __init__(self, lane: str, operation_id: str) -> None:
        super().__init__(f"lane {lane!r} is busy with operation {operation_id!r}")
        self.lane = lane
        self.operation_id = operation_id


class InvalidLane(HarnessError):
    pass


class OperationMismatch(HarnessError):
    pass


class ProviderNotConfigured(HarnessError):
    pass


class OperationAlreadyExists(HarnessError):
    pass


class NothingToCompact(HarnessError):
    """The selected branch has no prior history eligible for compaction."""


class ContextBudgetExceeded(HarnessError):
    """The final provider request cannot fit the configured context window."""

    def __init__(self, estimated_tokens: int, hard_limit_tokens: int) -> None:
        super().__init__(f"context requires {estimated_tokens} tokens; hard limit is {hard_limit_tokens}")
        self.estimated_tokens = estimated_tokens
        self.hard_limit_tokens = hard_limit_tokens


class UnknownTarget(HarnessError):
    """A navigation request refers to an entry outside the session tree."""


class MemoryScopeDenied(HarnessError):
    pass


class RecallBudgetExceeded(HarnessError):
    pass


class MemoryNotFound(HarnessError):
    pass


class UnsupportedPromptMode(HarnessError):
    pass


class SessionNotFound(HarnessError):
    """A session was requested that the catalog does not authorize."""


class InvalidCursor(HarnessError):
    """A pagination cursor was malformed or belonged to another query."""


class ProjectConfigError(HarnessError):
    """The application configuration cannot identify a usable project root."""
