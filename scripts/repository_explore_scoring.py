"""Local, deterministic file-access evidence for repository exploration evals.

Consumes committed telemetry only. This report projection is never a recovery
source and does not change the tool payload delivered to the model.
"""

import hashlib
import json
import math
import os
import re
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Any

from agent_harness.runtime.telemetry import TelemetryEvent, ToolTelemetry

ACCESS_VERSION = 1
_HEADER = re.compile(r"^## `([^`\n]+)`(?: — .*)?$")
_CANDIDATE = re.compile(r"^- `([^`\n]+)` \(file candidate; not expanded\)$")
_OTHER = "Truncated by output budget; consider a narrower identifier query. Other candidates: "
_METRICS = ("recall", "weighted_recall", "precision", "core_recall")


def _relative(value: object) -> str | None:
    if not isinstance(value, str) or not value or "\x00" in value:
        return None
    p = PurePosixPath(value)
    if p.is_absolute() or ".." in p.parts or p.as_posix() == ".":
        return None
    return p.as_posix()


class FileAccessCollector:
    """Retain full local attempts and derive model-visible file evidence."""

    def __init__(self, workspace: Path) -> None:
        self.root = workspace.resolve()
        self.events: list[ToolTelemetry] = []
        self.bash_observations: dict[str, list[dict[str, Any]]] = {}

    def register_bash(self, command: str, observation: dict[str, Any]) -> None:
        self.bash_observations.setdefault(command, []).append(observation)

    def record(self, event: TelemetryEvent) -> None:
        if isinstance(event, ToolTelemetry):
            if event.name == "bash" and isinstance(event.input, Mapping):
                observations = self.bash_observations.get(str(event.input.get("command")), [])
                if observations:
                    event = replace(event, metadata={**event.metadata, "file_access": observations.pop(0)})
            self.events.append(event)

    def _path(self, value: object) -> str | None:
        if not isinstance(value, str) or not value or "\x00" in value:
            return None
        # Do not require the temporary snapshot to still exist when projecting.
        candidate = Path(os.path.normpath(value if Path(value).is_absolute() else str(self.root / value)))
        try:
            return _relative(candidate.relative_to(self.root).as_posix())
        except ValueError:
            return None

    def as_dict(self) -> dict[str, Any]:
        located: set[str] = set()
        content: set[str] = set()
        modified: set[str] = set()
        read_bash: set[str] = set()
        read_bash_complete = True
        unobserved: list[dict[str, Any]] = []
        trace: list[dict[str, Any]] = []
        returned_bytes = 0
        returned_tokens = 0
        for event in self.events:
            trace.append(
                {
                    "tool_call_id": event.tool_call_id,
                    "attempt": event.attempt,
                    "name": event.name,
                    "input": event.input,
                    "output": event.output,
                    "outcome": event.outcome,
                    "is_error": event.is_error,
                    "started_at": event.started_at,
                    "ended_at": event.ended_at,
                    "file_access_observation": event.metadata.get("file_access"),
                }
            )
            size = len(json.dumps(event.output, ensure_ascii=False).encode())
            returned_bytes += size
            returned_tokens += math.ceil(size / 3)

            def unknown(reason: str) -> None:
                unobserved.append(
                    {
                        "tool_call_id": event.tool_call_id,
                        "attempt": event.attempt,
                        "name": event.name,
                        "reason": reason,
                    }
                )

            if event.outcome == "unknown":
                if event.name in ("bash", "read"):
                    read_bash_complete = False
                unknown("unknown_effect_outcome")
                continue
            if event.outcome == "aborted":
                continue
            if event.name == "bash":
                observation = event.metadata.get("file_access")
                if isinstance(observation, Mapping) and observation.get("complete") is True:
                    paths = observation.get("files", [])
                    read_bash.update(p for p in paths if _relative(p) == p)
                else:
                    read_bash_complete = False
                unknown("shell_opens_are_not_model_visible_content")
                continue
            if event.is_error or event.outcome != "completed":
                continue
            result = event.output if isinstance(event.output, Mapping) else {}
            body = result.get("content")
            if event.name in ("write", "edit"):
                arguments = event.input if isinstance(event.input, Mapping) else {}
                path = self._path(arguments.get("path"))
                if path is not None:
                    modified.add(path)
                # A successful write acknowledgement is not evidence of reading
                # the pinned source. Keep mutation runs out of complete scores.
                unknown("workspace_modified")
            elif event.name == "read":
                arguments = event.input if isinstance(event.input, Mapping) else {}
                details = result.get("details")
                details = details if isinstance(details, Mapping) else {}
                path = self._path(details.get("path", arguments.get("path")))
                if path is None or not isinstance(body, str):
                    read_bash_complete = False
                    unknown("read_result_without_valid_workspace_path_or_content")
                    continue
                located.add(path)
                read_bash.add(path)
                truncation = details.get("truncation")
                if isinstance(truncation, Mapping) and truncation.get("output_lines") == 0:
                    continue
                content.add(path)
            elif event.name == "repository_explore":
                if not isinstance(body, str) or not body.startswith("# Repository exploration ("):
                    unknown("unsupported_explorer_output")
                    continue
                in_code = False
                current: str | None = None
                for line in body.splitlines():
                    if line.startswith("```"):
                        in_code = not in_code
                        continue
                    if in_code:
                        # Count actual snippet lines, never headings embedded in code.
                        if current is not None and re.match(r"^\d+:", line):
                            content.add(current)
                        continue
                    match = _HEADER.fullmatch(line)
                    if match:
                        current = _relative(match.group(1))
                        if current is None:
                            unknown("invalid_explorer_path")
                        else:
                            located.add(current)
                        continue
                    candidate = _CANDIDATE.fullmatch(line)
                    if candidate:
                        current = None
                        path = _relative(candidate.group(1))
                        if path is not None:
                            located.add(path)
                    elif line.startswith(_OTHER):
                        current = None
                        for raw in line[len(_OTHER) :].split(", "):
                            path = _relative(raw)
                            if path is not None:
                                located.add(path)
            else:
                unknown("unsupported_tool")
        return {
            "version": ACCESS_VERSION,
            "complete": not unobserved,
            "located_files": sorted(located),
            "content_files": sorted(content),
            "modified_files": sorted(modified),
            "read_bash_files": sorted(read_bash),
            "read_bash_complete": read_bash_complete,
            "accessed_files": sorted(read_bash | content),
            "accessed_complete": read_bash_complete
            and all(
                c["reason"] in ("shell_opens_are_not_model_visible_content", "workspace_modified") for c in unobserved
            ),
            "unobserved_calls": unobserved,
            "tool_trace": trace,
            "returned_bytes": returned_bytes,
            "returned_tokens_estimate": returned_tokens,
        }


def answer_key_hash(source: Mapping[str, Any]) -> str:
    return hashlib.sha256(json.dumps(source, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def _labels(task: Mapping[str, Any]) -> dict[str, int]:
    rows = task.get("relevant_files")
    if not isinstance(rows, list) or not rows:
        raise ValueError("task requires nonempty relevant_files")
    labels: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            raise ValueError("invalid file label")
        path = _relative(row.get("path"))
        weight = row.get("weight")
        if path is None or path != row.get("path") or path in labels:
            raise ValueError("invalid or duplicate label path")
        if type(weight) is not int or weight not in (1, 2, 3):
            raise ValueError("invalid file weight")
        labels[path] = weight
    return labels


def _paths(access: Mapping[str, Any], key: str) -> set[str]:
    values = access.get(key)
    if not isinstance(values, list) or any(_relative(p) != p or not isinstance(p, str) for p in values):
        raise ValueError(f"invalid {key}")
    return set(values)


def _coverage(labels: dict[str, int], accessed: set[str], complete: bool) -> dict[str, Any]:
    gold = set(labels)
    hits = gold & accessed
    recall = len(hits) / len(gold)
    weighted = sum(labels[p] for p in hits) / sum(labels.values())
    core = {p for p, weight in labels.items() if weight == 3}
    return {
        "recall": recall if complete else None,
        "weighted_recall": weighted if complete else None,
        "recall_lower_bound": recall,
        "weighted_recall_lower_bound": weighted,
        "precision": len(hits) / len(accessed) if complete and accessed else None,
        "core_recall": len(hits & core) / len(core) if complete and core else None,
        "accessed_count": len(accessed),
        "matched_count": len(hits),
        "matched_files": sorted(hits),
        "missed_files": sorted(gold - accessed),
        "unlabelled_files": sorted(accessed - gold),
    }


def score_output(task: Mapping[str, Any], output: Mapping[str, Any]) -> dict[str, Any]:
    labels = _labels(task)
    access = output.get("file_access")
    if access is None:
        return {"status": "not_observed", "reason": "report has no file-access evidence"}
    if not isinstance(access, Mapping) or type(access.get("version")) is not int or access["version"] != ACCESS_VERSION:
        raise ValueError("unsupported file access version")
    if type(access.get("complete")) is not bool:
        raise ValueError("file access requires explicit completeness")
    located = _paths(access, "located_files")
    content = _paths(access, "content_files")
    if not content <= located:
        raise ValueError("content files must also be located files")
    complete = access["complete"]
    return {
        "status": "complete" if complete else "partial",
        "terminal_status": output.get("terminal_status"),
        "precision_scope": "annotated_files_only; unlabelled files require relevance review",
        "accessed": _coverage(labels, set(access.get("accessed_files", [])), access.get("accessed_complete") is True),
        "read_bash": _coverage(
            labels, set(access.get("read_bash_files", [])), access.get("read_bash_complete") is True
        ),
        "located": _coverage(labels, located, complete),
        "content": _coverage(labels, content, complete),
        "unobserved_calls": access.get("unobserved_calls", []),
    }


def _mean(values: list[float | int]) -> float | None:
    return sum(values) / len(values) if values else None


def _summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [item["file_score"] for item in items if item["file_score"]["status"] != "not_observed"]
    result: dict[str, Any] = {
        "items": len(items),
        "complete": sum(s["status"] == "complete" for s in scored),
        "partial": sum(s["status"] == "partial" for s in scored),
        "not_observed": len(items) - len(scored),
    }
    for level in ("located", "content", "read_bash", "accessed"):
        names = (*_METRICS, "recall_lower_bound", "weighted_recall_lower_bound")
        result[level] = {}
        for name in names:
            values = [s[level][name] for s in scored if s[level][name] is not None]
            result[level][name] = _mean(values)
            result[level][f"{name}_count"] = len(values)
    # Only provider total_tokens: other usage fields may overlap.
    cost_rows: dict[str, list[int | float]] = {
        k: []
        for k in (
            "tool_calls",
            "duration_ms",
            "provider_total_tokens",
            "returned_bytes",
            "returned_tokens_estimate",
        )
    }
    for item in items:
        output = item["output"]
        calls, duration = output.get("tool_calls"), output.get("duration_ms")
        usage, access = output.get("usage"), output.get("file_access")
        if isinstance(calls, list):
            cost_rows["tool_calls"].append(len(calls))
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            cost_rows["duration_ms"].append(duration)
        if isinstance(usage, Mapping) and isinstance(usage.get("total_tokens"), (int, float)):
            cost_rows["provider_total_tokens"].append(usage["total_tokens"])
        if isinstance(access, Mapping):
            for name in ("returned_bytes", "returned_tokens_estimate"):
                if isinstance(access.get(name), (int, float)):
                    cost_rows[name].append(access[name])
    result["costs"] = {
        k: {"mean": _mean(v), "total": sum(v) if v else None, "count": len(v)} for k, v in cost_rows.items()
    }
    return result


def _report_items(report: Mapping[str, Any], tasks: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    items: dict[str, dict[str, Any]] = {}
    for item in report["items"]:
        task_id = item.get("task_id", str(item["id"]).split("--", 1)[-1])
        if task_id not in tasks:
            raise ValueError(f"unknown task: {task_id}")
        if task_id in items:
            raise ValueError(f"duplicate task: {task_id}")
        output = item.get("output")
        if not isinstance(output, Mapping):
            raise ValueError(f"invalid output: {task_id}")
        items[task_id] = {
            "id": item["id"],
            "task_id": task_id,
            "output": output,
            "file_score": score_output(tasks[task_id], output),
        }
    return items


def compare_reports(
    source: Mapping[str, Any],
    baseline: Mapping[str, Any],
    treatment: Mapping[str, Any],
) -> dict[str, Any]:
    sha = source["pinned_git_sha"]
    policy = source["file_annotation_policy"]
    if policy.get("version") not in (1, 2) or policy.get("verified_git_sha", sha) != sha:
        raise ValueError("unsupported or mismatched annotation policy version/commit")
    key_hash = answer_key_hash(source)
    tasks = {t["id"]: t for t in source["tasks"]}
    if len(tasks) != len(source["tasks"]):
        raise ValueError("duplicate source task")
    for task in tasks.values():
        _labels(task)
    conditions = {}
    for name, report in (("baseline", baseline), ("treatment", treatment)):
        if report.get("repository_git_sha") != sha:
            raise ValueError(f"{name}: repository commit does not match answer key")
        if report.get("answer_key_sha256", key_hash) != key_hash:
            raise ValueError(f"{name}: answer key hash mismatch")
        if report.get("file_annotation_version", policy["version"]) != policy["version"]:
            raise ValueError(f"{name}: annotation version mismatch")
        conditions[name] = _report_items(report, tasks)
    if conditions["baseline"].keys() != conditions["treatment"].keys():
        raise ValueError("reports must contain the same paired tasks")
    paired: dict[str, Any] = {}
    for level in ("located", "content", "read_bash", "accessed"):
        paired[level] = {}
        for metric in _METRICS:
            deltas = []
            for task_id, b in conditions["baseline"].items():
                bs = b["file_score"]
                ts = conditions["treatment"][task_id]["file_score"]
                if level not in ("read_bash", "accessed") and (
                    bs["status"] != "complete" or ts["status"] != "complete"
                ):
                    continue
                left, right = bs[level][metric], ts[level][metric]
                if left is not None and right is not None:
                    deltas.append(right - left)
            paired[level][metric] = _mean(deltas)
            paired[level][f"{metric}_pairs"] = len(deltas)
    return {
        "schema_version": 1,
        "repository_git_sha": sha,
        "file_annotation_version": policy["version"],
        "answer_key_sha256": key_hash,
        "missing_tasks": sorted(set(tasks) - set(conditions["baseline"])),
        "items": {name: list(items.values()) for name, items in conditions.items()},
        "summary": {name: _summary(list(items.values())) for name, items in conditions.items()},
        "paired_deltas": paired,
    }
