"""Scope-bound, read-only tools for explicit long-term-memory retrieval."""

from dataclasses import dataclass, field

from agent_harness.domain.entries import JsonValue
from agent_harness.domain.memory import MemoryScope, RecallBudget, RecallBundle, RecallQuery
from agent_harness.memory.protocol import MemoryStore
from agent_harness.runtime.tools import AgentTool, ToolExecutionResult


def _error(message: str) -> ToolExecutionResult:
    return ToolExecutionResult(content=message, is_error=True)


def _query(arguments: JsonValue) -> tuple[str | None, int | None, ToolExecutionResult | None]:
    if not isinstance(arguments, dict):
        return None, None, _error("arguments must be an object")
    value, limit = arguments.get("query"), arguments.get("limit", 5)
    if not isinstance(value, str) or not value.strip() or len(value) > 2_000:
        return None, None, _error("query must be a non-empty string no longer than 2000 characters")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 20:
        return None, None, _error("limit must be an integer from 1 to 20")
    return value, limit, None


def _items(bundle: RecallBundle) -> list[JsonValue]:
    # ``RecallBundle`` is deliberately rendered at the integration boundary;
    # the runtime and domain retain no JSON/tool dependency.
    return [
        {
            "id": item.id,
            "version": item.version,
            "content": item.content,
            "score": item.score,
            "source_ids": list(item.source_ids),
        }
        for item in bundle.items
    ]


@dataclass(frozen=True, slots=True)
class MemorySearchTool:
    store: MemoryStore
    scope: MemoryScope
    name: str = "memory_search"
    description: str = (
        "Search active L1 repository memories. Use this for historical facts, tasks, methods, and artifacts."
    )
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
                "mode": {"type": "string", "enum": ["hybrid", "keyword"]},
            },
            "required": ["query"],
        }
    )
    replay_policy: str = "safe"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        query, limit, error = _query(arguments)
        if error is not None:
            return error
        assert query is not None and limit is not None
        if isinstance(arguments, dict) and arguments.get("mode", "hybrid") not in {"hybrid", "keyword"}:
            return _error("mode must be hybrid or keyword")
        bundle = await self.store.search(
            self.scope,
            RecallQuery(query),
            RecallBudget(max_l1_items=limit, max_total_chars=12_000, include_l2=False, include_l3=False, min_score=0),
        )
        l1 = RecallBundle(
            tuple(item for item in bundle.items if item.level == "l1"), bundle.content_hash, bundle.total_chars
        )
        return ToolExecutionResult(content={"memories": _items(l1)})


@dataclass(frozen=True, slots=True)
class ConversationSearchTool:
    store: MemoryStore
    scope: MemoryScope
    name: str = "conversation_search"
    description: str = "Search this repository's redacted L0 conversation and execution trace evidence."
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            "required": ["query"],
        }
    )
    replay_policy: str = "safe"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        query, limit, error = _query(arguments)
        if error is not None:
            return error
        assert query is not None and limit is not None
        bundle = await self.store.search_conversation(self.scope, RecallQuery(query), limit)
        return ToolExecutionResult(content={"evidence": _items(bundle)})


@dataclass(frozen=True, slots=True)
class MemoryReadSceneTool:
    store: MemoryStore
    scope: MemoryScope
    name: str = "memory_read_scene"
    description: str = "Read one L2 scene from the current repository's injected L2 index by scene_id."
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "scene_id": {"type": "string"},
            },
            "required": ["scene_id"],
        }
    )
    replay_policy: str = "safe"

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        if not isinstance(arguments, dict) or not isinstance(arguments.get("scene_id"), str):
            return _error("scene_id must be a string")
        scene_id = arguments["scene_id"]
        if not scene_id or "/" in scene_id or "\\" in scene_id or ".." in scene_id:
            return _error("invalid scene_id")
        scene = await self.store.read_scene(self.scope, scene_id)
        if scene is None:
            return _error("scene is not available in the current repository scope")
        return ToolExecutionResult(
            content={"scene_id": scene.scene_id, "version": scene.version, "content": scene.content}
        )


def create_memory_tools(store: MemoryStore, scope: MemoryScope) -> tuple[AgentTool, ...]:
    return (MemorySearchTool(store, scope), ConversationSearchTool(store, scope), MemoryReadSceneTool(store, scope))
