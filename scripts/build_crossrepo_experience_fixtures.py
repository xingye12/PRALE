"""Scaffold the 60 cross-repository task prompts from the registered task set.

The generated stages deliberately start as ``draft``. A task becomes runnable
only after its author adds local fixture data, an external hidden oracle, and
changes ``fixture.json`` to ``status: ready``. This prevents accidentally
spending model budget on a task whose acceptance contract has not been
reviewed.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

_ROW = re.compile(
    r"^\| (?P<id>\d{2}) \| (?P<scope>[^|]+) \| (?P<learn>[^|]+) \| "
    r"(?P<transfer>[^|]+) \| (?P<kernel>[^|]+) \|$"
)
_MODE = re.compile(r"\*\*(?P<mode>explore|demo|contract|operate)\*\*", re.IGNORECASE)


def _manifest(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("benchmark_id") != "prale-experience-crossrepo-v1":
        raise ValueError("unsupported task manifest")
    return value


def _tasks(path: Path) -> dict[str, dict[str, str]]:
    parsed: dict[str, dict[str, str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = _ROW.match(line)
        if match:
            parsed[match["id"]] = match.groupdict()
    if sorted(parsed) != [f"{index:02d}" for index in range(1, 31)]:
        raise ValueError("TASKSET.md does not contain all 30 registered task rows")
    return parsed


def _write_stage(
    *, root: Path, phase: str, task_id: str, repository: str, scope: str, mode: str, detail: str, kernel: str
) -> None:
    target = root / phase / task_id
    target.mkdir(parents=True, exist_ok=True)
    embedded_mode = _MODE.search(detail)
    if embedded_mode is not None and embedded_mode["mode"].lower() != mode:
        raise ValueError(f"task {task_id}/{phase} mode differs from task manifest")
    if mode not in {"explore", "demo", "contract", "operate"}:
        raise ValueError(f"task {task_id}/{phase} has no registered mode")
    prompt = "\n".join(
        [
            f"# Cross-repository experience task {phase}/{task_id}",
            "",
            f"Repository key: `{repository}`",
            f"Task mode: `{mode}`",
            "",
            "## Request",
            "",
            detail,
            "",
            "## Required delivery",
            "",
            "Write `.prale-eval/result.json` with this JSON object: "
            f"`task_id` exactly `{task_id}`, `repository` exactly `{repository}`, and `mode` exactly `{mode}`; "
            "also include `evidence` (a list of objects with `path`, `symbol`, `start_line`, `end_line`, and "
            "`observation`), `claims` (a list of objects with `claim` and `evidence_paths`), `conclusion`, "
            "and `validation` (with `command`, `status`, and `notes`). "
            + (
                f"Also write `.prale-eval/{mode}-deliverable.md` describing the executable demo, "
                "contract, or normalized operation result. Submit the complete executable scripts/tests and "
                "required local fixture data. `validation.command` must be one executable Bash command string "
                "(use relative workspace paths; combine required steps with &&). Run it before submitting. "
                "The controller will replay it in a copy of your final workspace with a fresh HOME, no agent "
                "memory, and a 60-second timeout, automatically archiving full stdout, stderr, exit code and "
                "timeout status. Keep replay-generated result files under `.prale-eval/`. Do not replace "
                "execution with prose or print a claimed success without checking the actual task behavior. "
                if mode != "explore"
                else ""
            )
            + "Do not modify task metadata, hidden-oracle files, package locks, or git configuration.",
            "",
            "The acceptance oracle is hidden. Equivalent correct implementations are allowed.",
        ]
    )
    (target / "TASK.md").write_text(prompt + "\n", encoding="utf-8")
    (target / "fixture.json").write_text(
        json.dumps(
            {
                "benchmark_id": "prale-experience-crossrepo-v1",
                "task_id": task_id,
                "phase": phase,
                "repository": repository,
                "scope": scope,
                "mode": mode,
                "experience_kernel": kernel,
                "status": "draft",
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--taskset", type=Path, default=Path("evals/experience-crossrepo-v1/TASKSET.md"))
    parser.add_argument("--manifest", type=Path, default=Path("evals/experience-crossrepo-v1/task-manifest.json"))
    parser.add_argument("--output", type=Path, default=Path("evals/experience-crossrepo-v1/fixtures"))
    args = parser.parse_args()
    tasks, manifest = _tasks(args.taskset), _manifest(args.manifest)
    pairs = manifest.get("pairs")
    if not isinstance(pairs, list):
        raise ValueError("task manifest has no pairs")
    for pair in pairs:
        if not isinstance(pair, dict) or not isinstance(pair.get("id"), str):
            raise ValueError("invalid pair")
        task_id = pair["id"]
        row = tasks[task_id]
        for phase in ("learn", "transfer"):
            stage = pair.get(phase)
            if (
                not isinstance(stage, dict)
                or not isinstance(stage.get("repo"), str)
                or not isinstance(stage.get("mode"), str)
            ):
                raise ValueError(f"invalid {task_id}/{phase}")
            _write_stage(
                root=args.output,
                phase=phase,
                task_id=task_id,
                repository=stage["repo"],
                scope=row["scope"].strip(),
                mode=stage["mode"],
                detail=row[phase].strip(),
                kernel=row["kernel"].strip(),
            )
    print(f"wrote 60 draft fixture prompts under {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
