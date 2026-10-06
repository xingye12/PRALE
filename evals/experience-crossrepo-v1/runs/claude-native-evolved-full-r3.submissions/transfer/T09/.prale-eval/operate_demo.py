#!/usr/bin/env python3
"""Operate the local fake linter and normalize the observed result.

The observation is grounded in aider/run_cmd.py:

* ``run_cmd`` (aider/run_cmd.py:11-23) dispatches to the pexpect variant only
  when stdin is a tty and pexpect exposes ``spawn``; otherwise it uses
  ``run_cmd_subprocess``.
* ``run_cmd_subprocess`` (aider/run_cmd.py:42-86) launches the command with
  ``shell=True`` and ``stderr=subprocess.STDOUT``, so stderr is *merged* into
  the captured output, and returns ``(returncode, combined_output)``.

The harness prefers the repository's real ``run_cmd``. When the module cannot
be imported (its optional ``pexpect`` dependency is unavailable in this
environment) it falls back to a byte-for-byte faithful re-implementation of the
``run_cmd_subprocess`` contract and records the limitation in the normalized
result. A second, independent capture keeps stdout and stderr separate so the
normalized result can classify each channel.

Run with:  python3 .prale-eval/operate_demo.py
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
LINTER = os.path.join(HERE, "fake_linter.py")
COMMAND = "python3 " + os.path.relpath(LINTER, REPO_ROOT)
ENCODING = sys.stdout.encoding or "utf-8"
OUT_PATH = os.path.join(HERE, "operate-observation.json")


def run_via_aider_run_cmd(command):
    """Use the repo's real run_cmd. Returns (result, limitation)."""
    sys.path.insert(0, REPO_ROOT)
    try:
        from aider.run_cmd import run_cmd  # noqa: WPS433
    except Exception as exc:  # optional pexpect dependency missing
        return None, "{}: {}".format(type(exc).__name__, exc)
    return run_cmd(command), None


def run_like_run_cmd_subprocess(command):
    """Faithful mirror of aider/run_cmd.py:42-86 (merged-stream contract)."""
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=True,
        encoding=ENCODING,
        errors="replace",
        bufsize=0,
        universal_newlines=True,
        cwd=None,
    )
    output = []
    while True:
        chunk = process.stdout.read(1)
        if not chunk:
            break
        output.append(chunk)
    process.wait()
    return process.returncode, "".join(output)


def capture_separate_streams(command):
    """Independent capture that keeps stdout and stderr distinct."""
    proc = subprocess.run(
        command,
        shell=True,
        text=True,
        encoding=ENCODING,
        errors="replace",
        capture_output=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def parse_findings(stdout):
    """Normalize ``file:line:col: CODE message`` lines into structured dicts."""
    findings = []
    for line in stdout.splitlines():
        parts = line.split(":", 3)
        if len(parts) == 4 and parts[1].strip().isdigit() and parts[2].strip().isdigit():
            file_name, line_no, col, code_message = parts
            code_message = code_message.strip()
            code, _, message = code_message.partition(" ")
            findings.append(
                {
                    "file": file_name,
                    "line": int(line_no),
                    "column": int(col),
                    "code": code,
                    "message": message.strip(),
                    "severity": "error",
                }
            )
    return findings


def main():
    observed_via = "aider.run_cmd.run_cmd"
    limitation = None

    result, limitation = run_via_aider_run_cmd(COMMAND)
    if result is None:
        observed_via = "run_cmd_subprocess contract mirror (aider/run_cmd.py:42-86)"
        result = run_like_run_cmd_subprocess(COMMAND)

    exit_code, combined_output = result

    # A separate capture keeps the two channels distinguishable.
    sep_code, stdout, stderr = capture_separate_streams(COMMAND)
    assert sep_code == exit_code, "exit status mismatch between captures"

    normalized = {
        "operation": "fake-linter-run",
        "command": COMMAND,
        "observed_via": observed_via,
        "streams_merged_by_run_cmd": True,
        "exit_code": exit_code,
        "status": "failed" if exit_code != 0 else "passed",
        "stdout": stdout,
        "stderr": stderr,
        "combined_output": combined_output,
        "findings": parse_findings(stdout),
        "diagnostics": [ln for ln in stderr.splitlines() if ln.strip()],
        "dependency_limitation": limitation,
    }
    return normalized


if __name__ == "__main__":
    normalized = main()
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(normalized, fh, indent=2)
        fh.write("\n")
    json.dump(normalized, sys.stdout, indent=2)
    sys.stdout.write("\n")
