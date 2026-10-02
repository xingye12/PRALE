from real_experience_adapters import _claude_summary


def test_claude_stream_summary_extracts_tool_calls_and_final_usage() -> None:
    output = "\n".join(
        [
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
            '{"type":"result","usage":{"input_tokens":12,"output_tokens":4},"result":"done"}',
        ]
    )

    assert _claude_summary(output) == {
        "tool_calls": ["Read"],
        "usage": {"input_tokens": 12, "output_tokens": 4},
        "result": {"type": "result", "usage": {"input_tokens": 12, "output_tokens": 4}, "result": "done"},
    }
