"""Convert long-term-memory evaluation results into a stable JSON report.

The evaluator/extractor runner writes raw candidates, retrieved IDs, and state
transitions.  This script owns the deterministic comparison with the
source-controlled benchmark, so dashboarding or an LLM judge never has to
reimplement memory semantics.
"""

import argparse
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _index(records: object, section: str) -> dict[str, dict[str, Any]]:
    if not isinstance(records, list):
        raise ValueError(f"results.{section} must be an array")
    indexed: dict[str, dict[str, Any]] = {}
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("id"), str):
            raise ValueError(f"every results.{section} item needs a string id")
        if record["id"] in indexed:
            raise ValueError(f"duplicate result id {record['id']!r}")
        indexed[record["id"]] = record
    return indexed


def _normalized(value: object) -> str:
    return " ".join(str(value).casefold().split())


def _contains_forbidden(candidates: Iterable[object], forbidden: Iterable[object]) -> list[str]:
    text = "\n".join(json.dumps(candidate, ensure_ascii=False, sort_keys=True) for candidate in candidates).casefold()
    return [str(term) for term in forbidden if _normalized(term) in text]


def _generation(
    benchmark: list[dict[str, Any]], results: Mapping[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    items = []
    for case in benchmark:
        result = results.get(case["id"], {})
        candidates = result.get("candidates", [])
        if not isinstance(candidates, list):
            candidates = []
        expected = case["expected_memories"]
        matched = []
        for memory in expected:
            found = any(
                isinstance(candidate, dict)
                and candidate.get("type") == memory["type"]
                and _normalized(candidate.get("content")) == _normalized(memory["content"])
                and candidate.get("scene_key") == memory["scene_key"]
                for candidate in candidates
            )
            matched.append(found)
        forbidden = _contains_forbidden(candidates, case["forbidden_terms"])
        passed = all(matched) and not forbidden and (bool(expected) or not candidates)
        items.append(
            {
                "id": case["id"],
                "passed": passed,
                "expected_count": len(expected),
                "matched_count": sum(matched),
                "candidate_count": len(candidates),
                "forbidden_terms_found": forbidden,
                "note": case["note"],
            }
        )
    return items, _metrics(items)


def _recall(
    benchmark: list[dict[str, Any]], results: Mapping[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    items = []
    for case in benchmark:
        result = results.get(case["id"], {})
        retrieved = result.get("retrieved_ids", [])
        if not isinstance(retrieved, list) or not all(isinstance(value, str) for value in retrieved):
            retrieved = []
        targets = case["must_recall"]
        ranks = [retrieved.index(target) + 1 for target in targets if target in retrieved]
        forbidden = [item for item in case["must_not_recall"] if item in retrieved]
        first_rank = min(ranks) if ranks else None
        items.append(
            {
                "id": case["id"],
                "mode": result.get("mode", "unknown"),
                "passed": bool(ranks) and not forbidden,
                "retrieved_ids": retrieved,
                "first_relevant_rank": first_rank,
                "recall_at_5": float(any(rank <= 5 for rank in ranks)),
                "reciprocal_rank": 0.0 if first_rank is None else 1.0 / first_rank,
                "forbidden_ids_found": forbidden,
            }
        )
    metrics = _metrics(items)
    metrics["recall_at_5"] = _mean(item["recall_at_5"] for item in items)
    metrics["mrr"] = _mean(item["reciprocal_rank"] for item in items)
    return items, metrics


def _correction(
    benchmark: list[dict[str, Any]], results: Mapping[str, dict[str, Any]]
) -> tuple[list[dict[str, Any]], dict[str, float]]:
    items = []
    for case in benchmark:
        result = results.get(case["id"], {})
        retrieved = result.get("retrieved_contents", [])
        if not isinstance(retrieved, list):
            retrieved = []
        decision_ok = result.get("decision") == case["expected_decision"]
        old_status_ok = result.get("old_status") == case["expected_old_status"]
        expected_active = case["expected_active"]
        active = result.get("active_contents", [])
        if not isinstance(active, list):
            active = []
        normalized_active = {_normalized(item) for item in active}
        normalized_retrieved = {_normalized(item) for item in retrieved}
        active_ok = all(_normalized(value) in normalized_active for value in expected_active)
        hidden = [value for value in case["must_not_recall"] if _normalized(value) in normalized_retrieved]
        passed = decision_ok and old_status_ok and active_ok and not hidden
        items.append(
            {
                "id": case["id"],
                "passed": passed,
                "decision_ok": decision_ok,
                "old_status_ok": old_status_ok,
                "active_content_ok": active_ok,
                "old_content_still_recalled": hidden,
            }
        )
    return items, _metrics(items)


def _mean(values: Iterable[float]) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def _metrics(items: list[dict[str, Any]]) -> dict[str, float]:
    return {
        "cases": float(len(items)),
        "passed": float(sum(bool(item["passed"]) for item in items)),
        "pass_rate": _mean(float(item["passed"]) for item in items),
    }


def build_report(benchmark: dict[str, Any], results: dict[str, Any]) -> dict[str, Any]:
    if benchmark.get("benchmark_id") != "prale-memory-v1":
        raise ValueError("unsupported memory benchmark")
    generation_results = _index(results.get("generation", []), "generation")
    recall_results = _index(results.get("semantic_recall", []), "semantic_recall")
    correction_results = _index(results.get("correction", []), "correction")
    generation, generation_metrics = _generation(benchmark["generation"], generation_results)
    recall, recall_metrics = _recall(benchmark["semantic_recall"], recall_results)
    correction, correction_metrics = _correction(benchmark["correction"], correction_results)
    all_items = [*generation, *recall, *correction]
    return {
        "benchmark_id": benchmark["benchmark_id"],
        "result_metadata": results.get("metadata", {}),
        "summary": {
            "generation": generation_metrics,
            "semantic_recall": recall_metrics,
            "correction": correction_metrics,
            "overall": _metrics(all_items),
        },
        "items": {"generation": generation, "semantic_recall": recall, "correction": correction},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="score long-term-memory evaluation results")
    parser.add_argument("--benchmark", type=Path, default=Path("evals/memory/benchmark-v1.json"))
    parser.add_argument("--results", type=Path, required=True, help="raw extractor/retrieval/correction results JSON")
    parser.add_argument("--output", type=Path, required=True, help="normalized report JSON")
    args = parser.parse_args()
    report = build_report(_read(args.benchmark), _read(args.results))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
