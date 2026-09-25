from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from agent_harness.domain.entries import JsonValue


@dataclass(frozen=True, slots=True)
class GenerationRequest:
    session_id: str
    lane: str
    operation_id: str
    messages: tuple[JsonValue, ...]
    tools: tuple["ToolDefinition", ...] = ()


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: JsonValue


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: JsonValue
    parallel: bool = False


@dataclass(frozen=True, slots=True)
class AssistantResult:
    content: str
    usage: dict[str, int | float]
    finish_reason: str = "stop"
    tool_calls: tuple[ToolCall, ...] = ()


@dataclass(frozen=True, slots=True)
class GenerationDelta:
    """A provider-neutral, append-only assistant content frame.

    A stream always ends with an ``AssistantResult`` yielded by the provider;
    deltas exist only for observation and durable interruption checkpoints.
    """

    content: str


class ChatProvider(Protocol):
    """Provider-neutral boundary; DeepSeek is an adapter added later."""

    async def generate(self, request: GenerationRequest) -> AssistantResult: ...


class StreamingChatProvider(ChatProvider, Protocol):
    """Optional capability.  Callers must retain the one-shot fallback."""

    def stream(self, request: GenerationRequest) -> AsyncIterator[GenerationDelta | AssistantResult]: ...
