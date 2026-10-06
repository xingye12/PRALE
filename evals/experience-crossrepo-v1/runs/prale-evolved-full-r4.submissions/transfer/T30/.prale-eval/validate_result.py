#!/usr/bin/env python3
"""Focused validation for .prale-eval/result.json (task T30, contract mode).

Checks, without any third-party dependency:
  * task metadata (task_id / repository / mode) matches the current TASK.md,
  * required top-level keys and per-entry keys exist,
  * every evidence entry cites a real symbol whose definition line lies inside
    the inclusive [start_line, end_line] range of the cited repository file,
  * the required source files are covered by evidence,
  * every claim's evidence_paths resolve to cited evidence paths,
  * the executable contract demo still holds.

Prints "result.json schema OK" and exits 0 only when everything passes.
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULT = ROOT / ".prale-eval" / "result.json"
TASK = ROOT / "TASK.md"
DEMO = ROOT / ".prale-eval" / "demo_boolean_override.py"

REQUIRED_PATHS = ["aider/args.py", "tests/basic/test_main.py"]
problems: list[str] = []


def fail(msg: str) -> None:
    problems.append(msg)


def load_task_metadata(task_text: str) -> dict:
    return {
        "task_id": re.search(r"`task_id` exactly `([^`]+)`", task_text).group(1),
        "repository": re.search(r"`repository` exactly `([^`]+)`", task_text).group(1),
        "mode": re.search(r"`mode` exactly `([^`]+)`", task_text).group(1),
    }


def symbols_in(path: Path) -> dict:
    """Map every real definition/assignment name to its definition line."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.setdefault(node.name, node.lineno)
    return found


def check_evidence(entries) -> set:
    cited_paths = set()
    symbol_cache = {}
    for i, ev in enumerate(entries):
        for key in ("path", "symbol", "start_line", "end_line", "observation"):
            if key not in ev:
                fail(f"evidence[{i}] missing key {key!r}")
        path = ROOT / ev.get("path", "")
        if not path.exists():
            fail(f"evidence[{i}] path does not exist: {ev.get('path')}")
            continue
        cited_paths.add(ev["path"])
        if path.suffix == ".py":
            symbol_cache.setdefault(ev["path"], symbols_in(path))
            sym = ev["symbol"]
            def_line = symbol_cache[ev["path"]].get(sym)
            if def_line is None:
                fail(f"evidence[{i}] symbol {sym!r} is not a real definition in {ev['path']}")
            elif not (ev["start_line"] <= def_line <= ev["end_line"]):
                fail(
                    f"evidence[{i}] symbol {sym!r} defined at line {def_line} is outside"
                    f" inclusive range [{ev['start_line']}, {ev['end_line']}] in {ev['path']}"
                )
        if not str(ev.get("observation", "")).strip():
            fail(f"evidence[{i}] has an empty observation")
    return cited_paths


def main() -> int:
    task_text = TASK.read_text(encoding="utf-8")
    meta = load_task_metadata(task_text)
    result = json.loads(RESULT.read_text(encoding="utf-8"))

    for key in ("task_id", "repository", "mode", "evidence", "claims", "conclusion", "validation"):
        if key not in result:
            fail(f"result.json missing top-level key {key!r}")

    for key, expected in meta.items():
        if result.get(key) != expected:
            fail(f"result.json {key}={result.get(key)!r} != TASK.md {expected!r}")

    evidence = result.get("evidence", [])
    cited_paths = check_evidence(evidence)

    required_covered = [p for p in REQUIRED_PATHS if p in cited_paths]
    if required_covered != REQUIRED_PATHS:
        fail(f"required paths not covered by evidence: {REQUIRED_PATHS}")
    else:
        print(f"required paths covered: {required_covered}")

    claims = result.get("claims", [])
    claims_per_path = {p: 0 for p in REQUIRED_PATHS}
    for i, claim in enumerate(claims):
        if "claim" not in claim or "evidence_paths" not in claim:
            fail(f"claims[{i}] missing 'claim'/'evidence_paths'")
            continue
        if not claim["evidence_paths"]:
            fail(f"claims[{i}] has empty evidence_paths")
        for p in claim["evidence_paths"]:
            if p not in cited_paths:
                fail(f"claims[{i}] evidence_path {p!r} is not cited in evidence")
            if p in claims_per_path:
                claims_per_path[p] += 1
    for p, n in claims_per_path.items():
        if n == 0:
            fail(f"no substantive claim references required path {p}")
        else:
            print(f"claims citing {p}: {n}")

    validation = result.get("validation", {})
    for key in ("command", "status", "notes"):
        if key not in validation:
            fail(f"validation missing key {key!r}")

    print(f"evidence entries: {len(evidence)} | claims: {len(claims)}")

    demo = subprocess.run([sys.executable, str(DEMO)], capture_output=True, text=True)
    if demo.returncode != 0 or "CONTRACT HOLDS" not in demo.stdout:
        fail(f"executable demo did not hold (exit {demo.returncode})")
    else:
        print("executable demo: CONTRACT HOLDS")

    if problems:
        print("result.json schema FAILED")
        for p in problems:
            print("  -", p)
        return 1
    print("result.json schema OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
