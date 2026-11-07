"""Re-score retained tool outputs using verified source-content evidence, not file opens."""

import argparse
import fnmatch
import io
import json
import re
import shlex
import subprocess
import tarfile
import tempfile
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any


def normalize_line(line: str) -> str:
    return re.sub(r"^\s*\d+\s*[:\t -]\s?", "", line).strip()


def bash_visible(command: str, body: str, sources: dict[str, str]) -> tuple[set[str], str]:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return set(), "unparsed_shell"
    targets: set[str] = set()
    reading = False
    is_search = False
    for token in tokens:
        if token and all(c in ";&|()<>" for c in token):
            reading = False
            continue
        if token in ("cat", "sed", "head", "tail", "nl", "awk", "grep", "rg"):
            reading = True
            is_search |= token in ("grep", "rg")
            continue
        if reading and not token.startswith("-"):
            path = token.removeprefix("/workspace/").removeprefix("./")
            targets.update(p for p in sources if p == path or ("*" in path and fnmatch.fnmatchcase(p, path)))
    matched = set()
    # Path-prefixed grep output must contain verified source text, not only a path.
    for line in body.splitlines():
        m = re.match(r"^(?:/workspace/|\./)?([^\s:]+?)(?::\d+)?[:-](.*)$", line)
        if m and m[1] in sources:
            fragment = normalize_line(m[2])
            if fragment and fragment in sources[m[1]]:
                matched.add(m[1])
    if targets:
        evidence = defaultdict(set)
        for path in targets:
            for line in sources[path].splitlines():
                line = line.strip()
                if len(line) >= 12:
                    evidence[line].add(path)
        for line in body.splitlines():
            line = normalize_line(line)
            owners = evidence.get(line, set())
            if len(owners) == 1:
                matched.update(owners)
    if matched:
        return matched, "verified_returned_source"
    if not targets and not is_search:
        return set(), "nonreading_or_unattributed"
    return set(), "no_attributable_source_content"


def read_visible(event: dict[str, Any]) -> set[str]:
    """Attribute only successful read output; never inherit explorer projections."""
    if event.get("name") != "read" or event.get("is_error") or event.get("outcome") != "completed":
        return set()
    output = event.get("output", {})
    if output.get("is_error") or not isinstance(output.get("content"), str) or not output["content"]:
        return set()
    details = output.get("details") or {}
    if (details.get("truncation") or {}).get("output_lines") == 0:
        return set()
    raw = details.get("path", event.get("input", {}).get("path"))
    if not isinstance(raw, str):
        return set()
    if "/workspace/" in raw:
        raw = raw.split("/workspace/", 1)[1]
    path = PurePosixPath(raw)
    if path.is_absolute() or ".." in path.parts or path.as_posix() == ".":
        return set()
    return {path.as_posix()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", type=Path, required=True)
    args = parser.parse_args()
    root = args.report_dir
    source = json.loads((root / "tasks.json").read_text())
    archive = subprocess.check_output(["git", "archive", source["pinned_git_sha"]])
    with tempfile.TemporaryDirectory() as d:
        with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
            tf.extractall(d, filter="data")
        sources = {
            p.relative_to(d).as_posix(): p.read_text(errors="replace") for p in Path(d).rglob("*") if p.is_file()
        }
    tasks = {t["id"]: t for t in source["tasks"]}
    result = {
        "method": "bash/read only; verified returned source content; conservative attribution",
        "included_tools": ["bash", "read"],
        "excluded_tools": ["repository_explore", "edit", "write"],
        "repository_git_sha": source["pinned_git_sha"],
        "items": {},
        "summary": {},
    }
    for condition in ("baseline", "treatment"):
        report = json.loads((root / f"{condition}.json").read_text())
        rows = []
        for item in report["items"]:
            visible = set()
            audit = []
            for event in item["output"]["file_access"]["tool_trace"]:
                if event["name"] == "read":
                    visible.update(read_visible(event))
                if event["name"] != "bash":
                    continue
                command = event["input"].get("command", "")
                body = event.get("output", {}).get("content", "")
                paths, reason = bash_visible(command, body if isinstance(body, str) else "", sources)
                visible.update(paths)
                audit.append({"command": command, "files": sorted(paths), "attribution": reason})
            gold = {f["path"]: f["weight"] for f in tasks[item["task_id"]]["relevant_files"]}
            hits = visible & gold.keys()
            rows.append(
                {
                    "task_id": item["task_id"],
                    "terminal_status": item["output"]["terminal_status"],
                    "files": sorted(visible),
                    "matched_files": sorted(hits),
                    "missed_files": sorted(gold.keys() - visible),
                    "extra_files": sorted(visible - gold.keys()),
                    "recall": len(hits) / len(gold),
                    "precision": len(hits) / len(visible) if visible else None,
                    "weighted_recall": sum(gold[p] for p in hits) / sum(gold.values()),
                    "bash_audit": audit,
                }
            )
        result["items"][condition] = rows
        result["summary"][condition] = {
            key: sum(r[key] for r in rows if r[key] is not None) / sum(r[key] is not None for r in rows)
            for key in ("recall", "precision", "weighted_recall")
        }
    (root / "visible-content-scores.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
