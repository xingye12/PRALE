from agent_harness.domain.compaction import select_compaction_window
from agent_harness.domain.context import project_messages
from agent_harness.domain.entries import Entry


def test_context_projection_omits_structural_entries_and_compaction_keeps_recent_tail() -> None:
    entries = [
        Entry("one", None, 1, 1, "message", {"role": "user", "content": "one"}),
        Entry("summary", "one", 2, 2, "compaction", {"summary": "old"}),
        Entry("two", "summary", 3, 3, "message", {"role": "assistant", "content": "two"}),
    ]

    assert project_messages(entries) == [
        {"role": "system", "content": "Conversation summary:\nold"},
        {"role": "assistant", "content": "two"},
    ]
    window = select_compaction_window(entries, retain_recent=1)
    assert [entry.id for entry in window.summarize] == ["one", "summary"]
    assert [entry.id for entry in window.retain] == ["two"]


def test_context_projection_replaces_summarized_history_with_summary_and_declared_tail() -> None:
    entries = [
        Entry("one", None, 1, 1, "message", {"role": "user", "content": "one"}),
        Entry("two", "one", 2, 2, "message", {"role": "assistant", "content": "two"}),
        Entry(
            "summary",
            "two",
            3,
            3,
            "compaction",
            {"summary": "one happened", "retained_message_ids": ["two"]},
        ),
        Entry("three", "summary", 4, 4, "message", {"role": "user", "content": "three"}),
    ]

    assert project_messages(entries) == [
        {"role": "system", "content": "Conversation summary:\none happened"},
        {"role": "assistant", "content": "two"},
        {"role": "user", "content": "three"},
    ]
