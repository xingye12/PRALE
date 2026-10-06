import json
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


def test_stage_audits_agent_commits_and_untracked_files(tmp_path: Path) -> None:
    source, fixture = _source(tmp_path), _fixture(tmp_path)
    capsule = build_capsule(repository_root=source, output=tmp_path / "capsule", container_image="node@sha256:test")
    command = (
        sys.executable,
        "-c",
        "from pathlib import Path; import subprocess; "
        "Path('app.txt').write_text('working\\n'); Path('evidence.txt').write_text('proof\\n'); "
        "Path('.git/info/exclude').write_text('ignored-proof.txt\\n'); "
        "Path('ignored-proof.txt').write_text('ignored proof\\n'); "
        "subprocess.run(['git', 'add', 'app.txt'], check=True); "
        "subprocess.run(['git', 'commit', '-m', 'agent fix'], check=True)",
    )

    result = run_stage(
        capsule=capsule,
        fixture=fixture,
        agent_command=command,
        allow_host_execution=True,
        timeout_seconds=10,
    )

    assert result["acceptance"] == "passed"
    assert result["files_changed"] == ["app.txt", "evidence.txt", "ignored-proof.txt"]
    assert result["diff_sha256"] != "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_stage_archives_delivery_before_ephemeral_workspace_is_removed(tmp_path: Path) -> None:
    source, fixture = _source(tmp_path), _fixture(tmp_path)
    capsule = build_capsule(repository_root=source, output=tmp_path / "capsule", container_image="node@sha256:test")
    command = (
        sys.executable,
        "-c",
        "from pathlib import Path; import json; Path('.prale-eval').mkdir(); "
        "Path('.prale-eval/result.json').write_text(json.dumps({'task_id': '01', 'evidence': [{'path': 'app.txt'}]})); "
        "Path('app.txt').write_text('working\\n')",
    )
    archive = tmp_path / "submissions" / "learn" / "01"

    result = run_stage(
        capsule=capsule,
        fixture=fixture,
        agent_command=command,
        allow_host_execution=True,
        timeout_seconds=10,
        submission_dir=archive,
    )

    assert result["submission"]["delivery_present"] is True
    assert json.loads((archive / ".prale-eval" / "result.json").read_text()) == {
        "task_id": "01",
        "evidence": [{"path": "app.txt"}],
    }
    assert (archive / "TASK.md").is_file()
    assert (archive / "workspace.diff").is_file()
    assert (archive / "sources" / "app.txt").read_text(encoding="utf-8") == "working\n"


def test_crossrepo_stage_archives_controller_replay_separately(tmp_path: Path) -> None:
    source, fixture = _source(tmp_path), _fixture(tmp_path)
    capsule = build_capsule(
        repository_root=source,
        output=tmp_path / "capsule",
        container_image="python@test",
        benchmark_id="prale-experience-crossrepo-v1",
    )
    command = (
        sys.executable,
        "-c",
        "from pathlib import Path; import json; Path('.prale-eval').mkdir(); "
        "Path('.prale-eval/result.json').write_text(json.dumps({'mode': 'operate', "
        f"'validation': {{'command': {sys.executable!r} + ' check.py'}}, "
        "'evidence': [{'path': 'check.py'}]})); "
        "Path('check.py').write_text(\"print('observed-output')\\n\"); "
        "Path('app.txt').write_text('working\\n')",
    )
    archive = tmp_path / "archive"

    result = run_stage(
        capsule=capsule,
        fixture=fixture,
        agent_command=command,
        allow_host_execution=True,
        timeout_seconds=10,
        submission_dir=archive,
    )

    assert result["acceptance"] == "passed"
    assert result["execution"]["exit_code"] == 0
    assert (archive / "execution/stdout.txt").read_text() == "observed-output\n"
    assert json.loads((archive / "manifest.json").read_text())["execution_sha256"]
    assert (archive / "sources/check.py").is_file()
    assert "check.py" in (archive / "workspace.diff").read_text()


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


def test_materialization_preserves_safe_relative_git_archive_symlinks(tmp_path: Path) -> None:
    source = _source(tmp_path)
    (source / "docs").mkdir()
    (source / "docs" / "guide.md").write_text("guide\n", encoding="utf-8")
    (source / "website").mkdir()
    (source / "website" / "guide.md").symlink_to("../docs/guide.md")
    _git(source, "add", "docs/guide.md", "website/guide.md")
    _git(source, "commit", "-m", "add docs link")
    capsule = build_capsule(repository_root=source, output=tmp_path / "capsule", container_image="node@sha256:test")

    workspace = materialize_stage(capsule=capsule, fixture=_fixture(tmp_path), destination=tmp_path / "workspace")

    assert (workspace / "website" / "guide.md").is_symlink()
    assert (workspace / "website" / "guide.md").read_text(encoding="utf-8") == "guide\n"


def _git_output(root: Path, *arguments: str) -> str:
    return subprocess.run(
        ["git", "-C", str(root), *arguments], check=True, capture_output=True, text=True
    ).stdout.strip()
