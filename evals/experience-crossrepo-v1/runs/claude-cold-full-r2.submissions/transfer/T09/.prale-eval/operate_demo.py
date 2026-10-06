#!/usr/bin/env python3
"""Operate the local fake linter through aider.run_cmd and normalize the result.

The demo performs one real operation:

    python3 .prale-eval/fake_linter.py sample.py

executed through ``aider.run_cmd.run_cmd`` -- the same helper aider itself uses
to shell out to a project's linter.  The observable result (exit status plus
streams) is then normalized into the JSON schema written to
``.prale-eval/observed.json`` and embedded in ``.prale-eval/result.json``.

The linter is also run a second time through a *raw* subprocess with separate
pipes.  ``run_cmd_subprocess`` sets ``stderr=subprocess.STDOUT``, so everything
run_cmd reports lands in a single merged stream; the raw run is what lets the
normalizer recover the stdout/stderr split and attribute the exit status.

No third-party dependency is installed by this script.  ``aider/run_cmd.py``
imports ``pexpect`` and ``psutil`` at module scope, and neither is available in
this offline environment, so a minimal in-memory shim is registered *only* to
satisfy those imports.  On this platform (Linux, non-tty stdin) ``run_cmd``
takes the ``run_cmd_subprocess`` branch, which never touches ``pexpect.spawn``;
the shim is therefore never called.  See ``note_dependency_limitation`` in the
normalized output.
"""
import json
import os
import subprocess
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.dirname(HERE)
LINTER = os.path.join(HERE, "fake_linter.py")
TARGET = "sample.py"
REQUIRED = ("pexpect", "psutil")

# The command under operation, expressed exactly as an operator would type it.
LINTER_COMMAND = f"{sys.executable} {os.path.relpath(LINTER, WORKSPACE)} {TARGET}"


def install_import_shims():
    """Register inert stubs for missing optional deps; return what was shimmed.

    Purely an import-time affordance.  No stub is ever invoked: the exercised
    branch (``run_cmd_subprocess``) is pure stdlib.
    """
    shimmed = []
    for name in REQUIRED:
        try:
            __import__(name)
        except ImportError:
            module = types.ModuleType(name)
            module.__doc__ = f"inert offline shim for {name}; never invoked"
            module.__prale_shim__ = True
            sys.modules[name] = module
            shimmed.append(name)
    return shimmed


def run_through_aider(command):
    """Run the command through aider's own helper. Returns (exit_code, merged)."""
    sys.path.insert(0, WORKSPACE)
    from aider.run_cmd import run_cmd

    return run_cmd(command, verbose=True)


def run_raw(command):
    """Run the command with separate pipes to recover the stdout/stderr split."""
    proc = subprocess.run(
        command,
        shell=True,
        cwd=WORKSPACE,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def parse_diagnostics(stdout):
    """Turn linter stdout lines into structured diagnostic records."""
    diagnostics = []
    for line in stdout.splitlines():
        # "<file>:<line>:<col>: <severity> <rule> <message>"
        head, _, tail = line.partition(": ")
        if not tail or head.count(":") != 2:
            continue  # summary/count lines carry no location
        path, lineno, col = head.rsplit(":", 2)
        severity, _, rule_and_msg = tail.partition(" ")
        rule, _, message = rule_and_msg.partition(" ")
        diagnostics.append(
            {
                "file": path,
                "line": int(lineno),
                "column": int(col),
                "severity": severity,
                "rule": rule,
                "message": message,
            }
        )
    return diagnostics


def main():
    shimmed = install_import_shims()

    aider_exit, merged = run_through_aider(LINTER_COMMAND)
    raw_exit, raw_stdout, raw_stderr = run_raw(LINTER_COMMAND)

    normalized = {
        "operation": "run_fake_linter",
        "command": LINTER_COMMAND,
        "cwd": WORKSPACE,
        "exit_code": aider_exit,
        "status": "fail" if aider_exit != 0 else "pass",
        "streams": {
            # run_cmd returns stdout and stderr merged into one stream.
            "merged": merged,
            "stdout": raw_stdout,
            "stderr": raw_stderr,
        },
        "diagnostics": parse_diagnostics(raw_stdout),
        "counts": {
            "diagnostics": len(parse_diagnostics(raw_stdout)),
            "stdout_lines": len(raw_stdout.splitlines()),
            "stderr_lines": len(raw_stderr.splitlines()),
        },
        "normalization": {
            "exit_code_source": "aider.run_cmd.run_cmd -> run_cmd_subprocess "
            "-> process.returncode",
            "stream_separation": "recovered by re-running the identical command "
            "with separate pipes, because run_cmd_subprocess passes "
            "stderr=subprocess.STDOUT",
            "aider_stdout_matches_raw_stdout": merged == raw_stdout,
            "aider_exit_matches_raw_exit": aider_exit == raw_exit,
            "shimmed_imports": shimmed,
        },
        "note_dependency_limitation": (
            "pexpect and psutil are not installed; blind import of "
            "aider.run_cmd fails. The demo registers inert in-memory shims for "
            "the import to succeed and records them under "
            "normalization.shimmed_imports. The shimmed modules are never "
            "called on this non-tty Linux path."
        ),
    }

    with open(os.path.join(HERE, "observed.json"), "w", encoding="utf-8") as fh:
        json.dump(normalized, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print("\n--- normalized ---")
    print(json.dumps(normalized, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
