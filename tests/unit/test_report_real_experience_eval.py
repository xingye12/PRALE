from report_real_experience_eval import build_report


def test_real_report_uses_hidden_acceptance_and_cost_only_for_passing_runs() -> None:
    report = build_report(
        {
            "metadata": {"system": "PRALE", "memory_mode": "warm"},
            "runs": [
                {
                    "stage": "transfer",
                    "acceptance": "passed",
                    "duration_seconds": 3,
                    "tool_calls": 2,
                    "memory_retrievals": [],
                },
                {"stage": "transfer", "acceptance": "failed", "duration_seconds": 99, "tool_calls": 99},
                {
                    "stage": "transfer",
                    "acceptance": "passed",
                    "duration_seconds": 5,
                    "tool_calls": 4,
                    "memory_retrievals": [],
                },
            ],
        }
    )

    assert report["summary"]["transfer"] == {
        "runs": 3,
        "acceptance_rate": 2 / 3,
        "median_duration_seconds_given_pass": 4.0,
        "median_tool_calls_given_pass": 3.0,
        "memory_retrieval_observable_rate": 2 / 3,
    }
