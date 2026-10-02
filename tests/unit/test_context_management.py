from agent_harness.domain.context_management import (
    OLD_TOOL_RESULT_CONTENT_CLEARED,
    ContextManagementConfig,
    build_compaction_prompt,
    continuation_summary_message,
    format_compact_summary,
    reduce_request_messages,
)


def _config(**values: object) -> ContextManagementConfig:
    defaults: dict[str, object] = {
        "context_window_tokens": 500,
        "reserved_output_tokens": 50,
        "soft_margin_tokens": 100,
        "hard_margin_tokens": 25,
        "per_tool_result_chars": 40,
        "per_tool_message_chars": 80,
        "protected_recent_messages": 2,
        "microcompact_keep_recent": 1,
    }
    return ContextManagementConfig(**{**defaults, **values})  # type: ignore[arg-type]


def test_request_reduction_trims_tool_projection_without_mutating_source() -> None:
    source = [{"role": "tool", "tool_call_id": "call-1", "content": "line\n" * 30, "details": {"path": "a.py"}}]

    reduced = reduce_request_messages(source, _config())

    assert source[0]["content"] == "line\n" * 30
    assert "[tool result trimmed:" in reduced.messages[0]["content"]  # type: ignore[index]
    assert reduced.messages[0]["_context_management"]["kind"] == "hard_trim"  # type: ignore[index]
    assert reduced.report.trimmed_tool_results == 1


def test_microcompact_clears_only_old_successful_tool_results() -> None:
    messages = [
        {"role": "tool", "tool_call_id": "old", "content": "x" * 200},
        {"role": "tool", "tool_call_id": "recent", "content": "y" * 200},
        {"role": "tool", "tool_call_id": "error", "content": "z" * 200, "is_error": True},
        {"role": "user", "content": "continue"},
    ]
    reduced = reduce_request_messages(
        messages,
        _config(
            context_window_tokens=300,
            per_tool_result_chars=1_000,
            per_tool_message_chars=1_000,
            protected_recent_messages=4,
        ),
    )

    assert reduced.messages[0]["content"] == OLD_TOOL_RESULT_CONTENT_CLEARED  # type: ignore[index]
    assert reduced.messages[1]["content"] == "y" * 200  # type: ignore[index]
    assert reduced.messages[2]["content"] == "z" * 200  # type: ignore[index]
    assert reduced.messages[0]["_context_management"]["kind"] == "micro_clear"  # type: ignore[index]
    assert reduced.report.micro_cleared_tool_results == 1


def test_compaction_prompt_formats_analysis_and_continuation() -> None:
    prompt = build_compaction_prompt([{"role": "user", "content": "work"}])

    assert prompt[0]["role"] == "system"  # type: ignore[index]
    assert prompt[-1]["role"] == "user"  # type: ignore[index]
    assert format_compact_summary("<analysis>scratch</analysis>\nfinal") == "final"
    assert format_compact_summary("<analysis>only scratch</analysis>") is None
    assert continuation_summary_message("final") == {
        "role": "user",
        "content": "This session is being continued from a compacted earlier conversation.\n\nfinal",
    }
