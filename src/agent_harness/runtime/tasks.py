"""Native task controls and the library facade share transactional transitions."""

from typing import Any

from agent_harness.domain.context_management import estimate_messages
from agent_harness.domain.session import Session, SessionMutator
from agent_harness.domain.tasks import STATUSES, TASK_NAMES, Task, TaskError, freeze, project, transition
from agent_harness.domain.values import ListAddress, ValueAddress
from agent_harness.runtime.subagents import ControlTool
from agent_harness.runtime.tools import RuntimeControlTool, invalid_tool_arguments
from agent_harness.storage.protocol import AppendList, SetValue, Write

TASK_STATE: ValueAddress[object] = ValueAddress("session/tasks")
TASK_AUDIT: ListAddress[object] = ListAddress("session/tasks/audit")


def create_task_tools(names: tuple[str, ...] = TASK_NAMES) -> tuple[RuntimeControlTool, ...]:
    if set(names) - set(TASK_NAMES) or len(names) != len(set(names)):
        raise ValueError("task tool names must be known and unique")
    text = {"type": "string"}
    fields = {
        "subject": {"type": "string", "minLength": 1},
        "description": text,
        "activeForm": {"type": ["string", "null"]},
        "metadata": {"type": "object"},
    }
    schemas = {
        "task_create": (fields, ["subject", "description"]),
        "task_get": ({"task_id": text}, ["task_id"]),
        "task_update": (
            {
                **fields,
                "task_id": text,
                "owner": {"type": ["string", "null"]},
                "status": {"enum": [*STATUSES, "deleted"]},
                "add_blocks": {"type": "array", "items": text},
                "add_blocked_by": {"type": "array", "items": text},
            },
            ["task_id"],
        ),
        "task_list": (
            {
                "status": {"enum": list(STATUSES)},
                "offset": {"type": "integer", "minimum": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
            },
            [],
        ),
    }
    descriptions = {
        "task_create": "Create a pending task and return its ID. Add dependencies with task_update.",
        "task_get": "Get a full task, dependencies and currently unfinished blockers by task_id.",
        "task_update": "Update fields or status; add_blocks/add_blocked_by add dependencies. "
        "Unfinished prerequisites prevent starting/completing; cycles are rejected. "
        "Status deleted tombstones the task and removes edges. Metadata merges by key.",
        "task_list": "List task summaries in numeric ID order, optionally filtered by status. "
        "Use offset/limit pagination; default limit 50, maximum 100.",
    }
    return tuple(
        ControlTool(
            name,
            f"{descriptions[name]} Session-shared planning. For complex work, create tasks and dependencies; "
            "mark in_progress before starting and completed only after verification. Simple questions need no tasks. "
            "Owner records responsibility only; it does not start agents. Metadata null values delete keys.",
            {
                "type": "object",
                "properties": schemas[name][0],
                "required": schemas[name][1],
                "additionalProperties": False,
            },
            name,
            8192,
        )
        for name in names
    )


async def task_writes(mutator: SessionMutator, kind: str, args: dict[str, Any]) -> tuple[Any, list[Write]]:
    tool = next(t for t in create_task_tools() if t.name == kind)
    invalid = invalid_tool_arguments(tool, args)
    if invalid:
        raise TaskError(invalid)
    state, result, changed = transition(await mutator.get_value(TASK_STATE), kind, args)
    writes: list[Write] = []
    if changed:
        writes = [
            SetValue(TASK_STATE, state),
            AppendList(
                TASK_AUDIT,
                {
                    "format_version": 1,
                    "version": state["version"],
                    "kind": kind,
                    "arguments": args,
                    "result": result,
                },
            ),
        ]
    return result, writes


class TaskRuntime:
    def __init__(self, session: Session) -> None:
        self.session = session

    async def _call(self, kind: str, args: dict[str, Any]) -> Any:
        async def mutate(mutator: SessionMutator) -> Any:
            result, writes = await task_writes(mutator, kind, args)
            if writes:
                await mutator.commit(writes)
            return result

        return await self.session.mutate(mutate)

    async def create(self, subject: str, description: str, **kwargs: Any) -> Task:
        return Task(**(await self._call("task_create", {"subject": subject, "description": description, **kwargs})))

    async def get(self, task_id: str) -> Task:
        return Task(**(await self._call("task_get", {"task_id": task_id})))

    async def update(self, task_id: str, **kwargs: Any) -> Task:
        result = await self._call("task_update", {"task_id": task_id, **kwargs})
        return Task(**result)

    async def list(self, **kwargs: Any) -> Any:
        return freeze(await self._call("task_list", kwargs))


async def task_overview(session: Session) -> tuple[int | None, dict[str, Any] | None]:
    snapshot = await session.get_value(TASK_STATE)
    if snapshot is None:
        return None, None
    records = snapshot["records"]
    tasks = [project(records, k) for k in records if records[k]["status"] != "deleted"]
    tasks.sort(
        key=lambda t: (
            0
            if t["status"] == "in_progress"
            else 1
            if t["status"] == "pending" and not t["unfinished_blockers"]
            else 2
            if t["status"] == "pending"
            else 3,
            int(t["id"]),
        )
    )
    lines: list[str] = []
    for task in tasks:
        line = (
            f"#{task['id']} {task['status']} {task['subject'][:300]} "
            f"owner={str(task['owner'])[:100]} blockedBy={task['unfinished_blockers']}"
        )
        candidate = {"role": "system", "content": "\n".join([*lines, line])}
        if estimate_messages([candidate]) > 1800:
            break
        lines.append(line)
    if not tasks:
        return snapshot["version"], None
    omitted = len(tasks) - len(lines)
    return snapshot["version"], {
        "role": "system",
        "content": "<session_tasks>\n"
        + "\n".join(lines)
        + f"\nOmitted {omitted} tasks. Use task_list/task_get for details.\n</session_tasks>",
    }
