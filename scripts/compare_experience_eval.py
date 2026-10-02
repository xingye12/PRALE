"""Compare memory-on minus memory-off experience-compounding gains."""

import argparse
import json
from pathlib import Path
from typing import Any

METRICS = (
    "transfer_acceptance_rate",
    "correction_acceptance_rate",
    "corrected_transfer_acceptance_rate",
    "evidence_reuse_rate",
    "avoidable_rediscovery_rate",
    "transfer_mean_tool_calls",
)


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def compare(reports: list[dict[str, Any]]) -> dict[str, Any]:
    groups: dict[str, dict[str, dict[str, Any]]] = {}
    for report in reports:
        metadata, summary = report.get("metadata"), report.get("summary")
        if not isinstance(metadata, dict) or not isinstance(summary, dict):
            raise ValueError("each report needs metadata and summary")
        system, mode = metadata.get("system"), metadata.get("memory_mode")
        if not isinstance(system, str) or mode not in {"memory-on", "memory-off"}:
            raise ValueError("each report needs metadata.system and memory-on/off memory_mode")
        if mode in groups.setdefault(system, {}):
            raise ValueError(f"duplicate {mode} report for {system!r}")
        groups[system][mode] = report
    comparisons = []
    for system, pair in sorted(groups.items()):
        if set(pair) != {"memory-on", "memory-off"}:
            raise ValueError(f"{system!r} needs exactly one memory-on and one memory-off report")
        on, off = pair["memory-on"]["summary"], pair["memory-off"]["summary"]
        deltas = {
            metric: on[metric] - off[metric]
            for metric in METRICS
            if on[metric] is not None and off[metric] is not None
        }
        # Rediscovery is a cost: a smaller warm value is an improvement.
        deltas["avoided_rediscovery_gain"] = off["avoidable_rediscovery_rate"] - on["avoidable_rediscovery_rate"]
        if on["transfer_mean_tool_calls"] is not None and off["transfer_mean_tool_calls"] is not None:
            deltas["transfer_tool_call_saving"] = off["transfer_mean_tool_calls"] - on["transfer_mean_tool_calls"]
        comparisons.append({"system": system, "memory_on_minus_off": deltas})
    return {"benchmark_id": "prale-experience-v1", "comparisons": comparisons}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", type=Path, nargs="+", help="one warm and one cold report per system")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    comparison = compare([_read(path) for path in args.reports])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(comparison, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
