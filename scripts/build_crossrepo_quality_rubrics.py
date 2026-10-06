"""Build reviewed, task-specific LLM-judge rubrics for cross-repository stages.

The rubric file is kept outside agent workspaces.  It names the task objective
and a fixed 10-point scoring model, while the judge receives only the archived
submission and cited source files.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _request(task: Path) -> str:
    lines = task.read_text(encoding="utf-8").splitlines()
    try:
        return lines[lines.index("## Request") + 2].strip()
    except (ValueError, IndexError) as error:
        raise ValueError(f"{task} does not contain a request") from error


def _rubric(*, task_id: str, phase: str, task: Path) -> dict[str, Any]:
    text = task.read_text(encoding="utf-8")
    mode = next(
        line.removeprefix("Task mode: `").removesuffix("`")
        for line in text.splitlines()
        if line.startswith("Task mode: `")
    )
    return {
        "task_id": task_id,
        "phase": phase,
        "mode": mode,
        "objective": _request(task),
        "criteria": [
            {
                "id": "evidence_accuracy",
                "max_score": 4,
                "minimum_score": 2,
                "instruction": "Each material conclusion must be supported by the cited source excerpts; penalize "
                "claims contradicted by the excerpts or unsupported by them.",
            },
            {
                "id": "objective_coverage",
                "max_score": 4,
                "minimum_score": 2,
                "instruction": "Assess whether the submission answers every substantive part of the registered "
                "objective, including boundary cases named in it.",
            },
            {
                "id": "validation_and_delivery",
                "max_score": 2,
                "minimum_score": 1,
                "instruction": "Assess whether the declared validation and mode-specific deliverable actually "
                "support the claimed outcome using controller-captured execution, complete code and diff. "
                "For non-explore tasks, award no credit without completed controller replay or when the core "
                "validation is blocked/unexecuted. Check real-module use, substantive assertions, and actual "
                "stdout/stderr/exit status; printed success alone is insufficient. An expected negative-path "
                "exit is valid only when it supports the objective. Exploration may use source inspection.",
            },
        ],
        "pass_score": 7,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=Path("evals/experience-crossrepo-v1/fixtures"))
    parser.add_argument("--output", type=Path, default=Path("evals/experience-crossrepo-v1/quality-rubrics.json"))
    args = parser.parse_args()
    stages = [
        _rubric(task_id=f"{index:02d}", phase=phase, task=args.fixtures / phase / f"{index:02d}" / "TASK.md")
        for phase in ("learn", "transfer")
        for index in range(1, 31)
    ]
    args.output.write_text(
        json.dumps({"rubric_version": 2, "stages": stages}, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {len(stages)} rubrics to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
