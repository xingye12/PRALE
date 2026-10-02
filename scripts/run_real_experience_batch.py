"""Run one PRALE or Claude Code warm/cold sequence over all real fixtures.

This controller deliberately requires ``--allow-host-execution``.  It is the
adapter integration test and a useful operator runner; production ranking must
invoke the same adapter command from the container/effective egress sandbox.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from real_experience_eval import load_capsule, run_stage

STAGES = ("learn", "transfer", "correction", "retransfer")


def _fixtures(root: Path) -> list[tuple[str, str, Path]]:
    items = []
    for episode in sorted(path for path in root.iterdir() if path.is_dir()):
        for stage in STAGES:
            fixture = episode / stage
            if not fixture.is_dir():
                raise ValueError(f"missing {stage} fixture for {episode.name}")
            items.append((episode.name, stage, fixture))
    return items


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capsule", type=Path, required=True)
    parser.add_argument("--adapter", choices=("prale", "claude-code"), required=True)
    parser.add_argument("--memory-mode", choices=("warm", "cold"), required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, default=Path("evals/experience-real-v2/fixtures"))
    parser.add_argument("--repository-id", default="pi-b455975")
    parser.add_argument("--model")
    parser.add_argument("--max-budget-usd", type=float, default=10.0)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--allow-host-execution", action="store_true")
    args = parser.parse_args()
    if not args.allow_host_execution:
        raise ValueError("this controller needs --allow-host-execution; use the container runner for ranking")
    adapter = Path(__file__).with_name("real_experience_adapters.py").resolve()
    state_root = args.state_dir.resolve()
    state_root.mkdir(parents=True, exist_ok=True)
    runs: list[dict[str, Any]] = []
    for index, (episode, stage, fixture) in enumerate(_fixtures(args.fixtures)):
        state = state_root if args.memory_mode == "warm" else state_root / f"cold-{index}"
        adapter_output = state / "adapter.json"
        command = [
            sys.executable,
            str(adapter),
            args.adapter,
            "--workspace",
            "{workspace}",
            "--state-dir",
            str(state),
            "--memory-mode",
            args.memory_mode,
            "--timeout",
            str(args.timeout),
            "--output",
            str(adapter_output),
        ]
        if args.adapter == "prale":
            command.extend(["--repository-id", args.repository_id])
        if args.model:
            command.extend(["--model", args.model])
        if args.adapter == "claude-code":
            command.extend(["--max-budget-usd", str(args.max_budget_usd)])
        result = run_stage(
            capsule=load_capsule(args.capsule),
            fixture=fixture,
            agent_command=command,
            allow_host_execution=True,
            timeout_seconds=args.timeout + 30,
        )
        result.update({"episode": episode, "stage": stage, "memory_mode": args.memory_mode})
        adapter_result = result.get("adapter_result")
        if isinstance(adapter_result, dict):
            result["tool_calls"] = len(adapter_result.get("tool_calls", []))
            result["memory_retrievals"] = adapter_result.get("memory_retrievals")
            result["usage"] = adapter_result.get("usage", {})
        runs.append(result)
    report = {"metadata": {"system": args.adapter, "memory_mode": args.memory_mode}, "runs": runs}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
