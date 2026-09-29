"""Read-only, on-demand repository navigation for Agent tool calls.

This module deliberately owns discovery, parsing, ranking and its checkout-external
cache.  Runtime code only sees :class:`RepositoryExplorerTool` through the normal
``AgentTool`` protocol.
"""

import asyncio
import hashlib
import json
import math
import re
import sqlite3
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from importlib import import_module
from pathlib import Path
from typing import Any, Final, Literal, Protocol

from agent_harness.domain.entries import JsonValue
from agent_harness.runtime.tools import ToolExecutionResult

TagRole = Literal["definition", "reference"]
SymbolKind = Literal["class", "function", "method", "interface", "constant", "variable", "module", "type", "unknown"]

INDEXER_VERSION: Final = 4
QUERY_VERSION: Final = 1
MAX_WIRE_BYTES: Final = 50 * 1024
MAX_WIRE_LINES: Final = 1_600
MAX_FALLBACK_CANDIDATES: Final = 12
MAX_SYMBOLS_PER_FILE: Final = 3
ROOT_IMPORTANT_FILES: Final = frozenset(
    {
        ".gitignore",
        "README",
        "README.md",
        "README.rst",
        "CONTRIBUTING.md",
        "LICENSE",
        "LICENSE.md",
        "LICENSE.txt",
        "pyproject.toml",
        "setup.py",
        "setup.cfg",
        "requirements.txt",
        "package.json",
        "tsconfig.json",
        "go.mod",
        "Cargo.toml",
        "pom.xml",
        "Dockerfile",
        "docker-compose.yml",
        "Makefile",
        "pytest.ini",
    }
)
_QUERY_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{2,}")
# Query-only exploration must work for the deployment's supported natural-language
# prompts as well as for code-shaped English.  These are intentionally bounded,
# auditable concept hints rather than a claim of semantic search.
_QUERY_CONCEPT_HINTS: Final = {
    "记忆模块": ("memory",),
    "记忆": ("memory",),
    "技能": ("skill",),
    "仓库": ("repository",),
    "会话": ("session",),
    "存储": ("storage",),
    "召回": ("recall",),
}
_DEFAULT_SKIPPED_DIRS = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".nox",
        "node_modules",
        ".venv",
        "venv",
        "dist",
        "build",
        "__pycache__",
    }
)


@dataclass(frozen=True, slots=True)
class RepositoryTag:
    relative_path: str
    name: str
    role: TagRole
    symbol_kind: SymbolKind
    line: int
    low_confidence: bool = False


@dataclass(frozen=True, slots=True)
class IndexedFile:
    relative_path: str
    content_hash: str
    tags: tuple[RepositoryTag, ...]
    parseable: bool


@dataclass(frozen=True, slots=True)
class RepositoryScanLimits:
    max_files: int = 8_000
    max_file_bytes: int = 1_000_000
    max_total_bytes: int = 32_000_000
    max_scan_ms: int = 60_000

    def __post_init__(self) -> None:
        if min(self.max_files, self.max_file_bytes, self.max_total_bytes, self.max_scan_ms) < 1:
            raise ValueError("repository scan limits must be positive")


@dataclass(frozen=True, slots=True)
class RepositoryExplorerConfig:
    workspace_root: Path
    cache_dir: Path
    limits: RepositoryScanLimits = RepositoryScanLimits()
    max_export_tokens: int = 6_000
    cache_max_entries: int = 20_000
    cache_ttl_ms: int = 7 * 24 * 60 * 60 * 1_000
    max_concurrent_indexes: int = 2

    def __post_init__(self) -> None:
        root = Path(self.workspace_root).resolve(strict=True)
        cache = Path(self.cache_dir).expanduser().resolve()
        if not root.is_dir():
            raise ValueError("workspace root must be a directory")
        try:
            cache.relative_to(root)
        except ValueError:
            pass
        else:
            raise ValueError("repository index cache must be outside workspace root")
        if not 256 <= self.max_export_tokens <= 6_000:
            raise ValueError("max_export_tokens must be between 256 and 6000")
        if self.cache_max_entries < 1 or self.cache_ttl_ms < 1 or self.max_concurrent_indexes < 1:
            raise ValueError("repository cache limits must be positive")
        object.__setattr__(self, "workspace_root", root)
        object.__setattr__(self, "cache_dir", cache)


class RepositoryIndexer(Protocol):
    async def index(self, include_tests: bool) -> tuple[IndexedFile, ...]: ...


class RepositoryIndexError(RuntimeError):
    """A structured exploration failure whose message is safe for a tool result."""


class RepositoryScanLimitExceeded(RepositoryIndexError):
    pass


class WorkspaceChangedDuringRender(RepositoryIndexError):
    """A selected output file changed while its snippet was being verified."""


class RepositoryTagCache:
    """Best-effort SQLite cache of file tags; cache failures are always misses."""

    def __init__(self, directory: Path, *, max_entries: int, ttl_ms: int) -> None:
        self._directory, self._max_entries, self._ttl_ms = directory, max_entries, ttl_ms
        self._path = directory / "repository-tags.sqlite"
        self._local = threading.local()

    def lookup(self, relative_path: str, size: int, mtime_ns: int) -> IndexedFile | None:
        try:
            conn = self._connection()
            row = conn.execute(
                "SELECT content_hash,tags,parseable FROM repository_tags_v3 "
                "WHERE path=? AND size=? AND mtime_ns=? AND indexer_version=? AND query_version=?",
                (relative_path, size, mtime_ns, INDEXER_VERSION, QUERY_VERSION),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE repository_tags_v3 SET accessed_at=? WHERE path=? AND size=? AND mtime_ns=?",
                (_now_ms(), relative_path, size, mtime_ns),
            )
            conn.commit()
            tags = tuple(RepositoryTag(relative_path, *item) for item in json.loads(row[1]))
            return IndexedFile(relative_path, str(row[0]), tags, bool(row[2]))
        except (OSError, sqlite3.Error, TypeError, ValueError, json.JSONDecodeError):
            return None

    def store(self, indexed: IndexedFile, size: int, mtime_ns: int) -> None:
        try:
            conn = self._connection()
            payload = json.dumps(
                [(tag.name, tag.role, tag.symbol_kind, tag.line, tag.low_confidence) for tag in indexed.tags],
                separators=(",", ":"),
            )
            now = _now_ms()
            conn.execute(
                """INSERT INTO repository_tags_v3(
                path,size,mtime_ns,content_hash,indexer_version,query_version,tags,parseable,accessed_at)
                VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(path,content_hash,indexer_version,query_version)
                DO UPDATE SET size=excluded.size,mtime_ns=excluded.mtime_ns,tags=excluded.tags,
                parseable=excluded.parseable,accessed_at=excluded.accessed_at""",
                (
                    indexed.relative_path,
                    size,
                    mtime_ns,
                    indexed.content_hash,
                    INDEXER_VERSION,
                    QUERY_VERSION,
                    payload,
                    int(indexed.parseable),
                    now,
                ),
            )
            conn.execute("DELETE FROM repository_tags_v3 WHERE accessed_at<?", (now - self._ttl_ms,))
            overflow = conn.execute("SELECT COUNT(*) FROM repository_tags_v3").fetchone()[0] - self._max_entries
            if overflow > 0:
                conn.execute(
                    "DELETE FROM repository_tags_v3 WHERE rowid IN "
                    "(SELECT rowid FROM repository_tags_v3 ORDER BY accessed_at LIMIT ?)",
                    (overflow,),
                )
            conn.commit()
        except (OSError, sqlite3.Error, TypeError, ValueError):
            return

    def _connection(self) -> sqlite3.Connection:
        existing = getattr(self._local, "connection", None)
        if existing is not None:
            return existing
        self._directory.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self._path)
        conn.execute(
            """CREATE TABLE IF NOT EXISTS repository_tags_v3(
            path TEXT NOT NULL,size INTEGER NOT NULL,mtime_ns INTEGER NOT NULL,content_hash TEXT NOT NULL,
            indexer_version INTEGER NOT NULL,query_version INTEGER NOT NULL,tags TEXT NOT NULL,
            parseable INTEGER NOT NULL,accessed_at INTEGER NOT NULL,
            PRIMARY KEY(path,content_hash,indexer_version,query_version))"""
        )
        self._local.connection = conn
        return conn


class TreeSitterRepositoryIndexer:
    """Incremental, containment-checked discovery backed by tree-sitter queries."""

    _LANGUAGE_BY_SUFFIX: Final = {
        ".py": "python",
        ".js": "javascript",
        ".jsx": "javascript",
        ".ts": "typescript",
        ".tsx": "tsx",
        ".go": "go",
        ".rs": "rust",
        ".java": "java",
        ".c": "c",
        ".h": "c",
        ".cc": "cpp",
        ".cpp": "cpp",
        ".cs": "c_sharp",
        ".rb": "ruby",
        ".php": "php",
        ".sh": "bash",
    }
    _GRAMMAR_MODULES: Final = {
        "python": ("tree_sitter_python", "language"),
        "javascript": ("tree_sitter_javascript", "language"),
        "typescript": ("tree_sitter_typescript", "language_typescript"),
        "tsx": ("tree_sitter_typescript", "language_tsx"),
        "go": ("tree_sitter_go", "language"),
        "rust": ("tree_sitter_rust", "language"),
        "java": ("tree_sitter_java", "language"),
        "c": ("tree_sitter_c", "language"),
        "cpp": ("tree_sitter_cpp", "language"),
        "c_sharp": ("tree_sitter_c_sharp", "language"),
        "ruby": ("tree_sitter_ruby", "language"),
        "php": ("tree_sitter_php", "language_php"),
        "bash": ("tree_sitter_bash", "language"),
    }

    def __init__(self, config: RepositoryExplorerConfig) -> None:
        self._config = config
        self._cache = RepositoryTagCache(
            config.cache_dir, max_entries=config.cache_max_entries, ttl_ms=config.cache_ttl_ms
        )
        try:
            import importlib.util

            if (
                importlib.util.find_spec("tree_sitter") is None
                or importlib.util.find_spec("tree_sitter_python") is None
            ):
                raise ImportError("tree_sitter or tree_sitter_python is not installed")
            from tree_sitter import Language, Parser, Query, QueryCursor
        except ImportError as error:  # composition checks before constructing in production
            raise RepositoryIndexError("repository_explorer requires the repository-explorer extra") from error
        self._parser, self._query, self._cursor = Parser, Query, QueryCursor
        self._languages: dict[str, Any] = {}
        for language_name, (module_name, factory_name) in self._GRAMMAR_MODULES.items():
            try:
                module = import_module(module_name)
                factory = getattr(module, factory_name)
                self._languages[language_name] = Language(factory())
            except (AttributeError, ImportError, TypeError):
                continue
        if "python" not in self._languages:
            raise RepositoryIndexError("repository_explorer requires the repository-explorer extra")

    async def index(self, include_tests: bool) -> tuple[IndexedFile, ...]:
        return await asyncio.to_thread(self._index_sync, include_tests)

    def _index_sync(self, include_tests: bool) -> tuple[IndexedFile, ...]:
        started = _now_ms()
        indexed: list[IndexedFile] = []
        total_bytes = 0
        for path in self._discover(include_tests, started):
            stat = path.stat()
            relative = path.relative_to(self._config.workspace_root).as_posix()
            total_bytes += stat.st_size
            if total_bytes > self._config.limits.max_total_bytes:
                raise RepositoryScanLimitExceeded("repository_scan_limit_exceeded: total_bytes")
            cached = self._cache.lookup(relative, stat.st_size, stat.st_mtime_ns)
            if cached is not None:
                indexed.append(cached)
                continue
            raw = path.read_bytes()
            if b"\0" in raw[:8192]:
                indexed_file = IndexedFile(relative, hashlib.sha256(raw).hexdigest(), (), False)
            else:
                indexed_file = IndexedFile(relative, hashlib.sha256(raw).hexdigest(), self._tags(relative, raw), True)
            self._cache.store(indexed_file, stat.st_size, stat.st_mtime_ns)
            indexed.append(indexed_file)
        return tuple(indexed)

    def _discover(self, include_tests: bool, started: int) -> Iterable[Path]:
        root = self._config.workspace_root
        stack = [root]
        found = 0
        while stack:
            if _now_ms() - started > self._config.limits.max_scan_ms:
                raise RepositoryScanLimitExceeded("repository_scan_limit_exceeded: scan_time")
            directory = stack.pop()
            for child in sorted(directory.iterdir(), key=lambda item: item.name, reverse=True):
                try:
                    resolved = child.resolve(strict=True)
                    resolved.relative_to(root)
                    stat = resolved.stat()
                except (OSError, ValueError):
                    continue
                relative = resolved.relative_to(root).as_posix()
                if resolved.is_dir():
                    if child.name not in _DEFAULT_SKIPPED_DIRS and resolved != self._config.cache_dir:
                        stack.append(resolved)
                    continue
                if not resolved.is_file() or stat.st_size > self._config.limits.max_file_bytes:
                    continue
                if not include_tests and _is_test_path(relative):
                    continue
                found += 1
                if found > self._config.limits.max_files:
                    raise RepositoryScanLimitExceeded("repository_scan_limit_exceeded: files")
                yield resolved

    def _tags(self, relative_path: str, raw: bytes) -> tuple[RepositoryTag, ...]:
        language_name = self._LANGUAGE_BY_SUFFIX.get(Path(relative_path).suffix.lower())
        if language_name is None:
            return ()
        return self._tree_sitter_tags(relative_path, raw, language_name)

    def _tree_sitter_tags(self, relative_path: str, raw: bytes, language_name: str) -> tuple[RepositoryTag, ...]:
        """Run wheel-shipped capture queries over a tree-sitter syntax tree."""
        language = self._languages.get(language_name)
        if language is None:
            return ()
        try:
            parser = self._parser(language)
            root_node = parser.parse(raw).root_node
        except Exception:
            return ()
        tags: list[RepositoryTag] = []
        # The Python bindings expose native query/cursor objects. Keep every
        # object alive until its captures have been consumed: some supported
        # tree-sitter builds otherwise release a query while its cursor still
        # owns native capture buffers.
        native_objects: list[object] = []
        for source in _query_source(language_name).split("\n\n"):
            try:
                query = self._query(language, source)
                cursor = self._cursor(query)
                native_objects.extend((query, cursor))
                captures = cursor.captures(root_node)
            except Exception:
                continue
            names = captures.get("name", [])
            for capture, nodes in captures.items():
                if capture.startswith("definition."):
                    role: TagRole | None = "definition"
                elif capture.startswith("reference."):
                    role = "reference"
                else:
                    role = None
                if role is None:
                    continue
                kind = _symbol_kind(capture.removeprefix(f"{role}."))
                for node in nodes:
                    for name in names:
                        if node.start_byte <= name.start_byte and name.end_byte <= node.end_byte:
                            decoded = raw[name.start_byte : name.end_byte].decode("utf-8", "replace")
                            tags.append(RepositoryTag(relative_path, decoded, role, kind, name.start_point.row + 1))
        unique = {
            (tag.relative_path, tag.name, tag.role, tag.symbol_kind, tag.line, tag.low_confidence): tag for tag in tags
        }
        return tuple(sorted(unique.values(), key=lambda tag: (tag.line, tag.name, tag.role)))


def _query_source(language_name: str) -> str:
    """Queries are package data so installed wheels never need a source checkout."""
    from importlib.resources import files

    return files("agent_harness.integrations.repository_queries").joinpath(f"{language_name}.scm").read_text()


def _symbol_kind(value: str) -> SymbolKind:
    normalized = value.lower()
    if "class" in normalized:
        return "class"
    if "method" in normalized:
        return "method"
    if "function" in normalized or "call" in normalized:
        return "function"
    if "interface" in normalized:
        return "interface"
    if "type" in normalized:
        return "type"
    if "constant" in normalized:
        return "constant"
    if "variable" in normalized:
        return "variable"
    if "module" in normalized:
        return "module"
    return "unknown"


def _is_test_path(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    return (
        any(part in {"test", "tests", "__tests__"} for part in parts[:-1])
        or name.startswith("test_")
        or name.endswith("_test.py")
        or ".test." in name
        or ".spec." in name
    )


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


@dataclass(frozen=True, slots=True)
class _ExploreRequest:
    identifiers: tuple[str, ...]
    known_paths: tuple[str, ...]
    focus_paths: tuple[str, ...]
    path_prefixes: tuple[str, ...]
    query: str | None
    include_tests: bool
    max_tokens: int


@dataclass(frozen=True, slots=True)
class _Candidate:
    relative_path: str
    tag: RepositoryTag | None
    score: float


@dataclass(frozen=True, slots=True)
class RepositoryExplorerTool:
    """A safe AgentTool that renders a bounded, current repository map."""

    config: RepositoryExplorerConfig
    indexer: RepositoryIndexer | None = None
    name: str = "repository_explore"
    description: str = (
        "Locate related implementation from known identifiers or code context in the configured repository. "
        "Identifiers are case-sensitive exact code symbols; for a conceptual task without a known symbol, use query "
        "and optional path_prefixes first. "
        "Use read for an exact known file path; if bash is enabled and one precise search will locate it, "
        "use bash instead. This tool is read-only, never terminates the operation, and its result is "
        "navigation guidance that must be verified with read."
    )
    input_schema: JsonValue = field(
        default_factory=lambda: {
            "type": "object",
            "properties": {
                "identifiers": {"type": "array", "items": {"type": "string"}},
                "known_paths": {"type": "array", "items": {"type": "string"}},
                "focus_paths": {"type": "array", "items": {"type": "string"}},
                "path_prefixes": {"type": "array", "items": {"type": "string"}},
                "query": {
                    "type": "string",
                    "description": (
                        "Optional conceptual feature hint and the preferred first signal when no exact symbol is known."
                    ),
                },
                "include_tests": {"type": "boolean", "default": True},
                "max_tokens": {"type": "integer", "minimum": 256, "maximum": 6000, "default": 4000},
            },
            "additionalProperties": False,
        }
    )
    replay_policy: str = "safe"
    _index_semaphore: asyncio.Semaphore = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "_index_semaphore", asyncio.Semaphore(self.config.max_concurrent_indexes))

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        try:
            request = _normalize_request(arguments, self.config)
            indexer = self.indexer or TreeSitterRepositoryIndexer(self.config)
            for attempt in range(2):
                async with self._index_semaphore:
                    indexed = await indexer.index(request.include_tests)
                try:
                    return await asyncio.to_thread(self._render, request, indexed)
                except WorkspaceChangedDuringRender:
                    if attempt:
                        raise
            raise AssertionError("unreachable")
        except RepositoryIndexError as error:
            return _bounded_error(str(error))
        except ValueError as error:
            return _bounded_error(f"repository_explore invalid arguments: {error}")
        except OSError:
            return _bounded_error("repository_explore could not read workspace")

    def _render(self, request: _ExploreRequest, indexed: tuple[IndexedFile, ...]) -> ToolExecutionResult:
        all_paths = {item.relative_path for item in indexed}
        definitions = [tag for item in indexed for tag in item.tags if tag.role == "definition"]
        matched_identifiers = {name for name in request.identifiers if any(tag.name == name for tag in definitions)}
        missing = tuple(name for name in request.identifiers if name not in matched_identifiers)
        if request.identifiers and not matched_identifiers:
            candidates = _fallback_candidates(indexed, request, all_paths)
        else:
            candidates = _rank_candidates(indexed, request, all_paths)
        candidates = [candidate for candidate in candidates if candidate.relative_path not in request.known_paths]
        revision = _revision(self.config.workspace_root)
        prefix = [
            f"# Repository exploration ({revision})",
            "Navigation only: use read on selected paths to confirm the current checkout before editing or concluding.",
        ]
        if missing:
            prefix.append("identifiers_not_found: " + ", ".join(missing))
            if not matched_identifiers:
                prefix.append("Using unmatched identifiers only as filename hints; no symbol-level match is claimed.")
        if not candidates:
            prefix.append("No matching symbols or eligible files were found.")
        selected: list[tuple[_Candidate, str]] = []
        prefix_content = "\n\n".join(prefix)
        encoded_bytes = _json_string_inner_bytes(prefix_content)
        content_lines = prefix_content.count("\n") + 1
        selected_per_file: Counter[str] = Counter()
        truncated = False
        for candidate in candidates:
            if candidate.tag is not None and selected_per_file[candidate.relative_path] >= MAX_SYMBOLS_PER_FILE:
                continue
            block = self._candidate_block(candidate)
            if block is None:
                continue
            block_delta = "\n\n" + block
            next_bytes = encoded_bytes + _json_string_inner_bytes(block_delta)
            next_lines = content_lines + block_delta.count("\n")
            if _within_incremental_wire_budget(next_bytes, next_lines, request.max_tokens, truncated=True):
                selected.append((candidate, block))
                selected_per_file[candidate.relative_path] += 1
                encoded_bytes, content_lines = next_bytes, next_lines
                continue
            truncated = True
            break
        selected.sort(key=_render_order)
        selected_blocks = [item[1] for item in selected]
        selected_ids = {id(item[0]) for item in selected}
        omitted = [candidate.relative_path for candidate in candidates if id(candidate) not in selected_ids][:12]
        suffix_for_render: str | None = None
        if omitted:
            suffix = "Truncated by output budget; consider a narrower identifier query. Other candidates: " + ", ".join(
                omitted
            )
            suffix_delta = "\n\n" + suffix
            suffix_bytes = _json_string_inner_bytes(suffix_delta)
            suffix_lines = suffix_delta.count("\n")
            while selected and not _within_incremental_wire_budget(
                encoded_bytes + suffix_bytes, content_lines + suffix_lines, request.max_tokens, truncated=True
            ):
                removed = selected_blocks.pop()
                selected.pop()
                removed_delta = "\n\n" + removed
                encoded_bytes -= _json_string_inner_bytes(removed_delta)
                content_lines -= removed_delta.count("\n")
                truncated = True
            if _within_incremental_wire_budget(
                encoded_bytes + suffix_bytes, content_lines + suffix_lines, request.max_tokens, truncated=True
            ):
                suffix_for_render = suffix
            else:
                truncated = True
        rendered_blocks = _group_rendered_candidates(selected)
        if suffix_for_render is not None:
            rendered_blocks.append(suffix_for_render)
        content = "\n\n".join([*prefix, *rendered_blocks])
        if not _within_wire_budget(content, truncated, request.max_tokens):
            # The prefix itself is deliberately small. This is a last guard for
            # a pathological long identifier/error message.
            content = _trim_to_wire_budget(content, request.max_tokens, truncated)
            truncated = True
        return ToolExecutionResult(content=content, details={"truncated": truncated, "token_estimate": True})

    def _candidate_block(self, candidate: _Candidate) -> str | None:
        if candidate.tag is None:
            target = _safe_path(self.config.workspace_root, candidate.relative_path)
            if target is None or not target.exists() or not target.is_file():
                raise WorkspaceChangedDuringRender("workspace_changed_during_render")
            return f"- `{candidate.relative_path}` (file candidate; not expanded)"
        target = _safe_path(self.config.workspace_root, candidate.relative_path)
        if target is None:
            raise WorkspaceChangedDuringRender("workspace_changed_during_render")
        first = target.read_bytes()
        first_hash = hashlib.sha256(first).hexdigest()
        first_stat = target.stat()
        lines = first.decode("utf-8", "replace").splitlines()
        start = max(0, candidate.tag.line - 3)
        end = min(len(lines), candidate.tag.line + 3)
        snippet = "\n".join(f"{number + 1}: {lines[number][:120]}" for number in range(start, end))
        second = target.read_bytes()
        second_stat = target.stat()
        if (
            hashlib.sha256(second).hexdigest() != first_hash
            or second_stat.st_size != first_stat.st_size
            or second_stat.st_mtime_ns != first_stat.st_mtime_ns
        ):
            raise WorkspaceChangedDuringRender("workspace_changed_during_render")
        confidence = " (low-confidence reference)" if candidate.tag.low_confidence else ""
        role = "reference " if candidate.tag.role == "reference" else ""
        return (
            f"## `{candidate.relative_path}` — {role}`{candidate.tag.name}` line {candidate.tag.line}{confidence}\n"
            f"snapshot `{first_hash[:12]}`\n```\n{snippet}\n```"
        )


def _group_rendered_candidates(selected: list[tuple[_Candidate, str]]) -> list[str]:
    """Render adjacent symbols as one aider-style file section."""
    blocks: list[str] = []
    current_path: str | None = None
    for candidate, block in selected:
        if candidate.tag is None:
            blocks.append(block)
            current_path = None
            continue
        parts = block.split("\n", 2)
        if len(parts) != 3:
            blocks.append(block)
            current_path = None
            continue
        confidence = " (low-confidence reference)" if candidate.tag.low_confidence else ""
        role = "reference " if candidate.tag.role == "reference" else ""
        symbol = f"### {role}`{candidate.tag.name}` line {candidate.tag.line}{confidence}\n{parts[2]}"
        if current_path == candidate.relative_path:
            blocks[-1] += "\n\n" + symbol
        else:
            blocks.append(f"## `{candidate.relative_path}`\n{parts[1]}\n{symbol}")
            current_path = candidate.relative_path
    return blocks


def _normalize_request(arguments: JsonValue, config: RepositoryExplorerConfig) -> _ExploreRequest:
    if not isinstance(arguments, dict):
        raise ValueError("arguments must be an object")
    unknown = set(arguments).difference(
        {"identifiers", "known_paths", "focus_paths", "path_prefixes", "query", "include_tests", "max_tokens"}
    )
    if unknown:
        raise ValueError("unknown properties: " + ", ".join(sorted(unknown)))
    identifiers = _string_array(arguments, "identifiers", 256, paths=False, root=config.workspace_root)
    known = _string_array(arguments, "known_paths", 1024, paths=True, root=config.workspace_root)
    focus = _string_array(arguments, "focus_paths", 1024, paths=True, root=config.workspace_root)
    prefixes = _string_array(arguments, "path_prefixes", 1024, paths=True, root=config.workspace_root, prefix=True)
    if set(known).intersection(focus):
        raise ValueError("a path cannot appear in both known_paths and focus_paths")
    query = arguments.get("query")
    if query is not None and (not isinstance(query, str) or not query.strip() or len(query.encode()) > 1_000):
        raise ValueError("query must be a non-empty string of at most 1000 UTF-8 bytes")
    include_tests = arguments.get("include_tests", True)
    if not isinstance(include_tests, bool):
        raise ValueError("include_tests must be a boolean")
    max_tokens = arguments.get("max_tokens", 4_000)
    if (
        not isinstance(max_tokens, int)
        or isinstance(max_tokens, bool)
        or not 256 <= max_tokens <= config.max_export_tokens
    ):
        raise ValueError(f"max_tokens must be an integer between 256 and {config.max_export_tokens}")
    if not any((identifiers, known, focus, prefixes, query)):
        raise ValueError("at least one exploration focus is required")
    return _ExploreRequest(identifiers, known, focus, prefixes, query, include_tests, max_tokens)


def _string_array(
    arguments: Mapping[str, JsonValue],
    key: str,
    maximum_bytes: int,
    *,
    paths: bool,
    root: Path,
    prefix: bool = False,
) -> tuple[str, ...]:
    raw = arguments.get(key, [])
    if not isinstance(raw, list) or len(raw) > 32:
        raise ValueError(f"{key} must be an array of at most 32 strings")
    values: list[str] = []
    for value in raw:
        if not isinstance(value, str) or not value or "\0" in value or len(value.encode()) > maximum_bytes:
            raise ValueError(f"{key} contains an invalid value")
        normalized = _normalize_relative_path(root, value, prefix=prefix) if paths else value
        if normalized in values:
            continue
        values.append(normalized)
    return tuple(values)


def _normalize_relative_path(root: Path, value: str, *, prefix: bool) -> str:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("paths must be workspace-relative")
    resolved = (root / candidate).resolve(strict=False)
    try:
        relative = resolved.relative_to(root)
    except ValueError as error:
        raise ValueError("path escapes workspace root") from error
    if not resolved.exists():
        raise ValueError("path does not exist")
    if not prefix and not resolved.is_file():
        raise ValueError("path does not exist or is not a regular file")
    if prefix and not (resolved.is_file() or resolved.is_dir()):
        raise ValueError("path prefix must be a regular file or directory")
    return relative.as_posix()


def _safe_path(root: Path, relative: str) -> Path | None:
    try:
        target = (root / relative).resolve(strict=True)
        target.relative_to(root)
        return target if target.is_file() else None
    except (OSError, ValueError):
        return None


def _rank_candidates(
    indexed: tuple[IndexedFile, ...], request: _ExploreRequest, all_paths: set[str]
) -> list[_Candidate]:
    definitions_by_name: dict[str, list[RepositoryTag]] = defaultdict(list)
    references: list[RepositoryTag] = []
    for item in indexed:
        for tag in item.tags:
            if tag.role == "definition":
                definitions_by_name[tag.name].append(tag)
            else:
                references.append(tag)
    edge_weights: dict[tuple[str, str], float] = defaultdict(float)
    grouped: Counter[tuple[str, str, bool]] = Counter(
        (tag.relative_path, tag.name, tag.low_confidence) for tag in references
    )
    for (referencer, name, low_confidence), count in grouped.items():
        for definition in definitions_by_name.get(name, []):
            weight = _edge_weight(
                name,
                count,
                definition_count=len(definitions_by_name[name]),
                identifier=name in request.identifiers,
                known_referencer=referencer in request.known_paths,
                low_confidence=low_confidence,
            )
            edge_weights[(referencer, definition.relative_path)] += weight
    if not edge_weights:
        for name, definitions in definitions_by_name.items():
            for source in definitions:
                for target in definitions:
                    if source.relative_path != target.relative_path:
                        edge_weights[(source.relative_path, target.relative_path)] += 1.0
    nodes = set(all_paths)
    for item in indexed:
        if any(tag.role == "definition" for tag in item.tags) and not any(
            dst == item.relative_path for _, dst in edge_weights
        ):
            edge_weights[(item.relative_path, item.relative_path)] += 0.1
    scores = _pagerank(nodes, edge_weights, request)
    query_terms = _query_terms(request.query)
    query_only_paths = {
        item.relative_path
        for item in indexed
        if any(
            term in item.relative_path.lower() or any(term in tag.name.lower() for tag in item.tags)
            for term in query_terms
        )
    }
    query_seed_names = {
        tag.name
        for item in indexed
        for tag in item.tags
        if tag.role == "definition" and any(term in tag.name.lower() for term in query_terms)
    }
    candidates: list[_Candidate] = []
    for item in indexed:
        if (
            request.query
            and not request.identifiers
            and query_only_paths
            and item.relative_path not in query_only_paths
        ):
            continue
        for tag in item.tags:
            query_definition = (
                request.query and not request.identifiers and any(term in tag.name.lower() for term in query_terms)
            )
            query_reference = request.query and not request.identifiers and tag.name in query_seed_names
            if tag.role == "definition" and (not request.query or request.identifiers or query_definition):
                score = scores.get(item.relative_path, 0.0) + (1000.0 if tag.name in request.identifiers else 0.0)
                if item.relative_path in request.focus_paths:
                    score += 100.0
                if any(
                    item.relative_path.startswith(prefix.rstrip("/") + "/") or item.relative_path == prefix
                    for prefix in request.path_prefixes
                ):
                    score += 10.0
                if _is_test_path(item.relative_path):
                    score -= 1.0
                score += _symbol_score_bonus(tag.symbol_kind)
                if query_definition:
                    score += 30.0
                candidates.append(_Candidate(item.relative_path, tag, score))
            elif query_reference:
                score = scores.get(item.relative_path, 0.0) + 25.0
                if _is_test_path(item.relative_path):
                    score -= 1.0
                candidates.append(_Candidate(item.relative_path, tag, score))
    deduplicated: dict[tuple[str, int, str, TagRole], _Candidate] = {}
    for candidate in candidates:
        assert candidate.tag is not None
        key = (candidate.relative_path, candidate.tag.line, candidate.tag.name, candidate.tag.role)
        previous = deduplicated.get(key)
        if previous is None or (
            previous.tag is not None
            and _symbol_priority(candidate.tag.symbol_kind) < _symbol_priority(previous.tag.symbol_kind)
        ):
            deduplicated[key] = candidate
    candidates = list(deduplicated.values())
    rendered_paths = {candidate.relative_path for candidate in candidates}
    for path in request.focus_paths:
        if path in all_paths and path not in rendered_paths:
            candidates.append(_Candidate(path, None, 100.0))
    if not candidates:
        return _fallback_candidates(indexed, request, all_paths)
    return sorted(
        candidates,
        key=lambda item: (
            -item.score,
            item.relative_path,
            item.tag.line if item.tag else 0,
            item.tag.name if item.tag else "",
        ),
    )


def _render_order(item: tuple[_Candidate, str]) -> tuple[str, int, str]:
    candidate = item[0]
    if candidate.tag is None:
        return (candidate.relative_path, 0, "")
    return (candidate.relative_path, candidate.tag.line, candidate.tag.name)


def _fallback_candidates(
    indexed: tuple[IndexedFile, ...], request: _ExploreRequest, all_paths: set[str]
) -> list[_Candidate]:
    query_terms = _query_terms(request.query)
    if request.identifiers:
        query_terms.update(
            word.lower() for identifier in request.identifiers for word in _QUERY_WORD.findall(identifier)
        )
    candidates: list[_Candidate] = []
    for item in indexed:
        score = 0.0
        lower = item.relative_path.lower()
        score += sum(100 for term in query_terms if term in lower)
        if item.relative_path in request.focus_paths:
            score += 100
        if item.relative_path in ROOT_IMPORTANT_FILES:
            score += 5
        if item.relative_path.startswith(".github/workflows/") and item.relative_path.endswith((".yml", ".yaml")):
            score += 5
        if any(
            item.relative_path.startswith(prefix.rstrip("/") + "/") or item.relative_path == prefix
            for prefix in request.path_prefixes
        ):
            score += 10
        if item.tags:
            score += 1
        candidates.append(_Candidate(item.relative_path, None, score))
    return sorted(candidates, key=lambda item: (-item.score, item.relative_path))[:MAX_FALLBACK_CANDIDATES]


def _query_terms(query: str | None) -> set[str]:
    normalized = (query or "").lower()
    terms = set(_QUERY_WORD.findall(normalized))
    for concept, hints in _QUERY_CONCEPT_HINTS.items():
        if concept in normalized:
            terms.update(hints)
    return terms


def _symbol_priority(kind: SymbolKind) -> int:
    return {
        "class": 0,
        "interface": 0,
        "type": 0,
        "function": 1,
        "method": 1,
        "module": 2,
        "constant": 3,
        "variable": 4,
        "unknown": 5,
    }[kind]


def _symbol_score_bonus(kind: SymbolKind) -> float:
    return {
        "class": 2.0,
        "interface": 2.0,
        "function": 1.5,
        "method": 1.5,
        "type": 1.0,
        "module": 0.5,
        "constant": 0.0,
        "variable": -0.5,
        "unknown": -1.0,
    }[kind]


def _pagerank(nodes: set[str], edges: Mapping[tuple[str, str], float], request: _ExploreRequest) -> dict[str, float]:
    if not nodes:
        return {}
    outgoing: dict[str, float] = defaultdict(float)
    for (source, _), weight in edges.items():
        outgoing[source] += weight
    personal = {node: 1.0 for node in nodes}
    for node in request.focus_paths:
        if node in personal:
            personal[node] += 50.0
    for node in request.known_paths:
        if node in personal:
            personal[node] += 10.0
    total_personal = sum(personal.values())
    rank = {node: personal[node] / total_personal for node in nodes}
    for _ in range(30):
        next_rank = {node: 0.15 * personal[node] / total_personal for node in nodes}
        dangling = sum(rank[node] for node in nodes if outgoing[node] == 0)
        for node in nodes:
            next_rank[node] += 0.85 * dangling * personal[node] / total_personal
        for (source, destination), weight in edges.items():
            next_rank[destination] += 0.85 * rank[source] * weight / outgoing[source]
        rank = next_rank
    return rank


def _is_compound_name(name: str) -> bool:
    return len(name) >= 8 and ("_" in name or "-" in name or any(char.isupper() for char in name[1:]))


def _edge_weight(
    name: str,
    repetitions: int,
    *,
    definition_count: int,
    identifier: bool,
    known_referencer: bool,
    low_confidence: bool,
) -> float:
    """The versioned, auditable edge modifiers from the repository-map spec."""
    weight = math.sqrt(repetitions)
    if identifier:
        weight *= 10
    if _is_compound_name(name):
        weight *= 10
    if name.startswith("_"):
        weight *= 0.1
    if definition_count > 5:
        weight *= 0.1
    if known_referencer:
        weight *= 50
    if low_confidence:
        weight *= 0.1
    return weight


def _within_wire_budget(content: str, truncated: bool, max_tokens: int) -> bool:
    payload = json.dumps(
        {"content": content, "is_error": False, "details": {"truncated": truncated, "token_estimate": True}},
        ensure_ascii=False,
    )
    return (
        len(payload.encode()) <= MAX_WIRE_BYTES
        and content.count("\n") + 1 <= MAX_WIRE_LINES
        and _token_estimate(payload) <= max_tokens
    )


def _json_string_inner_bytes(value: str) -> int:
    """Exact UTF-8 JSON-string size, excluding just the surrounding quotes."""
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8")) - 2


def _within_incremental_wire_budget(
    encoded_content_bytes: int, content_lines: int, max_tokens: int, *, truncated: bool
) -> bool:
    empty_wire = json.dumps(
        {"content": "", "is_error": False, "details": {"truncated": truncated, "token_estimate": True}},
        ensure_ascii=False,
    ).encode("utf-8")
    wire_bytes = len(empty_wire) - 2 + encoded_content_bytes
    return wire_bytes <= MAX_WIRE_BYTES and content_lines <= MAX_WIRE_LINES and math.ceil(wire_bytes / 3) <= max_tokens


def _trim_to_wire_budget(content: str, max_tokens: int, truncated: bool) -> str:
    marker = "\n[truncated]"
    lines = content.splitlines()
    if len(lines) > MAX_WIRE_LINES - 1:
        content = "\n".join(lines[: MAX_WIRE_LINES - 1])
    encoded = content.encode("utf-8")
    low, high = 0, len(encoded)
    best = marker
    while low <= high:
        middle = (low + high) // 2
        candidate = encoded[:middle].decode("utf-8", "ignore") + marker
        if _within_wire_budget(candidate, True, max_tokens):
            best = candidate
            low = middle + 1
        else:
            high = middle - 1
    return best


def _token_estimate(text: str) -> int:
    """Conservative tokenizer-independent estimate over final wire JSON."""
    return math.ceil(len(text.encode("utf-8")) / 3)


def _bounded_error(message: str) -> ToolExecutionResult:
    content = message[: min(4_000, MAX_WIRE_BYTES // 2)]
    return ToolExecutionResult(content=content, is_error=True, details={"truncated": False, "token_estimate": True})


def _revision(root: Path) -> str:
    # Do not shell out: a git revision is optional human context, while hashes
    # attached to rendered source are the actual output freshness guarantee.
    head = root / ".git" / "HEAD"
    try:
        value = head.read_text(encoding="utf-8").strip()
        if value.startswith("ref: "):
            value = (root / ".git" / value[5:]).read_text(encoding="utf-8").strip()
        return value[:12] if re.fullmatch(r"[0-9a-fA-F]{7,64}", value) else "worktree"
    except OSError:
        return "worktree"
