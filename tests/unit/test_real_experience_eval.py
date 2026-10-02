import subprocess
import sys
from pathlib import Path

import pytest
from real_experience_eval import (
    RealExperienceError,
    build_capsule,
    load_capsule,
    materialize_stage,
    run_stage,
)


def _git(root: Path, *arguments: str) -> None:
    subprocess.run(["git", "-C", str(root), *arguments], check=True, capture_output=True, text=True)


def _source(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init")
    _git(source, "config", "user.email", "tests@example.invalid")
    _git(source, "config", "user.name", "PRALE tests")
    (source / "app.txt").write_text("working\n", encoding="utf-8")
    _git(source, "add", "app.txt")
    _git(source, "commit", "-m", "baseline")
    return source


def _fixture(tmp_path: Path) -> Path:
    fixture = tmp_path / "fixture"
    fixture.mkdir()
    (fixture / "TASK.md").write_text("Restore the application behavior and add a regression test.\n", encoding="utf-8")
    (fixture / "mutation.patch").write_text(
        "--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-working\n+broken\n", encoding="utf-8"
    )
    (fixture / "oracle.py").write_text(
        "import sys\nfrom pathlib import Path\n"
        "workspace = Path(sys.argv[1])\n"
        "raise SystemExit(0 if (workspace / 'app.txt').read_text() == 'working\\n' else 1)\n",
        encoding="utf-8",
    )
    return fixture


def test_capsule_uses_committed_content_not_a_dirty_pi_worktree(tmp_path: Path) -> None:
    source = _source(tmp_path)
    (source / "app.txt").write_text("dirty\n", encoding="utf-8")

    capsule = build_capsule(repository_root=source, output=tmp_path / "capsule", container_image="node@sha256:test")
    destination = tmp_path / "workspace"
    materialize_stage(capsule=capsule, fixture=_fixture(tmp_path), destination=destination)

    assert (destination / "app.txt").read_text(encoding="utf-8") == "broken\n"
    assert (destination / "TASK.md").is_file()
    assert _git_output(destination, "status", "--short") == ""
    assert load_capsule(tmp_path / "capsule" / "capsule.json") == capsule


def test_stage_requires_explicit_host_execution_and_oracle_is_external(tmp_path: Path) -> None:
    source, fixture = _source(tmp_path), _fixture(tmp_path)
    capsule = build_capsule(repository_root=source, output=tmp_path / "capsule", container_image="node@sha256:test")

    with pytest.raises(RealExperienceError, match="host execution"):
        run_stage(
            capsule=capsule,
            fixture=fixture,
            agent_command=(sys.executable, "-c", "pass"),
            allow_host_execution=False,
            timeout_seconds=1,
        )

    command = (sys.executable, "-c", "from pathlib import Path; Path('app.txt').write_text('working\\n')")
    result = run_stage(
        capsule=capsule,
        fixture=fixture,
        agent_command=command,
        allow_host_execution=True,
        timeout_seconds=10,
    )

    assert result["acceptance"] == "passed"
    assert result["files_changed"] == ["app.txt"]


def test_materialization_accepts_empty_fixture_patches_and_relative_fixture_paths(tmp_path: Path, monkeypatch) -> None:
    source = _source(tmp_path)
    capsule = build_capsule(repository_root=source, output=tmp_path / "capsule", container_image="node@sha256:test")
    fixture = _fixture(tmp_path)
    (fixture / "mutation.patch").write_text("", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    workspace = materialize_stage(
        capsule=capsule,
        fixture=Path("fixture"),
        destination=tmp_path / "workspace",
    )

    assert (workspace / "app.txt").read_text(encoding="utf-8") == "working\n"


def _git_output(root: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *arguments], check=True, capture_output=True, text=True
    ).stdout.strip()
