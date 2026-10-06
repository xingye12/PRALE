"""Pure subagent contracts and versioned durable addresses."""

import re
from dataclasses import asdict, dataclass
from typing import Any, Literal

from agent_harness.domain.types import OperationStatus
from agent_harness.domain.values import ListAddress, ValueAddress

CONTROL_NAMES = ("subagent", "subagent_continue", "subagent_output", "subagent_list", "subagent_stop")
INTERNAL_PREFIX = "__subagent__/"
READ_TOOLS = ("read", "repository_explore", "memory_search", "conversation_search", "memory_read_scene", "skill_load")


class SubagentError(Exception):
    pass


class SubagentsDisabled(SubagentError):
    pass


class UnknownSubagentType(SubagentError):
    pass


class UnknownSubagentRun(SubagentError):
    pass


class SubagentBusy(SubagentError):
    pass


class InvalidSubagentDefinition(SubagentError):
    pass


class SubagentCapacityExceeded(SubagentError):
    pass


class SubagentOwnershipError(SubagentError):
    pass


class SubagentCapabilityUnavailable(SubagentError):
    pass


class SubagentIdempotencyConflict(SubagentError):
    pass


class IncompleteSubagentState(RuntimeError):
    pass


def positive(value: int, name: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{name} must be a positive integer")


@dataclass(frozen=True, slots=True)
class SubagentConfig:
    enabled: bool = True
    max_running: int = 4
    max_nonterminal: int = 64
    max_result_tokens: int = 4096

    def __post_init__(self) -> None:
        if not isinstance(self.enabled, bool):
            raise ValueError("enabled must be boolean")
        for name in ("max_running", "max_nonterminal", "max_result_tokens"):
            positive(getattr(self, name), name)


@dataclass(frozen=True, slots=True)
class SubagentDefinition:
    name: str
    description: str
    system_prompt: str
    tools: tuple[str, ...] | None = None
    disallowed_tools: tuple[str, ...] = ()
    model: str | None = None
    max_turns: int = 50
    background: bool = False

    def __post_init__(self) -> None:
        try:
            if not isinstance(self.name, str) or re.fullmatch(r"[A-Za-z0-9_-]+", self.name) is None:
                raise ValueError("invalid agent name")
            if any(not isinstance(s, str) or not s.strip() for s in (self.description, self.system_prompt)):
                raise ValueError("description and system_prompt must be non-empty")
            positive(self.max_turns, "max_turns")
            if not isinstance(self.background, bool):
                raise ValueError("background must be boolean")
            if self.model is not None and (not isinstance(self.model, str) or not self.model.strip()):
                raise ValueError("model must be a non-empty string")
            if self.model == "inherit":
                object.__setattr__(self, "model", None)
            for values in (self.tools, self.disallowed_tools):
                if values is not None and (
                    not isinstance(values, tuple)
                    or any(not isinstance(v, str) or not v for v in values)
                    or len(values) != len(set(values))
                ):
                    raise ValueError("tools must be tuples of unique non-empty names")
            if self.tools and "*" in self.tools and self.tools != ("*",):
                raise ValueError("wildcard cannot be combined with tool names")
            if "*" in self.disallowed_tools:
                raise ValueError("disallowed_tools uses exact names")
        except ValueError as error:
            raise InvalidSubagentDefinition(str(error)) from error

    def to_json(self) -> dict[str, Any]:
        return {"format_version": 1, **asdict(self)}

    @classmethod
    def from_json(cls, value: object) -> "SubagentDefinition":
        data = record(value)
        data = {k: v for k, v in data.items() if k != "format_version"}
        for name in ("tools", "disallowed_tools"):
            if data.get(name) is not None:
                data[name] = tuple(data[name])
        return cls(**data)


@dataclass(frozen=True, slots=True)
class SubagentRequest:
    prompt: str
    description: str
    subagent_type: str = "general-purpose"
    context: str | None = None
    model: str | None = None
    max_turns: int | None = None
    run_in_background: bool | None = None

    def __post_init__(self) -> None:
        if any(not isinstance(s, str) or not s.strip() for s in (self.prompt, self.description, self.subagent_type)):
            raise ValueError("prompt, description and subagent_type must be non-empty")
        if self.context is not None and not isinstance(self.context, str):
            raise ValueError("context must be a string")
        if self.model is not None and (not isinstance(self.model, str) or not self.model.strip()):
            raise ValueError("model must be a non-empty string")
        if self.max_turns is not None:
            positive(self.max_turns, "max_turns")
        if self.run_in_background is not None and not isinstance(self.run_in_background, bool):
            raise ValueError("run_in_background must be boolean")


@dataclass(frozen=True, slots=True)
class SubagentAdmission:
    agent_id: str
    run_id: str
    operation_id: str
    background: bool


@dataclass(frozen=True, slots=True)
class SubagentResult:
    status: OperationStatus
    answer: str
    answer_entry_id: str | None
    terminal_tip_id: str | None
    truncated: bool
    error_code: str | None


@dataclass(frozen=True, slots=True)
class SubagentSnapshot:
    agent_id: str
    run_id: str
    operation_id: str
    parent_lane: str
    parent_operation_id: str
    description: str
    state: Literal["queued", "running", "terminal"]
    cancel_requested: bool
    started_at: int
    ended_at: int | None
    result: SubagentResult | None


@dataclass(frozen=True, slots=True)
class SubagentWaitResult:
    retrieval_status: Literal["ready", "timeout"]
    snapshot: SubagentSnapshot


@dataclass(frozen=True, slots=True)
class SubagentStopResult:
    run_id: str
    status: Literal["requested", "already_requested", "already_terminal"]


@dataclass(frozen=True, slots=True)
class SubagentRecoveryReport:
    recovered: tuple[str, ...] = ()
    queued: tuple[str, ...] = ()
    terminal: tuple[str, ...] = ()
    unavailable: tuple[str, ...] = ()
    incomplete: tuple[str, ...] = ()


def value(key: str) -> ValueAddress[object]:
    return ValueAddress(key)


def index(key: str) -> ListAddress[object]:
    return ListAddress(key)


def record(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict) or type(raw.get("format_version")) is not int or raw.get("format_version") != 1:
        raise IncompleteSubagentState("missing or unsupported subagent durable record")
    return raw


def built_in_definitions() -> tuple[SubagentDefinition, ...]:
    return (
        SubagentDefinition(
            "general-purpose", "Execute a delegated task", "Complete the delegated task and return your findings."
        ),
        SubagentDefinition(
            "explore",
            "Read and investigate code",
            "Investigate the task using the available read-only tools. Return evidence and source references.",
            tools=READ_TOOLS,
        ),
        SubagentDefinition(
            "plan",
            "Develop an implementation plan",
            "Analyze the task with the available read-only tools and return an actionable implementation plan.",
            tools=READ_TOOLS,
        ),
    )
