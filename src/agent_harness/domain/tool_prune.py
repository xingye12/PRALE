"""Pure tool pruning, original-tail selection and branch-local reduction projection."""

import hashlib
import json
from dataclasses import dataclass

from agent_harness.domain.context import project_messages
from agent_harness.domain.context_management import (
    TOOL_PRUNE_MARKER,
    ContextManagementConfig,
    ContextReduction,
    ContextReductionReport,
    estimate_messages,
    needs_summary,
)
from agent_harness.domain.entries import Entry, JsonValue

PRUNE_MARKER = TOOL_PRUNE_MARKER


def message_hash(message: JsonValue) -> str:
    return hashlib.sha256(json.dumps(message, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def protected_start(messages: list[JsonValue], config: ContextManagementConfig) -> int:
    """Select from ORIGINAL messages, expanding backwards to a balanced cut.

    User/system anchors are retained separately by ContextView. Protecting a
    user request must not protect every later tool step in a long-running turn.
    A cut cannot leave a tool result without its call, including parallel calls.
    """
    boundary = len(messages)
    for index in range(len(messages) - 1, -1, -1):
        boundary = index
        if estimate_messages(messages[index:]) >= config.retain_tokens:
            break
    pending: set[str] = set()
    safe = 0
    for i, message in enumerate(messages[:boundary]):
        if not isinstance(message, dict):
            continue
        calls = message.get("tool_calls")
        if isinstance(calls, list):
            pending.update(call_id for c in calls if isinstance(c, dict) and isinstance(call_id := c.get("id"), str))
        if message.get("role") == "tool" and isinstance(message.get("tool_call_id"), str):
            call_id = message["tool_call_id"]
            assert isinstance(call_id, str)
            if call_id not in pending:
                return 0  # malformed history is never made less complete
            pending.discard(call_id)
        if not pending:
            safe = i + 1
    return safe if pending else boundary


def prune_content(content: JsonValue, config: ContextManagementConfig) -> JsonValue:
    """Prune aggregated text while preserving rich-block order and metadata."""
    if isinstance(content, str):
        if len(content) <= config.tool_prune_threshold_chars:
            return content
        tail = content[-config.tool_prune_tail_chars :] if config.tool_prune_tail_chars else ""
        return content[: config.tool_prune_head_chars] + PRUNE_MARKER + tail
    if not isinstance(content, list):
        return content
    total = sum(
        len(text)
        for b in content
        if isinstance(b, dict) and b.get("type") == "text" and isinstance(text := b.get("text"), str)
    )
    if total <= config.tool_prune_threshold_chars:
        return content
    result: list[JsonValue] = []
    offset = 0
    marked = False
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text" or not isinstance(block.get("text"), str):
            result.append(block)
            continue
        text = block["text"]
        assert isinstance(text, str)
        end = offset + len(text)
        head = text[: max(0, config.tool_prune_head_chars - offset)]
        tail = text[max(0, total - config.tool_prune_tail_chars - offset) :]
        marker = ""
        if not marked and offset < total - config.tool_prune_tail_chars and end > config.tool_prune_head_chars:
            marker = PRUNE_MARKER
            marked = True
        if head or marker or tail:
            result.append({**block, "text": head + marker + tail})
        offset = end
    return result


def reduce_tools(
    messages: list[JsonValue],
    config: ContextManagementConfig,
    *,
    boundary: int | None = None,
    pressure: bool | None = None,
) -> ContextReduction:
    before = estimate_messages(messages)
    if pressure is None:
        pressure = needs_summary(messages, config)
    if not config.enabled or not pressure:
        return ContextReduction(tuple(messages), ContextReductionReport(before, before))
    if boundary is None:
        boundary = protected_start(messages, config)
    result = list(messages)
    hashes = []
    for index, message in enumerate(messages[:boundary]):
        if not isinstance(message, dict) or message.get("role") != "tool":
            continue
        content = message.get("content")
        replacement = prune_content(content, config)
        if replacement != content:
            hashes.append(message_hash(message))
            result[index] = {**message, "content": replacement}
    return ContextReduction(
        tuple(result),
        ContextReductionReport(before, estimate_messages(result), len(hashes), source_hashes=tuple(hashes)),
    )


@dataclass(frozen=True)
class ContextView:
    originals: tuple[JsonValue, ...]
    messages: tuple[JsonValue, ...]
    source_ids: tuple[str, ...]
    boundary: int
    restored_ids: tuple[str, ...] = ()
    request_index: int = -1

    @property
    def retained_ids(self) -> list[str]:
        return [
            source_id
            for i, (source_id, message) in enumerate(zip(self.source_ids, self.originals, strict=True))
            if i >= self.boundary
            or i == self.request_index
            or (isinstance(message, dict) and message.get("role") == "system")
        ]


def context_view(entries: list[Entry], config: ContextManagementConfig) -> ContextView:
    originals = project_messages(entries)
    latest = next(
        (e for e in reversed(entries) if e.type in {"compaction", "context_collapse", "branch_summary"}), None
    )
    ids = []
    cursor = 0
    for index, message in enumerate(originals):
        if index == 0 and latest is not None:
            ids.append(latest.id)
            continue
        for position in range(cursor, len(entries)):
            entry = entries[position]
            if entry.type == "message" and entry.payload is message:
                ids.append(entry.id)
                cursor = position + 1
                break
        else:
            raise ValueError("projection has no source entry")
    boundary = protected_start(originals, config)
    messages = list(originals)
    restored: set[str] = set()
    for entry in entries:
        record = entry.payload
        if entry.type != "custom" or not isinstance(record, dict) or record.get("kind") != "context_tool_prune":
            continue
        source_id = record.get("source_entry_id")
        if source_id not in ids:
            continue
        index = ids.index(source_id)
        if index >= boundary and record.get("source_hash") == message_hash(originals[index]):
            restored.add(ids[index])
        if index < boundary and record.get("source_hash") == message_hash(originals[index]):
            replacement = record.get("message")
            if isinstance(replacement, dict):
                messages[index] = replacement
    entry_types = {entry.id: entry.type for entry in entries}
    request_index = next(
        (
            i
            for i in range(len(originals) - 1, -1, -1)
            if entry_types[ids[i]] == "message" and isinstance(m := originals[i], dict) and m.get("role") == "user"
        ),
        -1,
    )
    return ContextView(tuple(originals), tuple(messages), tuple(ids), boundary, tuple(sorted(restored)), request_index)
