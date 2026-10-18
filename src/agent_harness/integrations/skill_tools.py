"""Scope-bound, read-only tools for loading one enabled Skill version."""

import base64
from dataclasses import dataclass, field

from agent_harness.domain.entries import JsonValue
from agent_harness.domain.skill import SkillConfig, SkillLoadout, SkillScope
from agent_harness.runtime.tools import AgentTool, ToolExecutionResult
from agent_harness.skill.protocol import SkillStore


def _error(message: str) -> ToolExecutionResult:
    return ToolExecutionResult(content=message, is_error=True)


def _load_request(arguments: JsonValue) -> tuple[str | None, int | None, ToolExecutionResult | None]:
    if not isinstance(arguments, dict):
        return None, None, _error("arguments must be an object")
    skill_id, version = arguments.get("skill_id"), arguments.get("version")
    if not isinstance(skill_id, str) or not skill_id or "\x00" in skill_id or len(skill_id) > 200:
        return None, None, _error("skill_id must be a non-empty string no longer than 200 characters")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        return None, None, _error("version must be a positive integer from <available_skills>")
    return skill_id, version, None


def _file_content(content: bytes) -> tuple[str, str]:
    try:
        return "utf-8", content.decode("utf-8")
    except UnicodeDecodeError:
        return "base64", base64.b64encode(content).decode("ascii")


def _render(loadout: SkillLoadout) -> JsonValue:
    files: list[JsonValue] = []
    for item in loadout.files:
        encoding, content = _file_content(item.content)
        files.append(
            {
                "path": item.path,
                "mime_type": item.mime_type,
                "encoding": encoding,
                "content": content,
                "sha256": item.content_hash,
            }
        )
    return {
        "skill": {
            "skill_id": loadout.skill_id,
            "version": loadout.version,
            "markdown": loadout.markdown,
            "manifest": loadout.manifest,
            "content_hash": loadout.content_hash,
            "files": files,
        }
    }


@dataclass(frozen=True, slots=True)
class SkillLoadTool:
    workspace_reusable = True
    """Load an immutable, enabled Skill version from the deployment's scope."""

    store: SkillStore
    scope: SkillScope
    config: SkillConfig = SkillConfig()
    name: str = "skill_load"
    description: str = (
        "Load the complete SKILL.md and versioned resources for one entry in <available_skills>. "
        "Use the exact skill_id and version shown there."
    )
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {"skill_id": {"type": "string"}, "version": {"type": "integer", "minimum": 1}},
            "required": ["skill_id", "version"],
            "additionalProperties": False,
        }
    )
    replay_policy: str = "safe"
    max_result_tokens: int = 4_000

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        skill_id, version, error = _load_request(arguments)
        if error is not None:
            return error
        assert skill_id is not None and version is not None
        loadout = await self.store.load(self.scope, skill_id, version)
        if loadout is None:
            return _error("skill version is not available in the current repository scope")
        size = len(loadout.markdown) + len(loadout.manifest) + sum(len(item.content) for item in loadout.files)
        if size > self.config.loadout_budget:
            return _error("skill version exceeds the configured loadout budget")
        return ToolExecutionResult(content=_render(loadout))


def create_skill_tools(store: SkillStore, scope: SkillScope) -> tuple[AgentTool, ...]:
    return (SkillLoadTool(store, scope),)
