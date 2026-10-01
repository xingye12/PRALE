from build_memory_eval_cases import build_benchmark
from report_memory_eval import build_report


def _passing_results() -> dict[str, object]:
    benchmark = build_benchmark()
    return {
        "metadata": {"mode": "hybrid", "embedding_model": "bge-m3:test"},
        "generation": [
            {
                "id": case["id"],
                "candidates": case["expected_memories"],
            }
            for case in benchmark["generation"]
        ],
        "semantic_recall": [
            {"id": case["id"], "mode": "hybrid", "retrieved_ids": case["must_recall"]}
            for case in benchmark["semantic_recall"]
        ],
        "correction": [
            {
                "id": case["id"],
                "decision": case["expected_decision"],
                "old_status": case["expected_old_status"],
                "active_contents": case["expected_active"],
                "retrieved_contents": [],
            }
            for case in benchmark["correction"]
        ],
    }


def test_report_scores_a_complete_passing_run() -> None:
    report = build_report(build_benchmark(), _passing_results())

    assert report["summary"]["overall"] == {"cases": 35.0, "passed": 35.0, "pass_rate": 1.0}
    assert report["summary"]["semantic_recall"]["recall_at_5"] == 1.0
    assert report["summary"]["semantic_recall"]["mrr"] == 1.0


def test_report_exposes_generation_secret_and_recall_regressions() -> None:
    results = _passing_results()
    generation = results["generation"]
    assert isinstance(generation, list)
    next(item for item in generation if item["id"] == "generation--reject-secret")["candidates"] = [
        {"content": "Authorization: Bearer secret-token-value"}
    ]
    recall = results["semantic_recall"]
    assert isinstance(recall, list)
    next(item for item in recall if item["id"] == "recall--01")["retrieved_ids"] = ["budget"]

    report = build_report(build_benchmark(), results)

    secret = next(item for item in report["items"]["generation"] if item["id"] == "generation--reject-secret")
    failed_recall = next(item for item in report["items"]["semantic_recall"] if item["id"] == "recall--01")
    assert secret["passed"] is False
    assert secret["forbidden_terms_found"] == ["secret-token-value"]
    assert failed_recall["first_relevant_rank"] is None
    assert failed_recall["recall_at_5"] == 0.0
