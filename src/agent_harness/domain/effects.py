"""Append-only records of the external effects a Drive performed.

These records exist so that the cost of a turn survives the thing that produced
it: the process, the provider connection and the live event stream are all gone
by the time a UI asks what happened, and only durable rows can answer.

A span is written when the effect intent is committed and settled in the same
transaction as its outcome, so "pending" is a durable fact rather than a gap.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

type EffectKind = Literal["llm", "tool"]
"""``llm`` covers provider generation; ``tool`` covers one tool invocation."""

type EffectOutcome = Literal["pending", "completed", "failed", "aborted", "unknown"]
"""``pending`` means the effect was issued and never settled; ``unknown`` means it
was settled without a provable outcome (its result was lost to a crash)."""

type ErrorClass = Literal["provider_error", "tool_error", "hook_blocked", "unknown_tool", "interrupted"]


@dataclass(frozen=True, slots=True)
class EffectSpan:
    """One attempt at one external effect.

    ``call_id`` correlates the span with the effect's durable source: a tool's
    ``tool_call_id`` (whose name, arguments and order already live in the
    assistant entry) or the assistant entry reserved by a generation intent.
    Tool names and arguments are deliberately not duplicated here.
    """

    span_id: str
    operation_id: str
    call_id: str
    kind: EffectKind
    lane: str
    attempt: int
    started_at: int
    outcome: EffectOutcome = "pending"
    ended_at: int | None = None
    error_class: ErrorClass | None = None

    @property
    def settled(self) -> bool:
        return self.outcome != "pending"

    @property
    def duration_ms(self) -> int | None:
        """Call duration, or ``None`` when no duration can be proven.

        A pending span has no end.  An ``unknown`` span was settled by a
        recovery that ran long after the effect stopped, so its ``ended_at``
        records when the record was closed rather than how long the call took;
        reporting the difference would invent a duration for an effect we could
        not observe.

        Callers must not substitute the enclosing turn's duration either: it
        includes retry backoff and every sibling call of the same turn.
        """

        if self.ended_at is None or self.outcome in ("pending", "unknown"):
            return None
        return max(0, self.ended_at - self.started_at)


@dataclass(frozen=True, slots=True)
class UsageRecord:
    """One provider-reported usage report, attributed to its operation span."""

    id: str
    operation_id: str | None
    entry_id: str | None
    span_id: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    raw: dict[str, int | float]

    @property
    def legacy_unattributed(self) -> bool:
        """True for rows written before operations owned their usage.

        Those rows only ever had an entry binding, and that binding is not
        proof of which operation the tokens belong to.
        """

        return self.operation_id is None


_INPUT_KEYS = ("input_tokens", "prompt_tokens", "prompt_token_count")
_OUTPUT_KEYS = ("output_tokens", "completion_tokens", "completion_token_count")
_TOTAL_KEYS = ("total_tokens", "total_token_count")


def normalize_usage(usage: Mapping[str, object]) -> tuple[int | None, int | None, int | None]:
    """Return ``(input, output, total)`` from provider-specific usage fields.

    An absent field stays ``None``: a provider that reported no token count did
    not report zero, and callers must render it as unknown rather than as a
    number they invented. ``total`` is only derived when the provider gave both
    halves and no total of its own.
    """

    input_tokens = _first_count(usage, _INPUT_KEYS)
    output_tokens = _first_count(usage, _OUTPUT_KEYS)
    total_tokens = _first_count(usage, _TOTAL_KEYS)
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    return input_tokens, output_tokens, total_tokens


def _first_count(usage: Mapping[str, object], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
    return None


def as_usage(value: object) -> dict[str, int | float]:
    """Narrow a decoded usage payload to the numeric fields providers may send."""

    if not isinstance(value, Mapping):
        return {}
    return {
        key: float(item) if isinstance(item, float) else int(item)
        for key, item in value.items()
        if isinstance(item, (int, float)) and not isinstance(item, bool)
    }


__all__ = ["EffectKind", "EffectOutcome", "EffectSpan", "ErrorClass", "UsageRecord", "as_usage", "normalize_usage"]
