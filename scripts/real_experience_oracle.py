"""External real-v2 acceptance: behavior + fixed/fault regression replay.

This is an evaluation adapter, not a runtime API. The controller supplies the
original fault source captured before agent execution. No source snippet is
used as a correctness criterion.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from real_experience_manifest import _files
from real_experience_support import subject_path

CONTRACTS = Path(__file__).with_name("real_experience_contracts")
REGRESSION = ".prale-eval/regression.mjs"
COMMAND = f"node --experimental-vm-modules {REGRESSION}"


def run_node(arguments: list[str], cwd: Path, *, timeout: float = 15) -> dict[str, Any]:
    """Run bounded checks with fresh HOME; terminate descendant processes too."""
    with tempfile.TemporaryDirectory(prefix="prale-oracle-home-") as home:
        environment = {
            "PATH": os.defpath
            if shutil.which("node") is None
            else str(Path(shutil.which("node") or "").parent) + os.pathsep + os.defpath,
            "HOME": home,
            "TMPDIR": home,
            "CI": "true",
        }
        try:
            process = subprocess.Popen(
                ["node", "--experimental-vm-modules", *arguments],
                cwd=cwd,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as error:
            return {"status": "launch_failed", "exit_code": None, "stdout": "", "stderr": str(error)}
        status = "completed"
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            status = "timed_out"
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return {
            "status": status,
            "exit_code": process.returncode,
            "stdout": stdout[-20_000:],
            "stderr": stderr[-20_000:],
        }


def _regular(root: Path, relative: str) -> Path:
    path = root / relative
    if not path.is_file() or path.resolve() != path.absolute():
        raise ValueError(f"missing or symlinked delivery: {relative}")
    return path


def evaluate(fixture: Path, workspace: Path, fault_source: Path, baseline: str) -> dict[str, Any]:
    report: dict[str, Any] = {"oracle_version": 3, "status": "failed", "checks": {}}
    try:
        metadata = json.loads((fixture / "fixture.json").read_text())
        report["task_id"] = metadata["task_id"]
        report["fixture_revision"] = metadata["fixture_revision"]
        target = metadata["target"]
        manifest = json.loads(fault_source.with_suffix(".baseline.json").read_text(encoding="utf-8"))
        if manifest["baseline_commit"] != baseline:
            raise ValueError("controller baseline commit mismatch")
        if hashlib.sha256(_regular(workspace, ".git/config").read_bytes()).hexdigest() != manifest["git_config_sha256"]:
            raise ValueError("Git configuration was changed")
        before, after = manifest["files"], _files(workspace)
        changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
        if any(name != target and not name.startswith(".prale-eval/") for name in changed):
            raise ValueError("out-of-scope workspace changes")
        _regular(workspace, target)
        _regular(workspace, REGRESSION)
        loader = _regular(workspace, ".prale-eval/subject.mjs")
        if loader.read_bytes() != subject_path(metadata, CONTRACTS).read_bytes():
            raise ValueError("read-only subject loader was modified")
        result = json.loads(_regular(workspace, ".prale-eval/result.json").read_text())
        for key, expected in (
            ("task_id", metadata["task_id"]),
            ("repository", "earendil-works/pi"),
            ("mode", "repair"),
        ):
            if result.get(key) != expected:
                raise ValueError(f"result.json has wrong {key}")
        validation = result.get("validation", {})
        if (
            validation.get("command") != COMMAND
            or validation.get("status") != "passed"
            or not isinstance(validation.get("notes"), str)
            or len(validation["notes"].strip()) < 20
        ):
            raise ValueError("validation must identify the regression command, passed status and substantive notes")
        # Nothing runs against the submitted workspace itself. A test cannot repair
        # the submission or contaminate the other replay condition.
        with tempfile.TemporaryDirectory(prefix="prale-real-oracle-") as temporary:
            root = Path(temporary)
            fixed = Path(tempfile.mkdtemp(prefix="case-", dir=root)) / "workspace"
            shutil.copytree(workspace, fixed, symlinks=True, ignore=shutil.ignore_patterns(".git", "node_modules"))
            # Reject source/fixture symlinks, including extra regression imports.
            for path in fixed.rglob("*"):
                if path.is_symlink() and (path.is_relative_to(fixed / ".prale-eval") or path == fixed / target):
                    raise ValueError("regression delivery may not depend on symlinks")
            faulty = Path(tempfile.mkdtemp(prefix="case-", dir=root)) / "workspace"
            shutil.copytree(fixed, faulty, symlinks=True)
            (faulty / target).write_bytes(fault_source.read_bytes())
            wrapper = CONTRACTS / "regression.mjs"
            behavior_root = Path(tempfile.mkdtemp(prefix="case-", dir=root)) / "workspace"
            shutil.copytree(fixed, behavior_root, symlinks=True)
            behavior = run_node(
                [str(wrapper), str(CONTRACTS / "behavior.mjs"), str(behavior_root), metadata["episode"]], behavior_root
            )
            report["checks"]["behavior"] = behavior
            if behavior["status"] != "completed" or behavior["exit_code"] != 0:
                raise ValueError("hidden production behavior contract failed")
            # Run each regression with a controller-installed assertion marker. It
            # distinguishes a genuine Node AssertionError from crashes/import errors.
            passed = run_node([str(wrapper), str(fixed / REGRESSION)], fixed)
            report["checks"]["regression_fixed"] = passed
            if passed["status"] != "completed" or passed["exit_code"] != 0:
                raise ValueError("submitted regression failed on repaired source")
            killed = run_node([str(wrapper), str(faulty / REGRESSION)], faulty)
            report["checks"]["regression_fault"] = killed
            if (
                killed["status"] != "completed"
                or killed["exit_code"] != 42
                or "PRALE_REGRESSION_ASSERTION" not in killed["stderr"]
            ):
                raise ValueError("submitted regression did not detect the original fault with an assertion")
        report["status"] = "passed"
    except (ValueError, OSError, subprocess.SubprocessError, TypeError, KeyError, AttributeError) as error:
        report["error"] = str(error)
    return report


def main(fixture: Path) -> int:
    if len(sys.argv) != 4:
        print(
            json.dumps(
                {"status": "failed", "error": "controller must supply workspace, fault source and baseline commit"}
            )
        )
        return 1
    report = evaluate(fixture, Path(sys.argv[1]).resolve(), Path(sys.argv[2]), sys.argv[3])
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["status"] == "passed" else 1
