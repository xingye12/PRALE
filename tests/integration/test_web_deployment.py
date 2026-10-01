"""Phase 6: what a deployment may expose, and what it refuses to serve.

The acceptance criterion is negative — a production configuration must not
hand out database paths, provider credentials, unredacted tool arguments or
another scope's memory — so most of these tests assert an absence.  They run
against a deployment whose options spell those values out, which is the only
way an absence means anything.
"""

import asyncio
import importlib.util
import logging
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.serve import RedactingFilter, build_application, main
from agent_harness.api.settings import DEFAULT_GRACEFUL_SHUTDOWN_SECONDS, Settings
from agent_harness.api.web import DEFAULT_MAX_CONCURRENT_DRIVES, WebApplication, create_app
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
from agent_harness.storage.skill_sqlite import SQLiteSkillStore

REPOSITORY_ID = "git@example.com:owner/repo.git"
TOKEN = "operator-token-for-tests"
API_KEY = "sk-secret-value-for-tests"


@dataclass
class Provider:
    """Answer, wait at the gate, or fail with a message that quotes the key."""

    gate_entered: asyncio.Event | None = None
    gate_release: asyncio.Event | None = None
    fail: bool = False

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        if self.gate_entered is not None and self.gate_release is not None:
            self.gate_entered.set()
            await self.gate_release.wait()
        if self.fail:
            raise RuntimeError(f"provider rejected the request: api_key={API_KEY}")
        return AssistantResult(content="ok", usage={})


def _config(tmp_path: Path) -> ProjectRuntimeConfig:
    return ProjectRuntimeConfig(
        project_root=tmp_path,
        repository_id=REPOSITORY_ID,
        sessions_dir=tmp_path / "sessions",
        catalog_db=tmp_path / "catalog.sqlite",
        memory_db=tmp_path / "memory.sqlite",
        skill_db=tmp_path / "skills.sqlite",
    )


def _client(web: WebApplication, *, token: str | None = None) -> httpx.AsyncClient:
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=web.app), base_url="http://testserver", headers=headers)


async def _deployment(
    tmp_path: Path,
    provider: Provider,
    *,
    stores: bool = True,
    tokens: dict[str, str] | None = None,
    max_concurrent_drives: int = DEFAULT_MAX_CONCURRENT_DRIVES,
    trace_recorder: bool = False,
) -> WebApplication:
    config = _config(tmp_path)
    memory = SQLiteMemoryStore(config.memory_db) if stores else None
    skills = SQLiteSkillStore(config.skill_db) if stores else None
    web = create_app(
        config,
        provider,
        memory_store=memory,
        skill_store=skills,
        tokens=tokens,
        max_concurrent_drives=max_concurrent_drives,
        trace_recorder=trace_recorder,
    )
    await web.start()
    return web


def test_health_reports_load_and_identity_without_the_deployment_layout(tmp_path: Path) -> None:
    """A health answer names the deployment, never where it keeps its files."""

    async def scenario() -> None:
        # A provider that fails with the key in its message: the reachable
        # failure path, not a hypothetical one.
        web = await _deployment(
            tmp_path,
            Provider(fail=True),
            tokens={TOKEN: "operator"},
            trace_recorder=True,
        )
        try:
            await web.supervisor.create_session("s-1")
            async with _client(web, token=TOKEN) as client:
                submitted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "hello"})
                assert submitted.status_code == 202
                operation_id = submitted.json()["operation_id"]
                for _ in range(500):
                    detail = (await client.get(f"/api/sessions/s-1/turns/{operation_id}")).json()
                    if detail["summary"]["status"] is not None:
                        break
                    await asyncio.sleep(0.01)
                # A provider error settles the operation as ``unknown`` — a
                # generation that died mid-flight cannot be proven either way —
                # and the drive returns normally; only a crashed driver counts.
                assert detail["summary"]["status"] == "unknown"
                assert web.supervisor.failures == {}

                response = await client.get("/api/health")
                assert response.status_code == 200
                body = response.json()

            assert body["status"] == "ok"
            assert body["project"] == {"repository_id": REPOSITORY_ID, "project_id": REPOSITORY_ID}
            assert body["stores"] == {"catalog": True, "memory": True, "skills": True, "traces": True}
            assert body["sessions"] == {"open": 1}
            assert body["drives"] == {"active": 0, "limit": DEFAULT_MAX_CONCURRENT_DRIVES, "failed": 0}

            # Nothing about the layout, the credential, the drive's error text
            # or the project's own root is in the answer.
            serialized = response.text
            assert str(tmp_path) not in serialized
            for leaked in ("sqlite", "sessions/", API_KEY, "sk-secret", "provider rejected"):
                assert leaked not in serialized, leaked
            assert "project_root" not in serialized
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_health_counts_a_crashed_driver_without_quoting_it(tmp_path: Path) -> None:
    """A dead driver is a count to act on; its message stays in the log."""

    async def scenario() -> None:
        web = await _deployment(tmp_path, Provider())
        try:
            async with _client(web) as client:
                assert (await client.get("/api/health")).json()["drives"]["failed"] == 0
                # Only an unexpected error inside the drive machinery records a
                # failure, and none is reachable from a request; the count's
                # shape is what matters here, so it is set where a crash would.
                web.supervisor._failures[("s-1", "main")] = f"RuntimeError: refused, key {API_KEY}"
                body = (await client.get("/api/health")).json()
                response_text = (await client.get("/api/health")).text
            assert body["drives"]["failed"] == 1
            assert API_KEY not in response_text
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_health_reports_unconfigured_stores_as_absent(tmp_path: Path) -> None:
    async def scenario() -> None:
        web = await _deployment(tmp_path, Provider(), stores=False)
        try:
            async with _client(web) as client:
                body = (await client.get("/api/health")).json()
            assert body["stores"]["memory"] is False
            assert body["stores"]["skills"] is False
            assert body["drives"]["failed"] == 0
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_health_is_behind_the_service_token(tmp_path: Path) -> None:
    """A probe reaches a credentialed deployment the same way a browser does."""

    async def scenario() -> None:
        web = await _deployment(tmp_path, Provider(), tokens={TOKEN: "operator"})
        try:
            async with _client(web) as client:
                assert (await client.get("/api/health")).status_code == 401
            async with _client(web, token=TOKEN) as client:
                assert (await client.get("/api/health")).status_code == 200
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_a_credentialed_deployment_still_serves_the_ui_shell(tmp_path: Path) -> None:
    """A browser cannot put a token on a page load, and the shell needs none.

    The page and its modules hold no data; a deployment that gated them would
    have an API that works and a UI that cannot be opened.
    """

    async def scenario() -> None:
        web = await _deployment(tmp_path, Provider(), tokens={TOKEN: "operator"})
        try:
            async with _client(web) as client:
                shell = await client.get("/")
                assert shell.status_code == 200
                assert shell.headers["content-type"].startswith("text/html")
                # The served files never carry the credential they are given by
                # hand in the browser.
                assert TOKEN not in shell.text
                assert (await client.get("/static/app.js")).status_code == 200
                # A page-shaped path is not a blanket exemption: the API is
                # still the guarded surface, and a traversal out of /static/
                # reaches neither a file nor a route.
                assert (await client.get("/api/health")).status_code == 401
                traversal = await client.get("/static/../api/health")
                assert traversal.status_code != 200, "a static path reached the API"
                assert "repository_id" not in traversal.text
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_a_deployment_at_its_drive_limit_refuses_before_admitting(tmp_path: Path) -> None:
    """Shedding load must not leave an operation nothing is driving.

    The refusal is a 503 on a lane with nothing running, while a lane that is
    already working still answers 409 — the cap is a capacity answer, not a
    replacement for the lane's own state.
    """

    async def scenario() -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        web = await _deployment(
            tmp_path,
            Provider(gate_entered=entered, gate_release=release),
            max_concurrent_drives=1,
        )
        try:
            await web.supervisor.create_session("s-1")
            async with _client(web) as client:
                first = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "first"})
                assert first.status_code == 202
                await asyncio.wait_for(entered.wait(), timeout=5.0)

                saturated = await client.post("/api/sessions/s-1/lanes/other/turns", json={"prompt": "second"})
                assert saturated.status_code == 503
                assert "driving 1 turns" in saturated.json()["error"]

                # The refused lane kept no operation: a durable admission that
                # no one drives is exactly what recover() exists to clean up.
                lanes = (await client.get("/api/sessions/s-1/lanes")).json()["items"]
                refused = [lane for lane in lanes if lane["name"] == "other"]
                assert refused == [] or refused[0]["operation_id"] is None

                busy = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "again"})
                assert busy.status_code == 409
                assert busy.json()["lane"] == "main"

                release.set()
                for _ in range(500):
                    if web.supervisor.active_drives == 0:
                        break
                    await asyncio.sleep(0.01)
                after = await client.post("/api/sessions/s-1/lanes/other/turns", json={"prompt": "third"})
                assert after.status_code == 202
                release.set()
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_the_drive_limit_must_be_at_least_one(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="at least 1"):
        create_app(_config(tmp_path), Provider(), max_concurrent_drives=0)


def test_the_log_filter_removes_credentials_however_they_were_spelled() -> None:
    secret = "sk-live-abcdefghijklmnop"
    filter_ = RedactingFilter([secret, TOKEN])
    assert filter_.scrub(f"using {secret} now") == "using <redacted> now"
    assert filter_.scrub(f"Authorization: Bearer {TOKEN}") == "Authorization: Bearer <redacted>"
    assert filter_.scrub("Bearer abcdefghijklmnop.qrstuvwx") == "Bearer <redacted>"
    assert filter_.scrub("https://host/v1?api_key=zzz&x=1") == "https://host/v1?api_key=<redacted>&x=1"
    assert filter_.scrub("password: hunter2") == "password: <redacted>"
    # An unremarkable line is left alone.
    assert filter_.scrub("turn op-1 settled in 120ms") == "turn op-1 settled in 120ms"


def test_the_log_filter_scrubs_the_formatted_record_and_its_traceback() -> None:
    secret = "sk-live-abcdefghijklmnop"
    filter_ = RedactingFilter([secret])
    logger = logging.getLogger("test.redaction")
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Capture()
    handler.addFilter(filter_)
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        logger.info("call failed with key %s", secret)
        try:
            raise RuntimeError(f"rejected: {secret}")
        except RuntimeError:
            logger.exception("provider error")
    finally:
        logger.removeHandler(handler)

    assert len(records) == 2
    assert secret not in records[0].getMessage()
    assert "<redacted>" in records[0].getMessage()
    assert records[1].exc_text is not None
    assert secret not in records[1].exc_text
    # The formatter is what writes the traceback, so the scrubbed text has to
    # be the text it would use.
    rendered = logging.Formatter("%(message)s\n%(exc_text)s").format(records[1])
    assert secret not in rendered
    assert traceback.format_exception_only(type(RuntimeError()), RuntimeError(secret))  # sanity: the value was real


def _environment(tmp_path: Path, **overrides: str) -> dict[str, str]:
    environ = {
        "PRALE_PROJECT_ROOT": str(tmp_path),
        "PRALE_REPOSITORY_ID": REPOSITORY_ID,
        "PRALE_DATA_DIR": str(tmp_path / "data"),
        "PRALE_API_KEY": API_KEY,
        "PRALE_TOKENS": f"operator:{TOKEN}",
    }
    environ.update(overrides)
    return environ


def test_settings_parse_the_environment_into_one_deployment(tmp_path: Path) -> None:
    settings = Settings.from_environment(_environment(tmp_path, PRALE_TOOLS="read,edit", PRALE_MAX_DRIVES="3"))

    assert settings.config.repository_id == REPOSITORY_ID
    assert settings.catalog_db == tmp_path / "data" / "catalog.sqlite"
    assert settings.sessions_dir == tmp_path / "data" / "sessions"
    assert settings.memory_db == tmp_path / "data" / "memory.sqlite"
    assert settings.memory_embedding_model is None
    assert settings.tools == ("read", "edit")
    assert settings.max_concurrent_drives == 3
    assert settings.graceful_shutdown_seconds == DEFAULT_GRACEFUL_SHUTDOWN_SECONDS
    assert settings.traces is True
    assert settings.memory_prompt_file is None
    assert settings.tokens == {TOKEN: "operator"}
    # The entry point never hands a *path* to the scope: the scope is identity.
    assert settings.secrets == (API_KEY, TOKEN)


def test_settings_refuse_a_deployment_without_an_identity_or_a_credential(tmp_path: Path) -> None:
    with pytest.raises(ProjectConfigError, match="PRALE_REPOSITORY_ID"):
        Settings.from_environment({"PRALE_API_KEY": API_KEY})
    with pytest.raises(ProjectConfigError, match="PRALE_API_KEY"):
        Settings.from_environment({"PRALE_REPOSITORY_ID": REPOSITORY_ID})
    with pytest.raises(ProjectConfigError, match="unknown tools"):
        Settings.from_environment(_environment(tmp_path, PRALE_TOOLS="read,deploy"))
    with pytest.raises(ProjectConfigError, match="must be an integer"):
        Settings.from_environment(_environment(tmp_path, PRALE_PORT="eighty"))
    with pytest.raises(ProjectConfigError, match="must be greater than 0"):
        Settings.from_environment(_environment(tmp_path, PRALE_GRACEFUL_SHUTDOWN_SECONDS="0"))
    with pytest.raises(ProjectConfigError, match="name:token"):
        Settings.from_environment(_environment(tmp_path, PRALE_TOKENS="missing-separator"))
    with pytest.raises(ProjectConfigError, match="PRALE_REPOSITORY_INDEX_DIR is required"):
        Settings.from_environment(_environment(tmp_path, PRALE_TOOLS="repository_explore"))
    with pytest.raises(ProjectConfigError, match="outside PRALE_PROJECT_ROOT"):
        Settings.from_environment(
            _environment(
                tmp_path,
                PRALE_TOOLS="repository_explore",
                PRALE_REPOSITORY_INDEX_DIR=str(tmp_path / "index"),
            )
        )
    with pytest.raises(ProjectConfigError, match="between 256 and 6000"):
        Settings.from_environment(_environment(tmp_path, PRALE_REPOSITORY_MAX_EXPORT_TOKENS="6001"))
    # A checkout path is not an identity (ADR-018): refused by the config this
    # settings object builds, not only by the flag parser.
    with pytest.raises(ProjectConfigError, match="stable identifier"):
        Settings.from_environment(_environment(tmp_path, PRALE_REPOSITORY_ID=str(tmp_path))).config


def test_a_first_run_creates_the_layout_it_was_given(tmp_path: Path) -> None:
    """A fresh data directory is a deployment to make, not a store that fails."""

    settings = Settings.from_environment(_environment(tmp_path))
    data_dir = tmp_path / "data"
    assert not data_dir.exists()

    deployment = build_application(settings)
    try:
        assert settings.sessions_dir.is_dir()
        assert settings.catalog_db.is_file()
        assert settings.memory_db is not None and settings.memory_db.is_file()
        assert settings.skill_db is not None and settings.skill_db.is_file()
    finally:
        deployment.close()


def test_settings_can_turn_a_store_off(tmp_path: Path) -> None:
    settings = Settings.from_environment(_environment(tmp_path, PRALE_MEMORY="off", PRALE_SKILLS="off"))
    assert settings.memory_db is None
    assert settings.skill_db is None
    assert "off" in settings.describe()
    # Skills alone is a configuration the runtime cannot honour: extraction
    # materializes L0 archives through the memory store.
    with pytest.raises(ProjectConfigError, match="PRALE_SKILLS requires the memory store"):
        Settings.from_environment(_environment(tmp_path, PRALE_MEMORY="off"))
    with pytest.raises(ProjectConfigError, match="PRALE_MEMORY_EMBEDDING_MODEL requires PRALE_MEMORY"):
        Settings.from_environment(
            _environment(
                tmp_path,
                PRALE_MEMORY="off",
                PRALE_SKILLS="off",
                PRALE_MEMORY_EMBEDDING_MODEL="/models/bge-m3",
            )
        )


def test_settings_accept_an_opt_in_local_memory_embedding_model(tmp_path: Path) -> None:
    settings = Settings.from_environment(
        _environment(tmp_path, PRALE_MEMORY_EMBEDDING_MODEL="/root/vibe/AgenticRAG+RL/core/models/bge-m3")
    )

    assert settings.memory_embedding_model == Path("/root/vibe/AgenticRAG+RL/core/models/bge-m3")
    assert "memory_embedding  /root/vibe/AgenticRAG+RL/core/models/bge-m3" in settings.describe()


def test_print_config_shows_the_deployment_without_echoing_a_credential(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in _environment(tmp_path).items():
        monkeypatch.setenv(name, value)
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    try:
        assert main(["--print-config", "--port", "9001"]) == 0
    finally:
        root.handlers[:] = handlers
        root.setLevel(level)

    printed = capsys.readouterr().out
    assert f"repository_id     {REPOSITORY_ID}" in printed
    assert "9001" in printed
    assert API_KEY not in printed
    assert TOKEN not in printed
    assert "api_key           <set>" in printed


def test_repository_explorer_extra_is_checked_only_during_composition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings.from_environment(
        _environment(
            tmp_path,
            PRALE_TOOLS="repository_explore",
            PRALE_REPOSITORY_INDEX_DIR=str(tmp_path.parent / "repository-index"),
        )
    )

    original_find_spec = importlib.util.find_spec

    def missing_extra(name: str, package: str | None = None):
        if name == "tree_sitter_python":
            return None
        return original_find_spec(name, package)

    monkeypatch.setattr(importlib.util, "find_spec", missing_extra)
    assert "repository_explore on" in settings.describe()
    with pytest.raises(ProjectConfigError, match="repository-explorer extra"):
        build_application(settings)


def test_a_misconfigured_deployment_exits_with_an_explanation(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("PRALE_REPOSITORY_ID", raising=False)
    monkeypatch.setenv("PRALE_API_KEY", API_KEY)
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    try:
        assert main([]) == 2
    finally:
        root.handlers[:] = handlers
        root.setLevel(level)

    captured = capsys.readouterr()
    assert "PRALE_REPOSITORY_ID is required" in captured.err
    assert "Traceback" not in captured.err
    assert API_KEY not in captured.err + captured.out


# Tracing is an optional deployment capability: off unless the environment asks
# for it, and then never at the cost of a credential.

LANGFUSE_PUBLIC_KEY = "pk-lf-public-for-tests"
LANGFUSE_SECRET_KEY = "sk-lf-secret-for-tests"


def _tracing(tmp_path: Path, **overrides: str) -> dict[str, str]:
    """An environment for a deployment that opted into tracing."""

    return _environment(
        tmp_path,
        LANGFUSE_TRACING_ENABLED="1",
        LANGFUSE_PUBLIC_KEY=LANGFUSE_PUBLIC_KEY,
        LANGFUSE_SECRET_KEY=LANGFUSE_SECRET_KEY,
        **overrides,
    )


def test_tracing_is_off_until_the_deployment_turns_it_on(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An untraced deployment must not need the extra, let alone import it."""

    settings = Settings.from_environment(_environment(tmp_path))
    assert settings.langfuse is None
    assert settings.secrets == (API_KEY, TOKEN)
    assert "langfuse          off" in settings.describe()

    # The SDK is not part of the core dependencies, and a deployment that never
    # enables tracing is unaffected by it being absent.
    monkeypatch.setitem(sys.modules, "langfuse", None)
    deployment = build_application(settings)
    deployment.close()


def test_an_enabled_deployment_without_its_keys_is_refused(tmp_path: Path) -> None:
    """Half-configured tracing would look like a monitored deployment."""

    with pytest.raises(ProjectConfigError, match="LANGFUSE_PUBLIC_KEY"):
        Settings.from_environment(_environment(tmp_path, LANGFUSE_TRACING_ENABLED="1"))
    with pytest.raises(ProjectConfigError, match="LANGFUSE_SECRET_KEY"):
        Settings.from_environment(
            _environment(tmp_path, LANGFUSE_TRACING_ENABLED="1", LANGFUSE_PUBLIC_KEY=LANGFUSE_PUBLIC_KEY)
        )


def test_an_enabled_deployment_keeps_its_keys_to_itself(tmp_path: Path) -> None:
    settings = Settings.from_environment(
        _tracing(tmp_path, LANGFUSE_TRACING_ENVIRONMENT="staging", PRALE_LANGFUSE_CAPTURE="metadata")
    )

    assert settings.langfuse is not None
    assert (settings.langfuse.environment, settings.langfuse.capture) == ("staging", "metadata")
    described = settings.describe()
    assert "langfuse          on env=staging capture=metadata" in described
    assert "public_key=<set> secret_key=<set>" in described
    assert LANGFUSE_PUBLIC_KEY not in described
    assert LANGFUSE_SECRET_KEY not in described
    # The tracing secret is a credential like any other: it joins the values the
    # log filter and the sanitizer strip before anything leaves the process.
    assert settings.secrets == (API_KEY, TOKEN, LANGFUSE_SECRET_KEY)


def test_the_tracing_environment_and_capture_are_checked_at_startup(tmp_path: Path) -> None:
    with pytest.raises(ProjectConfigError, match="LANGFUSE_TRACING_ENVIRONMENT"):
        Settings.from_environment(_tracing(tmp_path, LANGFUSE_TRACING_ENVIRONMENT="nightly"))
    with pytest.raises(ProjectConfigError, match="PRALE_LANGFUSE_CAPTURE"):
        Settings.from_environment(_tracing(tmp_path, PRALE_LANGFUSE_CAPTURE="verbose"))

    # The three names a gateway recognises are the three that are accepted.
    for environment in ("development", "staging", "production"):
        settings = Settings.from_environment(_tracing(tmp_path, LANGFUSE_TRACING_ENVIRONMENT=environment))
        assert settings.langfuse is not None and settings.langfuse.environment == environment


def test_an_enabled_deployment_without_the_sdk_fails_before_it_opens_a_store(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings.from_environment(_tracing(tmp_path))
    monkeypatch.setitem(sys.modules, "langfuse", None)

    with pytest.raises(ProjectConfigError, match=r"prale-agent-harness\[langfuse\]"):
        build_application(settings)

    # Composition failed before the stores were opened: nothing to clean up and
    # no server that would start half-instrumented.
    assert not (tmp_path / "data" / "catalog.sqlite").exists()


def test_print_config_shows_tracing_without_echoing_its_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for name, value in _tracing(tmp_path, LANGFUSE_TRACING_ENVIRONMENT="staging").items():
        monkeypatch.setenv(name, value)
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    try:
        assert main(["--print-config"]) == 0
    finally:
        root.handlers[:] = handlers
        root.setLevel(level)

    printed = capsys.readouterr().out
    assert "langfuse          on env=staging capture=metadata" in printed
    assert "public_key=<set> secret_key=<set>" in printed
    assert LANGFUSE_PUBLIC_KEY not in printed
    assert LANGFUSE_SECRET_KEY not in printed


def test_a_served_turn_publishes_facts_for_the_session_that_ran_it(tmp_path: Path) -> None:
    """The deployment's sink is wired to the runtime, not only to the config.

    Nothing here reaches the network: a sink is any object with ``record``, and
    what it receives has to name the session the deployment served.
    """

    class Collector:
        def __init__(self) -> None:
            self.events: list = []

        def record(self, event) -> None:
            self.events.append(event)

    async def scenario() -> None:
        collector = Collector()
        web = create_app(_config(tmp_path), Provider(), telemetry=collector)
        await web.start()
        try:
            await web.supervisor.create_session("s-1")
            async with _client(web) as client:
                submitted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "hello"})
                assert submitted.status_code == 202
                operation_id = submitted.json()["operation_id"]
                for _ in range(500):
                    detail = (await client.get(f"/api/sessions/s-1/turns/{operation_id}")).json()
                    if detail["summary"]["status"] is not None:
                        break
                    await asyncio.sleep(0.01)
                assert detail["summary"]["status"] == "completed"
        finally:
            await web.aclose()

        assert [event.session_id for event in collector.events] == ["s-1"] * len(collector.events)
        started, terminal = (
            collector.events[0],
            [event for event in collector.events if getattr(event, "phase", None) == "terminal"],
        )
        assert (started.lane, started.operation_id, started.input) == ("main", operation_id, {"prompt": "hello"})
        assert terminal[-1].output["content"] == "ok"

    asyncio.run(scenario())
