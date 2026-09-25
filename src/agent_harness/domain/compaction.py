"""Pure compaction selection; it has no provider or storage dependencies."""

from dataclasses import dataclass

from agent_harness.domain.entries import Entry


@dataclass(frozen=True, slots=True)
class CompactionWindow:
    summarize: tuple[Entry, ...]
    retain: tuple[Entry, ...]


def select_compaction_window(entries: list[Entry], retain_recent: int = 8) -> CompactionWindow:
    """Keep a bounded recent tail while selecting older records for summary."""

    if retain_recent < 0:
        raise ValueError("retain_recent must be non-negative")
    if len(entries) <= retain_recent:
        return CompactionWindow((), tuple(entries))
    return CompactionWindow(tuple(entries[:-retain_recent]), tuple(entries[-retain_recent:]))
