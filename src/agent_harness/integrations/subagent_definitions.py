"""Explicit, non-executing Markdown definition loader; YAML is optional."""

from pathlib import Path
from typing import Any

from agent_harness.domain.subagents import InvalidSubagentDefinition, SubagentDefinition


def load_subagent_definitions(directories: tuple[Path, ...]) -> tuple[SubagentDefinition, ...]:
    if not directories:
        return ()
    try:
        import yaml
    except ImportError as error:
        raise InvalidSubagentDefinition("Markdown definitions require the subagents extra (PyYAML)") from error

    class UniqueLoader(yaml.SafeLoader):
        pass

    def mapping(loader: Any, node: Any) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node)
            if not isinstance(key, str) or key in result:
                raise InvalidSubagentDefinition("frontmatter keys must be unique strings")
            result[key] = loader.construct_object(value_node)
        return result

    UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)
    definitions: list[SubagentDefinition] = []
    names: set[str] = set()
    allowed = {"name", "description", "tools", "disallowed_tools", "model", "max_turns", "background"}
    for directory in directories:
        if not directory.is_dir():
            raise InvalidSubagentDefinition(f"definition directory does not exist: {directory}")
        for path in sorted(directory.glob("*.md")):
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
                if not lines or lines[0] != "---":
                    raise InvalidSubagentDefinition(f"missing frontmatter: {path}")
                boundary = lines.index("---", 1)
                fields = yaml.load("\n".join(lines[1:boundary]), Loader=UniqueLoader)
                if not isinstance(fields, dict) or set(fields) - allowed:
                    raise InvalidSubagentDefinition(f"invalid frontmatter fields: {path}")
                for key in ("tools", "disallowed_tools"):
                    if key in fields:
                        if not isinstance(fields[key], list):
                            raise InvalidSubagentDefinition(f"{key} must be a list")
                        fields[key] = tuple(fields[key])
                if fields.get("model") == "inherit":
                    fields["model"] = None
                definition = SubagentDefinition(system_prompt="\n".join(lines[boundary + 1 :]).strip(), **fields)
                if definition.name in names:
                    raise InvalidSubagentDefinition(f"duplicate definition: {definition.name}")
                names.add(definition.name)
                definitions.append(definition)
            except InvalidSubagentDefinition:
                raise
            except (OSError, UnicodeError, ValueError, TypeError, yaml.YAMLError) as error:
                raise InvalidSubagentDefinition(f"invalid definition {path}: {error}") from error
    return tuple(definitions)
