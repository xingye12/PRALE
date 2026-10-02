"""The deployment's configuration, parsed from the environment.

Two entry points read the same values: ``api/serve.py`` builds a web
deployment from them, and the evaluation harness (``scripts/eval_harness.py``)
builds a provider from them to run a dataset offline.  Keeping the parsing here
is what stops the second from growing a private copy of the first's defaults,
and what keeps an offline run free of the web framework: nothing in this module
imports starlette.

The parsing is separated from the composition on purpose.  A misconfigured
deployment should fail with an explanation, at startup, before anything opens;
a value read from inside a driver fails much further from its cause.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.domain.context_management import ContextManagementConfig
from agent_harness.integrations.langfuse import LangfuseConfig
from agent_harness.integrations.repository_explorer import RepositoryScanLimits

DEFAULT_HOST = "127.0.0.1"
"""Loopback by default: a deployment that should be reachable says so."""

DEFAULT_PORT = 8787
DEFAULT_MODEL = "deepseek-flash"
"""The provider's current fast model; ``PRALE_MODEL`` overrides it."""
DEFAULT_BASE_URL = "https://api.deepseek.com/chat/completions"
"""The whole endpoint, not a base to append a path to."""
DEFAULT_GRACEFUL_SHUTDOWN_SECONDS = 10.0
"""Bound the time Uvicorn waits for long-lived SSE requests to finish."""
DEFAULT_LANE = "main"
DATA_DIR_NAME = ".prale"
"""Where the stores live when ``PRALE_DATA_DIR`` does not say otherwise."""

BUILTIN_TOOLS = ("read", "write", "edit", "bash", "repository_explore")
"""The local tool set, named individually because enabling ``bash`` is a decision."""

DEFAULT_MAX_CONCURRENT_DRIVES = 8
"""How many turns one deployment drives at once, unless it is configured otherwise.

Each drive is an agent loop that may run tools, so an unbounded number of
simultaneously admitted turns is a resource decision rather than a detail.
Refusing *before* the prompt is written keeps a refusal from leaving an
undriven durable operation behind.
"""

__all__ = [
    "BUILTIN_TOOLS",
    "DATA_DIR_NAME",
    "DEFAULT_BASE_URL",
    "DEFAULT_GRACEFUL_SHUTDOWN_SECONDS",
    "DEFAULT_HOST",
    "DEFAULT_LANE",
    "DEFAULT_MAX_CONCURRENT_DRIVES",
    "DEFAULT_MODEL",
    "DEFAULT_PORT",
    "Settings",
]


DEFAULT_HOST = "127.0.0.1"
"""Loopback by default: a deployment that should be reachable says so."""
DEFAULT_PORT = 8787
DEFAULT_MODEL = "deepseek-flash"
"""The provider's current fast model; ``PRALE_MODEL`` overrides it."""
DEFAULT_BASE_URL = "https://api.deepseek.com/chat/completions"
"""The whole endpoint, not a base to append a path to."""
DEFAULT_GRACEFUL_SHUTDOWN_SECONDS = 10.0
"""Bound the time Uvicorn waits for long-lived SSE requests to finish."""
DEFAULT_LANE = "main"
DATA_DIR_NAME = ".prale"
"""Where the stores live when ``PRALE_DATA_DIR`` does not say otherwise."""
BUILTIN_TOOLS = ("read", "write", "edit", "bash", "repository_explore")
"""The local tool set, named individually because enabling ``bash`` is a decision."""


@dataclass(frozen=True, slots=True)
class Settings:
    """One deployment's values, parsed and validated before anything opens.

    This holds what the environment said, not the objects built from it: the
    parsing is separable from the composition so that a misconfigured deployment
    fails with an explanation instead of a traceback from inside a driver.
    """

    project_root: Path
    repository_id: str
    project_id: str | None
    default_lane: str
    sessions_dir: Path
    catalog_db: Path
    memory_db: Path | None
    memory_assets_dir: Path | None
    memory_embedding_model: Path | None
    skill_db: Path | None
    api_key: str
    model: str
    context_management: ContextManagementConfig
    base_url: str
    timeout_seconds: float
    tokens: dict[str, str]
    tools: tuple[str, ...]
    traces: bool
    max_concurrent_drives: int
    repository_index_dir: Path | None
    repository_scan_limits: RepositoryScanLimits
    repository_export_tokens: int
    repository_cache_entries: int
    repository_cache_ttl_ms: int
    repository_max_concurrent_indexes: int
    memory_prompt_file: Path | None
    langfuse: LangfuseConfig | None
    host: str
    port: int
    max_connections: int | None
    graceful_shutdown_seconds: float
    log_level: str

    @property
    def config(self) -> ProjectRuntimeConfig:
        return ProjectRuntimeConfig(
            project_root=self.project_root,
            repository_id=self.repository_id,
            sessions_dir=self.sessions_dir,
            catalog_db=self.catalog_db,
            memory_db=self.memory_db,
            memory_assets_dir=self.memory_assets_dir,
            skill_db=self.skill_db,
            project_id=self.project_id,
            default_lane=self.default_lane,
        )

    @property
    def secrets(self) -> tuple[str, ...]:
        """Every value the log filter must never print.

        The token map is credential → identity (that is the shape
        ``StaticTokenAuthenticator`` looks a bearer credential up in), so its
        keys are the secrets and its values are the names a log may show.
        """

        tracing = () if self.langfuse is None else (self.langfuse.secret_key,)
        return (self.api_key, *self.tokens, *tracing)

    def describe(self) -> str:
        """The deployment as text, with credentials reduced to their presence."""

        memory = "off" if self.memory_db is None else str(self.memory_db)
        embedding = "off" if self.memory_embedding_model is None else str(self.memory_embedding_model)
        skills = "off" if self.skill_db is None else str(self.skill_db)
        prompt = "none" if self.memory_prompt_file is None else str(self.memory_prompt_file)
        tools = ", ".join(self.tools) or "none"
        tokens = ", ".join(sorted(self.tokens.values())) or "none (unauthenticated)"
        return "\n".join(
            [
                f"project_root      {self.project_root}",
                f"repository_id     {self.repository_id}",
                f"project_id        {self.project_id or self.repository_id}",
                f"default_lane      {self.default_lane}",
                f"sessions_dir      {self.sessions_dir}",
                f"catalog_db        {self.catalog_db}",
                f"memory_db         {memory}",
                f"memory_embedding  {embedding}",
                f"skill_db          {skills}",
                f"provider          deepseek {self.model} @ {self.base_url}",
                f"api_key           {'<set>' if self.api_key else '<unset>'}",
                f"tokens            {tokens}",
                f"tools             {tools}",
                f"traces            {'on' if self.traces else 'off'}",
                f"memory_prompt     {prompt}",
                f"max_drives        {self.max_concurrent_drives}",
                f"repository_explore {'on' if 'repository_explore' in self.tools else 'off'}",
                f"repository_scan   files={self.repository_scan_limits.max_files} "
                f"bytes={self.repository_scan_limits.max_total_bytes} "
                f"file_bytes={self.repository_scan_limits.max_file_bytes} ms={self.repository_scan_limits.max_scan_ms}",
                f"repository_export_tokens {self.repository_export_tokens}",
                f"repository_max_concurrent_indexes {self.repository_max_concurrent_indexes}",
                f"max_connections   {self.max_connections if self.max_connections else 'unlimited'}",
                f"graceful_shutdown {self.graceful_shutdown_seconds}s",
                f"listen            {self.host}:{self.port}",
                "langfuse          off" if self.langfuse is None else self.langfuse.describe(),
            ]
        )

    @classmethod
    def from_environment(cls, environ: Mapping[str, str], *, cwd: Path | None = None) -> "Settings":
        """Parse the deployment's values, or explain what is missing.

        ``environ`` is a parameter rather than ``os.environ`` so that the
        parsing can be exercised without a subprocess.
        """

        base = Path(cwd or Path.cwd())
        root = _path(environ, "PRALE_PROJECT_ROOT", base)
        data_dir = _path(environ, "PRALE_DATA_DIR", root / DATA_DIR_NAME)
        repository_id = environ.get("PRALE_REPOSITORY_ID", "").strip()
        if not repository_id:
            raise ProjectConfigError(
                "PRALE_REPOSITORY_ID is required: a stable identity (for example a canonical Git remote), "
                "not a checkout path"
            )
        api_key = environ.get("PRALE_API_KEY", "").strip()
        if not api_key:
            raise ProjectConfigError("PRALE_API_KEY is required: this deployment needs a provider credential")
        model = environ.get("PRALE_MODEL", "").strip() or DEFAULT_MODEL
        try:
            context_management = ContextManagementConfig(
                enabled=not _off(environ, "PRALE_CONTEXT_MANAGEMENT"),
                context_window_tokens=_int(environ, "PRALE_CONTEXT_WINDOW_TOKENS", 128_000),
                reserved_output_tokens=_int(environ, "PRALE_CONTEXT_RESERVED_OUTPUT_TOKENS", 20_000),
                soft_margin_tokens=_int(environ, "PRALE_CONTEXT_SOFT_MARGIN_TOKENS", 13_000),
                hard_margin_tokens=_int(environ, "PRALE_CONTEXT_HARD_MARGIN_TOKENS", 3_000),
                per_tool_result_chars=_int(environ, "PRALE_CONTEXT_PER_TOOL_RESULT_CHARS", 50_000),
                per_tool_message_chars=_int(environ, "PRALE_CONTEXT_PER_TOOL_MESSAGE_CHARS", 200_000),
                protected_recent_messages=_int(environ, "PRALE_CONTEXT_PROTECTED_RECENT_MESSAGES", 6),
                microcompact_keep_recent=_int(environ, "PRALE_CONTEXT_MICROCOMPACT_KEEP_RECENT", 5),
                collapse_enabled=not _off(environ, "PRALE_CONTEXT_COLLAPSE"),
                auto_compact_enabled=not _off(environ, "PRALE_CONTEXT_AUTO_COMPACT"),
            )
        except ValueError as error:
            raise ProjectConfigError(str(error)) from error
        tools = _tools(environ.get("PRALE_TOOLS", ""))
        unknown = sorted(set(tools) - set(BUILTIN_TOOLS))
        if unknown:
            raise ProjectConfigError(f"PRALE_TOOLS names unknown tools: {unknown}; known: {list(BUILTIN_TOOLS)}")
        tokens = _tokens(environ.get("PRALE_TOKENS", ""))
        # Parsed here, with the rest, so that an enabled-but-unconfigurable
        # tracing setup stops the process before it serves a single turn — and
        # so the sanitizer knows the credentials it must never upload.
        langfuse = LangfuseConfig.from_environment(
            environ,
            project_root=str(root),
            secrets=(api_key, *tokens),
        )
        prompt_file = environ.get("PRALE_MEMORY_PROMPT", "").strip()
        memory_db = (
            None if _off(environ, "PRALE_MEMORY") else _path(environ, "PRALE_MEMORY_DB", data_dir / "memory.sqlite")
        )
        memory_assets_dir = (
            None if memory_db is None else _path(environ, "PRALE_MEMORY_ASSETS_DIR", data_dir / "memory-assets")
        )
        raw_embedding_model = environ.get("PRALE_MEMORY_EMBEDDING_MODEL", "").strip()
        memory_embedding_model = Path(raw_embedding_model).expanduser() if raw_embedding_model else None
        if memory_embedding_model is not None and memory_db is None:
            raise ProjectConfigError("PRALE_MEMORY_EMBEDDING_MODEL requires PRALE_MEMORY to be enabled")
        skill_db = (
            None if _off(environ, "PRALE_SKILLS") else _path(environ, "PRALE_SKILL_DB", data_dir / "skills.sqlite")
        )
        if skill_db is not None and memory_db is None:
            # Said here rather than left to composition: skill extraction reads
            # L0 archives through the memory store, and the runtime's own error
            # for that mismatch arrives much further from the configuration.
            raise ProjectConfigError("PRALE_SKILLS requires the memory store: extraction reads L0 archives from it")
        repository_index_dir = None
        if "repository_explore" in tools:
            raw_index_dir = environ.get("PRALE_REPOSITORY_INDEX_DIR", "").strip()
            if not raw_index_dir:
                raise ProjectConfigError("PRALE_REPOSITORY_INDEX_DIR is required when repository_explore is enabled")
            repository_index_dir = Path(raw_index_dir).expanduser()
            try:
                repository_index_dir.resolve().relative_to(root.resolve(strict=True))
            except ValueError:
                pass
            else:
                raise ProjectConfigError("PRALE_REPOSITORY_INDEX_DIR must be outside PRALE_PROJECT_ROOT")
        try:
            scan_limits = RepositoryScanLimits(
                max_files=_int(environ, "PRALE_REPOSITORY_MAX_FILES", 8_000),
                max_file_bytes=_int(environ, "PRALE_REPOSITORY_MAX_FILE_BYTES", 1_000_000),
                max_total_bytes=_int(environ, "PRALE_REPOSITORY_MAX_TOTAL_BYTES", 32_000_000),
                max_scan_ms=_int(environ, "PRALE_REPOSITORY_MAX_SCAN_MS", 60_000),
            )
        except ValueError as error:
            raise ProjectConfigError(str(error)) from error
        repository_export_tokens = _int(environ, "PRALE_REPOSITORY_MAX_EXPORT_TOKENS", 6_000)
        if not 256 <= repository_export_tokens <= 6_000:
            raise ProjectConfigError("PRALE_REPOSITORY_MAX_EXPORT_TOKENS must be between 256 and 6000")
        return cls(
            project_root=root,
            repository_id=repository_id,
            project_id=environ.get("PRALE_PROJECT_ID", "").strip() or None,
            default_lane=environ.get("PRALE_DEFAULT_LANE", "").strip() or DEFAULT_LANE,
            sessions_dir=_path(environ, "PRALE_SESSIONS_DIR", data_dir / "sessions"),
            catalog_db=_path(environ, "PRALE_CATALOG_DB", data_dir / "catalog.sqlite"),
            memory_db=memory_db,
            memory_assets_dir=memory_assets_dir,
            memory_embedding_model=memory_embedding_model,
            skill_db=skill_db,
            api_key=api_key,
            model=model,
            context_management=context_management,
            base_url=environ.get("PRALE_BASE_URL", "").strip() or DEFAULT_BASE_URL,
            timeout_seconds=_float(environ, "PRALE_TIMEOUT_SECONDS", 60.0),
            tokens=tokens,
            tools=tools,
            traces=not _off(environ, "PRALE_TRACES"),
            max_concurrent_drives=_int(environ, "PRALE_MAX_DRIVES", DEFAULT_MAX_CONCURRENT_DRIVES),
            repository_index_dir=repository_index_dir,
            repository_scan_limits=scan_limits,
            repository_export_tokens=repository_export_tokens,
            repository_cache_entries=_int(environ, "PRALE_REPOSITORY_CACHE_ENTRIES", 20_000),
            repository_cache_ttl_ms=_int(environ, "PRALE_REPOSITORY_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1_000),
            repository_max_concurrent_indexes=_int(environ, "PRALE_REPOSITORY_MAX_CONCURRENT_INDEXES", 2),
            memory_prompt_file=Path(prompt_file) if prompt_file else None,
            langfuse=langfuse,
            host=environ.get("PRALE_HOST", "").strip() or DEFAULT_HOST,
            port=_int(environ, "PRALE_PORT", DEFAULT_PORT),
            max_connections=_optional_int(environ, "PRALE_MAX_CONNECTIONS"),
            graceful_shutdown_seconds=_positive_float(
                environ, "PRALE_GRACEFUL_SHUTDOWN_SECONDS", DEFAULT_GRACEFUL_SHUTDOWN_SECONDS
            ),
            log_level=environ.get("PRALE_LOG_LEVEL", "").strip() or "info",
        )


def _off(environ: Mapping[str, str], name: str) -> bool:
    return environ.get(name, "").strip().lower() in {"off", "0", "false", "no"}


def _path(environ: Mapping[str, str], name: str, default: Path) -> Path:
    value = environ.get(name, "").strip()
    return Path(value).expanduser() if value else default


def _int(environ: Mapping[str, str], name: str, default: int) -> int:
    value = environ.get(name, "").strip()
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError as error:
        raise ProjectConfigError(f"{name} must be an integer, not {value!r}") from error
    if parsed < 1:
        raise ProjectConfigError(f"{name} must be at least 1, not {parsed}")
    return parsed


def _optional_int(environ: Mapping[str, str], name: str) -> int | None:
    return _int(environ, name, 1) if environ.get(name, "").strip() else None


def _float(environ: Mapping[str, str], name: str, default: float) -> float:
    value = environ.get(name, "").strip()
    if not value:
        return default
    try:
        return float(value)
    except ValueError as error:
        raise ProjectConfigError(f"{name} must be a number, not {value!r}") from error


def _positive_float(environ: Mapping[str, str], name: str, default: float) -> float:
    parsed = _float(environ, name, default)
    if parsed <= 0:
        raise ProjectConfigError(f"{name} must be greater than 0, not {parsed}")
    return parsed


def _tools(raw: str) -> tuple[str, ...]:
    return tuple(name.strip() for name in raw.split(",") if name.strip())


def _tokens(raw: str) -> dict[str, str]:
    """Parse ``name:token`` pairs; the name is what appears in a log line."""

    tokens: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, separator, value = entry.partition(":")
        if not separator or not name.strip() or not value.strip():
            raise ProjectConfigError(f"PRALE_TOKENS entry {entry!r} must be 'name:token'")
        tokens[value.strip()] = name.strip()
    return tokens
