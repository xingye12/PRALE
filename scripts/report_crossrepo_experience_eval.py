"""Summarize frozen-state cross-repository experience evaluation reports."""

from __future__ import annotations

import argparse
import json
import statistics
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


def _number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _cost(run: Mapping[str, Any]) -> float | None:
    adapter = run.get("adapter_result")
    if not isinstance(adapter, Mapping):
        return None
    direct = _number(adapter.get("cost_usd"))
    if direct is not None:
        return direct
    claude = adapter.get("claude_result")
    if not isinstance(claude, Mapping):
        return None
    return _number(claude.get("total_cost_usd"))


def _adapter_number(run: Mapping[str, Any], key: str) -> float | None:
    adapter = run.get("adapter_result")
    if not isinstance(adapter, Mapping):
        return None
    direct = _number(adapter.get(key))
    if direct is not None:
        return direct
    claude = adapter.get("claude_result")
    if not isinstance(claude, Mapping):
        return None
    claude_key = {"model_turns": "num_turns", "model_duration_ms": "duration_api_ms"}.get(key, key)
    return _number(claude.get(claude_key))


def _tool_calls(run: Mapping[str, Any]) -> float | None:
    adapter = run.get("adapter_result")
    if not isinstance(adapter, Mapping) or not isinstance(adapter.get("tool_calls"), list):
        return None
    return float(len(adapter["tool_calls"]))


def _usage_number(run: Mapping[str, Any], key: str) -> float | None:
    adapter = run.get("adapter_result")
    if not isinstance(adapter, Mapping) or not isinstance(adapter.get("usage"), Mapping):
        return None
    return _number(adapter["usage"].get(key))


def _median(values: Sequence[float | None]) -> float | None:
    known = [value for value in values if value is not None]
    return statistics.median(known) if known else None


def _summary(runs: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    accepted = [run for run in runs if run.get("acceptance") == "passed"]
    costs = [value for run in accepted if (value := _cost(run)) is not None]
    durations = [_number(run.get("duration_seconds")) for run in accepted]
    valid_durations = [value for value in durations if value is not None]
    metrics: dict[str, list[float | None]] = {
        "median_success_tool_calls": [_tool_calls(run) for run in accepted],
        "median_success_model_turns": [_adapter_number(run, "model_turns") for run in accepted],
        "median_success_input_tokens": [_usage_number(run, "input_tokens") for run in accepted],
        "median_success_output_tokens": [_usage_number(run, "output_tokens") for run in accepted],
        "median_success_cache_read_tokens": [_usage_number(run, "cache_read_input_tokens") for run in accepted],
    }
    return {
        "count": len(runs),
        "passed": len(accepted),
        "pass_rate": len(accepted) / len(runs) if runs else None,
        "median_success_cost_usd": statistics.median(costs) if costs else None,
        "median_success_duration_seconds": statistics.median(valid_durations) if valid_durations else None,
        **{name: _median(values) for name, values in metrics.items()},
    }


def _load(path: Path) -> Mapping[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, Mapping):
        raise ValueError(f"{path}: expected an object")
    for key in ("adapter", "learning", "transfer"):
        if key not in value:
            raise ValueError(f"{path}: missing {key}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", required=True, help="one controller report; repeat")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    conditions: list[dict[str, Any]] = []
    for path in args.input:
        report = _load(path)
        learning = report["learning"]
        transfer = report["transfer"]
        if not isinstance(learning, list) or not isinstance(transfer, list):
            raise ValueError(f"{path}: learning and transfer must be lists")
        typed_transfer = [run for run in transfer if isinstance(run, Mapping)]
        conditions.append(
            {
                "name": path.stem,
                "adapter": report["adapter"],
                "condition": report.get("condition", "evolved"),
                "learning": _summary([run for run in learning if isinstance(run, Mapping)]),
                "transfer": _summary(typed_transfer),
                "transfer_local": _summary([run for run in typed_transfer if run.get("scope") == "local"]),
                "transfer_l3_only": _summary([run for run in typed_transfer if run.get("scope") == "l3-only"]),
                "freeze": report.get("freeze"),
            }
        )
    result = {"benchmark_id": "prale-experience-crossrepo-v1", "conditions": conditions}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
