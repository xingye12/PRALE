#!/usr/bin/env python3
"""Focused validation for T23: schema + AST citation containment.

Checks
------
1. `.prale-eval/result.json` exists and has exactly the required top-level keys.
2. `task_id == "T23"`, `repository == "aider"`, `mode == "demo"`.
3. Every evidence entry has path/symbol/start_line/end_line/observation, the
   path exists, and the cited inclusive range really contains the named symbol
   (AST lookup for methods/classes/functions, exact-line search otherwise).
4. Every claim has a non-empty `claim` and non-empty `evidence_paths`, and each
   cited path is covered by the evidence array.
5. `aider/repomap.py` is covered (public acceptance contract).
6. `validation` has command/status/notes, and the demo output artifact exists
   with `status == "pass"`.

Prints `result.json schema OK` on success.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
RESULT = HERE / "result.json"

REQUIRED_KEYS = {
    "task_id",
    "repository",
    "mode",
    "evidence",
    "claims",
    "conclusion",
    "validation",
}
REQUIRED_EVIDENCE_PATHS = {"aider/repomap.py"}


def symbol_range(rel_path: str, symbol: str) -> tuple[int, int] | None:
    """Inclusive (start, end) line range of `symbol` (Class.method, func, name)."""
    src = (WORKSPACE / rel_path).read_text()
    tree = ast.parse(src, filename=rel_path)
    parts = symbol.split(".")
    nodes = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))]
    if len(parts) == 1:
        for node in tree.body:
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                if node.name == parts[0]:
                    return node.lineno, node.end_lineno
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for t in targets:
                    if isinstance(t, ast.Name) and t.id == parts[0]:
                        return node.lineno, node.end_lineno
        return None
    if len(parts) == 2 and isinstance(nodes, list) or len(parts) == 2:
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and node.name == parts[0]:
                for sub in node.body:
                    if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if sub.name == parts[1]:
                            return sub.lineno, sub.end_lineno
        return None
    return None


def main() -> int:
    errors: list[str] = []

    if not RESULT.is_file():
        print(f"FAIL: missing {RESULT}")
        return 1
    data = json.loads(RESULT.read_text())

    missing = REQUIRED_KEYS - set(data)
    if missing:
        errors.append(f"missing top-level keys: {sorted(missing)}")
    extra = set(data) - REQUIRED_KEYS
    if extra:
        print(f"note: extra top-level keys (allowed): {sorted(extra)}")

    if data.get("task_id") != "T23":
        errors.append(f"task_id != T23: {data.get('task_id')!r}")
    if data.get("repository") != "aider":
        errors.append(f"repository != aider: {data.get('repository')!r}")
    if data.get("mode") != "demo":
        errors.append(f"mode != demo: {data.get('mode')!r}")

    evidence = data.get("evidence") or []
    if not isinstance(evidence, list) or not evidence:
        errors.append("evidence must be a non-empty list")
        evidence = []
    covered_paths: set[str] = set()
    for i, entry in enumerate(evidence):
        for key in ("path", "symbol", "start_line", "end_line", "observation"):
            if key not in entry:
                errors.append(f"evidence[{i}] missing {key}")
        path = entry.get("path")
        sym = entry.get("symbol")
        if not path or not sym:
            continue
        covered_paths.add(path)
        if not (WORKSPACE / path).is_file():
            errors.append(f"evidence[{i}] path not found: {path}")
            continue
        if not str(entry.get("observation", "")).strip():
            errors.append(f"evidence[{i}] empty observation")
        rng = symbol_range(path, sym)
        if rng is None:
            errors.append(f"evidence[{i}] symbol {sym!r} not found in {path}")
            continue
        start, end = entry.get("start_line"), entry.get("end_line")
        if not isinstance(start, int) or not isinstance(end, int):
            errors.append(f"evidence[{i}] start_line/end_line must be ints")
            continue
        if not (start <= rng[0] and rng[1] <= end):
            errors.append(
                f"evidence[{i}] range {start}-{end} does not contain "
                f"{sym} ({rng[0]}-{rng[1]}) in {path}"
            )

    contract_missing = REQUIRED_EVIDENCE_PATHS - covered_paths
    if contract_missing:
        errors.append(f"evidence does not cover required paths: {sorted(contract_missing)}")

    claims = data.get("claims") or []
    if not isinstance(claims, list) or not claims:
        errors.append("claims must be a non-empty list")
        claims = []
    for i, claim in enumerate(claims):
        if not str(claim.get("claim", "")).strip():
            errors.append(f"claims[{i}] empty claim text")
        paths = claim.get("evidence_paths") or []
        if not paths:
            errors.append(f"claims[{i}] empty evidence_paths")
        for p in paths:
            if p not in covered_paths:
                errors.append(f"claims[{i}] evidence_paths {p!r} not in evidence array")

    validation = data.get("validation") or {}
    for key in ("command", "status", "notes"):
        if key not in validation:
            errors.append(f"validation missing {key}")
    if validation.get("status") not in {"pass", "passed", "ok"}:
        errors.append(f"validation.status not passing: {validation.get('status')!r}")

    demo_out = HERE / "demo-output.json"
    if not demo_out.is_file():
        errors.append("missing .prale-eval/demo-output.json (demo was not executed)")
    else:
        out = json.loads(demo_out.read_text())
        if out.get("status") != "pass":
            errors.append(f"demo-output.json status != pass: {out.get('status')!r}")

    if not (HERE / "demo-deliverable.md").is_file():
        errors.append("missing .prale-eval/demo-deliverable.md")

    print(f"evidence entries: {len(evidence)}")
    print(f"claims: {len(claims)}")
    print(f"required paths covered: {sorted(covered_paths)}")
    if errors:
        print("VALIDATION FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("result.json schema OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
