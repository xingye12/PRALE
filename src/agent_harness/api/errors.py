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
