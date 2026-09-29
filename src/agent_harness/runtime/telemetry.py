"""Structured execution facts, published after durable settlement.

A turn's outcome is decided by what the Session transaction committed; the
events below are a projection of that decision, published *afterwards* so that
an observer can never influence it.  Nothing here is authoritative: an
embedding application may lose every one of these events and the Session is
still exactly as correct.

The definitions live in ``runtime`` rather than in an adapter for two reasons.
``domain`` and ``storage`` stay free of any telemetry dependency, and a sink
(``integrations/langfuse.py``, a test double, an embedding application's own
collector) is written against a small local protocol instead of against one
vendor's SDK.

Values here are raw durable facts: the prompt, the messages, the tool
arguments, the tool result.  Deciding what may leave the process is the sink's
job, because only the deployment knows its capture policy.
"""

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol

from agent_harness.domain.entries import JsonValue

__all__ = [
    "EffectStatus",
    "GenerationTelemetry",
    "OperationPhase",
    "OperationTelemetry",
    "TelemetryEvent",
    "TelemetrySink",
    "ToolTelemetry",
    "close_telemetry",
    "publish",
]

_logger = logging.getLogger(__name__)

OperationPhase = Literal["started", "terminal"]
"""An operation is announced when it starts and closed when it is terminal."""

EffectStatus = Literal["completed", "failed", "aborted", "unknown"]
"""How one effect attempt ended, in PRALE's own vocabulary.

``unknown`` is not an error: it means the process cannot prove what the remote
side did, which is exactly what recovery records for an interrupted effect.
"""


@dataclass(frozen=True, slots=True)
class OperationTelemetry:
    """One ``run``, ``compaction`` or ``navigation`` operation.

    ``input`` and ``output`` are the scoring contract: an offline evaluator
    reads the prompt the turn was admitted with and the answer it settled on,
    so both are published whole and the sink decides how much of them may be
    uploaded.
    """

    session_id: str
    lane: str
    operation_id: str
    kind: str
    phase: OperationPhase
    input: JsonValue = None
    output: JsonValue = None
    status: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    started_at: int = 0
    ended_at: int | None = None
    metadata: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class GenerationTelemetry:
    """One provider attempt: a model call, never a whole Agent loop.

    ``attempt`` counts retries of one intent, so a turn that calls the model
    again after its tool results publishes a second fact that is also attempt
    one.  A retried call is therefore visible as a fact whose ``outcome`` is not
    ``completed``, not as a higher attempt number.
    """

    session_id: str
    lane: str
    operation_id: str
    attempt: int
    model: str | None
    input: JsonValue
    output: JsonValue
    usage: Mapping[str, int | float] = field(default_factory=dict)
    finish_reason: str | None = None
    outcome: EffectStatus = "completed"
    error_class: str | None = None
    error: str | None = None
    started_at: int | None = None
    ended_at: int = 0
    metadata: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ToolTelemetry:
    """One tool effect attempt, including hook blocks and unknown tools."""

    session_id: str
    lane: str
    operation_id: str
    tool_call_id: str
    name: str
    attempt: int
    input: JsonValue
    output: JsonValue
    is_error: bool = False
    outcome: EffectStatus = "completed"
    error_class: str | None = None
    started_at: int | None = None
    ended_at: int = 0


TelemetryEvent = OperationTelemetry | GenerationTelemetry | ToolTelemetry


class TelemetrySink(Protocol):
    """Where settled facts go.

    ``record`` is synchronous by contract.  It is called on the loop that runs
    a Drive, so it must enqueue and return rather than wait on anything: a
    slow or unavailable observer must not become a slow Agent loop.
    """

    def record(self, event: TelemetryEvent) -> None: ...


def publish(sink: TelemetrySink | None, event: TelemetryEvent) -> None:
    """Hand one settled fact to the sink, if there is one.

    Called from the Agent loop, so a sink that raises is contained here: the
    turn has already been committed and its outcome must not change because an
    observer failed.  The failure is logged rather than re-published as a
    ``HarnessEvent`` — an observer's own error must not re-enter the bus that
    feeds it.
    """

    if sink is None:
        return
    try:
        sink.record(event)
    except Exception:
        _logger.warning("telemetry sink rejected a %s", type(event).__name__, exc_info=True)


async def close_telemetry(sink: TelemetrySink | None) -> None:
    """Give a sink that has something to drain the chance to do it.

    Closing is an optional capability rather than part of the protocol, in the
    same way a storage backend may or may not expose ``bind_session``: an
    in-memory collector has nothing to release, and requiring it to say so would
    make the protocol a framework.
    """

    close = getattr(sink, "aclose", None)
    if not callable(close):
        return
    try:
        await close()
    except Exception:
        _logger.warning("telemetry sink failed to close", exc_info=True)
