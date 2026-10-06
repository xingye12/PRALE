#!/usr/bin/env python3
"""Stub command operated by the demo.

It writes one marker to stdout, one marker to stderr, and exits non-zero so
that all three observable fields (stdout, stderr, exit code) are produced.
"""

import sys

print("STUB_STDOUT: stub wrote to stdout")
print("STUB_STDERR: stub wrote to stderr", file=sys.stderr)
sys.exit(3)
