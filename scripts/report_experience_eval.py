"""Score one memory-on or memory-off experience-compounding benchmark run.

The runner is deliberately model-agnostic.  It scores observable task
acceptance plus evidence IDs and action counts emitted by the operator's
transcript adapter; it never judges an agent by a self-declared explanation.
"""

import argparse
import json
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _mean(values: Iterable[float]) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def _mean_known_tool_calls(stages: Iterable[dict[str, Any]]) -> float | None:
    values = [float(stage["tool_calls"]) for stage in stages if isinstance(stage["tool_calls"], int)]
    return _mean(values) if values else None


def _stage_index(value: object) -> dict[str, Mapping[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("each result episode needs a stages array")
    index: dict[str, Mapping[str, Any]] = {}
    for stage in value:
        if not isinstance(stage, Mapping) or not isinstance(stage.get("id"), str):
            raise ValueError("each result stage needs an id")
        if stage["id"] in index:
            raise ValueError(f"duplicate result stage {stage['id']!r}")
        index[stage["id"]] = stage
    return index


def _actions(value: object) -> list[str]:
    return value if isinstance(value, list) and all(isinstance(item, str) for item in value) else []


def build_report(benchmark: dict[str, Any], results: dict[str, Any]) -> dict[str, Any]:
    if benchmark.get("benchmark_id") != "prale-experience-v1":
        raise ValueError("unsupported experience benchmark")
    metadata = results.get("metadata")
    if not isinstance(metadata, Mapping) or metadata.get("memory_mode") not in {"memory-on", "memory-off"}:
        raise ValueError("results.metadata.memory_mode must be memory-on or memory-off")
    raw_episodes = results.get("episodes")
    if not isinstance(raw_episodes, list):
        raise ValueError("results.episodes must be an array")
    raw_by_id = {
        item.get("id"): item for item in raw_episodes if isinstance(item, Mapping) and isinstance(item.get("id"), str)
    }
    if len(raw_by_id) != len(raw_episodes):
        raise ValueError("result episodes need unique string ids")

    episodes = []
    for expected in benchmark["episodes"]:
        observed = raw_by_id.get(expected["id"], {})
        stages = _stage_index(observed.get("stages", [])) if observed else {}
        scored = []
        for spec in expected["stages"]:
            item = stages.get(spec["id"], {})
            accepted = item.get("acceptance") == "passed"
            evidence = set(_actions(item.get("evidence_ids")))
            required = set(spec.get("required_evidence_ids", []))
            reused = required.issubset(evidence) if required else None
            actions = _actions(item.get("actions"))
            avoidable = set(spec.get("avoidable_actions", []))
            repeated = sorted(avoidable.intersection(actions))
            scored.append(
                {
                    "id": spec["id"],
                    "accepted": accepted,
                    "evidence_reused": reused,
                    "repeated_avoidable_actions": repeated,
                    "tool_calls": item.get("tool_calls") if isinstance(item.get("tool_calls"), int) else None,
                }
            )
        episodes.append({"id": expected["id"], "stages": scored})

    transfer = [stage for episode in episodes for stage in episode["stages"] if stage["id"] == "transfer"]
    correction = [stage for episode in episodes for stage in episode["stages"] if stage["id"] == "correction"]
    retransfer = [stage for episode in episodes for stage in episode["stages"] if stage["id"] == "retransfer"]
    reusable = [stage for stage in [*transfer, *correction, *retransfer] if stage["evidence_reused"] is not None]
    all_scored = [stage for episode in episodes for stage in episode["stages"] if stage["id"] != "learn"]
    return {
        "benchmark_id": benchmark["benchmark_id"],
        "metadata": dict(metadata),
        "summary": {
            "transfer_acceptance_rate": _mean(float(stage["accepted"]) for stage in transfer),
            "correction_acceptance_rate": _mean(float(stage["accepted"]) for stage in correction),
            "corrected_transfer_acceptance_rate": _mean(float(stage["accepted"]) for stage in retransfer),
            "evidence_reuse_rate": _mean(float(bool(stage["evidence_reused"])) for stage in reusable),
            "avoidable_rediscovery_rate": _mean(
                float(bool(stage["repeated_avoidable_actions"])) for stage in all_scored
            ),
            "transfer_mean_tool_calls": _mean_known_tool_calls(transfer),
            "correction_mean_tool_calls": _mean_known_tool_calls(correction),
            "corrected_transfer_mean_tool_calls": _mean_known_tool_calls(retransfer),
        },
        "episodes": episodes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="score one experience-compounding benchmark run")
    parser.add_argument("--benchmark", type=Path, default=Path("evals/memory/experience-v1.json"))
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = build_report(_read(args.benchmark), _read(args.results))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
