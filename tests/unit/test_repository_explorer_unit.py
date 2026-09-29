import asyncio
import importlib.util
import json
from pathlib import Path

import pytest

from agent_harness.integrations.repository_explorer import (
    MAX_WIRE_BYTES,
    MAX_WIRE_LINES,
    IndexedFile,
    RepositoryExplorerConfig,
    RepositoryExplorerTool,
    RepositoryScanLimitExceeded,
    RepositoryScanLimits,
    RepositoryTag,
    TreeSitterRepositoryIndexer,
    _edge_weight,
    _within_wire_budget,
)


def _config(root: Path, *, limits: RepositoryScanLimits | None = None) -> RepositoryExplorerConfig:
    return RepositoryExplorerConfig(
        root,
        root.parent / f"{root.name}-index",
        limits=limits if limits is not None else RepositoryScanLimits(),
    )


def test_tree_sitter_tags_use_name_lines_and_supported_language_queries(tmp_path: Path) -> None:
    async def scenario() -> None:
        source = tmp_path / "module.py"
        source.write_text("\n\ndef helper():\n    return target()\n\ndef target():\n    return 1\n")
        (tmp_path / "other.ts").write_text("function ignored() {}")
        index = await TreeSitterRepositoryIndexer(_config(tmp_path)).index(include_tests=True)
        tags = next(item.tags for item in index if item.relative_path == "module.py")
        assert {(tag.name, tag.role, tag.line, tag.symbol_kind) for tag in tags} == {
            ("helper", "definition", 3, "function"),
            ("target", "reference", 4, "function"),
            ("target", "definition", 6, "function"),
        }
        typescript_tags = next(item.tags for item in index if item.relative_path == "other.ts")
        if importlib.util.find_spec("tree_sitter_typescript") is None:
            assert typescript_tags == ()
        else:
            assert [(tag.name, tag.role, tag.symbol_kind, tag.line) for tag in typescript_tags] == [
                ("ignored", "definition", "function", 1)
            ]

    asyncio.run(scenario())


def test_cache_reuses_stat_manifest_across_indexer_instances(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        (tmp_path / "module.py").write_text("def helper():\n    return 1\n")
        config = _config(tmp_path)
        await TreeSitterRepositoryIndexer(config).index(include_tests=True)
        warm = TreeSitterRepositoryIndexer(config)
        calls = 0
        original = warm._tags

        def count_tags(relative_path: str, raw: bytes):
            nonlocal calls
            calls += 1
            return original(relative_path, raw)

        monkeypatch.setattr(warm, "_tags", count_tags)
        await warm.index(include_tests=True)
        assert calls == 0

        (tmp_path / "module.py").write_text("def helper():\n    return 2\n")
        await warm.index(include_tests=True)
        assert calls == 1

    asyncio.run(scenario())


def test_corrupt_tag_cache_is_a_miss_not_an_explorer_failure(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "module.py").write_text("def helper():\n    return 1\n")
        config = _config(tmp_path)
        config.cache_dir.mkdir()
        (config.cache_dir / "repository-tags.sqlite").write_bytes(b"not sqlite")
        indexed = await TreeSitterRepositoryIndexer(config).index(include_tests=True)
        assert indexed[0].tags[0].name == "helper"

    asyncio.run(scenario())


def test_discovery_enforces_limits_and_excludes_tests(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "main.py").write_text("def main(): pass\n")
        (tmp_path / "tests").mkdir()
        (tmp_path / "tests" / "test_main.py").write_text("def test_main(): pass\n")
        indexer = TreeSitterRepositoryIndexer(_config(tmp_path))
        indexed = await indexer.index(include_tests=False)
        assert [item.relative_path for item in indexed] == ["main.py"]

        limited = TreeSitterRepositoryIndexer(_config(tmp_path, limits=RepositoryScanLimits(max_files=1)))
        with pytest.raises(RepositoryScanLimitExceeded, match="repository_scan_limit_exceeded: files"):
            await limited.index(include_tests=True)

    asyncio.run(scenario())


def test_discovery_ignores_local_tool_caches(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "src.py").write_text("def useful(): pass\n")
        for directory in (".mypy_cache", ".pytest_cache", ".ruff_cache"):
            target = tmp_path / directory
            target.mkdir()
            (target / "generated.py").write_text("def ignored(): pass\n")
        indexed = await TreeSitterRepositoryIndexer(_config(tmp_path)).index(include_tests=True)
        assert [item.relative_path for item in indexed] == ["src.py"]

    asyncio.run(scenario())


def test_path_validation_rejects_dotdot_symlink_and_missing_prefix(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "safe.py").write_text("def safe(): pass\n")
        outside = tmp_path.parent / "outside.py"
        outside.write_text("outside")
        (tmp_path / "escape.py").symlink_to(outside)
        tool = RepositoryExplorerTool(_config(tmp_path))
        for arguments in (
            {"focus_paths": ["sub/../safe.py"]},
            {"focus_paths": ["escape.py"]},
            {"path_prefixes": ["missing"]},
        ):
            result = await tool.execute(arguments)
            assert result.is_error

    asyncio.run(scenario())


class _FixedIndexer:
    async def index(self, include_tests: bool) -> tuple[IndexedFile, ...]:
        return (
            IndexedFile(
                "target.py",
                "x" * 64,
                (RepositoryTag("target.py", "target", "definition", "function", 1),),
                True,
            ),
        )


def test_render_retries_once_then_rejects_concurrently_changing_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        target = tmp_path / "target.py"
        target.write_text("def target():\n    return 1\n")
        original = Path.read_bytes
        reads = 0

        def changing_read(path: Path) -> bytes:
            nonlocal reads
            value = original(path)
            if path == target:
                reads += 1
                if reads % 2 == 0:
                    target.write_text(f"def target():\n    return changed_{'x' * reads}\n")
            return value

        monkeypatch.setattr(Path, "read_bytes", changing_read)
        result = await RepositoryExplorerTool(_config(tmp_path), _FixedIndexer()).execute({"identifiers": ["target"]})
        assert result.is_error
        assert result.content == "workspace_changed_during_render"

    asyncio.run(scenario())


def test_wire_budget_counts_full_json_bytes_lines_and_tokens() -> None:
    content = "line\n" * MAX_WIRE_LINES
    assert not _within_wire_budget(content, False, 6_000)
    assert not _within_wire_budget("x" * MAX_WIRE_BYTES, False, 6_000)
    assert not _within_wire_budget("x" * 1_000, False, 256)
    payload = json.dumps(
        {"content": "small", "is_error": False, "details": {"truncated": False, "token_estimate": True}}
    )
    assert _within_wire_budget("small", False, 6_000)
    assert len(payload.encode()) < MAX_WIRE_BYTES


def test_actual_tool_result_respects_the_full_wire_budget(tmp_path: Path) -> None:
    async def scenario() -> None:
        (tmp_path / "many.py").write_text(
            "\n".join(f"def function_{index}():\n    return {'x' * 100!r}\n" for index in range(80))
        )
        result = await RepositoryExplorerTool(_config(tmp_path)).execute(
            {"focus_paths": ["many.py"], "max_tokens": 256}
        )
        wire = json.dumps(
            {"content": result.content, "is_error": result.is_error, "details": result.details}, ensure_ascii=False
        )
        assert not result.is_error
        assert len(wire.encode()) <= MAX_WIRE_BYTES
        assert str(result.content).count("\n") + 1 <= MAX_WIRE_LINES
        assert (len(wire.encode()) + 2) // 3 <= 256
        assert result.details == {"truncated": True, "token_estimate": True}

    asyncio.run(scenario())


def test_graph_edge_modifiers_have_the_specified_values() -> None:
    assert (
        _edge_weight("long_symbol", 9, definition_count=1, identifier=True, known_referencer=True, low_confidence=False)
        == 15_000.0
    )
    assert _edge_weight(
        "_private_symbol", 1, definition_count=6, identifier=False, known_referencer=False, low_confidence=True
    ) == pytest.approx(0.01)
