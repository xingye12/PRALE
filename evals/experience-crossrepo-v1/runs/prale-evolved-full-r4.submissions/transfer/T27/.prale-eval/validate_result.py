#!/usr/bin/env python3
"""AST schema + citation validator for .prale-eval/result.json (T27).

Independent of any third-party runtime: it parses aider/models.py with `ast`
and checks, for every evidence entry, that the named symbol really exists and
that its definition span lies inside the reported inclusive
[start_line, end_line] range. It also checks the required result.json keys.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parent
RESULT = HERE / "result.json"


def symbol_span(tree: ast.AST, dotted: str) -> tuple[int, int] | None:
    parts = dotted.split(".")
    node: ast.AST = tree
    for part in parts:
        found = None
        for child in getattr(node, "body", []):
            if getattr(child, "name", None) == part:
                found = child
                break
        if found is None:
            return None
        node = found
    return node.lineno, node.end_lineno


def main() -> int:
    data = json.loads(RESULT.read_text())
    problems: list[str] = []

    for key in ("task_id", "repository", "mode", "evidence", "claims", "conclusion", "validation"):
        if key not in data:
            problems.append(f"missing top-level key: {key}")

    if data.get("task_id") != "T27":
        problems.append(f"task_id != T27: {data.get('task_id')!r}")
    if data.get("repository") != "aider":
        problems.append(f"repository != aider: {data.get('repository')!r}")
    if data.get("mode") != "contract":
        problems.append(f"mode != contract: {data.get('mode')!r}")

    for field in ("command", "status", "notes"):
        if field not in data.get("validation", {}):
            problems.append(f"validation missing field: {field}")

    sources: dict[str, ast.Module] = {}
    required_paths = {"aider/models.py"}
    seen_paths = set()

    for i, ev in enumerate(data.get("evidence", [])):
        for field in ("path", "symbol", "start_line", "end_line", "observation"):
            if field not in ev:
                problems.append(f"evidence[{i}] missing field: {field}")
        path = ev.get("path")
        seen_paths.add(path)
        if not isinstance(ev.get("start_line"), int) or not isinstance(ev.get("end_line"), int):
            problems.append(f"evidence[{i}] lines are not ints")
            continue
        if ev["start_line"] > ev["end_line"]:
            problems.append(f"evidence[{i}] start_line > end_line")
        if path not in sources:
            sources[path] = ast.parse((WORKSPACE / path).read_text())
        span = symbol_span(sources[path], ev.get("symbol", ""))
        if span is None:
            problems.append(f"evidence[{i}] symbol not found: {ev.get('symbol')}")
        elif not (ev["start_line"] <= span[0] and span[1] <= ev["end_line"]):
            problems.append(
                f"evidence[{i}] symbol {ev['symbol']} span {span} outside "
                f"[{ev['start_line']}, {ev['end_line']}]"
            )
        if not str(ev.get("observation", "")).strip():
            problems.append(f"evidence[{i}] empty observation")

    missing = required_paths - seen_paths
    if missing:
        problems.append(f"required evidence paths not covered: {sorted(missing)}")

    claim_paths = set()
    for i, claim in enumerate(data.get("claims", [])):
        if not str(claim.get("claim", "")).strip():
            problems.append(f"claims[{i}] empty claim")
        paths = claim.get("evidence_paths") or []
        if not paths:
            problems.append(f"claims[{i}] has no evidence_paths")
        for p in paths:
            if p not in seen_paths:
                problems.append(f"claims[{i}] references uncited path: {p}")
            claim_paths.add(p)
    for p in required_paths:
        if p not in claim_paths:
            problems.append(f"required path {p} has no claim")

    if problems:
        print("result.json validation FAILED:")
        for p in problems:
            print(" -", p)
        return 1

    print(f"result.json schema OK ({len(data['evidence'])} evidence, {len(data['claims'])} claims)")
    print("citation AST check OK: every symbol span lies inside its reported range")
    return 0


if __name__ == "__main__":
    sys.exit(main())
