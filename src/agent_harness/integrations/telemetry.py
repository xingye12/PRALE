"""Optional event-based telemetry adapters with no runtime dependency."""

from collections import Counter
from dataclasses import dataclass, field

from agent_harness.runtime.events import HarnessEvent


@dataclass(slots=True)
class InMemoryTelemetry:
    """A deterministic listener useful for embedding applications and tests."""

    event_counts: Counter[str] = field(default_factory=Counter)
    operation_counts: Counter[str] = field(default_factory=Counter)
    handler_errors: list[str] = field(default_factory=list)

    def __call__(self, event: HarnessEvent) -> None:
        self.event_counts[event.type] += 1
        if event.type == "operation_started" and isinstance(event.data, dict):
            kind = event.data.get("kind")
            if isinstance(kind, str):
                self.operation_counts[kind] += 1
        if event.type == "handler_error" and isinstance(event.data, dict):
            error = event.data.get("error")
            if isinstance(error, str):
                self.handler_errors.append(error)
