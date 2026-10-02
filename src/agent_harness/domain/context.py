"""Pure entry-tree projection for provider requests."""

from agent_harness.domain.context_management import continuation_summary_message
from agent_harness.domain.entries import Entry, JsonValue


def project_messages(entries: list[Entry]) -> list[JsonValue]:
    """Return provider-visible message payloads in stable branch order.

    Structural entries remain durable history but are represented as their
    payload only when their type is a conversation message.
    """

    latest_summary_index = max(
        (
            index
            for index, entry in enumerate(entries)
            if entry.type in {"compaction", "context_collapse", "branch_summary"}
        ),
        default=-1,
    )
    if latest_summary_index < 0:
        return [entry.payload for entry in entries if entry.type == "message"]

    summary_entry = entries[latest_summary_index]
    summary_payload = summary_entry.payload
    if not isinstance(summary_payload, dict) or not isinstance(summary_payload.get("summary"), str):
        raise ValueError(f"structural entry {summary_entry.id!r} lacks a string summary")
    retained_ids = summary_payload.get("retained_message_ids", [])
    if not isinstance(retained_ids, list) or not all(isinstance(entry_id, str) for entry_id in retained_ids):
        retained_ids = []
    retained = [
        entry.payload
        for entry in entries[:latest_summary_index]
        if entry.type == "message" and entry.id in retained_ids
    ]
    following = [entry.payload for entry in entries[latest_summary_index + 1 :] if entry.type == "message"]
    summary = summary_payload["summary"]
    assert isinstance(summary, str)
    summary_message: JsonValue = (
        continuation_summary_message(summary)
        if summary_payload.get("prompt_version") == 1
        else {"role": "system", "content": f"Conversation summary:\n{summary}"}
    )
    return [
        summary_message,
        *retained,
        *following,
    ]
