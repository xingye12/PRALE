"""Start one deployment from the environment, without a wrapper script.

Every value a running server needs is read once, at startup, from the
environment (see ``deploy/web.env.example``), so the process can be started by
a supervisor, a container entry point or a shell without an intervening script
that might get the composition wrong.  ``--print-config`` shows what those
values resolve to without binding a port; credentials are shown as ``<set>``
rather than echoed, on the assumption that its output will be pasted somewhere.

Three things are deliberately not configurable here:

* **the scope** — ``repository_id`` is an operator value, never a request
  value (ADR-WEB-003), and it is passed straight to ``ProjectRuntimeConfig``,
  which refuses a filesystem path (ADR-018);
* **the extraction prompt** — the memory and skill pipelines need prompt text
  this package does not ship, so a deployment that has none runs with the
  stores read-only.  ``PRALE_MEMORY_PROMPT`` points at a file for a deployment
  that has one; without it, memory shows L0 archives and no promoted entries;
* **the credential** — no default is invented.  A deployment with an unset
  ``PRALE_API_KEY`` is refused at startup rather than failing on the first turn.

Logging goes through one root handler carrying a redacting filter, and uvicorn
is told not to install a logging configuration of its own, so an access line
cannot reach a file without passing the filter.
"""

import argparse
import json
import logging
import os
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.web import DEFAULT_MAX_CONCURRENT_DRIVES, WebApplication, create_app
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.local_tools import create_builtin_tools
from agent_harness.integrations.memory_provider import JsonMemoryExtractor
from agent_harness.runtime.generation import GenerationRequest
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
from agent_harness.storage.skill_sqlite import SQLiteSkillStore

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

BUILTIN_TOOLS = ("read", "write", "edit", "bash")
"""The local tool set, named individually because enabling ``bash`` is a decision."""

_REDACTED = "<redacted>"
_BEARER = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}")
# ``authorization`` is not a key here: the header's shape is ``Bearer <value>``,
# and ``_BEARER`` already owns it.  Redaction errs toward removing too much, so
# a field named ``token`` loses its value even when that value is a count.
_CREDENTIAL = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\b(\s*[:=]\s*)([^\s,;&\"']+)"
)


class RedactingFilter(logging.Filter):
    """Keeps configured secrets out of every record a handler writes.

    Two layers, because they fail differently.  The literal pass removes the
    deployment's own values — the provider key and each service token — however
    they were spelled, which is the only layer that can catch a value that does
    not look like a credential.  The pattern pass catches shapes the literal
    pass was never told about, such as a key that arrives inside a provider
    error message or a URL a tool printed.

    Formatting happens here rather than in a formatter so that the exception
    text a record carries is scrubbed too: a provider error is exactly where a
    credential tends to be quoted back.
    """

    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = tuple(sorted({value for value in secrets if value}, key=len, reverse=True))

    def scrub(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, _REDACTED)
        text = _BEARER.sub(r"\1 " + _REDACTED, text)
        return _CREDENTIAL.sub(r"\1\2" + _REDACTED, text)

    def filter(self, record: logging.LogRecord) -> bool:
        # Setting ``msg`` to the rendered text and clearing ``args`` is the
        # documented way for a filter to rewrite a record: the handler's format
        # string then sees one already-formatted message.
        record.msg = self.scrub(record.getMessage())
        record.args = ()
        if record.exc_info is not None:
            record.exc_text = self.scrub(logging.Formatter().formatException(record.exc_info))
        if record.stack_info is not None:
            record.stack_info = self.scrub(record.stack_info)
        return True


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
    skill_db: Path | None
    api_key: str
    model: str
    base_url: str
    timeout_seconds: float
    tokens: dict[str, str]
    tools: tuple[str, ...]
    traces: bool
    max_concurrent_drives: int
    memory_prompt_file: Path | None
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

        return (self.api_key, *self.tokens)

    def describe(self) -> str:
        """The deployment as text, with credentials reduced to their presence."""

        memory = "off" if self.memory_db is None else str(self.memory_db)
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
                f"skill_db          {skills}",
                f"provider          deepseek {self.model} @ {self.base_url}",
                f"api_key           {'<set>' if self.api_key else '<unset>'}",
                f"tokens            {tokens}",
                f"tools             {tools}",
                f"traces            {'on' if self.traces else 'off'}",
                f"memory_prompt     {prompt}",
                f"max_drives        {self.max_concurrent_drives}",
                f"max_connections   {self.max_connections if self.max_connections else 'unlimited'}",
                f"graceful_shutdown {self.graceful_shutdown_seconds}s",
                f"listen            {self.host}:{self.port}",
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
        tools = _tools(environ.get("PRALE_TOOLS", ""))
        unknown = sorted(set(tools) - set(BUILTIN_TOOLS))
        if unknown:
            raise ProjectConfigError(f"PRALE_TOOLS names unknown tools: {unknown}; known: {list(BUILTIN_TOOLS)}")
        prompt_file = environ.get("PRALE_MEMORY_PROMPT", "").strip()
        memory_db = (
            None if _off(environ, "PRALE_MEMORY") else _path(environ, "PRALE_MEMORY_DB", data_dir / "memory.sqlite")
        )
        skill_db = (
            None if _off(environ, "PRALE_SKILLS") else _path(environ, "PRALE_SKILL_DB", data_dir / "skills.sqlite")
        )
        if skill_db is not None and memory_db is None:
            # Said here rather than left to composition: skill extraction reads
            # L0 archives through the memory store, and the runtime's own error
            # for that mismatch arrives much further from the configuration.
            raise ProjectConfigError("PRALE_SKILLS requires the memory store: extraction reads L0 archives from it")
        return cls(
            project_root=root,
            repository_id=repository_id,
            project_id=environ.get("PRALE_PROJECT_ID", "").strip() or None,
            default_lane=environ.get("PRALE_DEFAULT_LANE", "").strip() or DEFAULT_LANE,
            sessions_dir=_path(environ, "PRALE_SESSIONS_DIR", data_dir / "sessions"),
            catalog_db=_path(environ, "PRALE_CATALOG_DB", data_dir / "catalog.sqlite"),
            memory_db=memory_db,
            skill_db=skill_db,
            api_key=api_key,
            model=model,
            base_url=environ.get("PRALE_BASE_URL", "").strip() or DEFAULT_BASE_URL,
            timeout_seconds=_float(environ, "PRALE_TIMEOUT_SECONDS", 60.0),
            tokens=_tokens(environ.get("PRALE_TOKENS", "")),
            tools=tools,
            traces=not _off(environ, "PRALE_TRACES"),
            max_concurrent_drives=_int(environ, "PRALE_MAX_DRIVES", DEFAULT_MAX_CONCURRENT_DRIVES),
            memory_prompt_file=Path(prompt_file) if prompt_file else None,
            host=environ.get("PRALE_HOST", "").strip() or DEFAULT_HOST,
            port=_int(environ, "PRALE_PORT", DEFAULT_PORT),
            max_connections=_optional_int(environ, "PRALE_MAX_CONNECTIONS"),
            graceful_shutdown_seconds=_positive_float(
                environ, "PRALE_GRACEFUL_SHUTDOWN_SECONDS", DEFAULT_GRACEFUL_SHUTDOWN_SECONDS
            ),
            log_level=environ.get("PRALE_LOG_LEVEL", "").strip() or "info",
        )


@dataclass(slots=True)
class Deployment:
    """The built application and the objects it does not own the closing of.

    ``create_app`` closes the catalog, the sessions and the promotion runtimes,
    but not the two stores it was handed: the deployment opened them, so the
    deployment closes them.
    """

    web: WebApplication
    stores: tuple[SQLiteMemoryStore | SQLiteSkillStore, ...] = field(default_factory=tuple)

    def close(self) -> None:
        for store in self.stores:
            store.close()


def build_extractor(settings: Settings) -> JsonMemoryExtractor | None:
    """The memory extraction stage, if this deployment has a prompt for it.

    The pipeline is LLM-driven and the prompt is a research artifact, not
    configuration: shipping a placeholder here would fill the memory store with
    whatever a generic instruction extracted from a trace.  A deployment that
    wants promotion points ``PRALE_MEMORY_PROMPT`` at its own prompt file and
    gets a JSON-only completer over the same provider the agent uses.
    """

    if settings.memory_prompt_file is None:
        return None
    prompt = settings.memory_prompt_file.read_text(encoding="utf-8")
    provider = DeepSeekProvider(
        api_key=settings.api_key,
        model=settings.model,
        base_url=settings.base_url,
        timeout_seconds=settings.timeout_seconds,
    )

    async def complete(stage: str, payload: dict[str, object]) -> str:
        request_payload = {"stage": stage, **payload}
        result = await provider.generate(_json_request(prompt, request_payload))
        return result.content

    return JsonMemoryExtractor(complete)


def prepare_directories(settings: Settings) -> None:
    """Create the layout this deployment chose, before anything opens it.

    A store whose parent directory is missing does not start an empty store, it
    fails to open at all — so a first run with a fresh ``PRALE_DATA_DIR`` would
    end in a sqlite error rather than a working deployment.  Creating the paths
    is the entry point's job: it is what decided they exist.
    """

    wanted = [settings.sessions_dir, settings.catalog_db.parent]
    wanted.extend(store.parent for store in (settings.memory_db, settings.skill_db) if store is not None)
    for directory in wanted:
        directory.mkdir(parents=True, exist_ok=True)


def build_application(settings: Settings) -> Deployment:
    """Compose the deployment: provider, tools, stores, then the adapter."""

    prepare_directories(settings)
    provider = DeepSeekProvider(
        api_key=settings.api_key,
        model=settings.model,
        base_url=settings.base_url,
        timeout_seconds=settings.timeout_seconds,
    )
    tools = create_builtin_tools(settings.project_root) if settings.tools else ()
    stores: list[SQLiteMemoryStore | SQLiteSkillStore] = []
    memory_store = None
    skill_store = None
    if settings.memory_db is not None:
        memory_store = SQLiteMemoryStore(settings.memory_db)
        stores.append(memory_store)
    if settings.skill_db is not None:
        skill_store = SQLiteSkillStore(settings.skill_db)
        stores.append(skill_store)
    web = create_app(
        settings.config,
        provider,
        tools=tools,
        memory_store=memory_store,
        skill_store=skill_store,
        memory_extractor=build_extractor(settings),
        # A reviewer is a deployment artifact in the same sense as the memory
        # prompt: without one, archives accumulate and no skill is proposed.
        skill_reviewer=None,
        trace_recorder=settings.traces,
        tokens=settings.tokens,
        max_concurrent_drives=settings.max_concurrent_drives,
    )
    return Deployment(web, tuple(stores))


def configure_logging(level: str, secrets: Iterable[str]) -> None:
    """One root handler, carrying the redacting filter, for every logger."""

    handler = logging.StreamHandler()
    handler.addFilter(RedactingFilter(secrets))
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level.upper())


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prale-web", description="Serve one agent-harness project over HTTP.")
    parser.add_argument("--host", help="interface to bind (default: PRALE_HOST or 127.0.0.1)")
    parser.add_argument("--port", type=int, help="port to bind (default: PRALE_PORT or 8787)")
    parser.add_argument("--log-level", help="debug, info, warning or error (default: PRALE_LOG_LEVEL or info)")
    parser.add_argument(
        "--print-config",
        action="store_true",
        help="print the resolved configuration and exit; secrets are reported as <set>, never echoed",
    )
    arguments = parser.parse_args(argv)

    environ = dict(os.environ)
    # Flags are one-off overrides of the same environment, not a second source
    # of truth: folding them in before parsing keeps one code path valid.
    if arguments.host:
        environ["PRALE_HOST"] = arguments.host
    if arguments.port:
        environ["PRALE_PORT"] = str(arguments.port)
    if arguments.log_level:
        environ["PRALE_LOG_LEVEL"] = arguments.log_level
    try:
        settings = Settings.from_environment(environ)
    except ProjectConfigError as error:
        print(f"configuration error: {error}", file=sys.stderr)
        return 2

    configure_logging(settings.log_level, settings.secrets)
    if arguments.print_config:
        print(settings.describe())
        return 0
    logging.getLogger(__name__).info("configuration resolved\n%s", settings.describe())

    import uvicorn  # imported here so that --print-config needs no server installed

    deployment = build_application(settings)
    try:
        # ``log_config=None`` leaves logging to the root handler installed
        # above, so an access line cannot bypass the redacting filter.
        uvicorn.run(
            deployment.web.app,
            host=settings.host,
            port=settings.port,
            log_config=None,
            limit_concurrency=settings.max_connections,
            timeout_graceful_shutdown=settings.graceful_shutdown_seconds,
        )
    finally:
        deployment.close()
    return 0


def _json_request(prompt: str, payload: dict[str, object]) -> GenerationRequest:
    """One completion, off the session record: the prompt, then the payload.

    ``GenerationRequest`` names a session, a lane and an operation because it
    is how a turn is asked for; this one is not a turn, so those fields are
    empty and nothing durable refers to it.
    """

    return GenerationRequest(
        session_id="",
        lane="",
        operation_id="",
        messages=(
            {"role": "system", "content": prompt},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)},
        ),
        tools=(),
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


if __name__ == "__main__":  # pragma: no cover - exercised through main()
    sys.exit(main())
