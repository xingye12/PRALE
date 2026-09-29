import asyncio
from pathlib import Path

import pytest

from agent_harness.api.harness import Harness
from agent_harness.domain.entries import JsonValue
from agent_harness.integrations.repository_explorer import (
    IndexedFile,
    RepositoryExplorerConfig,
    RepositoryExplorerTool,
    RepositoryTag,
)
from agent_harness.runtime.generation import AssistantResult, ToolCall
from agent_harness.storage.memory import MemoryStorage


def _tool(root: Path) -> RepositoryExplorerTool:
    return RepositoryExplorerTool(RepositoryExplorerConfig(root, root.parent / f"{root.name}-index"))


def test_repository_explorer_indexes_python_symbols_and_excludes_known_paths(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "service.py").write_text(
            "def build_widget():\n    return helper()\n\ndef helper():\n    return 1\n"
        )
        (tmp_path / "caller.py").write_text("from service import helper\n\ndef run():\n    return helper()\n")
        tool = _tool(tmp_path)

        result = await tool.execute({"identifiers": ["helper"], "known_paths": ["caller.py"]})

        assert not result.is_error
        assert "## `service.py`" in str(result.content)
        assert "### `helper` line 4" in str(result.content)
        assert "snapshot `" in str(result.content)
        assert "caller.py" not in str(result.content)
        assert result.details == {"truncated": False, "token_estimate": True}

    asyncio.run(scenario())


def test_repository_explorer_rejects_escape_and_reports_unknown_identifier_as_file_navigation(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "README.md").write_text("Repository guide")
        tool = _tool(tmp_path)

        escaped = await tool.execute({"focus_paths": ["../outside.py"]})
        missing = await tool.execute({"identifiers": ["not_here"], "query": "repository guide"})

        assert escaped.is_error and "workspace-relative" in str(escaped.content)
        assert not missing.is_error
        assert "identifiers_not_found: not_here" in str(missing.content)
        assert "README.md" in str(missing.content)
        assert "not expanded" in str(missing.content)

    asyncio.run(scenario())


def test_unmatched_identifiers_rank_a_small_set_of_filename_hints(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "memory.py").write_text("def store(): pass\n")
        (tmp_path / "memory_notes.md").write_text("notes")
        (tmp_path / "unrelated.py").write_text("def elsewhere(): pass\n")
        tool = _tool(tmp_path)
        result = await tool.execute({"identifiers": ["memory", "Memory"]})
        content = str(result.content)
        assert "Using unmatched identifiers only as filename hints" in content
        assert content.index("`memory.py`") < content.index("`unrelated.py`")
        assert "line " not in content
        assert "snapshot `" not in content

    asyncio.run(scenario())


def test_repository_explorer_can_be_called_by_a_normal_drive(tmp_path: Path) -> None:
    class Provider:
        def __init__(self) -> None:
            self.calls = 0

        async def generate(self, request):
            self.calls += 1
            if self.calls > 1:
                return AssistantResult("done", {})
            return AssistantResult(
                "", {}, tool_calls=(ToolCall("call-1", "repository_explore", {"identifiers": ["helper"]}),)
            )

    async def scenario() -> None:
        (tmp_path / "service.py").write_text("def helper():\n    return 1\n")
        storage = MemoryStorage()
        lane = await (await Harness.open("session", storage, tools=(_tool(tmp_path),))).acquire_lane("main")
        await lane.prompt("Find helper", operation_id="op")
        result = await lane.drive(Provider())
        entries = await storage.scan_branch(result.tip_id)
        tool_entries = [entry for entry in entries if entry.payload.get("role") == "tool"]
        assert tool_entries and not tool_entries[0].payload["is_error"]
        assert "service.py" in str(tool_entries[0].payload["content"])

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "argument",
    [
        {},
        {"identifiers": ["x" * 257]},
        {"focus_paths": ["/etc/passwd"]},
        {"max_tokens": 255, "query": "find"},
        {"query": "x" * 1_001},
    ],
)
def test_repository_explorer_validates_bounded_arguments(tmp_path: Path, argument: dict[str, JsonValue]) -> None:
    async def scenario() -> None:
        result = await _tool(tmp_path).execute(argument)
        assert result.is_error

    asyncio.run(scenario())


class FakeIndexer:
    async def index(self, include_tests: bool) -> tuple[IndexedFile, ...]:
        return (
            IndexedFile(
                "known.py", "a" * 64, (RepositoryTag("known.py", "needle", "definition", "function", 1),), True
            ),
            IndexedFile(
                "other.py", "b" * 64, (RepositoryTag("other.py", "needle", "definition", "function", 1),), True
            ),
        )


def test_repository_explorer_known_path_is_not_rendered(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "known.py").write_text("def needle(): pass\n")
        (tmp_path / "other.py").write_text("def needle(): pass\n")
        tool = RepositoryExplorerTool(
            RepositoryExplorerConfig(tmp_path, tmp_path.parent / f"{tmp_path.name}-index"), FakeIndexer()
        )
        result = await tool.execute({"identifiers": ["needle"], "known_paths": ["known.py"]})
        assert "known.py" not in str(result.content)
        assert "other.py" in str(result.content)

    asyncio.run(scenario())


class OrderedIndexer:
    async def index(self, include_tests: bool) -> tuple[IndexedFile, ...]:
        return (
            IndexedFile("a.py", "a" * 64, (RepositoryTag("a.py", "alpha", "definition", "function", 1),), True),
            IndexedFile("b.py", "b" * 64, (RepositoryTag("b.py", "beta", "definition", "function", 1),), True),
        )


def test_rank_selects_before_rendering_in_stable_path_line_name_order(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "a.py").write_text("def alpha():\n    return 1\n")
        (tmp_path / "b.py").write_text("def beta():\n    return 2\n")
        tool = RepositoryExplorerTool(_tool(tmp_path).config, OrderedIndexer())
        result = await tool.execute({"identifiers": ["beta"]})
        assert not result.is_error
        assert str(result.content).index("`a.py`") < str(result.content).index("`b.py`")

    asyncio.run(scenario())


def test_path_prefix_personalizes_but_never_cuts_global_identifier_discovery(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "preferred").mkdir()
        (tmp_path / "preferred" / "local.py").write_text("def local():\n    return 1\n")
        (tmp_path / "global.py").write_text("def globally_defined_target():\n    return 1\n")
        result = await _tool(tmp_path).execute(
            {"identifiers": ["globally_defined_target"], "path_prefixes": ["preferred"]}
        )
        assert not result.is_error
        assert "## `global.py`" in str(result.content)
        assert "### `globally_defined_target` line 1" in str(result.content)

    asyncio.run(scenario())


def test_query_only_renders_related_symbols_in_grouped_file_sections(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "memory_runtime.py").write_text(
            "class MemoryRuntime:\n    pass\n\ndef recall_memory():\n    return MemoryRuntime()\n"
        )
        (tmp_path / "unrelated.py").write_text("class Dashboard:\n    pass\n")
        result = await _tool(tmp_path).execute({"query": "memory module implementation"})
        content = str(result.content)
        assert "## `memory_runtime.py`" in content
        assert "### `MemoryRuntime` line 1" in content
        assert "### `recall_memory` line 4" in content
        assert "unrelated.py" not in content

    asyncio.run(scenario())


def test_query_only_expands_supported_chinese_concept_hint(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "memory_runtime.py").write_text("class MemoryRuntime:\n    pass\n")
        (tmp_path / "unrelated.py").write_text("class Dashboard:\n    pass\n")
        result = await _tool(tmp_path).execute({"query": "详细介绍一下当前项目的记忆模块是怎么做的"})
        content = str(result.content)
        assert "## `memory_runtime.py`" in content
        assert "### `MemoryRuntime` line 1" in content
        assert "unrelated.py" not in content

    asyncio.run(scenario())


def test_query_only_includes_references_to_query_seed_definitions(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "memory_runtime.py").write_text("class MemoryRuntime:\n    pass\n")
        (tmp_path / "consumer.py").write_text(
            "from memory_runtime import MemoryRuntime\n\ndef consume():\n    return MemoryRuntime()\n"
        )
        result = await _tool(tmp_path).execute({"query": "memory implementation"})
        content = str(result.content)
        assert "## `memory_runtime.py`" in content
        assert "## `consumer.py`" in content
        assert "### reference `MemoryRuntime` line 4" in content

    asyncio.run(scenario())
