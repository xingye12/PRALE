"""Pure, provider-neutral request-context budgeting and reductions.

The functions in this module deliberately operate on copies of provider
messages.  Session entries remain the authoritative, immutable transcript.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import cast

from agent_harness.domain.entries import JsonValue

OLD_TOOL_RESULT_CONTENT_CLEARED = "[Old tool result content cleared]"


@dataclass(frozen=True, slots=True)
class ContextManagementConfig:
    """Budgets for the automatic, pre-request context projection.

    ``context_window_tokens`` may be ``None`` for providers that do not
    publish a context window.  In that case lossless hard trimming remains
    active while automatic summary/collapse is disabled.
    """

    enabled: bool = True
    context_window_tokens: int | None = 128_000
    reserved_output_tokens: int = 20_000
    reserved_system_tokens: int = 0
    soft_margin_tokens: int = 13_000
    hard_margin_tokens: int = 3_000
    per_tool_result_chars: int = 50_000
    per_tool_message_chars: int = 200_000
    protected_recent_messages: int = 6
    microcompact_keep_recent: int = 5
    collapse_enabled: bool = True
    auto_compact_enabled: bool = True
    max_summary_retries: int = 3

    def __post_init__(self) -> None:
        positive = (
            self.reserved_output_tokens,
            self.soft_margin_tokens,
            self.hard_margin_tokens,
            self.per_tool_result_chars,
            self.per_tool_message_chars,
            self.protected_recent_messages,
            self.microcompact_keep_recent,
            self.max_summary_retries,
        )
        if any(value < 1 for value in positive) or self.reserved_system_tokens < 0:
            raise ValueError("context-management limits must be positive")
        if self.context_window_tokens is not None:
            if self.context_window_tokens <= 0:
                raise ValueError("context_window_tokens must be positive")
            hard_limit = self.hard_limit_tokens
            soft_limit = self.soft_limit_tokens
            assert hard_limit is not None and soft_limit is not None
            if hard_limit <= 0 or soft_limit <= 0:
                raise ValueError("context window is smaller than its reservations")
            if soft_limit > hard_limit:
                raise ValueError("soft limit must not exceed hard limit")

    @property
    def soft_limit_tokens(self) -> int | None:
        if self.context_window_tokens is None:
            return None
        return (
            self.context_window_tokens
            - self.reserved_output_tokens
            - self.reserved_system_tokens
            - self.soft_margin_tokens
        )

    @property
    def hard_limit_tokens(self) -> int | None:
        if self.context_window_tokens is None:
            return None
        return (
            self.context_window_tokens
            - self.reserved_output_tokens
            - self.reserved_system_tokens
            - self.hard_margin_tokens
        )


@dataclass(frozen=True, slots=True)
class ContextReductionReport:
    estimated_tokens_before: int
    estimated_tokens_after: int
    trimmed_tool_results: int = 0
    micro_cleared_tool_results: int = 0
    snipped_messages: int = 0
    source_hashes: tuple[str, ...] = ()

    @property
    def tokens_saved(self) -> int:
        return max(0, self.estimated_tokens_before - self.estimated_tokens_after)


@dataclass(frozen=True, slots=True)
class ContextReduction:
    messages: tuple[JsonValue, ...]
    report: ContextReductionReport


def estimate_messages(messages: list[JsonValue] | tuple[JsonValue, ...]) -> int:
    """Conservative, tokenizer-independent estimate of final JSON wire size."""

    encoded = json.dumps(messages, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return (len(encoded) + 2) // 3


def _as_message(value: JsonValue) -> dict[str, JsonValue] | None:
    return value if isinstance(value, dict) and isinstance(value.get("role"), str) else None


def _text(value: JsonValue | object) -> str | None:
    return value if isinstance(value, str) else None


def _preview(content: str, limit: int, details: object) -> str:
    if len(content) <= limit:
        return content
    # Prefer a stable leading preview at a line boundary.  The authoritative
    # entry still has the full result and any existing paging/file handle.
    cut = content.rfind("\n", 0, max(1, limit - 1))
    if cut <= 0:
        cut = max(1, limit - 1)
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]
    handle = ""
    if isinstance(details, dict):
        path = details.get("full_output_path") or details.get("path")
        if isinstance(path, str):
            handle = f"; handle={path}"
    return f"{content[:cut]}\n[tool result trimmed: chars={len(content)} sha256={digest}{handle}]"


def hard_trim_tool_results(
    messages: list[JsonValue], config: ContextManagementConfig
) -> tuple[list[JsonValue], int, tuple[str, ...]]:
    """Trim only the request projection of oversized tool result messages."""

    result: list[JsonValue] = []
    trimmed = 0
    hashes: list[str] = []
    for raw in messages:
        message = _as_message(raw)
        if message is None or message.get("role") != "tool":
            result.append(raw)
            continue
        content = _text(message.get("content"))
        if content is None:
            result.append(raw)
            continue
        limit = min(config.per_tool_result_chars, config.per_tool_message_chars)
        if len(content) <= limit:
            result.append(raw)
            continue
        replacement = _preview(content, limit, message.get("details"))
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        copy = {
            **message,
            "content": replacement,
            "_context_management": {"kind": "hard_trim", "source_sha256": digest},
        }
        result.append(cast(JsonValue, copy))
        trimmed += 1
        hashes.append(digest)
    return result, trimmed, tuple(hashes)


def snip_compact_if_needed(messages: list[JsonValue], config: ContextManagementConfig) -> tuple[list[JsonValue], int]:
    """Drop the oldest complete messages when the soft budget is exceeded.

    The tail is protected, so the most recent prompt and adjacent tool exchange
    are never removed.  This is a request-only reduction; its exact output is
    frozen in the following effect intent.
    """

    soft = config.soft_limit_tokens
    if not config.enabled or soft is None or estimate_messages(messages) <= soft:
        return messages, 0
    protected = min(len(messages), config.protected_recent_messages)
    removable = max(0, len(messages) - protected)
    if removable == 0:
        return messages, 0
    kept = list(messages)
    removed = 0
    while removable > 0 and estimate_messages(kept) > soft:
        kept.pop(0)
        removed += 1
        removable -= 1
    if removed:
        notice: JsonValue = {
            "role": "system",
            "content": f"[Earlier conversation messages omitted for context budget: {removed}]",
        }
        kept.insert(0, notice)
    return kept, removed


def microcompact_messages(
    messages: list[JsonValue], config: ContextManagementConfig
) -> tuple[list[JsonValue], int, tuple[str, ...]]:
    """Clear old successful tool result content after snip under soft pressure."""

    soft = config.soft_limit_tokens
    if not config.enabled or soft is None or estimate_messages(messages) <= soft:
        return messages, 0, ()
    tool_indexes = [
        index
        for index, raw in enumerate(messages)
        if (message := _as_message(raw)) is not None
        and message.get("role") == "tool"
        and not bool(message.get("is_error"))
        and _text(message.get("content")) not in {None, OLD_TOOL_RESULT_CONTENT_CLEARED}
    ]
    candidates = tool_indexes[: max(0, len(tool_indexes) - config.microcompact_keep_recent)]
    result = list(messages)
    cleared = 0
    hashes: list[str] = []
    for index in candidates:
        if estimate_messages(result) <= soft:
            break
        message = _as_message(result[index])
        assert message is not None
        content = _text(message.get("content"))
        assert content is not None
        hashes.append(hashlib.sha256(content.encode("utf-8")).hexdigest())
        result[index] = cast(
            JsonValue,
            {
                **message,
                "content": OLD_TOOL_RESULT_CONTENT_CLEARED,
                "_context_management": {"kind": "micro_clear", "source_sha256": hashes[-1]},
            },
        )
        cleared += 1
    return result, cleared, tuple(hashes)


def reduce_request_messages(messages: list[JsonValue], config: ContextManagementConfig) -> ContextReduction:
    """Apply non-LLM reductions in the documented query-preparation order."""

    before = estimate_messages(messages)
    trimmed, trim_count, trim_hashes = hard_trim_tool_results(list(messages), config)
    snipped, snip_count = snip_compact_if_needed(trimmed, config)
    compacted, clear_count, clear_hashes = microcompact_messages(snipped, config)
    return ContextReduction(
        tuple(compacted),
        ContextReductionReport(
            before,
            estimate_messages(compacted),
            trim_count,
            clear_count,
            snip_count,
            (*trim_hashes, *clear_hashes),
        ),
    )


def needs_summary(messages: list[JsonValue] | tuple[JsonValue, ...], config: ContextManagementConfig) -> bool:
    """Whether non-LLM reductions left the request above the soft budget."""

    return bool(
        config.enabled
        and config.soft_limit_tokens is not None
        and estimate_messages(messages) > config.soft_limit_tokens
    )


def build_compaction_prompt(messages: list[JsonValue], *, retry: bool = False) -> list[JsonValue]:
    """Create the provider-neutral, no-tools request for a continuation summary."""

    retry_note = "\n[earlier conversation truncated for compaction retry]" if retry else ""
    return [
        {
            "role": "system",
            "content": (
                "You compact an agent conversation. Return only a concise continuation summary that preserves "
                "the user's goals, decisions, constraints, file paths, pending work, and tool findings. "
                "Do not call tools. You may reason inside <analysis> tags, but put the final summary after them."
            ),
        },
        *messages,
        {
            "role": "user",
            "content": (
                "Summarize the selected earlier conversation so this session can continue without it." + retry_note
            ),
        },
    ]


def format_compact_summary(content: str) -> str | None:
    """Remove optional scratch analysis and reject an empty final summary."""

    remaining = content
    while "<analysis>" in remaining and "</analysis>" in remaining:
        start = remaining.index("<analysis>")
        end = remaining.index("</analysis>", start) + len("</analysis>")
        remaining = remaining[:start] + remaining[end:]
    summary = remaining.strip()
    return summary or None


def continuation_summary_message(summary: str) -> JsonValue:
    return {
        "role": "user",
        "content": f"This session is being continued from a compacted earlier conversation.\n\n{summary}",
    }
