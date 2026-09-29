"""Phase 5's static assets: served by the adapter, and still in step with it.

The SPA has no build step (ADR-WEB-005), so nothing compiles the front end
against the API: the two can drift silently until a page 404s in a browser.
These tests run at the HTTP layer and read the shipped modules as text, which
is the only contract check available without a browser toolchain in the repo.

What they *can* prove:
  * the shell and every asset it references are served;
  * every ``/api/...`` path a module builds is a route the adapter registers;
  * the display contract's hard rules hold in the source (durations come from
    the domain's ``duration_ms``, agent text never goes through ``innerHTML``);
  * each view can render an empty state and a not-configured deployment.

What they cannot: that the page looks right.  That needs a browser.
"""

import asyncio
import re
from pathlib import Path

import httpx

from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.web import STATIC_DIR, WebApplication, create_app
from agent_harness.runtime.generation import AssistantResult, GenerationRequest

REPOSITORY_ID = "git@example.com:owner/repo.git"
VIEW_MODULES = ("chat.js", "trace.js", "memory.js", "skills.js")
MODULES = ("app.js", "api.js", "dom.js", "format.js", *VIEW_MODULES)

# A path a module builds, with its interpolations normalised: the adapter
# registers ``/sessions/{session_id}/turns``, the module writes
# ``/sessions/${encodeURIComponent(id)}/turns``.
_PATHS = {"sessions", "memory", "skills", "project"}
_STRING_LITERAL = re.compile(r"""["'`](/[^"'`\n]*)""")
_INTERPOLATION = re.compile(r"\$\{[^}]*\}")
_ROUTE_PARAM = re.compile(r"\{[^}]*\}")
_REFERENCED_ASSET = re.compile(r"""(?:src|href)="(/static/[^"]+)""")

# The source guards are about code, not prose: these modules explain their
# rules in comments, and a sentence like "never subtract ``ended_at -
# started_at``" must not read as the violation it warns about.
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_LINE_COMMENT = re.compile(r"(?m)^\s*//.*$")
_TRAILING_COMMENT = re.compile(r"(?m)\s//\s.*$")


class _Provider:
    async def generate(self, request: GenerationRequest) -> AssistantResult:
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


async def _open(tmp_path: Path) -> WebApplication:
    web = create_app(_config(tmp_path), _Provider())
    await web.start()
    return web


def _source(name: str) -> str:
    return (STATIC_DIR / name).read_text(encoding="utf-8")


def _code(name: str) -> str:
    """One module with its comments removed, for the source-level guards."""

    source = _BLOCK_COMMENT.sub("", _source(name))
    return _TRAILING_COMMENT.sub("", _LINE_COMMENT.sub("", source))


def _normalise(path: str) -> str:
    return _ROUTE_PARAM.sub("{x}", _INTERPOLATION.sub("{x}", path))


def _api_paths(source: str) -> set[str]:
    found = set()
    for literal in _STRING_LITERAL.findall(source):
        head = literal.lstrip("/").split("/", 1)[0]
        if head in _PATHS:
            found.add("/api" + _normalise(literal))
    return found


def test_the_shell_and_every_asset_it_references_are_served(tmp_path: Path) -> None:
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    referenced = _REFERENCED_ASSET.findall(html)
    assert referenced, "the shell references no assets"

    async def scenario() -> None:
        web = await _open(tmp_path)
        try:
            transport = httpx.ASGITransport(app=web.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                page = await client.get("/")
                assert page.status_code == 200
                assert page.headers["content-type"].startswith("text/html")
                assert "/static/app.js" in page.text

                # The four nav entries the spec asks for (§4 前端布局).
                for label in ("对话", "轨迹", "记忆", "技能"):
                    assert label in page.text

                for asset in referenced:
                    response = await client.get(asset)
                    assert response.status_code == 200, asset
                    assert response.content, asset

                for name in MODULES:
                    response = await client.get(f"/static/{name}")
                    assert response.status_code == 200, name
                    assert "javascript" in response.headers["content-type"], name

                missing = await client.get("/static/not-a-module.js")
                assert missing.status_code == 404
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_every_api_path_the_modules_build_is_a_registered_route(tmp_path: Path) -> None:
    async def scenario() -> None:
        web = await _open(tmp_path)
        try:
            routes = {
                _normalise(route.path) for route in web.app.routes if getattr(route, "path", "").startswith("/api")
            }
            assert routes, "the adapter registered no API routes"

            referenced: set[str] = set()
            for name in MODULES:
                referenced |= _api_paths(_source(name))

            unknown = sorted(referenced - routes)
            assert not unknown, f"modules call API paths the adapter does not serve: {unknown}"

            # The reverse direction is informational, not a failure: the adapter
            # may expose more than one page uses (the audit views are optional,
            # and a deployment can serve only part of the UI).
            print(f"routes not referenced by the SPA: {sorted(routes - referenced)}")
        finally:
            await web.aclose()

    asyncio.run(scenario())


def test_no_duration_is_re_derived_from_timestamps() -> None:
    for name in MODULES:
        # ``EffectSpan.duration_ms`` is a domain rule (``None`` for pending and
        # unknown); subtracting timestamps would invent a duration the record
        # cannot prove.
        code = _code(name)
        assert not re.search(r"ended_at\s*-\s*started_at", code), name
        assert not re.search(r"started_at\s*-\s*ended_at", code), name

    rendering = _code("trace.js") + _code("chat.js")
    assert "duration_ms" in rendering, "the views no longer read the domain's duration"


def test_agent_text_never_goes_through_inner_html() -> None:
    for name in MODULES:
        code = _code(name)
        assert "innerHTML" not in code, name
        assert "outerHTML" not in code, name
        assert "insertAdjacentHTML" not in code, name


def test_chat_treats_message_updates_as_incremental_content() -> None:
    """The runtime sends one delta per update, so the live bubble appends it once."""

    code = _code("chat.js")
    assert 'live.text += typeof data.data?.content === "string" ? data.data.content : ""' in code


def test_chat_refetches_settled_messages_and_renders_markdown_safely() -> None:
    chat = _code("chat.js")
    dom = _code("dom.js")

    assert 'name === "message_end"' in chat
    assert "details.delete(data.operation_id)" in chat
    assert "const wanted = turns;" in chat
    assert "markdown(content)" in chat
    assert "export function markdown(text)" in dom
    assert "document.createElement" in dom


def test_tool_results_start_collapsed_in_chat_and_trace() -> None:
    """Verbose durable tool output must not dominate either primary view."""

    for name in ("chat.js", "trace.js"):
        code = _code(name)
        assert 'class: "tool-result"' in code, name
        assert "text: `工具返回结果${callId}（点击展开）`" in code, name
        assert '"open"' not in code, name


def test_each_view_renders_an_empty_state_and_an_unavailable_state() -> None:
    for name in VIEW_MODULES:
        source = _source(name)
        assert "empty(" in source, f"{name} renders no empty state"
        assert "notice(" in source, f"{name} cannot report an unavailable store"

    for name in ("memory.js", "skills.js"):
        assert "未配置" in _source(name), name


def test_the_app_wires_all_four_views() -> None:
    source = _source("app.js")
    for name in VIEW_MODULES:
        assert f'from "./{name}"' in source, name
        assert f"{name.split('.')[0]}: create" in source, name


def test_the_stream_client_sends_credentials_as_a_header() -> None:
    """EventSource cannot set headers, so the stream is read with ``fetch``.

    A credentialed deployment must not be forced to put its token in the URL,
    where it would land in access logs (phase 6 redacts them, but a token that
    is never in the URL is better than one that is redacted).
    """

    code = _code("api.js")
    assert "EventSource" not in code
    assert "Last-Event-ID" in code
    assert "Authorization" in code
