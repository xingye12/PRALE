import pytest
from report_crossrepo_experience_eval import _summary


def test_crossrepo_summary_slices_pass_rate_and_success_only_cost() -> None:
    runs = [
        {
            "acceptance": "passed",
            "duration_seconds": 8,
            "adapter_result": {"claude_result": {"total_cost_usd": 0.4}},
        },
        {
            "acceptance": "failed",
            "duration_seconds": 2,
            "adapter_result": {"claude_result": {"total_cost_usd": 9.0}},
        },
        {"acceptance": "passed", "duration_seconds": 4, "adapter_result": {"claude_result": {"total_cost_usd": 0.2}}},
    ]

    summary = _summary(runs)
    assert summary["count"] == 3
    assert summary["passed"] == 2
    assert summary["pass_rate"] == pytest.approx(2 / 3)
    assert summary["median_success_cost_usd"] == pytest.approx(0.3)
    assert summary["median_success_duration_seconds"] == 6.0


def test_crossrepo_summary_reads_prale_normalized_cost_and_usage() -> None:
    summary = _summary(
        [
            {
                "acceptance": "passed",
                "duration_seconds": 3,
                "adapter_result": {
                    "cost_usd": 0.03,
                    "model_turns": 4,
                    "tool_calls": ["bash", "write"],
                    "usage": {"input_tokens": 12, "output_tokens": 5, "cache_read_input_tokens": 2},
                },
            }
        ]
    )

    assert summary["median_success_cost_usd"] == 0.03
    assert summary["median_success_tool_calls"] == 2
    assert summary["median_success_model_turns"] == 4
    assert summary["median_success_input_tokens"] == 12
    assert summary["median_success_output_tokens"] == 5
    assert summary["median_success_cache_read_tokens"] == 2
