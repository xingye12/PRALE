from agent_harness.domain.context_management import ContextManagementConfig, reduce_request_messages
from agent_harness.domain.tool_prune import protected_start


def config(**kwargs):
    return ContextManagementConfig(
        context_window_tokens=10_000,
        reserved_output_tokens=500,
        headroom_tokens=1000,
        threshold_ratio=kwargs.pop("threshold_ratio", 0.8),
        hard_margin_tokens=100,
        **kwargs,
    )


def test_strategy_specific_defaults():
    current = ContextManagementConfig()
    assert current.strategy == "tool_prune_summary_v1"
    assert current.context_window_tokens == 1_000_000
    assert current.soft_limit_tokens == 300_000
    assert current.hard_limit_tokens == 977_000
    assert current.retain_tokens == 156_800
    assert ContextManagementConfig(strategy="layered_v1").context_window_tokens == 128_000


def test_no_pruning_before_pressure_and_original_never_mutated():
    messages = [{"role": "tool", "content": "x" * 9000}, {"role": "user", "content": "continue"}]
    assert reduce_request_messages(messages, config()).messages == tuple(messages)
    assert messages[0]["content"] == "x" * 9000


def test_only_prefix_tools_pruned_recent_complete_exchange_kept():
    old = {"role": "tool", "tool_call_id": "old", "content": "a" * 30_000, "is_error": True}
    call = {"role": "assistant", "tool_calls": [{"id": "recent", "name": "read", "arguments": {}}]}
    recent = {"role": "tool", "tool_call_id": "recent", "content": "z" * 9000}
    messages = [
        {"role": "assistant", "tool_calls": [{"id": "old"}]},
        old,
        {"role": "user", "content": "work"},
        call,
        recent,
    ]
    assert protected_start(messages, config()) == 3
    result = reduce_request_messages(messages, config())
    assert result.report.trimmed_tool_results == 1
    assert result.messages[1]["content"].startswith("a" * 4096)
    assert result.messages[1]["content"].endswith("a" * 1024)
    assert result.messages[1]["is_error"] is True
    assert result.messages[2:] == tuple(messages[2:])


def test_boundary_expands_to_include_tool_call():
    messages = [
        {"role": "user", "content": "old"},
        {"role": "assistant", "tool_calls": [{"id": "x", "name": "read"}]},
        {"role": "tool", "tool_call_id": "x", "content": "x" * 40_000},
    ]
    assert protected_start(messages, config()) == 1  # complete tool pair is protected; the user is a separate anchor
    assert reduce_request_messages(messages, config()).messages == tuple(messages)


def test_unicode_rich_blocks_preserve_non_text_and_tail():
    from agent_harness.domain.tool_prune import PRUNE_MARKER, prune_content

    blocks = [
        {"type": "text", "text": "中" * 5000},
        {"type": "image", "data": "opaque"},
        {"type": "text", "text": "😀" * 5000, "extra": "keep"},
    ]
    result = prune_content(blocks, config())
    assert result[0]["text"] == "中" * 4096 + PRUNE_MARKER
    assert result[1] == blocks[1]
    assert result[2] == {"type": "text", "text": "😀" * 1024, "extra": "keep"}
    assert prune_content("a" * 8192, config()) == "a" * 8192


def test_pressure_threshold_inclusive():
    from agent_harness.domain.context_management import estimate_messages, needs_summary

    cfg = config(threshold_ratio=0.5)
    # JSON envelope contributes to the token estimate too.
    message = [{"role": "user", "content": "x" * 14970}]
    while estimate_messages(message) < cfg.soft_limit_tokens:
        message[0]["content"] += "x"
    assert estimate_messages(message) == cfg.soft_limit_tokens
    assert needs_summary(message, cfg)


def test_long_single_user_turn_protects_prompt_without_protecting_every_old_tool():
    from agent_harness.domain.entries import Entry
    from agent_harness.domain.tool_prune import context_view

    messages = [
        {"role": "user", "content": "finish this task"},
        {"role": "assistant", "tool_calls": [{"id": "old"}]},
        {"role": "tool", "tool_call_id": "old", "content": "A" * 30000},
        {"role": "assistant", "tool_calls": [{"id": "recent"}]},
        {"role": "tool", "tool_call_id": "recent", "content": "Z" * 9000},
    ]
    entries = [Entry(str(i), str(i - 1) if i else None, i, 0, "message", m) for i, m in enumerate(messages)]
    view = context_view(entries, config())
    assert view.retained_ids == ["0", "3", "4"]
    result = reduce_request_messages(messages, config())
    assert result.messages[0] == messages[0]
    assert result.messages[2]["content"] != messages[2]["content"]
    assert result.messages[3:] == tuple(messages[3:])
