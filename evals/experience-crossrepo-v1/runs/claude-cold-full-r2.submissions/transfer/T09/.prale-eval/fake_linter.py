#!/usr/bin/env python3
"""Deterministic fake linter used to exercise aider.run_cmd's execution contract.

It deliberately emits all three observable signals a real linter produces:
  * structured diagnostics on stdout
  * an advisory line on stderr
  * a non-zero exit status (2 == "lint findings present")

Usage: fake_linter.py [TARGET ...]
"""
import sys

EXIT_LINT_FINDINGS = 2

# (rule, severity, file, line, col, message)
DIAGNOSTICS = [
    ("FAKE-LINT0001", "warning", "sample.py", 3, 1, "unused import 'os'"),
    ("FAKE-LINT0002", "error", "sample.py", 7, 80, "line too long (92 > 79)"),
]


def render_stdout(diagnostics):
    lines = []
    for rule, severity, path, line, col, message in diagnostics:
        lines.append(f"{path}:{line}:{col}: {severity} {rule} {message}")
    if diagnostics:
        lines.append(f"{len(diagnostics)} problem(s) found")
    return "\n".join(lines) + "\n"


def render_stderr(diagnostics):
    errors = sum(1 for d in diagnostics if d[1] == "error")
    return f"fake-lint: error: {errors} error(s), refusing to pass\n"


def main(argv):
    if not argv:
        sys.stderr.write("fake-lint: error: no target files given\n")
        return 3
    sys.stdout.write(render_stdout(DIAGNOSTICS))
    sys.stdout.flush()
    sys.stderr.write(render_stderr(DIAGNOSTICS))
    sys.stderr.flush()
    return EXIT_LINT_FINDINGS


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
