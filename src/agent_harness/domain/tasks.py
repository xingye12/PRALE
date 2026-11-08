"""Pure Session task graph transitions. blockedBy is the authoritative edge set."""

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

TASK_NAMES = ("task_create", "task_get", "task_update", "task_list")
STATUSES = ("pending", "in_progress", "completed")


class TaskError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class Task:
    id: str
    subject: str
    description: str
    activeForm: str | None
    status: str
    owner: str | None
    metadata: Mapping[str, Any]
    blocks: tuple[str, ...]
    blockedBy: tuple[str, ...]
    unfinished_blockers: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "metadata", freeze(dict(self.metadata)))
        for name in ("blocks", "blockedBy", "unfinished_blockers"):
            object.__setattr__(self, name, tuple(getattr(self, name)))


def freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return MappingProxyType({k: freeze(v) for k, v in value.items()})
    if isinstance(value, list):
        return tuple(freeze(v) for v in value)
    return value


def project(records: dict[str, Any], task_id: str) -> dict[str, Any]:
    if task_id not in records or records[task_id]["status"] == "deleted":
        raise TaskError(f"unknown task: {task_id}")
    task = deepcopy(records[task_id])
    task["blocks"] = sorted((k for k, v in records.items() if task_id in v["blockedBy"]), key=int)
    task["unfinished_blockers"] = [k for k in task["blockedBy"] if records[k]["status"] != "completed"]
    return task


def transition(snapshot: dict[str, Any] | None, kind: str, args: dict[str, Any]) -> tuple[dict[str, Any], Any, bool]:
    state: dict[str, Any] = (
        deepcopy(snapshot) if snapshot is not None else {"format_version": 1, "version": 0, "next_id": 1, "records": {}}
    )
    if state.get("format_version") != 1:
        raise RuntimeError("unsupported task format")
    records = state["records"]
    if kind == "task_get":
        return state, project(records, args["task_id"]), False
    if kind == "task_list":
        offset, limit = args.get("offset", 0), args.get("limit", 50)
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise TaskError("offset must be nonnegative")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise TaskError("limit must be between 1 and 100")
        status = args.get("status")
        if status is not None and status not in STATUSES:
            raise TaskError("invalid status")
        ids = [
            k
            for k in sorted(records, key=int)
            if records[k]["status"] != "deleted" and (status is None or records[k]["status"] == status)
        ]
        tasks = [project(records, k) for k in ids[offset : offset + limit]]
        for task in tasks:
            task.pop("description")
            task.pop("metadata")
        return (
            state,
            {"tasks": tasks, "total": len(ids), "next_offset": offset + limit if offset + limit < len(ids) else None},
            False,
        )
    if kind == "task_create":
        task_id = str(state["next_id"])
        state["next_id"] += 1
        records[task_id] = {
            "id": task_id,
            "subject": args["subject"],
            "description": args["description"],
            "activeForm": args.get("activeForm"),
            "status": "pending",
            "owner": None,
            "metadata": {},
            "blockedBy": [],
        }
    elif kind == "task_update":
        task_id = args["task_id"]
        project(records, task_id)
    else:
        raise TaskError("unknown task operation")
    task = records[task_id]
    for field in ("subject", "description", "activeForm", "owner", "status"):
        if field in args:
            task[field] = args[field]
    if not isinstance(task["subject"], str) or not task["subject"].strip():
        raise TaskError("subject must be nonempty")
    if not isinstance(task["description"], str):
        raise TaskError("description must be a string")
    for field in ("activeForm", "owner"):
        if task[field] is not None and not isinstance(task[field], str):
            raise TaskError(f"{field} must be a string or null")
    if task["status"] not in (*STATUSES, "deleted"):
        raise TaskError("invalid status")
    metadata = args.get("metadata", {})
    if not isinstance(metadata, dict):
        raise TaskError("metadata must be an object")
    for key, value in metadata.items():
        if value is None:
            task["metadata"].pop(key, None)
        else:
            task["metadata"][key] = deepcopy(value)
    for field in ("add_blocks", "add_blocked_by"):
        edges = args.get(field, [])
        if not isinstance(edges, list) or any(not isinstance(k, str) for k in edges):
            raise TaskError("dependencies must be arrays of task IDs")
        for other in edges:
            project(records, other)
            source, target = (other, task_id) if field == "add_blocks" else (task_id, other)
            if source == target:
                raise TaskError("a task cannot depend on itself")
            if task["status"] == "deleted":
                raise TaskError("cannot add dependencies while deleting a task")
            records[source]["blockedBy"] = sorted(set([*records[source]["blockedBy"], target]), key=int)
    if task["status"] == "deleted":
        task["blockedBy"] = []
        for record in records.values():
            record["blockedBy"] = [k for k in record["blockedBy"] if k != task_id]
    # Kahn traversal avoids a recursion limit for long task chains.
    remaining = {k: set(v["blockedBy"]) for k, v in records.items()}
    ready = [k for k, deps in remaining.items() if not deps]
    visited = 0
    while ready:
        key = ready.pop()
        visited += 1
        for other, deps in remaining.items():
            if key in deps:
                deps.remove(key)
                if not deps:
                    ready.append(other)
    if visited != len(records):
        raise TaskError("cyclic task dependency")
    for record in records.values():
        if record["status"] in ("in_progress", "completed") and any(
            records[k]["status"] != "completed" for k in record["blockedBy"]
        ):
            raise TaskError("unfinished prerequisites prevent this transition")
    state["version"] += 1
    result = (
        {**deepcopy(task), "blocks": [], "unfinished_blockers": []}
        if task["status"] == "deleted"
        else project(records, task_id)
    )
    return state, result, True
