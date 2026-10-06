"""Materialise and score reproducible, real-repository experience evaluations.

The module deliberately does not run an agent itself.  PRALE and Claude Code
have different launchers, but both can be invoked against the same frozen
workspace by :func:`run_stage`.  The agent command is an explicitly opted-in
host escape hatch; production runs are expected to invoke this module inside
the container named by the capsule manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class RealExperienceError(ValueError):
    """A malformed or unsafe real-repository evaluation fixture."""


@dataclass(frozen=True, slots=True)
class Capsule:
    benchmark_id: str
    repository: str
    base_commit: str
    source_archive: Path
    source_digest: str
    container_image: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def build_capsule(
    *,
    repository_root: Path,
    output: Path,
    container_image: str,
    benchmark_id: str = "prale-experience-real-v2",
    repository: str = "earendil-works/pi",
) -> Capsule:
    """Freeze committed repository content into a portable tar archive.

    ``git archive`` reads a commit object, so uncommitted files in the source
    worktree never enter the benchmark.  The output manifest is written only
    after the archive digest has been calculated.
    """

    root = repository_root.resolve()
    commit = _git(root, "rev-parse", "HEAD").stdout.strip()
    if len(commit) != 40:
        raise RealExperienceError(f"could not resolve a full HEAD commit in {root}")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "source.tar"
    with archive.open("wb") as target:
        completed = subprocess.run(
            ["git", "-C", str(root), "archive", "--format=tar", commit],
            stdout=target,
            stderr=subprocess.PIPE,
            text=False,
        )
    if completed.returncode:
        raise RealExperienceError("git archive failed")
    capsule = Capsule(
        benchmark_id=benchmark_id,
        repository=repository,
        base_commit=commit,
        source_archive=archive,
        source_digest=sha256(archive),
        container_image=container_image,
    )
    (output / "capsule.json").write_text(
        json.dumps(
            {
                "benchmark_id": capsule.benchmark_id,
                "repository": capsule.repository,
                "base_commit": capsule.base_commit,
                "source_archive": archive.name,
                "source_digest": capsule.source_digest,
                "container_image": capsule.container_image,
                "network": "disabled",
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return capsule


def load_capsule(path: Path) -> Capsule:
    value = _object(path)
    try:
        archive = path.parent / _text(value, "source_archive")
        capsule = Capsule(
            benchmark_id=_text(value, "benchmark_id"),
            repository=_text(value, "repository"),
            base_commit=_text(value, "base_commit"),
            source_archive=archive,
            source_digest=_text(value, "source_digest"),
            container_image=_text(value, "container_image"),
        )
    except KeyError as error:
        raise RealExperienceError(f"{path}: missing {error.args[0]}") from error
    if (
        capsule.benchmark_id not in {"prale-experience-real-v2", "prale-experience-crossrepo-v1"}
        or len(capsule.base_commit) != 40
    ):
        raise RealExperienceError(f"{path}: unsupported capsule")
    if not archive.is_file() or sha256(archive) != capsule.source_digest:
        raise RealExperienceError(f"{path}: source archive is missing or has the wrong digest")
    return capsule


def materialize_stage(*, capsule: Capsule, fixture: Path, destination: Path, task_text: str | None = None) -> Path:
    """Extract one source snapshot, apply its mutation, then hide the diff.

    The fixture patch is deliberately committed as ``fixture baseline`` before
    the agent starts.  An agent can inspect its own changes but cannot recover
    the answer using ``git diff`` against the unmutated upstream source.
    """

    if destination.exists():
        raise RealExperienceError(f"destination already exists: {destination}")
    with tarfile.open(capsule.source_archive) as archive:
        _safe_extract(archive, destination)
    patch = (fixture / "mutation.patch").resolve()
    if patch.is_file() and patch.read_text(encoding="utf-8").strip():
        applied = subprocess.run(["git", "apply", str(patch)], cwd=destination, capture_output=True, text=True)
        if applied.returncode:
            raise RealExperienceError(f"could not apply {patch}: {applied.stderr.strip()}")
    if task_text is None:
        shutil.copy2(fixture / "TASK.md", destination / "TASK.md")
    else:
        (destination / "TASK.md").write_text(task_text, encoding="utf-8")
    _git(destination, "init")
    _git(destination, "config", "user.email", "fixture@example.invalid")
    _git(destination, "config", "user.name", "PRALE real-eval fixture")
    _git(destination, "add", "--all")
    committed = _git(destination, "commit", "-m", "fixture baseline")
    if committed.returncode:
        raise RealExperienceError(f"could not commit fixture baseline: {committed.stderr.strip()}")
    return destination


def run_stage(
    *,
    capsule: Capsule,
    fixture: Path,
    agent_command: Sequence[str],
    allow_host_execution: bool,
    timeout_seconds: float,
    task_text: str | None = None,
    oracle_stage_token: str | None = None,
    submission_dir: Path | None = None,
    validation_timeout_seconds: float = 60,
) -> dict[str, Any]:
    """Run one independent stage and evaluate it with an oracle outside cwd."""

    if not allow_host_execution:
        raise RealExperienceError("host execution is disabled; run inside the pinned container or opt in explicitly")
    if validation_timeout_seconds <= 0:
        raise RealExperienceError("validation timeout must be positive")
    if not (fixture / "TASK.md").is_file() or not (fixture / "oracle.py").is_file():
        raise RealExperienceError(f"fixture is incomplete: {fixture}")
    with tempfile.TemporaryDirectory(prefix="prale-real-eval-") as temporary:
        root = Path(temporary)
        workspace = materialize_stage(
            capsule=capsule, fixture=fixture, destination=root / "workspace", task_text=task_text
        )
        baseline = _git(workspace, "rev-parse", "HEAD").stdout.strip()
        if not baseline:
            raise RealExperienceError("could not resolve fixture baseline commit")
        before = _workspace_snapshot(workspace)
        home = root / "home"
        home.mkdir()
        (root / "tmp").mkdir()
        environment = {"HOME": str(home), "TMPDIR": str(root / "tmp"), "PRALE_EVAL_WORKSPACE": str(workspace)}
        started = time.monotonic()
        try:
            completed = subprocess.run(
                [piece.replace("{workspace}", str(workspace)) for piece in agent_command],
                cwd=workspace,
                env={**os.environ, **environment},
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
            agent_status = "completed" if completed.returncode == 0 else "failed"
            agent_output = (completed.stdout + completed.stderr)[-20_000:]
        except subprocess.TimeoutExpired as error:
            agent_status = "timed_out"
            timeout_stdout = (
                error.stdout.decode("utf-8", errors="replace") if isinstance(error.stdout, bytes) else error.stdout
            )
            timeout_stderr = (
                error.stderr.decode("utf-8", errors="replace") if isinstance(error.stderr, bytes) else error.stderr
            )
            agent_output = ((timeout_stdout or "") + (timeout_stderr or ""))[-20_000:]
        oracle_command = ["python", str(fixture / "oracle.py"), str(workspace)]
        if oracle_stage_token is not None:
            oracle_command.append(oracle_stage_token)
        oracle = subprocess.run(oracle_command, capture_output=True, text=True, check=False)
        after = _workspace_snapshot(workspace)
        snapshot_delta = _snapshot_delta(before, after)
        diff = _workspace_diff(workspace, baseline) + snapshot_delta
        stage_duration_seconds = round(time.monotonic() - started, 3)
        execution_dir = root / "execution"
        execution = (
            _capture_validation(workspace, execution_dir, timeout_seconds=validation_timeout_seconds)
            if capsule.benchmark_id == "prale-experience-crossrepo-v1"
            else None
        )
        adapter_result = _last_json_object(agent_output)
        result = {
            "acceptance": "passed" if oracle.returncode == 0 else "failed",
            "agent_status": agent_status,
            "duration_seconds": stage_duration_seconds,
            "agent_output": agent_output,
            "oracle_output": (oracle.stdout + oracle.stderr)[-20_000:],
            "diff_sha256": hashlib.sha256(diff.encode()).hexdigest(),
            "files_changed": sorted(set(_changed_files(workspace, baseline)).union(_snapshot_changed(before, after))),
            "adapter_result": adapter_result,
        }
        if execution is not None:
            result["execution"] = execution
        if submission_dir is not None:
            result["submission"] = _archive_submission(
                workspace=workspace,
                destination=submission_dir,
                task_text=task_text or (workspace / "TASK.md").read_text(encoding="utf-8"),
                diff=diff,
                result=result,
                execution_dir=execution_dir if execution is not None else None,
            )
    return result


def _capture_validation(workspace: Path, destination: Path, *, timeout_seconds: float) -> dict[str, Any]:
    """Replay the declared command in a copy; retain controller-owned, unabridged streams.

    This is evidence collection, not a task-specific behavioral oracle. Host
    execution uses the caller's existing opt-in; container policy supplies isolation.
    """
    destination.mkdir(parents=True)
    record: dict[str, Any] = {
        "version": 1,
        "origin": "controller_replay",
        "command": None,
        "status": "not_run",
        "exit_code": None,
        "timeout_seconds": timeout_seconds,
        "duration_seconds": 0,
        "stdout": "stdout.txt",
        "stderr": "stderr.txt",
    }
    for name in ("stdout.txt", "stderr.txt"):
        (destination / name).write_bytes(b"")
    try:
        submission = json.loads((workspace / ".prale-eval/result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        submission = {}
    validation = submission.get("validation") if isinstance(submission, dict) else None
    command = validation.get("command") if isinstance(validation, dict) else None
    if isinstance(submission, dict) and submission.get("mode") == "explore":
        record["reason"] = "exploration does not require executable validation"
    elif not isinstance(command, str) or not command.strip():
        record["reason"] = "missing executable validation.command"
    else:
        record["command"] = command
        with tempfile.TemporaryDirectory(prefix="prale-validation-", dir=destination.parent) as temporary:
            root = Path(temporary)
            replay = root / "workspace"
            shutil.copytree(workspace, replay, symlinks=True)
            (root / "home").mkdir()
            (root / "tmp").mkdir()
            environment = {
                **os.environ,
                "HOME": str(root / "home"),
                "TMPDIR": str(root / "tmp"),
                "PRALE_EVAL_WORKSPACE": str(replay),
            }
            started = time.monotonic()
            with (destination / "stdout.txt").open("wb") as stdout, (destination / "stderr.txt").open("wb") as stderr:
                try:
                    process = subprocess.Popen(
                        ["bash", "-o", "pipefail", "-c", command],
                        cwd=replay,
                        env=environment,
                        stdin=subprocess.DEVNULL,
                        stdout=stdout,
                        stderr=stderr,
                        start_new_session=True,
                    )
                    try:
                        process.wait(timeout=timeout_seconds)
                        record["status"] = "completed"
                    except subprocess.TimeoutExpired:
                        record["status"] = "timed_out"
                    finally:
                        # Also stop children left running after their shell exits.
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                    record["exit_code"] = process.returncode
                except OSError as error:
                    record["status"] = "launch_failed"
                    record["reason"] = str(error)
            record["duration_seconds"] = round(time.monotonic() - started, 3)
            if (replay / ".prale-eval").is_dir():
                shutil.copytree(replay / ".prale-eval", destination / "artifacts", symlinks=True)
    record["stdout_sha256"] = sha256(destination / "stdout.txt")
    record["stderr_sha256"] = sha256(destination / "stderr.txt")
    (destination / "execution.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    return record


def _archive_submission(
    *,
    workspace: Path,
    destination: Path,
    task_text: str,
    diff: str,
    result: Mapping[str, Any],
    execution_dir: Path | None = None,
) -> dict[str, Any]:
    """Persist the agent's deliverable before the ephemeral workspace is removed."""

    if destination.exists():
        raise RealExperienceError(f"refusing to overwrite submission archive: {destination}")
    destination.mkdir(parents=True)
    delivery = workspace / ".prale-eval"
    if delivery.is_dir():
        shutil.copytree(delivery, destination / ".prale-eval")
    _archive_cited_sources(workspace, delivery / "result.json", destination / "sources")
    (destination / "TASK.md").write_text(task_text, encoding="utf-8")
    (destination / "workspace.diff").write_text(diff, encoding="utf-8")
    if execution_dir is not None:
        shutil.copytree(execution_dir, destination / "execution", symlinks=True)
    manifest = {
        "acceptance": result["acceptance"],
        "agent_status": result["agent_status"],
        "diff_sha256": result["diff_sha256"],
        "files_changed": result["files_changed"],
        "task_sha256": hashlib.sha256(task_text.encode()).hexdigest(),
    }
    if execution_dir is not None:
        manifest["execution_sha256"] = sha256(destination / "execution" / "execution.json")
    (destination / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return {
        "path": str(destination),
        "delivery_present": delivery.is_dir(),
        "manifest_sha256": sha256(destination / "manifest.json"),
    }


def _archive_cited_sources(workspace: Path, result_path: Path, destination: Path) -> None:
    """Copy only source files cited by the submission for later blinded review."""

    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(result, Mapping) or not isinstance(result.get("evidence"), list):
        return
    for evidence in result["evidence"]:
        if not isinstance(evidence, Mapping) or not isinstance(evidence.get("path"), str):
            continue
        relative = Path(evidence["path"])
        source = workspace / relative
        if source.is_file() and source.resolve().is_relative_to(workspace.resolve()):
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def _workspace_diff(workspace: Path, baseline: str) -> str:
    """Return the complete agent delta, including ignored generated artifacts."""

    diff = _git(workspace, "diff", "--binary", baseline, "--")
    chunks = [diff.stdout]
    for path in _nonbaseline_files(workspace):
        added = subprocess.run(
            ["git", "-C", str(workspace), "diff", "--binary", "--no-index", "/dev/null", path],
            capture_output=True,
            text=True,
            check=False,
        )
        # git diff --no-index returns 1 when it found a difference.
        if added.returncode not in {0, 1}:
            raise RealExperienceError(f"could not collect untracked diff for {path}: {added.stderr.strip()}")
        chunks.append(added.stdout)
    return "".join(chunks)


def _changed_files(workspace: Path, baseline: str) -> list[str]:
    completed = _git(workspace, "diff", "--name-only", baseline, "--")
    tracked = completed.stdout.splitlines()
    return sorted(set(tracked).union(_nonbaseline_files(workspace)))


def _nonbaseline_files(workspace: Path) -> list[str]:
    """List every non-tracked path, including agent-created ignored files.

    Evaluation delivery is conventionally written below ``.prale-eval/``. A
    repository may ignore that directory, so ``--exclude-standard`` alone
    would otherwise make a successful agent look like it changed nothing.
    """

    untracked = _git(workspace, "ls-files", "--others", "--exclude-standard").stdout.splitlines()
    ignored = _git(workspace, "ls-files", "--others", "--ignored", "--exclude-standard").stdout.splitlines()
    return sorted(set(untracked).union(ignored))


def _workspace_snapshot(workspace: Path) -> dict[str, str]:
    """Hash regular workspace files independently of Git's ignore machinery."""

    snapshot: dict[str, str] = {}
    for path in workspace.rglob("*"):
        relative = path.relative_to(workspace)
        if ".git" in relative.parts or path.is_symlink() or not path.is_file():
            continue
        snapshot[relative.as_posix()] = sha256(path)
    return snapshot


def _snapshot_changed(before: Mapping[str, str], after: Mapping[str, str]) -> list[str]:
    return sorted(path for path in before.keys() | after.keys() if before.get(path) != after.get(path))


def _snapshot_delta(before: Mapping[str, str], after: Mapping[str, str]) -> str:
    return "".join(
        f"snapshot {path} {before.get(path, '-')} {after.get(path, '-')}\n" for path in _snapshot_changed(before, after)
    )


def _last_json_object(output: str) -> dict[str, Any] | None:
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _safe_extract(archive: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    members = archive.getmembers()
    symlinks: list[tarfile.TarInfo] = []
    for member in members:
        member_path = root / member.name
        if not member_path.resolve().is_relative_to(root):
            raise RealExperienceError(f"unsafe archive member: {member.name}")
        if member.issym():
            # Git archives can contain legitimate relative documentation links.
            # Extract them only after ordinary files, and only if the link target
            # also stays inside the workspace root.
            link_target = member_path.parent / member.linkname
            if not link_target.resolve().is_relative_to(root):
                raise RealExperienceError(f"unsafe archive symlink: {member.name}")
            symlinks.append(member)
        elif member.islnk() or not (member.isdir() or member.isreg()):
            raise RealExperienceError(f"unsafe archive member: {member.name}")
    for member in members:
        if not member.issym():
            # The complete member set was validated above before anything was
            # created, including every path and supported file type.
            archive.extract(member, path=destination, set_attrs=True, filter="fully_trusted")
    for member in symlinks:
        target = destination / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(member.linkname, target)


def _git(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, text=True, check=False)


def _object(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RealExperienceError(f"could not read {path}: {error}") from error
    if not isinstance(value, Mapping):
        raise RealExperienceError(f"{path}: expected an object")
    return value


def _text(value: Mapping[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise KeyError(key)
    return item
