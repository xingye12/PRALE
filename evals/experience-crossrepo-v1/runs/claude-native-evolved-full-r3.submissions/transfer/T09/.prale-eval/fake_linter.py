#!/usr/bin/env python3
"""A local fake linter used to exercise aider's run_cmd contract.

It deliberately writes human-readable output to stdout, a diagnostic warning
to stderr, and terminates with a nonzero exit status so the observing harness
has to normalize all three channels.
"""
import sys


def main():
    sys.stdout.write("fake_linter: checking fake_target.py\n")
    sys.stdout.write("fake_target.py:1:1: E999 fake syntax finding\n")
    sys.stdout.write("fake_linter: 1 problem found\n")
    sys.stderr.write("fake_linter: warning: no config file, using defaults\n")
    sys.stderr.flush()
    return 2


if __name__ == "__main__":
    sys.exit(main())
