"""The startup script: convenience, held to the same rules as the entry point.

``deploy/start-web.sh`` exists so a local run does not need a memorised list of
exports, and everything it decides is a deployment decision — a scope, a data
directory, whether a credential is set.  So it gets the same treatment as
``serve.py``: no credential in its output, no invented scope, and one command
that really serves.

The script runs in a subprocess with a deliberately small environment, from a
working directory with nothing in it.
"""

import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

REPOSITORY_ID = "git@example.com:owner/repo.git"
API_KEY = "sk-launcher-secret-000"
REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "deploy" / "start-web.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="the launcher is a bash script")


def _environment(tmp_path: Path, config: Path | None = None) -> dict[str, str]:
    """No inherited configuration: neither an installed package nor a per-user
    config file may stand in for what a test is checking, and the working
    directory is empty so the package is importable only through the path the
    script adds itself."""

    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    environment = {"PATH": os.environ["PATH"], "HOME": str(home), "LANG": "C.UTF-8"}
    if config is not None:
        environment["PRALE_CONFIG"] = str(config)
    return environment


def _write_config(tmp_path: Path, **values: str) -> Path:
    config = tmp_path / "web.env"
    config.write_text("\n".join(f'{name}="{value}"' for name, value in values.items()) + "\n", encoding="utf-8")
    return config


def _launch(tmp_path: Path, *args: str, config: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(SCRIPT), *args],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        env=_environment(tmp_path, config),
        timeout=120,
        check=False,
    )


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _await_health(process: subprocess.Popen[bytes], port: int, timeout: float = 30.0) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    last_error = "no attempt"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"the launcher exited with {process.returncode} before answering")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as response:
                assert response.status == 200
                return json.loads(response.read())  # type: ignore[no-any-return]
        except (OSError, urllib.error.URLError) as error:  # not up yet, or not listening
            last_error = repr(error)
        time.sleep(0.1)
    raise AssertionError(f"no answer on port {port} within {timeout}s ({last_error})")


def test_the_launcher_describes_itself_and_the_server_options(tmp_path: Path) -> None:
    result = _launch(tmp_path, "--help")
    assert result.returncode == 0, result.stderr
    assert "Start one deployment" in result.stdout
    assert "usage: prale-web" in result.stdout


def test_the_launcher_refuses_to_invent_a_scope(tmp_path: Path) -> None:
    """A guessed scope reads as an empty one; the run stops instead."""

    result = _launch(tmp_path, "--print-config")
    assert result.returncode == 2
    assert "PRALE_REPOSITORY_ID is required" in result.stderr
    assert "PRALE_REPOSITORY_ID" not in result.stdout


def test_the_launcher_prints_a_configured_deployment_without_touching_the_disk(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    config = _write_config(
        tmp_path,
        PRALE_REPOSITORY_ID=REPOSITORY_ID,
        PRALE_API_KEY=API_KEY,
        PRALE_DATA_DIR=data_dir,
        PRALE_TOOLS="read",
    )

    result = _launch(tmp_path, "--print-config", config=config)
    assert result.returncode == 0, result.stderr
    assert f"repository_id     {REPOSITORY_ID}" in result.stdout
    assert "api_key           <set>" in result.stdout
    assert API_KEY not in result.stdout + result.stderr
    # Answering "what did I configure?" is not a deployment: it opens nothing.
    assert not data_dir.exists()


def test_one_command_serves_a_deployment_and_stops_it(tmp_path: Path) -> None:
    """The point of the script, from outside: launch, answer, exit on signal."""

    data_dir = tmp_path / "data"
    port = _free_port()
    config = _write_config(
        tmp_path,
        PRALE_REPOSITORY_ID=REPOSITORY_ID,
        PRALE_API_KEY=API_KEY,
        PRALE_DATA_DIR=data_dir,
        PRALE_TOOLS="read",
        PRALE_PORT=str(port),
    )
    log = tmp_path / "launcher.log"

    with log.open("wb") as sink:
        process = subprocess.Popen(
            [str(SCRIPT)],
            stdout=sink,
            stderr=subprocess.STDOUT,
            cwd=str(tmp_path),
            env=_environment(tmp_path, config),
        )
    try:
        body = _await_health(process, port)
        assert body["status"] == "ok"
        assert body["project"] == {"repository_id": REPOSITORY_ID, "project_id": REPOSITORY_ID}
        # A first run made the layout it was pointed at.
        assert (data_dir / "catalog.sqlite").is_file()
        assert (data_dir / "sessions").is_dir()

        process.terminate()
        # uvicorn restores the default disposition and re-raises the signal it
        # caught, so a *graceful* SIGTERM exit reports -15 rather than 0.  The
        # log is what says the shutdown was the server's own.
        assert process.wait(timeout=30) in (0, -signal.SIGTERM)
    finally:
        if process.poll() is None:  # a failing assertion must not leave a server
            process.kill()
            process.wait(timeout=30)

    output = log.read_text(encoding="utf-8")
    assert "Shutting down" in output
    assert "Application shutdown complete." in output
    assert f"start-web: open http://127.0.0.1:{port}/" in output
    assert "unauthenticated" in output  # no PRALE_TOKENS in this deployment
    assert API_KEY not in output  # still true of everything the run printed
    assert "Traceback" not in output


def test_shutdown_deadline_ends_a_long_lived_sse_connection(tmp_path: Path) -> None:
    """A browser event stream must not make the first shutdown signal hang forever."""

    port = _free_port()
    config = _write_config(
        tmp_path,
        PRALE_REPOSITORY_ID=REPOSITORY_ID,
        PRALE_API_KEY=API_KEY,
        PRALE_DATA_DIR=tmp_path / "data",
        PRALE_PORT=str(port),
        PRALE_GRACEFUL_SHUTDOWN_SECONDS="1",
    )
    log = tmp_path / "sse-shutdown.log"
    connection: http.client.HTTPConnection | None = None
    with log.open("wb") as sink:
        process = subprocess.Popen(
            [str(SCRIPT)],
            stdout=sink,
            stderr=subprocess.STDOUT,
            cwd=str(tmp_path),
            env=_environment(tmp_path, config),
        )
    try:
        _await_health(process, port)
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/sessions",
            data=b'{"session_id":"sse-shutdown","lane":"main"}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            assert response.status == 201

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        connection.request("GET", "/api/sessions/sse-shutdown/lanes/main/events")
        stream = connection.getresponse()
        assert stream.status == 200
        assert stream.readline() == b"retry: 2000\n"

        started = time.monotonic()
        process.terminate()
        assert process.wait(timeout=5) in (0, -signal.SIGTERM)
        assert time.monotonic() - started < 4
    finally:
        if connection is not None:
            connection.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=30)

    assert "timeout graceful shutdown exceeded" in log.read_text(encoding="utf-8")
