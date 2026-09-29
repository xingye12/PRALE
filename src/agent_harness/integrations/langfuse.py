"""Optional Langfuse tracing: the one module that imports the Langfuse SDK.

The adapter is a :class:`~agent_harness.runtime.telemetry.TelemetrySink`, so
``domain``, ``storage`` and ``runtime`` never learn that Langfuse exists, and a
deployment that does not enable tracing never imports the SDK at all.

Two properties matter more than the shape of a trace:

* **Nothing here can change a turn.**  ``record`` only sanitizes and enqueues;
  one worker task drives the SDK.  A full queue, an unreachable Langfuse or a
  bug in this module costs a trace, never an operation's outcome.
* **What leaves the process is a policy, not an accident.**  Every value is
  passed through :class:`TelemetrySanitizer` under one of three capture
  profiles *before* it is queued, so a profile that forbids prompt text cannot
  leak it through a field somebody forgot to handle.

Cloud and self-hosted Langfuse differ only in ``LANGFUSE_BASE_URL``; the
deployment validates its own configuration at startup
(``LangfuseConfig.from_environment``) so that an enabled-but-unconfigured
deployment fails immediately instead of quietly collecting nothing.
"""

import asyncio
import hashlib
import json
import logging
import re
from collections import deque
from collections.abc import AsyncIterator, Iterable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from typing import Any, Final, Literal

from agent_harness.api.errors import ProjectConfigError
from agent_harness.domain.effects import as_usage, normalize_usage
from agent_harness.domain.entries import JsonValue
from agent_harness.runtime.telemetry import (
    EffectStatus,
    GenerationTelemetry,
    OperationTelemetry,
    TelemetryEvent,
    ToolTelemetry,
)

__all__ = [
    "CAPTURE_PROFILES",
    "DEFAULT_ENVIRONMENT",
    "ENVIRONMENTS",
    "CapturePolicy",
    "LangfuseConfig",
    "LangfuseTelemetry",
    "TelemetrySanitizer",
]

_logger = logging.getLogger(__name__)

CaptureProfile = Literal["metadata", "redacted", "full"]
CAPTURE_PROFILES: Final = ("metadata", "redacted", "full")
"""Least to most permissive; ``metadata`` is what a deployment starts with."""

ENVIRONMENTS: Final = ("development", "staging", "production")
"""An allowlist, because the value tags every trace in the project forever."""

DEFAULT_ENVIRONMENT: Final = "development"
DEFAULT_QUEUE_SIZE: Final = 1_000
DEFAULT_FLUSH_TIMEOUT_SECONDS: Final = 5.0
DEFAULT_MAX_OPEN_OPERATIONS: Final = 256
"""Upper bound on announced-but-unclosed turns kept in memory."""

ROOT_OBSERVATION: Final = "prale.run"
"""The stable name of an operation's trace root; kinds are metadata, not names."""

_MAX_SESSION_ID: Final = 200
"""Langfuse refuses a longer or non-ASCII session id; an id that cannot be sent
verbatim is hashed instead of dropping every trace of that session."""


# --------------------------------------------------------------------------- #
# Sanitizer
# --------------------------------------------------------------------------- #

# Matching is substring-based and therefore over-redacts: a field named
# ``token_count`` loses its value.  That is the intended direction for a gate
# that decides what leaves the process, and it is deliberately *not* the same
# function as ``runtime.lane._redact_trace``, which answers a different
# question (what may be written to the local audit trace).
_SECRET_MARKERS: Final = (
    "authorization",
    "cookie",
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "access_key",
    "private_key",
    "credential",
    "signature",
    "session_key",
)

_REDACTED: Final = "[REDACTED]"
_BEARER: Final = re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}")
# A credential in prose, including one inside JSON embedded in an error
# message: the optional quoted opening is kept so that ``api_key="x"`` becomes
# ``api_key="[REDACTED]"`` rather than losing its quoting.
_CREDENTIAL: Final = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\b"
    r"(\s*[:=]\s*)(\\?[\"']?)([^\s,;&\"'\\]+)"
)
_PEM: Final = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL)
_WINDOWS_PATH: Final = re.compile(r"^[A-Za-z]:[\\/]")
_POSIX_PATH: Final = re.compile(r"^/")


@dataclass(frozen=True, slots=True)
class CapturePolicy:
    """How much of a fact may leave the process, and how much of its bulk."""

    profile: CaptureProfile = "metadata"
    max_string: int = 2_000
    max_items: int = 50
    max_depth: int = 6

    @classmethod
    def for_profile(cls, profile: CaptureProfile) -> "CapturePolicy":
        match profile:
            case "metadata":
                # No payload text is kept at all, so the limits only bound the
                # structure that is uploaded in its place.
                return cls(profile, max_string=0, max_items=20, max_depth=4)
            case "redacted":
                return cls(profile, max_string=2_000, max_items=50, max_depth=6)
            case "full":
                return cls(profile, max_string=20_000, max_items=200, max_depth=8)

    @property
    def uploads_text(self) -> bool:
        return self.profile != "metadata"


class TelemetrySanitizer:
    """Turns durable facts into values that may be uploaded.

    ``payload`` is for anything that may carry user, model or tool text, and
    decides between uploading it (redacted) and describing it (metadata).
    ``describe`` is for values that never carried text.  Neither raises: a fact
    that cannot be sanitized is reported as a marker rather than by failing the
    turn that produced it.
    """

    def __init__(self, policy: CapturePolicy | None = None, *, secrets: Iterable[str] = ()) -> None:
        self._policy = policy or CapturePolicy()
        # The deployment's own credentials are removed literally, whatever shape
        # they have; a provider error that quotes a key back is the usual way
        # one would otherwise reach a trace.
        self._secrets = tuple(sorted({value for value in secrets if value and len(value) >= 8}, key=len, reverse=True))
        self._project_root = ""

    def payload(self, value: JsonValue) -> JsonValue:
        if not self._policy.uploads_text:
            return self.describe(value)
        return self._walk(value, depth=0)

    def describe(self, value: JsonValue) -> JsonValue:
        return self._describe(value, depth=0)

    def event(self, event: TelemetryEvent) -> TelemetryEvent:
        """One settled fact, sanitized field by field for its own kind."""

        if isinstance(event, OperationTelemetry):
            return replace(
                event,
                session_id=_session_key(event.session_id),
                input=self.payload(event.input),
                output=self.payload(event.output),
                error_message=None if event.error_message is None else self._scrub_text(event.error_message),
                metadata={key: self.describe(value) for key, value in event.metadata.items()},
            )
        if isinstance(event, GenerationTelemetry):
            return replace(
                event,
                session_id=_session_key(event.session_id),
                input=self.payload(event.input),
                output=self.payload(event.output),
                error=None if event.error is None else self._scrub_text(event.error),
                metadata={key: self.describe(value) for key, value in event.metadata.items()},
            )
        return replace(
            event,
            session_id=_session_key(event.session_id),
            input=self.payload(event.input),
            output=self.payload(event.output),
        )

    # -- walking ------------------------------------------------------------ #

    def _walk(self, value: object, *, depth: int) -> JsonValue:
        if depth > self._policy.max_depth:
            return "[depth limit]"
        if isinstance(value, str):
            return self._scrub_text(value)
        if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            return value
        if isinstance(value, Mapping):
            return {
                str(key): _REDACTED if _is_secret_key(str(key)) else self._walk(item, depth=depth + 1)
                for key, item in list(value.items())[: self._policy.max_items]
            }
        if isinstance(value, Sequence):
            items = list(value)[: self._policy.max_items]
            if len(value) > self._policy.max_items:
                items.append(f"[{len(value) - self._policy.max_items} more items]")
            return [self._walk(item, depth=depth + 1) for item in items]
        return self._scrub_text(str(value))

    def _describe(self, value: object, *, depth: int) -> JsonValue:
        """The same shape with its text replaced by a length and a digest.

        Numbers survive: they carry the structure an evaluator filters on, such
        as ``is_error`` or a token count, and a value that is a *number* is not
        the text this profile exists to withhold.
        """

        if depth > self._policy.max_depth:
            return "[depth limit]"
        if isinstance(value, str):
            return {"chars": len(value), "sha256": _short_hash(value)}
        if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            return value
        if isinstance(value, Mapping):
            return {
                str(key): _REDACTED if _is_secret_key(str(key)) else self._describe(item, depth=depth + 1)
                for key, item in list(value.items())[: self._policy.max_items]
            }
        if isinstance(value, Sequence):
            return [self._describe(item, depth=depth + 1) for item in list(value)[: self._policy.max_items]]
        return {"chars": 0, "type": type(value).__name__}

    # -- text --------------------------------------------------------------- #

    def _scrub_text(self, text: str) -> str:
        for secret in self._secrets:
            text = text.replace(secret, _REDACTED)
        text = _PEM.sub(_REDACTED, text)
        text = _BEARER.sub(r"\1 " + _REDACTED, text)
        text = _CREDENTIAL.sub(r"\1\2\3" + _REDACTED, text)
        text = self._normalize_paths(text)
        limit = self._policy.max_string
        if 0 < limit < len(text):
            return f"{text[:limit]}…[truncated {len(text) - limit} chars]"
        return text

    def _normalize_paths(self, text: str) -> str:
        """Reduce a path to something that is not a map of this machine.

        Only used for whole strings, because a path inside prose is not
        reliably distinguishable from any other word.
        """

        if not (_POSIX_PATH.match(text) or _WINDOWS_PATH.match(text)):
            return text
        normalized = text.replace("\\", "/")
        if self._project_root and normalized.startswith(f"{self._project_root}/"):
            return normalized[len(self._project_root) + 1 :]
        if self._project_root and normalized == self._project_root:
            return "."
        return f"[abs]/{normalized.rsplit('/', 1)[-1]}"

    def bind_project_root(self, project_root: str) -> None:
        """Relativize paths under the deployment's own checkout."""

        self._project_root = project_root.rstrip("/")


def _is_secret_key(key: str) -> bool:
    lowered = key.lower()
    return any(marker in lowered for marker in _SECRET_MARKERS)


def _short_hash(value: object) -> str:
    if not isinstance(value, str):
        value = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(value.encode("utf-8", "replace")).hexdigest()[:12]


def _session_key(session_id: str) -> str:
    """A session id Langfuse will accept, derived from the durable one."""

    if session_id.isascii() and 0 < len(session_id) <= _MAX_SESSION_ID:
        return session_id
    return f"sha256:{_short_hash(session_id)}"


def _prompt_digest(value: JsonValue) -> JsonValue:
    """A prompt/response rendered as identity instead of text."""

    return {"chars": len(_as_text(value)), "sha256": _short_hash(_as_text(value))}


def _as_text(value: JsonValue) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class LangfuseConfig:
    """Everything one deployment needs to trace, validated at startup."""

    public_key: str
    secret_key: str
    base_url: str
    environment: str = DEFAULT_ENVIRONMENT
    capture: CaptureProfile = "metadata"
    queue_size: int = DEFAULT_QUEUE_SIZE
    flush_timeout_seconds: float = DEFAULT_FLUSH_TIMEOUT_SECONDS
    max_open_operations: int = DEFAULT_MAX_OPEN_OPERATIONS
    release: str | None = None
    project_root: str | None = None
    secrets: tuple[str, ...] = ()

    @property
    def policy(self) -> CapturePolicy:
        return CapturePolicy.for_profile(self.capture)

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str],
        *,
        project_root: str | None = None,
        secrets: Iterable[str] = (),
    ) -> "LangfuseConfig | None":
        """Parse tracing settings, or ``None`` when tracing is switched off.

        A disabled deployment does not read credentials and never fails here:
        the switch is the first thing consulted, so an unconfigured laptop
        behaves exactly as it did before this module existed.
        """

        if not _truthy(environ.get("LANGFUSE_TRACING_ENABLED", "")):
            return None
        public_key = environ.get("LANGFUSE_PUBLIC_KEY", "").strip()
        secret_key = environ.get("LANGFUSE_SECRET_KEY", "").strip()
        if not public_key or not secret_key:
            raise ProjectConfigError(
                "LANGFUSE_TRACING_ENABLED is set, but LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY is missing: "
                "a half-configured deployment would look monitored while tracing nothing"
            )
        environment = environ.get("LANGFUSE_TRACING_ENVIRONMENT", "").strip() or DEFAULT_ENVIRONMENT
        if environment not in ENVIRONMENTS:
            raise ProjectConfigError(f"LANGFUSE_TRACING_ENVIRONMENT must be one of {list(ENVIRONMENTS)}")
        capture = environ.get("PRALE_LANGFUSE_CAPTURE", "").strip() or "metadata"
        if capture not in CAPTURE_PROFILES:
            raise ProjectConfigError(f"PRALE_LANGFUSE_CAPTURE must be one of {list(CAPTURE_PROFILES)}")
        release = environ.get("PRALE_LANGFUSE_RELEASE", "").strip() or None
        return cls(
            public_key=public_key,
            secret_key=secret_key,
            base_url=environ.get("LANGFUSE_BASE_URL", "").strip() or DEFAULT_BASE_URL,
            environment=environment,
            capture=capture,  # type: ignore[arg-type]
            queue_size=_positive_int(environ, "PRALE_LANGFUSE_QUEUE_SIZE", DEFAULT_QUEUE_SIZE),
            flush_timeout_seconds=_positive_float(
                environ, "PRALE_LANGFUSE_FLUSH_TIMEOUT_SECONDS", DEFAULT_FLUSH_TIMEOUT_SECONDS
            ),
            max_open_operations=_positive_int(
                environ, "PRALE_LANGFUSE_MAX_OPEN_OPERATIONS", DEFAULT_MAX_OPEN_OPERATIONS
            ),
            release=release,
            project_root=project_root,
            secrets=tuple(secrets),
        )

    def describe(self) -> str:
        """One line for ``--print-config``; keys are presence, never values."""

        return (
            f"langfuse          on env={self.environment} capture={self.capture} "
            f"host={self.base_url} public_key=<set> secret_key=<set> queue={self.queue_size}"
        )

    def sanitizer(self) -> TelemetrySanitizer:
        sanitizer = TelemetrySanitizer(self.policy, secrets=self.secrets)
        if self.project_root:
            sanitizer.bind_project_root(self.project_root)
        return sanitizer


DEFAULT_BASE_URL: Final = "https://cloud.langfuse.com"


def _truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _positive_int(environ: Mapping[str, str], name: str, default: int) -> int:
    raw = environ.get(name, "").strip()
    if not raw:
        return default
    try:
        parsed = int(raw)
    except ValueError as error:
        raise ProjectConfigError(f"{name} must be an integer") from error
    if parsed < 1:
        raise ProjectConfigError(f"{name} must be at least 1")
    return parsed


def _positive_float(environ: Mapping[str, str], name: str, default: float) -> float:
    raw = environ.get(name, "").strip()
    if not raw:
        return default
    try:
        parsed = float(raw)
    except ValueError as error:
        raise ProjectConfigError(f"{name} must be a number") from error
    if parsed <= 0:
        raise ProjectConfigError(f"{name} must be greater than 0")
    return parsed


# --------------------------------------------------------------------------- #
# The adapter
# --------------------------------------------------------------------------- #

_clients_built = 0
"""How many SDK clients this process has built; see ``LangfuseTelemetry._connect``."""


@dataclass(slots=True)
class _OpenOperation:
    """One announced turn: its root observation and what it is tagged with."""

    observation: Any
    metadata: dict[str, str]


class LangfuseTelemetry:
    """A bounded, best-effort bridge from settled facts to Langfuse traces.

    The runtime calls :meth:`record` on the loop that runs a Drive, so that
    method does two cheap things — sanitize, enqueue — and returns.  Everything
    that touches the SDK, including the export queue the SDK keeps for itself,
    happens in one worker task, and every failure in it is counted and logged
    rather than raised into the caller.
    """

    def __init__(self, config: LangfuseConfig, *, client: Any | None = None) -> None:
        self._config = config
        self._sanitizer = config.sanitizer()
        # A plain deque rather than an ``asyncio.Queue``: this queue has to
        # outlive the loop it was filled on.  Facts arrive on whichever loop is
        # running a turn, and an embedding application may drive several loops
        # in one process — the Langfuse experiment runner drives one per
        # experiment — while an ``asyncio.Queue`` binds itself to the first loop
        # that waits on it and then refuses every other.
        self._pending: deque[TelemetryEvent] = deque()
        self._max_pending = max(1, config.queue_size)
        self._open: dict[tuple[str, str], _OpenOperation] = {}
        self._worker: asyncio.Task[None] | None = None
        self._owns_client = client is None
        self._client: Any = client if client is not None else self._connect()
        self._closed = False
        self._dropped = 0
        self._failed = 0

    # -- configuration ------------------------------------------------------ #

    @classmethod
    def from_environment(cls, environ: Mapping[str, str], **kwargs: Any) -> "LangfuseTelemetry | None":
        config = LangfuseConfig.from_environment(environ, **kwargs)
        return None if config is None else cls(config)

    @property
    def dropped(self) -> int:
        """Facts this adapter threw away: the queue was full or it was closed."""

        return self._dropped

    @property
    def failed(self) -> int:
        """Facts that reached the worker and could not be turned into traces."""

        return self._failed

    def _connect(self) -> Any:
        """Build the SDK client.  The import lives here and nowhere else."""

        global _clients_built
        try:
            from langfuse import Langfuse
        except ImportError as error:
            raise ProjectConfigError(
                "tracing is enabled but the Langfuse SDK is not installed: install prale-agent-harness[langfuse]"
            ) from error
        if _clients_built:
            # OpenTelemetry allows one global tracer provider per process, so a
            # second client sends its spans through the *first* one's exporter.
            # A deployment builds one; an embedding application that builds two
            # should hear about it here rather than wonder why half its traces
            # are missing.
            _logger.warning(
                "a Langfuse client already exists in this process: OpenTelemetry installs one global tracer "
                "provider, so this deployment's traces are exported through the first client's configuration"
            )
        _clients_built += 1
        return Langfuse(
            public_key=self._config.public_key,
            secret_key=self._config.secret_key,
            base_url=self._config.base_url,
            environment=self._config.environment,
            release=self._config.release,
        )

    # -- the sink ----------------------------------------------------------- #

    def record(self, event: TelemetryEvent) -> None:
        """Sanitize one settled fact and hand it to the worker.

        Synchronous by contract: the Drive calls this after a commit, and must
        not wait for an exporter, a socket or a lock held by an observation.
        """

        if self._closed:
            self._dropped += 1
            return
        safe = self._sanitizer.event(event)
        if len(self._pending) >= self._max_pending:
            self._overflow(safe)
        else:
            self._pending.append(safe)
        # Queued first, then handed over: a worker started before the fact was
        # there would exit again without it.
        self._ensure_worker()

    def _overflow(self, event: TelemetryEvent) -> None:
        """A full queue is a slow or unreachable Langfuse.

        The newest fact wins when it closes a turn: an operation's terminal
        event is what makes its trace scoreable, and losing it while keeping
        the generations under it would leave a trace nobody can evaluate.
        """

        self._dropped += 1
        if not (isinstance(event, OperationTelemetry) and event.phase == "terminal"):
            _logger.warning("langfuse telemetry queue is full; dropped a %s", type(event).__name__)
            return
        if self._pending:
            self._pending.popleft()
            self._pending.append(event)
            return
        _logger.warning("langfuse telemetry queue is full; dropped an operation's terminal event")

    async def drain(self) -> None:
        """Wait until every fact given to this adapter has become an observation.

        Facts are published on the loop that runs a Drive and mapped on a task
        belonging to whatever loop is running the harness now, so an embedding
        application that drives one loop and closes it — the Langfuse
        experiment runner does exactly that — calls this before the loop goes
        away, while its worker can still be scheduled.
        """

        while True:
            self._ensure_worker()
            worker = self._worker
            if worker is None or worker.done():
                return
            # Shielded: the worker belongs to this adapter, not to whoever is
            # waiting for it, so a cancelled drain must not strand it half way.
            await asyncio.shield(worker)

    def _ensure_worker(self) -> None:
        """Give the loop that is running now a worker, unless it already has one.

        A task belongs to the loop that created it: when that loop is closed
        the task can never be scheduled again, and a fact published later would
        sit unmapped until the next turn.  Starting one per loop is what lets
        the same adapter serve a deployment's long-lived loop and the
        experiment runner's loop-per-run alike.
        """

        if self._closed or not self._pending:
            return
        if self._worker is not None and not self._worker.done() and not self._worker.get_loop().is_closed():
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No loop yet: the facts wait in ``_pending`` for the next loop, or
            # for the close, whichever comes first.
            return
        self._worker = loop.create_task(self._drain(), name="langfuse-telemetry")

    async def _drain(self) -> None:
        """Map every fact waiting now, then leave.

        Nothing here waits, so a worker cannot be left suspended on a queue:
        it runs to the end of what it found and the next fact starts another.
        """

        while self._pending:
            event = self._pending.popleft()
            try:
                self._handle(event)
            except Exception:
                self._failed += 1
                _logger.warning("langfuse rejected a %s", type(event).__name__, exc_info=True)
        self._worker = None

    # -- mapping ------------------------------------------------------------ #

    def _handle(self, event: TelemetryEvent) -> None:
        if isinstance(event, OperationTelemetry):
            self._handle_operation(event)
        elif isinstance(event, GenerationTelemetry):
            self._handle_generation(event)
        else:
            self._handle_tool(event)

    def _handle_operation(self, event: OperationTelemetry) -> None:
        key = (event.session_id, event.operation_id)
        if event.phase == "started":
            if key in self._open:
                # A resumed Drive re-announces the operation it picked up: it is
                # the same turn and the same trace, and a second root would leave
                # the first one open for the life of the process.
                return
            self._open_root(event, key)
            return
        opened = self._open.pop(key, None)
        if opened is None:
            # The announcement was lost (a full queue, or a process that died
            # with it): publish the turn as one closed observation rather than
            # dropping what did settle.
            opened = self._open_root(replace(event, phase="started"), key)
            self._open.pop(key, None)
        # The root observation's own input and output *are* the trace's in
        # Langfuse v4, which is why ``set_trace_io`` is deprecated: an evaluator
        # that scores a run reads these two values, and the durable
        # ``operation_id`` that ties it back to a Session is in the metadata.
        opened.observation.update(
            output=event.output,
            metadata={**opened.metadata, "status": event.status or "unknown", **self._error_metadata(event)},
            level=_level_for(event.status),
            status_message=event.error_message or event.error_code,
        )
        opened.observation.end(end_time=_ms_to_ns(event.ended_at))

    def _handle_generation(self, event: GenerationTelemetry) -> None:
        root = self._root_for(event.session_id, event.lane, event.operation_id)
        usage = normalize_usage(event.usage)
        observation = self._start_child(
            root,
            name="prale.generate",
            as_type="generation",
            session_id=event.session_id,
            started_at=event.started_at,
            input=event.input,
            output=event.output,
            model=event.model,
            usage_details=_usage_details(*usage),
            metadata={
                "attempt": event.attempt,
                "finish_reason": event.finish_reason,
                "usage": as_usage(event.usage),
                **self._error_metadata(event),
            },
            level=_level_for(event.outcome),
            status_message=event.error or event.error_class,
        )
        observation.end(end_time=_ms_to_ns(event.ended_at))

    def _handle_tool(self, event: ToolTelemetry) -> None:
        root = self._root_for(event.session_id, event.lane, event.operation_id)
        observation = self._start_child(
            root,
            name=f"prale.tool.{event.name}" if event.name else "prale.tool",
            as_type="tool",
            session_id=event.session_id,
            started_at=event.started_at,
            input=event.input,
            output=event.output,
            metadata={
                "tool_call_id": event.tool_call_id,
                "attempt": event.attempt,
                "is_error": event.is_error,
                **self._error_metadata(event),
            },
            level=_level_for(event.outcome),
            status_message=event.error_class,
        )
        observation.end(end_time=_ms_to_ns(event.ended_at))

    @staticmethod
    def _error_metadata(event: TelemetryEvent) -> dict[str, JsonValue]:
        error_class = getattr(event, "error_class", None)
        return {"error_class": error_class} if error_class else {}

    # -- observations ------------------------------------------------------- #

    def _open_root(self, event: OperationTelemetry, key: tuple[str, str]) -> _OpenOperation:
        if len(self._open) >= self._config.max_open_operations:
            self._evict_oldest()
        metadata = {
            "operation_id": event.operation_id,
            "lane": event.lane,
            "kind": event.kind,
            "capture": self._config.capture,
        }
        with _propagate(
            session_id=event.session_id,
            tags=["prale", event.kind],
            metadata={"operation_id": event.operation_id, "lane": event.lane},
        ):
            observation = self._client.start_observation(
                name=ROOT_OBSERVATION,
                as_type="agent",
                input=event.input,
                metadata=metadata,
                version=self._config.release,
            )
        opened = _OpenOperation(observation=observation, metadata=metadata)
        self._open[key] = opened
        if event.started_at:
            _set_span_start(observation, event.started_at)
        return opened

    def _root_for(self, session_id: str, lane: str, operation_id: str) -> _OpenOperation:
        key = (session_id, operation_id)
        opened = self._open.get(key)
        if opened is None:
            # A child without its announcement: recover the turn as a root that
            # is closed as soon as it is the only thing left to close.
            opened = self._open_root(
                OperationTelemetry(
                    session_id=session_id,
                    lane=lane,
                    operation_id=operation_id,
                    kind="unknown",
                    phase="started",
                ),
                key,
            )
        return opened

    def _start_child(self, root: _OpenOperation, **attributes: Any) -> Any:
        started_at = attributes.pop("started_at", None)
        session_id = attributes.pop("session_id", None)
        with _propagate(session_id=session_id):
            observation = root.observation.start_observation(**attributes)
        if started_at:
            _set_span_start(observation, started_at)
        return observation

    def _evict_oldest(self) -> None:
        """Bound the turns kept in memory when a terminal fact never arrives."""

        key = next(iter(self._open))
        opened = self._open.pop(key)
        self._dropped += 1
        try:
            opened.observation.end()
        except Exception:  # an already-ended observation is not a reason to fail
            _logger.debug("langfuse could not close an abandoned operation", exc_info=True)

    # -- lifecycle ---------------------------------------------------------- #

    async def aclose(self) -> None:
        """Drain what settled, close every open turn, then flush the SDK."""

        if self._closed:
            return
        timeout = self._config.flush_timeout_seconds
        # Drained before the adapter says it is closed: a fact left behind by a
        # loop that ended can still be mapped by a worker on the loop that is
        # closing it, and a close must not throw away a trace it could upload.
        try:
            await asyncio.wait_for(self.drain(), timeout)
        except TimeoutError:
            queued = len(self._pending)
            self._dropped += queued
            _logger.warning("langfuse telemetry did not drain within %ss; dropping %d facts", timeout, queued)
        self._closed = True
        if self._pending:
            # Nothing can map these now, and a number nobody counts is a memory
            # leak in an observer that is supposed to be cheap.
            self._dropped += len(self._pending)
            self._pending.clear()
        for opened in list(self._open.values()):
            try:
                opened.observation.end()
            except Exception:
                _logger.debug("langfuse could not close an open operation", exc_info=True)
        self._open.clear()
        await asyncio.to_thread(self._flush)

    def _flush(self) -> None:
        """Blocking by nature; the caller runs it off the loop."""

        try:
            self._client.flush()
        except Exception:
            _logger.warning("langfuse flush failed", exc_info=True)
        if self._owns_client:
            try:
                self._client.shutdown()
            except Exception:
                _logger.warning("langfuse shutdown failed", exc_info=True)


# --------------------------------------------------------------------------- #
# SDK boundary
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def _no_attributes() -> AsyncIterator[None]:
    yield


def _propagate(**attributes: Any) -> Any:
    """Attach trace-level attributes to every observation made inside.

    The import is here rather than at module scope so that importing this
    module — which ``api/serve.py`` does to read its configuration — does not
    import the SDK of a deployment that never enables tracing.
    """

    if not attributes.get("session_id"):
        return _no_attributes()
    from langfuse import propagate_attributes

    return propagate_attributes(**attributes)


def _set_span_start(observation: Any, started_at_ms: int) -> None:
    """Move an observation's start back to when the effect really began.

    The runtime publishes a fact only once it is settled, so the SDK would
    otherwise time every observation from the moment its worker got to it — and
    a latency dashboard built on that measures this module, not the model.  The
    durable start and end are always also in ``metadata``, so a Langfuse version
    that no longer accepts this leaves the numbers available rather than wrong.
    """

    span = getattr(observation, "_otel_span", None)
    if span is None or getattr(span, "start_time", None) is None:
        return
    start_ns = _ms_to_ns(started_at_ms)
    if start_ns >= span.start_time:
        # Never move a start forward: a worker that began after the effect
        # settled would otherwise report a negative duration.
        return
    try:
        span._start_time = start_ns  # noqa: SLF001 - no supported setter exists
    except Exception:
        _logger.debug("langfuse would not accept an explicit start time", exc_info=True)


def _ms_to_ns(milliseconds: int | None) -> int | None:
    return None if milliseconds is None else milliseconds * 1_000_000


def _usage_details(input_tokens: int | None, output_tokens: int | None, total_tokens: int | None) -> dict[str, int]:
    """Langfuse's own names for the three counts a provider reports.

    A count the provider did not report is left out rather than sent as zero:
    Langfuse aggregates what it is given, and an invented zero is a wrong
    number, not a missing one.
    """

    details: dict[str, int] = {}
    if input_tokens is not None:
        details["input"] = input_tokens
    if output_tokens is not None:
        details["output"] = output_tokens
    if total_tokens is not None:
        details["total"] = total_tokens
    return details


def _level_for(status: str | EffectStatus | None) -> str:
    match status:
        case "completed":
            return "DEFAULT"
        case "aborted" | "declined":
            return "WARNING"
        case _:
            return "ERROR"
