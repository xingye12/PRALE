from dataclasses import dataclass
from typing import Literal

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | list[JsonValue] | dict[str, JsonValue]
EntryType = Literal["message", "compaction", "context_collapse", "branch_summary", "custom"]


@dataclass(frozen=True, slots=True)
class Entry:
    """Immutable node in a session's conversation tree."""

    id: str
    parent_id: str | None
    seq: int
    timestamp: int
    type: EntryType
    payload: JsonValue
    custom_type: str | None = None


@dataclass(frozen=True, slots=True)
class NewEntry:
    """An entry before the storage transaction assigns sequence and timestamp."""

    id: str
    parent_id: str | None
    type: EntryType
    payload: JsonValue
    custom_type: str | None = None
