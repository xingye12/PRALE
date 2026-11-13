"""Deterministic multi-module acceptance for the real-v2 advanced suite."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from real_experience_manifest import _files, capture_manifest
from real_experience_oracle import COMMAND, REGRESSION, _regular, run_node
from real_experience_support import subject_path

CONTRACTS = Path(__file__).with_name("real_experience_advanced")
WRAPPER = Path(__file__).with_name("real_experience_contracts") / "regression.mjs"
TIMEOUT = 8


def capture_baseline(workspace: Path, fault_sources: Path, baseline: str) -> None:
    capture_manifest(workspace, fault_sources / "baseline.json", baseline)


def _passed(result: dict[str, Any]) -> bool:
    return result["status"] == "completed" and result["exit_code"] == 0


def _asserted(result: dict[str, Any]) -> bool:
    return (
        result["status"] == "completed"
        and result["exit_code"] == 42
        and "PRALE_REGRESSION_ASSERTION" in result["stderr"]
    )


def evaluate(fixture: Path, workspace: Path, fault_sources: Path, baseline: str) -> dict[str, Any]:
    report: dict[str, Any] = {"oracle_version": 4, "status": "failed", "checks": {}}
    try:
        metadata = json.loads((fixture / "fixture.json").read_text(encoding="utf-8"))
        report["task_id"] = metadata["task_id"]
        report["suite_id"] = metadata["suite_id"]
        report["fixture_revision"] = metadata["fixture_revision"]
        targets = metadata["targets"]
        if (
            not isinstance(targets, list)
            or len(targets) < 2
            or len(set(targets)) != len(targets)
            or not all(isinstance(target, str) for target in targets)
        ):
            raise ValueError("advanced fixture requires distinct multiple source targets")
        allowed = set(targets)
        manifest = json.loads(_regular(fault_sources, "baseline.json").read_text(encoding="utf-8"))
        if manifest["baseline_commit"] != baseline:
            raise ValueError("controller baseline commit mismatch")
        if hashlib.sha256(_regular(workspace, ".git/config").read_bytes()).hexdigest() != manifest["git_config_sha256"]:
            raise ValueError("Git configuration was changed")
        before, after = manifest["files"], _files(workspace)
        changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
        if allowed - changed:
            raise ValueError(f"every faulty production module must be repaired: {sorted(allowed - changed)}")
        if any(name not in allowed and not name.startswith(".prale-eval/") for name in changed):
            raise ValueError("out-of-scope tracked changes")
        for target in targets:
            if Path(target).is_absolute() or ".." in Path(target).parts:
                raise ValueError("invalid source path")
            _regular(workspace, target)
            _regular(fault_sources, target)
        _regular(workspace, REGRESSION)
        helper = _regular(workspace, ".prale-eval/subject.mjs")
        if helper.read_bytes() != subject_path(metadata, CONTRACTS).read_bytes():
            raise ValueError("read-only public graph loader changed")
        if len(_regular(workspace, ".prale-eval/repair.md").read_text(encoding="utf-8").strip()) < 80:
            raise ValueError("repair.md must explain the cross-module repair")
        delivery = json.loads(_regular(workspace, ".prale-eval/result.json").read_text(encoding="utf-8"))
        for field, expected in (
            ("task_id", metadata["task_id"]),
            ("repository", "earendil-works/pi"),
            ("mode", "repair"),
        ):
            if delivery.get(field) != expected:
                raise ValueError(f"wrong stage-local {field}")
        validation = delivery.get("validation", {})
        if (
            validation.get("command") != COMMAND
            or validation.get("status") != "passed"
            or not isinstance(validation.get("notes"), str)
            or len(validation["notes"].strip()) < 20
        ):
            raise ValueError("missing executable validation evidence")
        with tempfile.TemporaryDirectory(prefix="prale-advanced-oracle-") as temporary:
            root = Path(temporary)

            def snapshot(restored: tuple[str, ...] = ()) -> Path:
                # Condition names must not be observable by the submitted test.
                copy = Path(tempfile.mkdtemp(prefix="case-", dir=root)) / "workspace"
                shutil.copytree(workspace, copy, symlinks=True, ignore=shutil.ignore_patterns(".git", "node_modules"))
                for path in (copy / ".prale-eval").rglob("*"):
                    if path.is_symlink():
                        raise ValueError("regression files must not be symlinks")
                for target in restored:
                    (copy / target).write_bytes((fault_sources / target).read_bytes())
                return copy

            behavior_root = snapshot()
            behavior = run_node(
                [str(WRAPPER), str(CONTRACTS / "behavior.mjs"), str(behavior_root), metadata["episode"]],
                behavior_root,
                timeout=TIMEOUT,
            )
            report["checks"]["behavior"] = behavior
            if not _passed(behavior):
                raise ValueError("cross-module hidden behavior failed")
            fixed = snapshot()
            positive = run_node([str(WRAPPER), str(fixed / REGRESSION)], fixed, timeout=TIMEOUT)
            report["checks"]["regression_fixed"] = positive
            if not _passed(positive):
                raise ValueError("regression does not pass the repair")
            report["checks"]["regression_individual"] = {}
            for target in targets:
                faulty = snapshot((target,))
                result = run_node([str(WRAPPER), str(faulty / REGRESSION)], faulty, timeout=TIMEOUT)
                report["checks"]["regression_individual"][target] = result
                if not _asserted(result):
                    raise ValueError(f"regression failed to detect the independent fault in {target}")
            combined = snapshot(tuple(targets))
            result = run_node([str(WRAPPER), str(combined / REGRESSION)], combined, timeout=TIMEOUT)
            report["checks"]["regression_combined"] = result
            if not _asserted(result):
                raise ValueError("regression failed to detect the original combined incident")
        report["status"] = "passed"
    except (ValueError, TypeError, KeyError, AttributeError, OSError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    return report


def main(fixture: Path) -> int:
    if len(sys.argv) != 4:
        print(json.dumps({"status": "failed", "error": "workspace, fault-source directory and baseline required"}))
        return 1
    report = evaluate(fixture, Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3])
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return int(report["status"] != "passed")
