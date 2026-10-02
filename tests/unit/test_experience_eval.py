from build_experience_eval_cases import BENCHMARK_ID, build_benchmark
from compare_experience_eval import compare
from report_experience_eval import build_report


def _results(mode: str, *, accepted: str = "passed", tool_calls: int = 2) -> dict[str, object]:
    benchmark = build_benchmark()
    episodes = []
    for episode in benchmark["episodes"]:
        stages = []
        for spec in episode["stages"]:
            stages.append(
                {
                    "id": spec["id"],
                    "acceptance": accepted,
                    "evidence_ids": spec.get("required_evidence_ids", []),
                    "actions": [],
                    "tool_calls": tool_calls,
                }
            )
        episodes.append({"id": episode["id"], "stages": stages})
    return {"metadata": {"system": "PRALE", "memory_mode": mode}, "episodes": episodes}


def test_experience_benchmark_has_fresh_session_transfer_and_correction_stages() -> None:
    benchmark = build_benchmark()

    assert benchmark["benchmark_id"] == BENCHMARK_ID
    assert len(benchmark["episodes"]) == 4
    assert benchmark["protocol"]["session_boundary"].startswith("Each transfer")
    assert all(
        [stage["id"] for stage in episode["stages"]] == ["learn", "transfer", "correction"]
        for episode in benchmark["episodes"]
    )
    assert all(
        stage["fixture"]["acceptance_command"] == "python {oracle_source} {workspace}"
        for episode in benchmark["episodes"]
        for stage in episode["stages"]
    )


def test_report_scores_transfer_reuse_and_rediscovery_separately() -> None:
    results = _results("warm")
    first_transfer = results["episodes"][0]["stages"][1]  # type: ignore[index]
    first_transfer["evidence_ids"] = []
    first_transfer["actions"] = ["sqlite3"]

    report = build_report(build_benchmark(), results)

    assert report["summary"]["transfer_acceptance_rate"] == 1.0
    assert report["summary"]["evidence_reuse_rate"] == 7 / 8
    assert report["summary"]["avoidable_rediscovery_rate"] == 1 / 8
    assert report["summary"]["transfer_mean_tool_calls"] == 2.0


def test_comparison_reports_the_warm_advantage_not_just_absolute_scores() -> None:
    warm = build_report(build_benchmark(), _results("warm", tool_calls=1))
    cold = build_report(build_benchmark(), _results("cold", tool_calls=4))

    comparison = compare([warm, cold])

    delta = comparison["comparisons"][0]["warm_minus_cold"]
    assert delta["transfer_tool_call_saving"] == 3.0
    assert delta["transfer_mean_tool_calls"] == -3.0
