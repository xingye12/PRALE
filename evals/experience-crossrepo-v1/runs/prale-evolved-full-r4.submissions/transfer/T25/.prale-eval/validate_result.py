#!/usr/bin/env python3
"""Focused validator for T25: AST/schema check over `.prale-eval/result.json`.

Checks, all stdlib-only and workspace-confined:
1. `task_id` / `repository` / `mode` in result.json match the current TASK.md.
2. Every required top-level key is present with the right shape.
3. Every evidence entry names a real symbol whose definition lies inside the
   cited inclusive start_line/end_line range (AST for Python, key lookup for
   JSON, section text for Markdown).
4. The evidence contract path `aider/run_cmd.py` is covered by a substantive
   (non-trivial observation) entry and cited by at least one claim.
5. Every claim's `evidence_paths` resolve to cited evidence, and the operate
   output `.prale-eval/normalized_lint_result.json` carries the normalized
   observation (nonzero exit, fail status, parsed issues).

Prints `result.json schema OK` and exits 0 only if every check passes.
"""
import ast
import json
import re
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parent.parent
RESULT = WORKSPACE / ".prale-eval" / "result.json"
TASK = WORKSPACE / "TASK.md"
NORMALIZED = WORKSPACE / ".prale-eval" / "normalized_lint_result.json"

REQUIRED_EVIDENCE_PATH = "aider/run_cmd.py"
failures = []


def fail(message):
    failures.append(message)
    print(f"FAIL {message}")


def parse_task():
    text = TASK.read_text()
    def grab(key):
        match = re.search(rf"{key}`?\s+exactly\s+`([^`]+)`", text)
        return match.group(1) if match else None
    mode = re.search(r"Task mode: `([^`]+)`", text)
    return {
        "task_id": grab("task_id"),
        "repository": grab("repository"),
        "mode": mode.group(1) if mode else None,
    }


def defined_lines(path, symbol):
    """Line numbers where `symbol` is defined (or mentioned for non-Python)."""
    text = path.read_text()
    if path.suffix == ".py":
        tree = ast.parse(text)
        lines = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if node.name == symbol:
                    lines.append(node.lineno)
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == symbol:
                        lines.append(node.lineno)
        return lines
    if path.suffix == ".json":
        return [
            i + 1
            for i, line in enumerate(text.splitlines())
            if re.search(rf'"{re.escape(symbol)}"\s*:', line)
        ]
    return [
        i + 1
        for i, line in enumerate(text.splitlines())
        if symbol in line
    ]


def main():
    task = parse_task()
    result = json.loads(RESULT.read_text())

    for key in ("task_id", "repository", "mode"):
        if result.get(key) != task[key]:
            fail(f"{key} mismatch: result={result.get(key)!r} task={task[key]!r}")
        else:
            print(f"OK  {key}={result[key]!r} matches TASK.md")

    for key in ("evidence", "claims", "conclusion", "validation"):
        if key not in result:
            fail(f"missing required key {key!r}")
    if not isinstance(result.get("evidence"), list) or not result["evidence"]:
        fail("evidence must be a non-empty list")
    if not isinstance(result.get("claims"), list) or not result["claims"]:
        fail("claims must be a non-empty list")
    for key in ("command", "status", "notes"):
        if key not in result.get("validation", {}):
            fail(f"validation missing {key!r}")

    cited = set()
    for entry in result["evidence"]:
        for field in ("path", "symbol", "start_line", "end_line", "observation"):
            if field not in entry:
                fail(f"evidence entry missing {field!r}: {entry.get('path')}")
        path = WORKSPACE / entry["path"]
        cited.add(entry["path"])
        if not path.exists():
            fail(f"evidence path does not exist: {entry['path']}")
            continue
        start, end = entry["start_line"], entry["end_line"]
        if not (isinstance(start, int) and isinstance(end, int) and start <= end):
            fail(f"bad range for {entry['path']}:{entry['symbol']}")
            continue
        lines = defined_lines(path, entry["symbol"])
        if not any(start <= line <= end for line in lines):
            fail(
                f"SYMBOL OUTSIDE RANGE {entry['path']} {entry['symbol']} "
                f"{start}-{end} defined_at={lines}"
            )
        else:
            print(f"OK  {entry['path']}:{entry['symbol']} within {start}-{end}")

    substantive = [
        e
        for e in result["evidence"]
        if e["path"] == REQUIRED_EVIDENCE_PATH and len(e.get("observation", "")) >= 80
    ]
    if not substantive:
        fail(f"required path {REQUIRED_EVIDENCE_PATH} lacks a substantive evidence entry")
    else:
        print(f"OK  required path covered: {REQUIRED_EVIDENCE_PATH} ({len(substantive)} entries)")

    claim_paths = set()
    for claim in result["claims"]:
        if "claim" not in claim or "evidence_paths" not in claim:
            fail(f"claim missing claim/evidence_paths: {claim}")
            continue
        if not claim["evidence_paths"]:
            fail(f"claim has empty evidence_paths: {claim['claim'][:40]}")
        for p in claim["evidence_paths"]:
            claim_paths.add(p)
            if p not in cited:
                fail(f"claim cites uncited path {p!r}")
        if len(claim["claim"]) < 40:
            fail(f"claim too thin: {claim['claim']!r}")
    print(f"OK  claims: {len(result['claims'])} (paths={len(claim_paths)})")

    if REQUIRED_EVIDENCE_PATH not in claim_paths:
        fail(f"no claim cites required path {REQUIRED_EVIDENCE_PATH}")
    else:
        print(f"OK  a claim cites {REQUIRED_EVIDENCE_PATH}")

    if NORMALIZED.exists():
        norm = json.loads(NORMALIZED.read_text())
        checks = {
            "exit_code_is_3_nonzero": norm.get("exit_code") == 3,
            "status_fail": norm.get("status") == "fail",
            "three_issues": norm.get("counts", {}).get("issues") == 3,
            "stderr_diagnostic_kept_separate": len(norm.get("diagnostics", [])) == 1,
            "nonzero_exit_preserved": norm["runner_contract"]["nonzero_exit_preserved"],
            "stderr_merged_by_runner": norm["runner_contract"]["stderr_merged_into_stdout"],
        }
        for name, ok in checks.items():
            if ok:
                print(f"OK  normalized: {name}")
            else:
                fail(f"normalized check failed: {name}")
    else:
        fail(f"missing normalized operation result {NORMALIZED.relative_to(WORKSPACE)}")

    if failures:
        print("schema FAILED")
        return 1
    print("result.json schema OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
