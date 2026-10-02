"""The web adapter's contract: durable admission, background drive, explicit abort.

Phase 4's acceptance criteria are mostly about what a disconnected browser must
*not* do, and about a state two processes can disagree on: an operation admitted
by a process that then dies.  The stream tests therefore drive the ASGI app
directly rather than through an HTTP client — an in-process client buffers a
whole response before returning it, so it cannot express "the browser went away
mid-stream".
"""

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.web import WebApplication, create_app
from agent_harness.domain.skill import SkillProposal, SkillScope
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore
from agent_harness.storage.skill_sqlite import SQLiteSkillStore

REPOSITORY_ID = "git@example.com:owner/repo.git"
TOKEN = "local-operator-token"


class Gate:
    """A barrier the test releases when it decides a turn may finish."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()


@dataclass
class Provider:
    """Answer immediately, or wait at the gate so a turn can be observed live."""

    gate: Gate | None = None
    content: str = "done"

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        if self.gate is not None:
            self.gate.started.set()
            await self.gate.release.wait()
        return AssistantResult(content=self.content, usage={"input_tokens": 3, "output_tokens": 2})


class Browser:
    """One ASGI request whose disconnection the test controls."""

    def __init__(self, app: Any, path: str, *, last_event_id: str | None = None) -> None:
        self._app = app
        self._path = path
        self._last_event_id = last_event_id
        self._chunks: asyncio.Queue[str] = asyncio.Queue()
        self._frames: list[str] = []
        self._disconnected = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self.status: int | None = None

    async def open(self) -> None:
        headers = [(b"host", b"testserver")]
        if self._last_event_id is not None:
            headers.append((b"last-event-id", self._last_event_id.encode()))
        scope = {
            "type": "http",
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": self._path,
            "raw_path": self._path.encode(),
            "query_string": b"",
            "root_path": "",
            "headers": headers,
            "server": ("testserver", 80),
            "client": ("127.0.0.1", 1234),
        }
        self._task = asyncio.create_task(self._app(scope, self._receive, self._send))

    async def _receive(self) -> dict[str, object]:
        await self._disconnected.wait()
        return {"type": "http.disconnect"}

    async def _send(self, message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            self.status = int(message["status"])  # type: ignore[call-overload]
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            if isinstance(body, bytes) and body:
                self._chunks.put_nowait(body.decode())

    async def next_frame(self, timeout: float = 5.0) -> str:
        """The next SSE frame, without its blank-line separator."""

        while not self._frames:
            chunk = await asyncio.wait_for(self._chunks.get(), timeout=timeout)
            self._frames.extend(frame for frame in chunk.split("\n\n") if frame.strip())
        return self._frames.pop(0)

    async def wait(self) -> None:
        """Wait for a request that ends by itself, such as a refusal."""

        assert self._task is not None
        await asyncio.wait_for(self._task, timeout=5.0)

    async def disconnect(self) -> None:
        self._disconnected.set()
        assert self._task is not None
        await asyncio.wait_for(self._task, timeout=5.0)


def _config(tmp_path: Path) -> ProjectRuntimeConfig:
    return ProjectRuntimeConfig(
        project_root=tmp_path,
        repository_id=REPOSITORY_ID,
        sessions_dir=tmp_path / "sessions",
        catalog_db=tmp_path / "catalog.sqlite",
        memory_db=tmp_path / "memory.db",
        skill_db=tmp_path / "skills.db",
    )


def _client(web: WebApplication, *, token: str | None = None) -> httpx.AsyncClient:
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=web.app), base_url="http://testserver", headers=headers)


async def _open(
    config: ProjectRuntimeConfig, provider: Provider, *, tokens: dict[str, str] | None = None
) -> WebApplication:
    assert config.memory_db is not None and config.skill_db is not None
    web = create_app(
        config,
        provider,
        memory_store=SQLiteMemoryStore(config.memory_db),
        skill_store=SQLiteSkillStore(config.skill_db),
        tokens=tokens,
    )
    await web.start()
    await web.supervisor.create_session("s-1")
    return web


async def _settled(client: httpx.AsyncClient, session: str, operation_id: str, timeout: float = 5.0) -> dict:
    """Poll a turn until it has a status; ``None`` means it is still unsettled."""

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        detail = (await client.get(f"/api/sessions/{session}/turns/{operation_id}")).json()
        if detail["summary"]["status"] is not None:
            return detail
        if loop.time() > deadline:
            raise AssertionError(f"turn {operation_id} never settled")
        await asyncio.sleep(0.01)


def _frame_data(frame: str) -> dict:
    for line in frame.splitlines():
        if line.startswith("data: "):
            parsed = json.loads(line[6:])
            assert isinstance(parsed, dict)
            return parsed
    raise AssertionError(f"frame has no data line: {frame!r}")


def test_a_submitted_turn_is_driven_in_the_background_and_read_over_http(tmp_path: Path) -> None:
    async def scenario() -> None:
        web = await _open(_config(tmp_path), Provider())
        try:
            async with _client(web) as client:
                project = (await client.get("/api/project")).json()
                assert set(project) == {"project_root", "repository_id", "project_id"}
                assert project["project_root"] == str(tmp_path)
                assert project["repository_id"] == REPOSITORY_ID

                listed = (await client.get("/api/sessions")).json()
                assert [row["session_id"] for row in listed["items"]] == ["s-1"]
                assert listed["next_cursor"] is None

                accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "hello"})
                assert accepted.status_code == 202
                operation_id = accepted.json()["operation_id"]

                # The submitting request is over; the supervisor keeps driving
                # the turn, and its progress is readable at any time.
                detail = await _settled(client, "s-1", operation_id)

                assert detail["summary"]["status"] == "completed"
                assert detail["summary"]["lane"] == "main"
                assert (detail["summary"]["input_tokens"], detail["summary"]["total_tokens"]) == (3, 5)
                assert detail["summary"]["duration_ms"] is not None
                assert [entry["type"] for entry in detail["entries"]] == ["message", "message"]
                assert detail["entries"][0]["payload"]["role"] == "user"
                assert detail["entries"][-1]["payload"]["content"] == "done"
                assert detail["request"]["prompt"] == "hello"
                assert detail["unattributed_usage"] == []

                turns = (await client.get("/api/sessions/s-1/turns")).json()
                assert [turn["operation_id"] for turn in turns["items"]] == [operation_id]
                lanes = (await client.get("/api/sessions/s-1/lanes")).json()
                assert [lane["name"] for lane in lanes["items"]] == ["main"]
                assert lanes["items"][0]["operation_id"] is None
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_skill_must_be_enabled_in_the_web_ui_before_the_runtime_can_discover_it(tmp_path: Path) -> None:
    async def scenario() -> None:
        config = _config(tmp_path)
        web = await _open(config, Provider())
        try:
            assert config.skill_db is not None
            store = SQLiteSkillStore(config.skill_db)
            proposal = SkillProposal(
                "create",
                evidence_entry_ids=("tool-result",),
                markdown="""---
name: Deploy
description: Reusable deployment verification procedure
triggers: deploy, release
version: 1
status: active
---
适用范围与不适用范围：已验证的服务发布。
前置条件：有已批准的发布包。
步骤：执行部署并记录结果。
验证：检查健康端点和回滚指标。
失败/回滚处理：停止发布并回滚到上一版本。
资源使用说明：无附加资源。
""",
            )
            asset = await store.create(SkillScope(REPOSITORY_ID), proposal, 1)
            assert asset.state == "disabled"
            assert await store.listing(SkillScope(REPOSITORY_ID), "deploy", 2_000) == ()

            async with _client(web) as client:
                response = await client.post(f"/api/skills/{asset.skill_id}/enabled", json={"enabled": True})
                assert response.status_code == 200
                assert response.json()["state"] == "active"
                assert [item.skill_id for item in await store.listing(SkillScope(REPOSITORY_ID), "deploy", 2_000)] == [
                    asset.skill_id
                ]
                disabled = await client.post(f"/api/skills/{asset.skill_id}/enabled", json={"enabled": False})
                assert disabled.status_code == 200
                assert disabled.json()["state"] == "disabled"

            assert await store.listing(SkillScope(REPOSITORY_ID), "deploy", 2_000) == ()
            assert [row.event for row in await store.list_audit(SkillScope(REPOSITORY_ID), None, 10)] == [
                "skill_state_changed",
                "skill_state_changed",
            ]
            store.close()
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_a_session_is_created_explicitly_and_never_as_a_side_effect(tmp_path: Path) -> None:
    async def scenario() -> None:
        web = await _open(_config(tmp_path), Provider())
        try:
            async with _client(web) as client:
                created = await client.post("/api/sessions", json={"session_id": "review-1"})
                assert created.status_code == 201
                assert created.json()["session_id"] == "review-1"
                assert (await client.get("/api/sessions/review-1/turns")).json() == {
                    "items": [],
                    "next_cursor": None,
                }

                generated = await client.post("/api/sessions", json={})
                assert generated.status_code == 201
                assert generated.json()["session_id"]

                # A session id becomes a file name, so a path-shaped one is a
                # client error rather than a write outside the session directory.
                assert (await client.post("/api/sessions", json={"session_id": "../escape"})).status_code == 400

                # Registering again keeps the session and its history; it is a
                # way to open one, not to reset one.
                accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "hello"})
                operation_id = accepted.json()["operation_id"]
                await _settled(client, "s-1", operation_id)
                again = await client.post("/api/sessions", json={"session_id": "s-1"})
                turns = (await client.get("/api/sessions/s-1/turns")).json()

                assert again.status_code == 201
                assert [turn["operation_id"] for turn in turns["items"]] == [operation_id]

                # A catalog row whose database is missing is not an empty
                # session: it is an error, on the command path as well as on the
                # read path, and creating the session is what makes it usable.
                await web.catalog.register("ghost")
                refused = await client.post("/api/sessions/ghost/lanes/main/turns", json={"prompt": "hi"})

                assert (await client.get("/api/sessions/ghost/turns")).status_code == 404
                assert refused.status_code == 404
                assert (await client.post("/api/sessions", json={"session_id": "ghost"})).status_code == 201
                assert (await client.get("/api/sessions/ghost/turns")).json() == {"items": [], "next_cursor": None}
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_the_event_stream_opens_with_a_durable_snapshot_and_acknowledges_resume(tmp_path: Path) -> None:
    async def scenario() -> None:
        web = await _open(_config(tmp_path), Provider())
        try:
            browser = Browser(web.app, "/api/sessions/s-1/lanes/main/events", last_event_id="7")
            await browser.open()
            try:
                assert await browser.next_frame() == "retry: 2000"
                frame = await browser.next_frame()
                snapshot = _frame_data(frame)

                assert frame.startswith("id: 0\nevent: snapshot\ndata: ")
                assert browser.status == 200
                # The stream opens with durable state, and says out loud that a
                # reconnect's Last-Event-ID was seen but not replayed.
                assert snapshot["name"] == "main"
                assert snapshot["tip_id"] is None
                assert snapshot["resumed_from"] == "7"
            finally:
                await browser.disconnect()
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_a_disconnected_browser_cancels_the_wait_not_the_operation(tmp_path: Path) -> None:
    async def scenario() -> None:
        gate = Gate()
        web = await _open(_config(tmp_path), Provider(gate))
        try:
            async with _client(web) as client:
                browser = Browser(web.app, "/api/sessions/s-1/lanes/main/events")
                await browser.open()
                assert await browser.next_frame() == "retry: 2000"
                opening = _frame_data(await browser.next_frame())
                assert opening["tip_id"] is None and opening["operation_id"] is None

                accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "long"})
                operation_id = accepted.json()["operation_id"]
                admitted = await browser.next_frame()
                assert admitted.startswith("id: 1\nevent: operation_admitted\n")
                assert _frame_data(admitted)["operation_id"] == operation_id

                await gate.started.wait()
                await browser.disconnect()

                # Nothing about the operation was cancelled by the browser going
                # away: it is still unsettled, and it finishes on its own.
                detail = (await client.get(f"/api/sessions/s-1/turns/{operation_id}")).json()
                assert detail["summary"]["status"] is None

                gate.release.set()
                finished = await _settled(client, "s-1", operation_id)

                assert finished["summary"]["status"] == "completed"
                assert finished["entries"][-1]["payload"]["content"] == "done"
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_only_an_explicit_abort_cancels_an_operation(tmp_path: Path) -> None:
    async def scenario() -> None:
        gate = Gate()
        web = await _open(_config(tmp_path), Provider(gate))
        try:
            async with _client(web) as client:
                accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "long"})
                operation_id = accepted.json()["operation_id"]
                await gate.started.wait()

                busy = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "again"})
                assert busy.status_code == 409
                assert busy.json()["operation_id"] == operation_id

                abort = await client.post("/api/sessions/s-1/lanes/main/abort")
                assert abort.status_code == 200
                assert abort.json() == {"operation_id": operation_id, "newly_requested": True}

                finished = await _settled(client, "s-1", operation_id)

                # The abort reached the runtime while the provider call was in
                # flight, so the durable outcome is "unknown": the effect was
                # issued and its result is gone.  Reporting a clean abort (or a
                # duration) would claim knowledge nobody has.
                assert finished["summary"]["status"] == "unknown"
                assert finished["summary"]["error_code"] == "interrupted"
                assert finished["summary"]["duration_ms"] is None
                # A settled lane has nothing left to cancel, so asking again is
                # a conflict rather than a silent success.
                assert (await client.post("/api/sessions/s-1/lanes/main/abort")).status_code == 409
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_a_turn_the_dead_process_left_behind_is_recovered_explicitly(tmp_path: Path) -> None:
    async def scenario() -> None:
        config = _config(tmp_path)
        gate = Gate()
        first = await _open(config, Provider(gate))
        async with _client(first) as client:
            accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "hello"})
            operation_id = accepted.json()["operation_id"]
            await gate.started.wait()

        # The process dies mid-turn: its driver is cancelled without settling
        # anything, which is the durable state a crash leaves behind.
        task = first.supervisor.drive_task("s-1", "main")
        assert task is not None
        task.cancel()
        await asyncio.wait({task})
        await first.aclose()

        second = await _open(config, Provider(content="after the restart"))
        try:
            async with _client(second) as client:
                unfinished = (await client.get(f"/api/sessions/s-1/turns/{operation_id}")).json()
                # Without a driver in this process, the durable record cannot
                # claim the turn is still running — only that it never settled.
                assert unfinished["summary"]["status"] is None

                recovered = await client.post("/api/sessions/s-1/lanes/main/recover")
                assert recovered.status_code == 200
                assert recovered.json()["result"]["status"] == "unknown"

                # Recovery must not re-run a generation that may already have
                # happened, so it settles the turn as unknown instead of
                # guessing: the trace says so, and shows why.
                detail = (await client.get(f"/api/sessions/s-1/turns/{operation_id}")).json()
                assert detail["summary"]["status"] == "unknown"
                assert detail["summary"]["error_code"] == "interrupted"
                assert detail["entries"][-1]["payload"]["stop_reason"] == "aborted"
                # One turn, not two: recovery settled the admitted operation.
                turns = (await client.get("/api/sessions/s-1/turns")).json()
                assert [turn["operation_id"] for turn in turns["items"]] == [operation_id]

                # The lane is free again, and the session keeps working.
                lanes = (await client.get("/api/sessions/s-1/lanes")).json()
                assert lanes["items"][0]["operation_id"] is None
                assert (await client.post("/api/sessions/s-1/lanes/main/recover")).json()["result"] is None

                accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "next"})
                assert accepted.status_code == 202
                following = await _settled(client, "s-1", accepted.json()["operation_id"])
                assert following["summary"]["status"] == "completed"
                assert following["entries"][-1]["payload"]["content"] == "after the restart"
        finally:
            await second.aclose()

    asyncio.run(scenario())


def test_recover_is_refused_while_this_process_is_still_driving_the_lane(tmp_path: Path) -> None:
    async def scenario() -> None:
        gate = Gate()
        web = await _open(_config(tmp_path), Provider(gate))
        try:
            async with _client(web) as client:
                accepted = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "long"})
                operation_id = accepted.json()["operation_id"]
                await gate.started.wait()

                refused = await client.post("/api/sessions/s-1/lanes/main/recover")

                assert refused.status_code == 409
                assert "being driven" in refused.json()["error"]

                gate.release.set()
                assert (await _settled(client, "s-1", operation_id))["summary"]["status"] == "completed"
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_unknown_sessions_and_malformed_requests_are_client_errors(tmp_path: Path) -> None:
    async def scenario() -> None:
        web = await _open(_config(tmp_path), Provider())
        try:
            async with _client(web) as client:
                assert (await client.get("/api/sessions/nope/turns")).status_code == 404
                assert (await client.get("/api/sessions/nope/lanes")).status_code == 404

                bad_cursor = await client.get("/api/sessions/s-1/turns", params={"cursor": "not-a-cursor"})
                bad_limit = await client.get("/api/sessions/s-1/turns", params={"limit": "many"})
                zero_limit = await client.get("/api/sessions/s-1/turns", params={"limit": 0})
                empty_prompt = await client.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": ""})

                assert [response.status_code for response in (bad_cursor, bad_limit, zero_limit, empty_prompt)] == [
                    400,
                    400,
                    400,
                    400,
                ]
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_a_deployment_without_memory_or_skill_stores_reports_them_unavailable(tmp_path: Path) -> None:
    async def scenario() -> None:
        config = _config(tmp_path)
        web = create_app(config, Provider())
        await web.start()
        await web.supervisor.create_session("s-1")
        try:
            async with _client(web) as client:
                for path in ("/api/memory/l0", "/api/memory/l1", "/api/memory/l3", "/api/memory/jobs", "/api/skills"):
                    response = await client.get(path)
                    assert response.status_code == 503
                    assert "no memory store" in response.json()["error"] or "no skill store" in response.json()["error"]
        finally:
            await web.aclose()

        configured = await _open(config, Provider())
        try:
            async with _client(configured) as client:
                empty = {"items": [], "next_cursor": None}
                for path in (
                    "/api/memory/l0",
                    "/api/memory/l1",
                    "/api/memory/l2",
                    "/api/memory/jobs",
                    "/api/memory/audit",
                    "/api/skills",
                    "/api/skills/archives",
                    "/api/skills/jobs",
                    "/api/skills/audit",
                ):
                    assert (await client.get(path)).json() == empty, path
                assert (await client.get("/api/memory/l3")).json() == {"doctrine": None}
                assert (await client.get("/api/memory/l0/missing")).status_code == 404
                assert (await client.get("/api/skills/missing")).status_code == 404
        finally:
            await configured.aclose()

    asyncio.run(scenario())


def test_configured_tokens_gate_every_route_that_carries_data(tmp_path: Path) -> None:
    """Everything but the shell itself: the browser cannot set a header on a page load."""

    async def scenario() -> None:
        web = await _open(_config(tmp_path), Provider(), tokens={TOKEN: "operator"})
        try:
            async with _client(web) as anonymous:
                # The page and its modules are a navigation, not a fetch, and
                # carry no data; guarding them would make the UI unreachable.
                assert (await anonymous.get("/")).status_code == 200
                assert (await anonymous.get("/static/app.js")).status_code == 200
                assert (await anonymous.get("/api/project")).status_code == 401
                refused = await anonymous.post("/api/sessions/s-1/lanes/main/turns", json={"prompt": "hi"})
                assert refused.status_code == 401
                assert "credential" in refused.json()["error"]

            async with _client(web, token="wrong") as impostor:
                assert (await impostor.get("/api/sessions")).status_code == 401

            async with _client(web, token=TOKEN) as operator:
                assert (await operator.get("/api/project")).status_code == 200

                # A stream with no credential never starts, so the browser
                # cannot watch (or drive) anything without one.
                browser = Browser(web.app, "/api/sessions/s-1/lanes/main/events")
                await browser.open()
                await browser.wait()

                assert browser.status == 401
        finally:
            await web.aclose()

    asyncio.run(scenario())
