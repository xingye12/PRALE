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
* **the memory extraction prompt** — memory promotion needs prompt text this
  package does not ship. ``PRALE_MEMORY_PROMPT`` points at a file for a
  deployment that has one; without it, memory shows L0 archives and no
  promoted entries. The coding Skill reviewer ships as a separate constrained
  integration and is enabled whenever the SkillStore is enabled;
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
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.settings import Settings
from agent_harness.api.web import WebApplication, create_app
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.langfuse import LangfuseTelemetry
from agent_harness.integrations.local_tools import create_builtin_tools
from agent_harness.integrations.memory_provider import JsonMemoryExtractor
from agent_harness.integrations.repository_explorer import (
    RepositoryExplorerConfig,
    RepositoryExplorerTool,
    RepositoryIndexError,
    TreeSitterRepositoryIndexer,
)
from agent_harness.integrations.skill_reviewer import CodingSkillReviewer
from agent_harness.runtime.generation import GenerationRequest
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
from agent_harness.storage.skill_sqlite import SQLiteSkillStore

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
    # Built before anything durable opens: this is the one step that can still
    # fail on configuration (the SDK is an optional extra), and failing here
    # leaves no store and no server behind.
    telemetry = None if settings.langfuse is None else LangfuseTelemetry(settings.langfuse)
    explorer = _repository_explorer(settings)
    available_tools = (
        create_builtin_tools(settings.project_root, repository_explorer=explorer) if settings.tools else ()
    )
    tools = tuple(tool for tool in available_tools if tool.name in settings.tools)
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
        skill_reviewer=CodingSkillReviewer(provider) if skill_store is not None else None,
        trace_recorder=settings.traces,
        telemetry=telemetry,
        tokens=settings.tokens,
        max_concurrent_drives=settings.max_concurrent_drives,
    )
    return Deployment(web, tuple(stores))


def _repository_explorer(settings: Settings) -> RepositoryExplorerTool | None:
    if "repository_explore" not in settings.tools:
        return None
    assert settings.repository_index_dir is not None
    try:
        config = RepositoryExplorerConfig(
            settings.project_root,
            settings.repository_index_dir,
            limits=settings.repository_scan_limits,
            max_export_tokens=settings.repository_export_tokens,
            cache_max_entries=settings.repository_cache_entries,
            cache_ttl_ms=settings.repository_cache_ttl_ms,
            max_concurrent_indexes=settings.repository_max_concurrent_indexes,
        )
        return RepositoryExplorerTool(config, TreeSitterRepositoryIndexer(config))
    except (RepositoryIndexError, ValueError) as error:
        raise ProjectConfigError(f"repository_explore is unavailable: {error}") from error


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

    try:
        deployment = build_application(settings)
    except ProjectConfigError as error:
        # Composition can still refuse: an uninstallable optional extra, an
        # index directory that cannot be built.  Both are configuration, and
        # both should read as configuration rather than as a traceback.
        print(f"configuration error: {error}", file=sys.stderr)
        return 2
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


if __name__ == "__main__":  # pragma: no cover - exercised through main()
    sys.exit(main())
