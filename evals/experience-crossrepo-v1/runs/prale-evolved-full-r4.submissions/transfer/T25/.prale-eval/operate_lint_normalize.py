#!/usr/bin/env python3
"""T25 `operate` demo: run a local fake linter, normalize the observation.

The demo is stdlib-only and never leaves the workspace.

Pipeline
--------
1. ``run_fake_linter_separately`` launches ``.prale-eval/fake_linter.py`` with a
   separate pipe for stdout and stderr, so all three observed signals (stdout,
   stderr, nonzero exit status) are available individually.
2. ``load_runner`` AST-extracts the *real* ``run_cmd`` / ``run_cmd_subprocess``
   functions from ``aider/run_cmd.py`` and execs them with lightweight stubs.
   A plain ``import aider.run_cmd`` is impossible in this environment because
   the module imports ``pexpect``, which is not installed; per task rules that
   limitation is recorded rather than fixed by installing anything.
3. ``run_through_aider_runner`` calls the extracted ``run_cmd`` with stdin
   forced to a non-TTY (the CI path) and records its ``(returncode, output)``
   tuple, proving the runner preserves the nonzero exit status but merges the
   two streams.
4. ``normalize`` folds the raw observation into the ``prale.lint-normalized/v1``
   schema and writes ``.prale-eval/normalized_lint_result.json``.

Exit code 0 means every normalized-field contract held.
"""
import ast
import contextlib
import io
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent  # workspace root
RUN_CMD_SRC = WORKSPACE / "aider" / "run_cmd.py"
FAKE_LINTER = WORKSPACE / ".prale-eval" / "fake_linter.py"
NORMALIZED_OUT = WORKSPACE / ".prale-eval" / "normalized_lint_result.json"

#: ``file:line:col: CODE message`` - the fake linter's finding format.
ISSUE_RE = re.compile(
    r"^(?P<file>[^\s:]+):(?P<line>\d+):(?P<col>\d+): "
    r"(?P<code>[A-Z]\d+) (?P<message>.*)$"
)
SEVERITY_BY_PREFIX = {"E": "error", "W": "warning", "F": "error"}


class _StubModule:
    """Placeholder for an unavailable third-party module."""

    def __getattr__(self, name):  # pragma: no cover - defensive only
        raise AttributeError(name)


class _NonTtyStdin:
    """Minimal stdin stand-in so ``run_cmd`` takes the subprocess branch."""

    def isatty(self):
        return False


def run_fake_linter_separately(cwd=WORKSPACE):
    """Operate the fake linter with separate stdout/stderr pipes."""
    proc = subprocess.run(
        [sys.executable, str(FAKE_LINTER)],
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    return {"exit_code": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}


def load_runner():
    """Exec the real ``run_cmd`` helpers extracted from aider/run_cmd.py."""
    source = RUN_CMD_SRC.read_text()
    tree = ast.parse(source)
    wanted = {"run_cmd", "run_cmd_subprocess", "get_windows_parent_process_name"}
    segments = [
        ast.get_source_segment(source, node)
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted
    ]
    assert len(segments) == len(wanted), f"expected {wanted}, extracted {len(segments)}"
    namespace = {
        "os": os,
        "platform": platform,
        "subprocess": subprocess,
        "sys": sys,
        "pexpect": _StubModule(),
        "psutil": _StubModule(),
        "BytesIO": io.BytesIO,
    }
    exec("\n\n".join(segments), namespace)  # noqa: S102 - real repo source
    return namespace["run_cmd"]


def run_through_aider_runner(command, cwd=WORKSPACE):
    """Call the extracted aider ``run_cmd`` and capture its return tuple."""
    run_cmd = load_runner()
    real_stdin = sys.stdin
    streamed = io.StringIO()
    sys.stdin = _NonTtyStdin()
    try:
        with contextlib.redirect_stdout(streamed):
            returncode, output = run_cmd(command, cwd=str(cwd))
    finally:
        sys.stdin = real_stdin
    return {
        "function": "aider.run_cmd.run_cmd",
        "exit_code": returncode,
        "output": output,
        "mirrored_to_stdout": streamed.getvalue(),
    }


def normalize(command, raw, runner):
    """Fold the observed run into the normalized lint-result schema."""
    issues = []
    summary_lines = []
    for line in raw["stdout"].splitlines():
        match = ISSUE_RE.match(line)
        if match:
            code = match.group("code")
            issues.append(
                {
                    "file": match.group("file"),
                    "line": int(match.group("line")),
                    "column": int(match.group("col")),
                    "code": code,
                    "severity": SEVERITY_BY_PREFIX.get(code[0], "info"),
                    "message": match.group("message"),
                }
            )
        elif line.strip():
            summary_lines.append(line)

    diagnostics = [
        {"severity": "warning", "message": line}
        for line in raw["stderr"].splitlines()
        if line.strip()
    ]
    stderr_text = raw["stderr"].strip()
    merged = bool(stderr_text) and stderr_text in runner["output"] and stderr_text not in raw["stdout"]

    return {
        "schema": "prale.lint-normalized/v1",
        "task_id": "T25",
        "repository": "aider",
        "tool": "fake_lint",
        "command": command,
        "working_directory": ".",
        "exit_code": raw["exit_code"],
        "status": "fail" if raw["exit_code"] != 0 else "pass",
        "streams": {
            "stdout": raw["stdout"],
            "stderr": raw["stderr"],
            "stdout_lines": len(raw["stdout"].splitlines()),
            "stderr_lines": len(raw["stderr"].splitlines()),
        },
        "issues": issues,
        "diagnostics": diagnostics,
        "summary_lines": summary_lines,
        "counts": {
            "files": len({issue["file"] for issue in issues}),
            "issues": len(issues),
            "errors": sum(1 for i in issues if i["severity"] == "error"),
            "warnings": sum(1 for i in issues if i["severity"] == "warning"),
            "diagnostics": len(diagnostics),
        },
        "runner_contract": {
            "function": runner["function"],
            "returns": ["returncode", "combined_output"],
            "observed_exit_code": runner["exit_code"],
            "nonzero_exit_preserved": runner["exit_code"] == raw["exit_code"] != 0,
            "stderr_merged_into_stdout": merged,
            "stream_separation": "merged" if merged else "separate",
            "output_mirrored_to_stdout": runner["mirrored_to_stdout"] == runner["output"],
            "raw_stream_capture": "subprocess.run(capture_output=True)",
        },
    }


def check(result, raw, runner):
    """Focused contract checks over the normalized result."""
    checks = {
        "exit_code_nonzero": raw["exit_code"] != 0,
        "status_fail": result["status"] == "fail",
        "stdout_observed": bool(raw["stdout"].strip()),
        "stderr_observed": bool(raw["stderr"].strip()),
        "issues_parsed": result["counts"]["issues"] == 3,
        "issue_codes": [i["code"] for i in result["issues"]] == ["E501", "W291", "F401"],
        "runner_preserves_exit": result["runner_contract"]["nonzero_exit_preserved"],
        "runner_merges_streams": result["runner_contract"]["stderr_merged_into_stdout"],
        "runner_identity": runner["function"] == "aider.run_cmd.run_cmd",
    }
    return checks


def main():
    command = f"{Path(sys.executable).name} .prale-eval/fake_linter.py"
    raw = run_fake_linter_separately()
    runner = run_through_aider_runner(command)
    result = normalize(command, raw, runner)

    NORMALIZED_OUT.write_text(json.dumps(result, indent=2) + "\n")
    reloaded = json.loads(NORMALIZED_OUT.read_text())

    checks = check(result, raw, runner)
    for name, ok in checks.items():
        print(f"{'OK  ' if ok else 'FAIL'} {name}")
    print(f"raw exit_code={raw['exit_code']} stdout_lines={result['streams']['stdout_lines']} "
          f"stderr_lines={result['streams']['stderr_lines']} issues={result['counts']['issues']}")
    print(f"runner exit_code={runner['exit_code']} stream_separation="
          f"{result['runner_contract']['stream_separation']}")
    print(f"wrote {NORMALIZED_OUT.relative_to(WORKSPACE)} "
          f"({len(json.dumps(reloaded))} bytes, reproducible={reloaded == result})")

    if all(checks.values()) and reloaded == result:
        print("OPERATE CONTRACT HOLDS")
        return 0
    print("OPERATE CONTRACT VIOLATED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
