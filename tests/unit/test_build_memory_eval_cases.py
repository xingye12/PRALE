import json

from build_memory_eval_cases import BENCHMARK_ID, build_benchmark


def test_memory_benchmark_has_the_agreed_case_counts_and_unique_ids() -> None:
    benchmark = build_benchmark()

    assert benchmark["benchmark_id"] == BENCHMARK_ID
    assert len(benchmark["generation"]) == 15
    assert len(benchmark["semantic_recall"]) == 10
    assert len(benchmark["correction"]) == 10
    ids = [case["id"] for section in ("generation", "semantic_recall", "correction") for case in benchmark[section]]
    assert len(ids) == len(set(ids)) == 35


def test_generation_cases_are_serializable_and_distinguish_rejected_candidates() -> None:
    generation = build_benchmark()["generation"]

    json.dumps(generation, ensure_ascii=False)
    rejected = next(case for case in generation if case["id"] == "generation--reject-unverified-plan")
    assert rejected["expected_memories"] == []
    assert all(case["archive"]["items"] for case in generation)


def test_recall_and_correction_cases_name_an_expected_outcome() -> None:
    benchmark = build_benchmark()

    assert all(case["must_recall"] for case in benchmark["semantic_recall"])
    assert {case["expected_decision"] for case in benchmark["correction"]} == {
        "supersede",
        "merge",
        "reject",
        "separate_scope",
    }
