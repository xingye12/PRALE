#!/usr/bin/env python3
"""Executable demo for learn/22 (aider, mode=operate).

Operating a stub command that fails, preserving all three observable fields:
stdout, stderr and the exit code.

The demo does two things:

1. It runs the failing stub through the repository's own command machinery
   (``aider/run_cmd.py``), which is the contract the repository ships:
   ``run_cmd``/``run_cmd_subprocess`` return ``(exit_status, combined_output)``
   because stderr is redirected into stdout
   (``stderr=subprocess.STDOUT``). That path therefore preserves the exit code
   and the combined output, but it does *not* keep stderr as its own field.
2. It then normalizes the operation result into three distinct, preserved
   fields -- ``stdout``, ``stderr`` and ``exit_code`` -- captured with separate
   pipes, and asserts that the three fields really survived as separate values.

The normalized result is written to ``.prale-eval/operate-result.json``.

``pexpect`` and ``psutil`` are optional runtime dependencies of ``aider`` that
are not installed in this evaluation image; inert stand-ins are injected into
``sys.modules`` so the real, unmodified module body of ``aider/run_cmd.py`` can
be imported. No dependency is installed and no repository source is modified.
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
RUN_CMD_PATH = os.path.join(REPO_ROOT, "aider", "run_cmd.py")
STUB_PATH = os.path.join(HERE, "stub_fail.py")
RESULT_PATH = os.path.join(HERE, "operate-result.json")

STUB_EXIT_CODE = 3
STDOUT_MARKER = "STUB_STDOUT"
STDERR_MARKER = "STUB_STDERR"


def build_stub_command():
    """Return the shell command string that runs the failing stub."""
    return f'"{sys.executable}" "{STUB_PATH}"'


def load_repo_run_cmd():
    """Import aider/run_cmd.py verbatim, standing in for missing optional deps."""
    if "pexpect" not in sys.modules:
        pexpect = types.ModuleType("pexpect")
        pexpect.spawn = None  # hasattr(pexpect, "spawn") must stay truthy
        pexpect.ExceptionPexpect = Exception
        sys.modules["pexpect"] = pexpect
    if "psutil" not in sys.modules:
        sys.modules["psutil"] = types.ModuleType("psutil")

    spec = importlib.util.spec_from_file_location("aider_run_cmd_learn22", RUN_CMD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def operate_via_repo(run_cmd_module, command):
    """Run the stub through the repository's run_cmd and keep its raw contract."""
    sink = io.StringIO()
    with contextlib.redirect_stdout(sink):
        # Non-tty stdin makes run_cmd take the run_cmd_subprocess branch.
        exit_status, combined_output = run_cmd_module.run_cmd(command, verbose=False)
    return {
        "function": "aider.run_cmd.run_cmd",
        "return_shape": ["exit_status", "combined_output"],
        "stderr_merged_into_stdout": True,
        "exit_status": exit_status,
        "combined_output": combined_output,
    }


def preserve_all_three(command):
    """Run the stub with separate pipes so stdout/stderr/exit code survive."""
    proc = subprocess.run(
        command,
        shell=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    return {"exit_code": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}


def main():
    command = build_stub_command()
    repo_result = operate_via_repo(load_repo_run_cmd(), command)
    fields = preserve_all_three(command)

    # The point of the operation: all three fields are preserved and distinct.
    assert fields["exit_code"] == STUB_EXIT_CODE, fields
    assert STDOUT_MARKER in fields["stdout"], fields
    assert STDERR_MARKER not in fields["stdout"], "stderr leaked into stdout"
    assert STDERR_MARKER in fields["stderr"], fields
    assert STDOUT_MARKER not in fields["stderr"], "stdout leaked into stderr"

    # The repo contract keeps exit code + combined output (stderr folded in).
    assert repo_result["exit_status"] == STUB_EXIT_CODE, repo_result
    assert STDOUT_MARKER in repo_result["combined_output"], repo_result
    assert STDERR_MARKER in repo_result["combined_output"], repo_result

    normalized = {
        "operation": "run_failing_stub_command",
        "command": command,
        "exit_code": fields["exit_code"],
        "stdout": fields["stdout"],
        "stderr": fields["stderr"],
        "fields_preserved": ["stdout", "stderr", "exit_code"],
        "repo_contract": repo_result,
    }
    with open(RESULT_PATH, "w", encoding="utf-8") as fh:
        json.dump(normalized, fh, indent=2)
        fh.write("\n")

    print("OK: preserved exit_code=%r, stdout=%r, stderr=%r" % (
        normalized["exit_code"],
        normalized["stdout"].strip(),
        normalized["stderr"].strip(),
    ))
    print("wrote", os.path.relpath(RESULT_PATH, REPO_ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
