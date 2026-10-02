"""Report acceptance and warm-minus-cold gains for real-repository runs."""

import argparse
import json
from collections import defaultdict
from collections.abc import Mapping
from pathlib import Path
from typing import Any


def build_report(results: Mapping[str, Any]) -> dict[str, Any]:
    metadata = results.get("metadata")
    runs = results.get("runs")
    if not isinstance(metadata, Mapping) or not isinstance(runs, list):
        raise ValueError("results need metadata and runs")
    stages: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for run in runs:
        if not isinstance(run, Mapping) or not isinstance(run.get("stage"), str):
            raise ValueError("each run needs a string stage")
        stages[run["stage"]].append(run)

    def rate(items: list[Mapping[str, Any]]) -> float | None:
        return None if not items else sum(item.get("acceptance") == "passed" for item in items) / len(items)

    def median_cost(items: list[Mapping[str, Any]], key: str) -> float | None:
        values = sorted(
            float(item[key])
            for item in items
            if item.get("acceptance") == "passed" and isinstance(item.get(key), (int, float))
        )
        if not values:
            return None
        midpoint = len(values) // 2
        return values[midpoint] if len(values) % 2 else (values[midpoint - 1] + values[midpoint]) / 2

    summary = {}
    for stage, items in stages.items():
        summary[stage] = {
            "runs": len(items),
            "acceptance_rate": rate(items),
            "median_duration_seconds_given_pass": median_cost(items, "duration_seconds"),
            "median_tool_calls_given_pass": median_cost(items, "tool_calls"),
            "memory_retrieval_observable_rate": sum(item.get("memory_retrievals") is not None for item in items)
            / len(items),
        }
    return {"benchmark_id": "prale-experience-real-v2", "metadata": dict(metadata), "summary": summary, "runs": runs}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw = json.loads(args.results.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping):
        raise ValueError("results must be an object")
    report = build_report(raw)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
