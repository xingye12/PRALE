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
