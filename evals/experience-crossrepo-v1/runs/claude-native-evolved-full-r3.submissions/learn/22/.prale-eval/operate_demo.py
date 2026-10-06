"""Operate a failing stub command and preserve stdout / stderr / exit code.

This is the executable demo backing `.prale-eval/operate-deliverable.md`.

It does two things:

1. Runs a stub command that fails, capturing the three fields directly at the
   OS level (`subprocess.run(..., capture_output=True)`), and normalizes them
   into a single operation-result object.
2. Runs the *same* stub through aider's own `aider.run_cmd.run_cmd` so the
   repository's actual contract is observed rather than assumed.

Dependency note: aider/run_cmd.py imports `pexpect` and `psutil` at module
scope.  Neither is installed in this environment and dependencies must not be
installed.  To import the real module without them we register minimal stand-in
modules in `sys.modules` *only when the real package is absent*.  These shims
are never used on the executed code path (`run_cmd_subprocess`), because stdin
is not a tty here, so `run_cmd` dispatches to the subprocess branch exactly as
it would in CI.

Run:  python .prale-eval/operate_demo.py
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import types

# The failing stub: distinct stdout, distinct stderr, non-zero exit code.
STUB = (
    "python -c \""
    "import sys; "
    "sys.stdout.write('stub-stdout-line\\n'); "
    "sys.stdout.flush(); "
    "sys.stderr.write('stub-stderr-line\\n'); "
    "sys.stderr.flush(); "
    "sys.exit(3)"
    "\""
)


def _ensure_optional_imports():
    """Register stand-ins for pexpect/psutil only if they are not installed."""
    shimmed = []
    if "pexpect" not in sys.modules:
        try:
            import pexpect  # noqa: F401
        except ImportError:
            sys.modules["pexpect"] = types.ModuleType("pexpect")
            shimmed.append("pexpect")
    if "psutil" not in sys.modules:
        try:
            import psutil  # noqa: F401
        except ImportError:
            sys.modules["psutil"] = types.ModuleType("psutil")
            shimmed.append("psutil")
    return shimmed


def capture_os_level(command):
    """Capture the three fields independently and normalize them."""
    proc = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
    )
    return {
        "command": command,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "exit_code": proc.returncode,
        "preserved_fields": ["stdout", "stderr", "exit_code"],
    }


def capture_via_aider(command):
    """Observe aider's documented return contract for the same stub."""
    shimmed = _ensure_optional_imports()
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    from aider.run_cmd import run_cmd  # noqa: E402  (import after shims)

    # run_cmd_subprocess echoes output to stdout in real-time; suppress it so
    # the JSON written below stays machine-readable.
    with contextlib.redirect_stdout(io.StringIO()):
        result = run_cmd(command)
    exit_status, combined_output = result
    return {
        "shimmed_optional_imports": shimmed,
        "returned_arity": len(result),
        "exit_status": exit_status,
        "combined_output": combined_output,
        "stderr_merged_into_stdout": "stub-stderr-line" in combined_output,
    }


def main():
    normalized = capture_os_level(STUB)
    aider_view = capture_via_aider(STUB)

    payload = {
        "stub_command": STUB,
        "os_level_operation_result": normalized,
        "aider_run_cmd_result": aider_view,
    }

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "operate-result.json")
    with open(out_path, "w") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")

    print(json.dumps(payload, indent=2))
    print("\nwrote", out_path)

    # A failing stub must surface all three fields unchanged.
    assert normalized["exit_code"] == 3
    assert normalized["stdout"] == "stub-stdout-line\n"
    assert normalized["stderr"] == "stub-stderr-line\n"
    return 0


if __name__ == "__main__":
    sys.exit(main())
