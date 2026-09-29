"""HTTP/SSE adapter over the read facades and the harness runtime.

This is the only module in the package that knows a web framework, and that
framework is an optional dependency: nothing in ``domain/``, ``runtime/`` or the
read facades imports it, so a deployment that does not install the ``web``
extra never loads it.

Two rules shape every handler:

* the browser names a session and a lane, never a path, a scope or a database.
  Locations come from the catalog's allow-list and scopes from server
  configuration (ADR-WEB-001, ADR-WEB-003), so neither ``repository_id`` nor a
  session's directory can be chosen by a request;
* a disconnected browser cancels the wait, not the work.  A submitted turn is
  admitted durably and then driven by a task this module owns, so closing a tab
  cannot abort an operation; only an explicit abort request reaches
  ``Lane.request_abort``.

Values are serialized strictly: a dataclass, sequence, mapping, scalar or byte
string is represented (bytes as base64), and anything else is an error rather
than a stringified surprise in the UI.
"""

import asyncio
import base64
import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict, fields, is_dataclass
from pathlib import Path
from typing import Any

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Receive, Scope, Send

from agent_harness.api.catalog import SessionCatalog, SessionSummary
from agent_harness.api.errors import HarnessError, InvalidCursor, LaneBusy, SessionNotFound
from agent_harness.api.harness import Harness
from agent_harness.api.memory import MemoryQueryService
from agent_harness.api.models import AbortResult, LaneSnapshot, OperationAdmission, OperationResult
from agent_harness.api.pagination import Page
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.service import AuthenticationError, RemoteSubscription, StaticTokenAuthenticator
from agent_harness.api.settings import DEFAULT_MAX_CONCURRENT_DRIVES
from agent_harness.api.skill import SkillQueryService
from agent_harness.api.trace import TraceQueryService
from agent_harness.domain.memory import MemoryScope
from agent_harness.domain.skill import SkillScope
from agent_harness.memory.protocol import MemoryStore
from agent_harness.memory.runtime import MemoryExtractor, MemoryRuntime
from agent_harness.runtime.events import HarnessEvent
from agent_harness.runtime.generation import ChatProvider
from agent_harness.runtime.lane import ActiveOperation, Lane
from agent_harness.runtime.telemetry import TelemetrySink, close_telemetry
from agent_harness.runtime.tools import AgentTool
from agent_harness.skill.protocol import SkillReviewer, SkillStore
from agent_harness.skill.runtime import SkillEvolutionRuntime
from agent_harness.storage.catalog import SQLiteCatalogStore
from agent_harness.storage.sqlite import SQLiteStorage

STATIC_DIR = Path(__file__).resolve().parent.parent / "web"
"""The front end's static assets, shipped inside the package (ADR-WEB-005)."""

HEARTBEAT_SECONDS = 15.0
"""Idle interval after which the event stream emits a comment line.

A connection that only speaks when the agent does is indistinguishable from a
dropped one, both to proxies and to the browser's reconnect logic.
"""


class ServiceUnavailable(RuntimeError):
    """A view was requested that this deployment has no store for."""


class Conflict(RuntimeError):
    """The request contradicts the lane's durable state."""


_ABSENT = object()


def _jsonable(value: object) -> object:
    """Represent durable values as JSON without inventing missing ones.

    ``bytes`` become base64 because JSON has no byte string.  An unmodelled
    type is an error, not a ``str()`` of the object: a payload this adapter
    cannot describe honestly should fail loudly, not reach the UI as a field
    that renders as ``<object at 0x...>``.

    A class that computes a ``duration_ms`` property gets it serialized even
    though it is not a field: ``EffectSpan.duration_ms`` is a domain rule about
    when a duration can be proven at all, and shipping it as data is what keeps
    a client from reconstructing one by subtracting timestamps.
    """

    if is_dataclass(value) and not isinstance(value, type):
        payload = {field.name: _jsonable(getattr(value, field.name)) for field in fields(value)}
        computed = getattr(value, "duration_ms", _ABSENT)
        if computed is not _ABSENT and "duration_ms" not in payload:
            payload["duration_ms"] = _jsonable(computed)
        return payload
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    raise TypeError(f"cannot serialize {type(value).__name__} for the web client")


def _page(page: Page[Any]) -> object:
    return {"items": _jsonable(page.items), "next_cursor": page.next_cursor}


def _cursor(request: Request) -> str | None:
    return request.query_params.get("cursor")


def _limit(request: Request, default: int = 50) -> int:
    raw = request.query_params.get("limit")
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ValueError("limit must be an integer") from error


def _sse(event: str, data: object, event_id: int) -> str:
    payload = json.dumps(_jsonable(data), separators=(",", ":"), ensure_ascii=False)
    return f"id: {event_id}\nevent: {event}\ndata: {payload}\n\n"


class BearerAuthMiddleware:
    """Reject requests that do not carry a configured service token.

    This is not multi-user authorization (ADR-WEB-003): a deployment that
    configures no tokens is a local single-user deployment, and the check exists
    so that a stray process on the same machine cannot drive an agent.  It runs
    as middleware so that a route added later cannot forget it.

    The one exception is the page the browser fetches to run the UI at all
    (:func:`_is_page_request`); everything that carries data stays guarded.
    """

    def __init__(self, app: ASGIApp, tokens: dict[str, str]) -> None:
        self._app = app
        self._authenticator = StaticTokenAuthenticator(dict(tokens))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _is_page_request(scope):
            await self._app(scope, receive, send)
            return
        header = ""
        for name, value in scope["headers"]:
            if name == b"authorization":
                header = value.decode("latin-1")
                break
        scheme, _, credential = header.partition(" ")
        try:
            await self._authenticator.authenticate(credential if scheme.lower() == "bearer" else None)
        except AuthenticationError as error:
            response = JSONResponse({"error": str(error)}, status_code=401)
            await response(scope, receive, send)
            return
        await self._app(scope, receive, send)


def _is_page_request(scope: Scope) -> bool:
    """Whether this request is one the browser makes by itself.

    Loading the shell and its modules is a navigation, not a fetch: the browser
    sends no ``Authorization`` header and cannot be told to, so guarding them
    would make the UI unreachable in exactly the deployments that need a
    credential.  They carry no data — every value the page shows is read from
    ``/api/...``, which stays guarded — and the token itself lives in the
    browser's sessionStorage, never in the served files.
    """

    if scope.get("method") not in ("GET", "HEAD"):
        return False
    path = scope.get("path", "")
    return path == "/" or path.startswith("/static/")


class _OpenSession:
    """One opened session: its harness, and the database connection behind it."""

    def __init__(self, harness: Harness, storage: SQLiteStorage) -> None:
        self.harness = harness
        self.storage = storage


class SessionSupervisor:
    """Opens one harness per session, and owns the drives it starts.

    The supervisor is the composition root for the runtime half of the web
    application: it derives the memory and skill scopes from server
    configuration, builds the promotion runtimes once per deployment (they
    consume jobs across sessions), and keeps one background task per lane so
    that an admitted turn keeps running after the request that submitted it is
    gone.

    Sessions stay open for the process's lifetime: the deployment serves one
    project whose sessions cost one SQLite connection each, and evicting one
    would drop the mapping from a live SSE subscription to its lane.  Every
    connection and shared runtime is released by ``aclose``.
    """

    def __init__(
        self,
        catalog: SessionCatalog,
        config: ProjectRuntimeConfig,
        provider: ChatProvider,
        *,
        tools: tuple[AgentTool, ...] = (),
        memory_store: MemoryStore | None = None,
        skill_store: SkillStore | None = None,
        memory_extractor: MemoryExtractor | None = None,
        skill_reviewer: SkillReviewer | None = None,
        trace_recorder: bool = False,
        max_concurrent_drives: int = DEFAULT_MAX_CONCURRENT_DRIVES,
        telemetry: TelemetrySink | None = None,
    ) -> None:
        if skill_store is not None and memory_store is None:
            raise ValueError("skill_store requires memory_store for L0 archive materialization")
        if max_concurrent_drives < 1:
            raise ValueError("max_concurrent_drives must be at least 1")
        self._catalog = catalog
        self._provider = provider
        self._tools = tools
        self._trace_recorder = trace_recorder
        self._max_drives = max_concurrent_drives
        self._telemetry = telemetry
        self._sessions: dict[str, _OpenSession] = {}
        self._open_lock = asyncio.Lock()
        self._drives: dict[tuple[str, str], asyncio.Task[None]] = {}
        self._failures: dict[tuple[str, str], str] = {}
        self._closed = False
        scope = MemoryScope(config.repository_id) if memory_store is not None else None
        self._memory_scope = scope
        self._skill_scope = SkillScope.from_memory_scope(scope) if scope is not None else None
        self._memory_runtime = MemoryRuntime(memory_store, memory_extractor) if memory_store is not None else None
        self._skill_runtime = SkillEvolutionRuntime(skill_store, skill_reviewer) if skill_store is not None else None

    @property
    def failures(self) -> dict[tuple[str, str], str]:
        """Drives that ended in an unexpected error, keyed by (session, lane)."""

        return dict(self._failures)

    @property
    def active_drives(self) -> int:
        """How many lanes this process is driving right now.

        Counted from the tasks themselves rather than from a counter: a drive
        that finished but whose callback has not run yet is not active, and a
        load figure that lags reality would let the cap be exceeded.
        """

        return sum(1 for task in self._drives.values() if not task.done())

    @property
    def max_concurrent_drives(self) -> int:
        return self._max_drives

    @property
    def open_sessions(self) -> int:
        """Sessions with an open database connection in this process."""

        return len(self._sessions)

    @property
    def closed(self) -> bool:
        """Whether shutdown has begun; a probe reads this to drain first."""

        return self._closed

    def drive_task(self, session_id: str, lane: str) -> asyncio.Task[None] | None:
        """The background drive for a lane, if one is running in this process.

        A driver running here is what distinguishes "this operation is being
        worked on" from "this operation was abandoned by a process that is gone";
        the durable record alone cannot tell them apart.
        """

        return self._drives.get((session_id, lane))

    async def start(self) -> None:
        """Start the promotion workers; safe to call more than once."""

        if self._memory_runtime is not None:
            await self._memory_runtime.start()
        if self._skill_runtime is not None:
            await self._skill_runtime.start()

    async def aclose(self) -> None:
        """Stop every drive, seal open sessions, then close the shared runtimes.

        ``Harness.close`` is deliberately not used: it closes the memory and
        skill runtimes, which this supervisor shares across sessions, so using
        it would leave every session after the first one without promotion.  The
        two things a session owns are its database connection and the skill
        evidence it has buffered, and both are released explicitly here.
        """

        if self._closed:
            return
        self._closed = True
        for task in list(self._drives.values()):
            task.cancel()
        for task in list(self._drives.values()):
            try:
                await task
            except BaseException:  # shutdown must not be held back by one drive
                pass
        self._drives.clear()
        for session_id, opened in self._sessions.items():
            if self._skill_runtime is not None and self._skill_scope is not None:
                await self._skill_runtime.archive_session_closed(self._skill_scope, session_id)
            opened.storage.close()
        self._sessions.clear()
        if self._memory_runtime is not None:
            await self._memory_runtime.aclose()
        if self._skill_runtime is not None:
            await self._skill_runtime.aclose()

    async def create_session(self, session_id: str | None = None, lane: str | None = None) -> SessionSummary:
        """Register a session and create its database: the one way one is born.

        Registration alone would leave a catalog row without a database, and no
        query may quietly create one (a session whose file is gone is an error,
        not an empty history), so the create path is where the file is made.
        Re-creating an existing session is a no-op for its contents: the
        catalog keeps the original row, and the database is opened, not reset.
        """

        summary = await self._catalog.register(session_id or uuid.uuid4().hex, lane=lane)
        path = await self._catalog.resolve(summary.session_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        SQLiteStorage(path).close()
        return summary

    async def harness(self, session_id: str) -> Harness:
        async with self._open_lock:
            opened = self._sessions.get(session_id)
            if opened is None:
                opened = await self._open(session_id)
                self._sessions[session_id] = opened
            return opened.harness

    async def lane(self, session_id: str, name: str) -> Lane:
        return await (await self.harness(session_id)).acquire_lane(name)

    async def watch(self, session_id: str, lane: str) -> tuple[LaneSnapshot, RemoteSubscription]:
        """Subscribe to a lane, snapshot first, with disposal that never aborts.

        Watching a lane that does not exist yet creates it, exactly as
        submitting a turn would: lane creation is durable and idempotent, so a
        client may open the event stream before it submits anything.
        """

        selected = await self.lane(session_id, lane)
        published: list[RemoteSubscription] = []

        def listener(event: HarnessEvent) -> None:
            for subscription in published:
                subscription.publish(event)

        snapshot, unsubscribe = await selected.watch(listener)
        subscription = RemoteSubscription(unsubscribe)
        published.append(subscription)
        return snapshot, subscription

    async def submit_turn(
        self, session_id: str, lane: str, prompt: str, operation_id: str | None = None
    ) -> OperationAdmission:
        """Admit a turn durably, then drive it in the background."""

        if self._closed:
            raise ServiceUnavailable("the server is shutting down")
        selected = await self.lane(session_id, lane)
        self._refuse_if_saturated(session_id, lane, await selected.active_operation())
        admission = await selected.prompt(prompt, operation_id)
        await self._catalog.touch(session_id)
        self._start_drive(session_id, lane, selected)
        return admission

    def _refuse_if_saturated(self, session_id: str, lane: str, active: ActiveOperation | None) -> None:
        """Refuse a turn this deployment has no capacity left to drive.

        The refusal has to happen before ``Lane.prompt``.  Admitting durably and
        then declining to drive would leave an operation the running process
        never finishes, which is precisely the state ``recover`` exists to clean
        up: shedding load must not manufacture one.

        Two situations are not saturation.  A lane that already holds an
        operation gets ``LaneBusy`` from ``prompt``, which says more; a lane
        whose previous drive is still winding down adds no concurrency, because
        the new drive chains onto the one already counted.

        The limit is load shedding, not a reservation: two turns submitted in
        the same event-loop turn can both pass the check before either starts,
        so the cap can be exceeded by the requests already in flight.
        """

        if active is not None:
            return
        running = self._drives.get((session_id, lane))
        if running is not None and not running.done():
            return
        if self.active_drives >= self._max_drives:
            raise ServiceUnavailable(
                f"this deployment is already driving {self._max_drives} turns; retry once one settles"
            )

    async def abort(self, session_id: str, lane: str) -> AbortResult:
        """Request cancellation of the lane's current operation, explicitly."""

        selected = await self.lane(session_id, lane)
        if await selected.active_operation() is None:
            raise Conflict(f"lane {lane!r} has no active operation to abort")
        try:
            return await selected.request_abort()
        except RuntimeError as error:
            # The operation settled between the check and the request; nothing
            # is left to cancel, and that is a conflict, not a server fault.
            raise Conflict(str(error)) from error

    async def recover(self, session_id: str, lane: str) -> OperationResult | None:
        """Take over whatever a previous process left unfinished, if anything.

        Recovery replaces the durable drive lease, so it is refused while this
        process is actively driving the lane: that operation is not abandoned,
        and replacing its lease would run a second driver for the same turn.  A
        lane with no active operation recovers to ``None``.
        """

        running = self._drives.get((session_id, lane))
        if running is not None and not running.done():
            raise Conflict(
                f"lane {lane!r} is being driven by this process; recover is for operations no live process owns"
            )
        selected = await self.lane(session_id, lane)
        return await selected.recover(self._provider)

    async def _open(self, session_id: str) -> _OpenSession:
        path = await self._catalog.resolve(session_id)
        if not path.is_file():
            # Same rule as the read facades: a registered session whose database
            # is missing is an error, never a fresh empty session — only
            # ``create_session`` may make one.
            raise SessionNotFound(f"session {session_id!r} has no database at its registered location")
        storage = SQLiteStorage(path)
        harness = await Harness.open(
            session_id,
            storage,
            self._tools,
            memory_scope=self._memory_scope,
            memory_runtime=self._memory_runtime,
            skill_scope=self._skill_scope,
            skill_runtime=self._skill_runtime,
            trace_recorder=self._trace_recorder,
            telemetry=self._telemetry,
        )
        return _OpenSession(harness, storage)

    def _start_drive(self, session_id: str, lane: str, selected: Lane) -> None:
        key = (session_id, lane)
        previous = self._drives.get(key)
        if previous is not None and previous.done():
            previous = None
        task = asyncio.create_task(self._drive(selected, previous), name=f"drive:{session_id}:{lane}")
        self._drives[key] = task
        task.add_done_callback(lambda finished: self._finish_drive(key, finished))

    def _finish_drive(self, key: tuple[str, str], finished: asyncio.Task[None]) -> None:
        if self._drives.get(key) is finished:
            self._drives.pop(key, None)
        if finished.cancelled():
            return
        error = finished.exception()
        if error is not None:
            # The operation itself settles as failed in the session; this only
            # records that the driver died, for the deployment's own health view.
            self._failures[key] = f"{type(error).__name__}: {error}"

    async def _drive(self, selected: Lane, previous: asyncio.Task[None] | None) -> None:
        if previous is not None:
            # A turn admitted while the previous drive is still winding down must
            # not be left undriven.  ``wait`` observes it without re-raising its
            # outcome, and without swallowing our own cancellation into a drive
            # that is still running.
            await asyncio.wait({previous})
        await selected.drive(self._provider)


class WebApplication:
    """Composition root: builds the app, and owns everything it opens."""

    def __init__(
        self,
        config: ProjectRuntimeConfig,
        provider: ChatProvider,
        *,
        tools: tuple[AgentTool, ...] = (),
        memory_store: MemoryStore | None = None,
        skill_store: SkillStore | None = None,
        memory_extractor: MemoryExtractor | None = None,
        skill_reviewer: SkillReviewer | None = None,
        trace_recorder: bool = False,
        tokens: dict[str, str] | None = None,
        max_concurrent_drives: int = DEFAULT_MAX_CONCURRENT_DRIVES,
        telemetry: TelemetrySink | None = None,
    ) -> None:
        self._config = config
        # The deployment's optional observer.  It is closed last, after the
        # drives it reports on have stopped settling.
        self._telemetry = telemetry
        # Which stores exist, never where they are: a health answer is served to
        # whoever is probing, and a database path is deployment layout.
        self._stores = {
            "catalog": True,
            "memory": memory_store is not None,
            "skills": skill_store is not None,
            "traces": trace_recorder,
        }
        self._catalog_store = SQLiteCatalogStore(config.catalog_db)
        self.catalog = SessionCatalog(self._catalog_store, config)
        self.trace = TraceQueryService(self.catalog)
        memory_scope = MemoryScope(config.repository_id)
        self.memory = MemoryQueryService(memory_store, memory_scope) if memory_store is not None else None
        self.skill = (
            SkillQueryService(skill_store, SkillScope.from_memory_scope(memory_scope))
            if skill_store is not None
            else None
        )
        self.supervisor = SessionSupervisor(
            self.catalog,
            config,
            provider,
            tools=tools,
            memory_store=memory_store,
            skill_store=skill_store,
            memory_extractor=memory_extractor,
            skill_reviewer=skill_reviewer,
            trace_recorder=trace_recorder,
            max_concurrent_drives=max_concurrent_drives,
            telemetry=telemetry,
        )
        self.app = self._build_app(tokens or {})

    async def start(self) -> None:
        await self.supervisor.start()

    async def aclose(self) -> None:
        await self.supervisor.aclose()
        if self._telemetry is not None:
            # Draining here, on the loop, is what makes a short-lived deployment
            # deliver its last turns: after ``uvicorn.run`` returns there is no
            # loop left to flush on.
            await close_telemetry(self._telemetry)
        self._catalog_store.close()

    @asynccontextmanager
    async def lifespan(self, app: Starlette) -> AsyncIterator[None]:
        """Start and stop with the server, so a plain uvicorn deploy is enough."""

        await self.start()
        try:
            yield
        finally:
            await self.aclose()

    def _memory_service(self) -> MemoryQueryService:
        if self.memory is None:
            raise ServiceUnavailable("this deployment has no memory store configured")
        return self.memory

    def _skill_service(self) -> SkillQueryService:
        if self.skill is None:
            raise ServiceUnavailable("this deployment has no skill store configured")
        return self.skill

    def _build_app(self, tokens: dict[str, str]) -> Starlette:
        prefix = "/api"
        routes = [
            Route(f"{prefix}/health", self.health),
            Route(f"{prefix}/project", self.get_project),
            Route(f"{prefix}/sessions", self.list_sessions),
            Route(f"{prefix}/sessions", self.create_session, methods=["POST"]),
            Route(f"{prefix}/sessions/{{session_id}}/lanes", self.list_lanes),
            Route(f"{prefix}/sessions/{{session_id}}/turns", self.list_turns),
            Route(f"{prefix}/sessions/{{session_id}}/turns/{{operation_id}}", self.get_turn),
            Route(f"{prefix}/sessions/{{session_id}}/lanes/{{lane}}/turns", self.submit_turn, methods=["POST"]),
            Route(f"{prefix}/sessions/{{session_id}}/lanes/{{lane}}/abort", self.abort, methods=["POST"]),
            Route(f"{prefix}/sessions/{{session_id}}/lanes/{{lane}}/recover", self.recover, methods=["POST"]),
            Route(f"{prefix}/sessions/{{session_id}}/lanes/{{lane}}/events", self.events),
            Route(f"{prefix}/memory/l0", self.list_l0),
            Route(f"{prefix}/memory/l0/{{archive_id}}", self.get_l0),
            Route(f"{prefix}/memory/l1", self.list_l1),
            Route(f"{prefix}/memory/l2", self.list_l2),
            Route(f"{prefix}/memory/l3", self.get_l3),
            Route(f"{prefix}/memory/jobs", self.list_memory_jobs),
            Route(f"{prefix}/memory/audit", self.list_memory_audit),
            Route(f"{prefix}/skills", self.list_skills),
            Route(f"{prefix}/skills/archives", self.list_skill_archives),
            Route(f"{prefix}/skills/archives/{{archive_id}}", self.get_skill_archive),
            Route(f"{prefix}/skills/jobs", self.list_skill_jobs),
            Route(f"{prefix}/skills/audit", self.list_skill_audit),
            Route(f"{prefix}/skills/{{skill_id}}", self.get_skill),
            Route(f"{prefix}/skills/{{skill_id}}/versions", self.list_skill_versions),
            Route("/", self.index),
            # A missing asset directory is a startup failure, not a page of 404s.
            Mount("/static", app=StaticFiles(directory=STATIC_DIR), name="static"),
        ]
        middleware = [Middleware(BearerAuthMiddleware, tokens=tokens)] if tokens else []
        return Starlette(
            routes=routes,
            middleware=middleware,
            lifespan=self.lifespan,
            exception_handlers={
                SessionNotFound: _not_found,
                LaneBusy: _lane_busy,
                InvalidCursor: _bad_request,
                HarnessError: _bad_request,
                ServiceUnavailable: _service_unavailable,
                Conflict: _conflict,
                ValueError: _bad_request,
            },
        )

    async def health(self, request: Request) -> JSONResponse:
        """Liveness and a little load, without the deployment's layout.

        No store path, no credential, no failure message and no operation
        payload appears here.  A drive's error text can quote a provider
        response or a tool argument, so the count is reported and the message
        stays in the log; a health answer is read by whoever runs the probe.
        """

        failures = self.supervisor.failures
        return JSONResponse(
            {
                "status": "shutting_down" if self.supervisor.closed else "ok",
                "project": {
                    "repository_id": self._config.repository_id,
                    "project_id": self._config.project_id or self._config.repository_id,
                },
                "stores": dict(self._stores),
                "sessions": {"open": self.supervisor.open_sessions},
                "drives": {
                    "active": self.supervisor.active_drives,
                    "limit": self.supervisor.max_concurrent_drives,
                    "failed": len(failures),
                },
            }
        )

    async def get_project(self, request: Request) -> JSONResponse:
        return JSONResponse(_jsonable(self._config.project))

    async def list_sessions(self, request: Request) -> JSONResponse:
        page = await self.catalog.list_sessions(_cursor(request), _limit(request))
        return JSONResponse(_page(page))

    async def create_session(self, request: Request) -> JSONResponse:
        body = await _json_body(request)
        session_id = body.get("session_id")
        lane = body.get("lane")
        if session_id is not None and not isinstance(session_id, str):
            raise ValueError("session_id must be a string")
        if lane is not None and not isinstance(lane, str):
            raise ValueError("lane must be a string")
        summary = await self.supervisor.create_session(session_id, lane)
        return JSONResponse(_jsonable(summary), status_code=201)

    async def list_lanes(self, request: Request) -> JSONResponse:
        lanes = await self.trace.list_lanes(request.path_params["session_id"])
        return JSONResponse({"items": _jsonable(lanes)})

    async def list_turns(self, request: Request) -> JSONResponse:
        page = await self.trace.list_turns(
            request.path_params["session_id"],
            request.query_params.get("lane"),
            _cursor(request),
            _limit(request),
        )
        return JSONResponse(_page(page))

    async def get_turn(self, request: Request) -> JSONResponse:
        detail = await self.trace.get_turn(request.path_params["session_id"], request.path_params["operation_id"])
        return JSONResponse(_jsonable(detail))

    async def submit_turn(self, request: Request) -> JSONResponse:
        body = await _json_body(request)
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt:
            raise ValueError("prompt is required")
        operation_id = body.get("operation_id")
        admission = await self.supervisor.submit_turn(
            request.path_params["session_id"],
            request.path_params["lane"],
            prompt,
            operation_id if isinstance(operation_id, str) else None,
        )
        return JSONResponse(_jsonable(admission), status_code=202)

    async def abort(self, request: Request) -> JSONResponse:
        result = await self.supervisor.abort(request.path_params["session_id"], request.path_params["lane"])
        return JSONResponse(_jsonable(result))

    async def recover(self, request: Request) -> JSONResponse:
        result = await self.supervisor.recover(request.path_params["session_id"], request.path_params["lane"])
        return JSONResponse({"result": _jsonable(result)})

    async def events(self, request: Request) -> StreamingResponse:
        snapshot, subscription = await self.supervisor.watch(
            request.path_params["session_id"], request.path_params["lane"]
        )
        return StreamingResponse(
            _event_stream(subscription, snapshot, request.headers.get("last-event-id")),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def list_l0(self, request: Request) -> JSONResponse:
        page = await self._memory_service().list_l0(_cursor(request), _limit(request))
        return JSONResponse(_page(page))

    async def get_l0(self, request: Request) -> JSONResponse:
        archive = await self._memory_service().get_l0(request.path_params["archive_id"])
        if archive is None:
            raise SessionNotFound("no such archive in this repository")
        return JSONResponse(_jsonable(archive))

    async def list_l1(self, request: Request) -> JSONResponse:
        page = await self._memory_service().list_l1(
            request.query_params.get("status"), _cursor(request), _limit(request)
        )
        return JSONResponse(_page(page))

    async def list_l2(self, request: Request) -> JSONResponse:
        page = await self._memory_service().list_l2(
            request.query_params.get("status"), _cursor(request), _limit(request)
        )
        return JSONResponse(_page(page))

    async def get_l3(self, request: Request) -> JSONResponse:
        return JSONResponse({"doctrine": _jsonable(await self._memory_service().get_l3())})

    async def list_memory_jobs(self, request: Request) -> JSONResponse:
        page = await self._memory_service().list_jobs(
            request.query_params.get("status"), _cursor(request), _limit(request)
        )
        return JSONResponse(_page(page))

    async def list_memory_audit(self, request: Request) -> JSONResponse:
        page = await self._memory_service().list_audit(_cursor(request), _limit(request))
        return JSONResponse(_page(page))

    async def list_skills(self, request: Request) -> JSONResponse:
        page = await self._skill_service().list_skills(
            request.query_params.get("state"), _cursor(request), _limit(request)
        )
        return JSONResponse(_page(page))

    async def get_skill(self, request: Request) -> JSONResponse:
        asset = await self._skill_service().get_skill(request.path_params["skill_id"])
        if asset is None:
            raise SessionNotFound("no such skill in this repository")
        return JSONResponse(_jsonable(asset))

    async def list_skill_versions(self, request: Request) -> JSONResponse:
        page = await self._skill_service().list_versions(
            request.path_params["skill_id"], _cursor(request), _limit(request)
        )
        return JSONResponse(_page(page))

    async def list_skill_archives(self, request: Request) -> JSONResponse:
        page = await self._skill_service().list_archives(_cursor(request), _limit(request))
        return JSONResponse(_page(page))

    async def get_skill_archive(self, request: Request) -> JSONResponse:
        archive = await self._skill_service().get_archive(request.path_params["archive_id"])
        if archive is None:
            raise SessionNotFound("no such archive in this repository")
        return JSONResponse(_jsonable(archive))

    async def list_skill_jobs(self, request: Request) -> JSONResponse:
        page = await self._skill_service().list_jobs(
            request.query_params.get("status"), _cursor(request), _limit(request)
        )
        return JSONResponse(_page(page))

    async def list_skill_audit(self, request: Request) -> JSONResponse:
        page = await self._skill_service().list_audit(_cursor(request), _limit(request))
        return JSONResponse(_page(page))

    async def index(self, request: Request) -> Response:
        """The single page shell; view routing happens in the browser."""

        return Response((STATIC_DIR / "index.html").read_text(encoding="utf-8"), media_type="text/html")


async def _event_stream(
    subscription: RemoteSubscription, snapshot: LaneSnapshot, resumed_from: str | None
) -> AsyncIterator[str]:
    """Forward lane events, snapshot first, until the client goes away.

    Events are best effort (ADR-WEB-002), so a reconnecting client is not
    replayed a backlog it cannot be given faithfully.  ``Last-Event-ID`` is
    acknowledged rather than honoured: the compensation for a gap is the durable
    snapshot that opens every stream, plus the query facades the client can
    re-read at any time.
    """

    sequence = 0
    yield "retry: 2000\n\n"
    yield _sse("snapshot", {**asdict(snapshot), "resumed_from": resumed_from}, sequence)
    try:
        while True:
            try:
                event = await asyncio.wait_for(subscription.next(), timeout=HEARTBEAT_SECONDS)
            except TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if event is None:
                return
            sequence += 1
            yield _sse(str(event.get("type", "event")), event, sequence)
    except Exception as error:  # a broken read must be visible, then end the stream
        yield _sse("error", {"message": str(error)}, sequence + 1)
    finally:
        # Disposal ends this subscription only; the operation keeps running.
        subscription.close()


async def _json_body(request: Request) -> dict[str, object]:
    try:
        body = await request.json()
    except Exception as error:
        raise ValueError("request body must be JSON") from error
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    return body


def _error(status: int, message: str, **extra: object) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


async def _not_found(request: Request, error: Exception) -> JSONResponse:
    return _error(404, str(error))


async def _lane_busy(request: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, LaneBusy)
    return _error(409, str(error), lane=error.lane, operation_id=error.operation_id)


async def _service_unavailable(request: Request, error: Exception) -> JSONResponse:
    return _error(503, str(error))


async def _conflict(request: Request, error: Exception) -> JSONResponse:
    return _error(409, str(error))


async def _bad_request(request: Request, error: Exception) -> JSONResponse:
    return _error(400, str(error), kind=type(error).__name__)


def create_app(
    config: ProjectRuntimeConfig,
    provider: ChatProvider,
    *,
    tools: tuple[AgentTool, ...] = (),
    memory_store: MemoryStore | None = None,
    skill_store: SkillStore | None = None,
    memory_extractor: MemoryExtractor | None = None,
    skill_reviewer: SkillReviewer | None = None,
    trace_recorder: bool = False,
    tokens: dict[str, str] | None = None,
    max_concurrent_drives: int = DEFAULT_MAX_CONCURRENT_DRIVES,
    telemetry: TelemetrySink | None = None,
) -> WebApplication:
    """Build the web application for one deployment.

    The result is also the lifecycle handle: ``start`` begins the promotion
    workers and ``aclose`` stops them, and the ASGI app does both through its
    lifespan so a plain ``uvicorn`` run needs nothing else.
    """

    return WebApplication(
        config,
        provider,
        tools=tools,
        memory_store=memory_store,
        skill_store=skill_store,
        memory_extractor=memory_extractor,
        skill_reviewer=skill_reviewer,
        trace_recorder=trace_recorder,
        tokens=tokens,
        max_concurrent_drives=max_concurrent_drives,
        telemetry=telemetry,
    )


__all__ = [
    "DEFAULT_MAX_CONCURRENT_DRIVES",
    "SessionSupervisor",
    "WebApplication",
    "create_app",
]
