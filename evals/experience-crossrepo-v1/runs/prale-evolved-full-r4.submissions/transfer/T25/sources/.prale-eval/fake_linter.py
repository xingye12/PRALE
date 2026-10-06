#!/usr/bin/env python3
"""Local fake linter used by the T25 `operate` demo.

The script is deliberately small and dependency-free. It emits three distinct
observable signals so the pipeline has something real to normalize:

* lint findings on **stdout** (one `file:line:col: code message` per issue),
* a configuration diagnostic on **stderr**,
* a **nonzero** process exit code (3).

Nothing here depends on aider; it stands in for any external linter that aider
would invoke through ``aider.run_cmd.run_cmd`` / ``run_cmd_subprocess``.
"""
import sys

#: Nonzero exit code, mirroring "lint problems were found".
EXIT_CODE = 3

#: Lint findings, emitted on stdout, one per line.
STDOUT_LINES = [
    "src/app.py:1:80: E501 line too long (92 > 79 characters)",
    "src/app.py:3:1: W291 trailing whitespace",
    "src/app.py:7:5: F401 'os' imported but unused",
    "fake_lint: 3 problems found in 1 file",
]

#: Diagnostics, emitted on stderr.
STDERR_LINES = [
    "fake_lint: warning: config .fakelint.toml not found, using defaults",
]


def main():
    """Emit the fake lint result and exit nonzero."""
    for line in STDOUT_LINES:
        print(line)
    for line in STDERR_LINES:
        print(line, file=sys.stderr)
    sys.exit(EXIT_CODE)


if __name__ == "__main__":
    main()
