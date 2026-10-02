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


def build_capsule(*, repository_root: Path, output: Path, container_image: str) -> Capsule:
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
        benchmark_id="prale-experience-real-v2",
        repository="earendil-works/pi",
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
    if capsule.benchmark_id != "prale-experience-real-v2" or len(capsule.base_commit) != 40:
        raise RealExperienceError(f"{path}: unsupported capsule")
    if not archive.is_file() or sha256(archive) != capsule.source_digest:
        raise RealExperienceError(f"{path}: source archive is missing or has the wrong digest")
    return capsule


def materialize_stage(*, capsule: Capsule, fixture: Path, destination: Path) -> Path:
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
    shutil.copy2(fixture / "TASK.md", destination / "TASK.md")
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
) -> dict[str, Any]:
    """Run one independent stage and evaluate it with an oracle outside cwd."""

    if not allow_host_execution:
        raise RealExperienceError("host execution is disabled; run inside the pinned container or opt in explicitly")
    if not (fixture / "TASK.md").is_file() or not (fixture / "oracle.py").is_file():
        raise RealExperienceError(f"fixture is incomplete: {fixture}")
    with tempfile.TemporaryDirectory(prefix="prale-real-eval-") as temporary:
        root = Path(temporary)
        workspace = materialize_stage(capsule=capsule, fixture=fixture, destination=root / "workspace")
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
            agent_output = ((error.stdout or "") + (error.stderr or ""))[-20_000:]
        oracle = subprocess.run(
            ["python", str(fixture / "oracle.py"), str(workspace)], capture_output=True, text=True, check=False
        )
        diff = _git(workspace, "diff", "--binary", "HEAD")
        adapter_result = _last_json_object(agent_output)
        return {
            "acceptance": "passed" if oracle.returncode == 0 else "failed",
            "agent_status": agent_status,
            "duration_seconds": round(time.monotonic() - started, 3),
            "agent_output": agent_output,
            "oracle_output": (oracle.stdout + oracle.stderr)[-20_000:],
            "diff_sha256": hashlib.sha256(diff.stdout.encode()).hexdigest(),
            "files_changed": _changed_files(workspace),
            "adapter_result": adapter_result,
        }


def _changed_files(workspace: Path) -> list[str]:
    completed = _git(workspace, "diff", "--name-only", "HEAD")
    return [line for line in completed.stdout.splitlines() if line]


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
    for member in archive.getmembers():
        if member.issym() or member.islnk() or not (root / member.name).resolve().is_relative_to(root):
            raise RealExperienceError(f"unsafe archive member: {member.name}")
    archive.extractall(destination, filter="data")


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
