"""Run cross-repository continual learning, freeze it, then fork blinded transfer stages.

The controller is deliberately agnostic to agent implementation. It invokes the
existing PRALE/Claude Code adapter with the same stage materializer and creates
an immutable learning-state snapshot before any transfer task begins.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import json
import random
import re
import secrets
import shutil
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Literal

from real_experience_eval import RealExperienceError, load_capsule, run_stage

from agent_harness.domain.memory import GLOBAL_L3_SCOPE, MemoryScope
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore

Adapter = Literal["prale", "claude-code"]


def _transfer_plan(pairs: list[Mapping[str, Any]], seed: int) -> dict[str, Any]:
    shuffled = list(pairs)
    random.Random(seed).shuffle(shuffled)
    return {
        "seed": seed,
        "stages": [
            {"public_id": f"T{position:02d}", "internal_id": _text(pair, "id")}
            for position, pair in enumerate(shuffled, start=1)
        ],
    }


def _planned_pairs(pairs: list[Mapping[str, Any]], plan: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    raw_stages = plan.get("stages")
    if not isinstance(raw_stages, list) or len(raw_stages) != len(pairs):
        raise RealExperienceError("transfer plan does not match the selected task set")
    by_id = {_text(pair, "id"): pair for pair in pairs}
    planned: list[tuple[str, Mapping[str, Any]]] = []
    for stage in raw_stages:
        item = _object(stage, "transfer plan stage")
        public_id, internal_id = _text(item, "public_id"), _text(item, "internal_id")
        if internal_id not in by_id or not public_id.startswith("T"):
            raise RealExperienceError("transfer plan contains an unknown or invalid stage")
        planned.append((public_id, by_id.pop(internal_id)))
    if by_id:
        raise RealExperienceError("transfer plan omits selected tasks")
    return planned


def _blinded_transfer_task(fixture: Path, internal_id: str, public_id: str) -> str:
    task = (fixture / "TASK.md").read_text(encoding="utf-8")
    header = f"# Cross-repository experience task transfer/{internal_id}"
    identity = f"`task_id` exactly `{internal_id}`"
    if header not in task or identity not in task:
        raise RealExperienceError(f"transfer fixture {fixture} cannot be blinded")
    return task.replace(header, "# Cross-repository experience transfer task").replace(
        identity, f"`task_id` exactly `{public_id}`"
    )


def _object(value: object, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise RealExperienceError(f"{name} must be an object")
    return value


def _text(value: Mapping[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise RealExperienceError(f"missing {key}")
    return item


def _manifest(path: Path) -> tuple[Mapping[str, Mapping[str, str]], list[Mapping[str, Any]]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RealExperienceError(f"could not read task manifest {path}") from error
    root = _object(raw, "task manifest")
    if _text(root, "benchmark_id") != "prale-experience-crossrepo-v1":
        raise RealExperienceError("unsupported task manifest")
    repositories_raw = _object(root.get("repositories"), "repositories")
    repositories: dict[str, Mapping[str, str]] = {}
    for key, value in repositories_raw.items():
        if not isinstance(key, str):
            raise RealExperienceError("repository id must be a string")
        item = _object(value, f"repositories.{key}")
        repositories[key] = {"capsule": _text(item, "capsule"), "memory_scope": _text(item, "memory_scope")}
    pairs = root.get("pairs")
    if not isinstance(pairs, list) or len(pairs) != 30:
        raise RealExperienceError("task manifest must contain exactly 30 pairs")
    parsed = [_object(pair, "pair") for pair in pairs]
    ids = [_text(pair, "id") for pair in parsed]
    if sorted(ids) != [f"{index:02d}" for index in range(1, 31)]:
        raise RealExperienceError("pair ids must be 01 through 30")
    for pair in parsed:
        for phase in ("learn", "transfer"):
            stage = _object(pair.get(phase), f"{pair['id']}.{phase}")
            if _text(stage, "repo") not in repositories:
                raise RealExperienceError(f"{pair['id']}.{phase} references an unknown repository")
    return repositories, parsed


def _hash_tree(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        with path.open("rb") as source:
            while block := source.read(1024 * 1024):
                digest.update(block)
    return digest.hexdigest()


def _l3_findings(content: str, scopes: list[str]) -> list[dict[str, str]]:
    """Detect repository facts that are forbidden in globally shared L3."""

    generic_words = {"agent", "memory", "works"}
    repository_words = [
        part
        for scope in scopes
        for part in re.split(r"[/_-]", scope)
        if len(part) >= 4 and part.lower() not in generic_words
    ]
    patterns = {
        "repository_identifier": r"\b(?:" + "|".join(re.escape(word) for word in repository_words) + r")\b",
        "repository_path": r"(?:^|[\s`'\"])(?:packages|server|aider|MemoryCore|MemoryKnowledge|"
        r"MemoryPanel|sdk)/[^\s`'\"]+",
        "absolute_path": r"(?:^|[\s`'\"])/(?:root|tmp|workspace)/[^\s`'\"]+",
        "source_symbol": r"\b[a-z]+(?:[A-Z][A-Za-z0-9]+){1,}\b",
        "source_excerpt": r"```|(?:^|\n)\s*(?:def|class|function|const|import|export)\s+",
        "commit_id": r"\b[0-9a-f]{40}\b",
        "url": r"https?://\S+",
        "token_shaped": r"\b(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token)\s*[:=]\s*\S+)",
    }
    findings: list[dict[str, str]] = []
    for kind, pattern in patterns.items():
        for match in re.finditer(pattern, content, flags=re.MULTILINE):
            findings.append(
                {
                    "kind": kind,
                    "match_sha256": hashlib.sha256(match.group(0).encode()).hexdigest(),
                }
            )
    return findings


def _l3_audit(content: str | None, scopes: list[str]) -> dict[str, Any]:
    findings = _l3_findings(content, scopes) if content is not None else []
    return {
        "status": "passed" if not findings else "rejected",
        "content_present": content is not None,
        "content_sha256": hashlib.sha256(content.encode()).hexdigest() if content is not None else None,
        "finding_count": len(findings),
        "findings": findings,
    }


async def _memory_audit(state: Path, scopes: list[str]) -> dict[str, Any]:
    store = SQLiteMemoryStore(state / "memory.sqlite")
    try:
        summary: dict[str, Any] = {"scopes": {}}
        for scope_id in scopes:
            scope = MemoryScope(scope_id)
            l0 = await store.list_l0(scope, None, 10_000)
            user_turns = 0
            for archive in l0:
                trace = await store.read_archive(archive.archive_id)
                if trace is not None:
                    user_turns += sum(item.role == "user" for item in trace.items)
            l1 = await store.list_l1(scope, "active", None, 10_000)
            l2 = await store.list_l2(scope, "current", None, 10_000)
            summary["scopes"][scope_id] = {
                "l0_archives": len(l0),
                "user_turns": user_turns,
                "l1_active": len(l1),
                "l2_current": len(l2),
            }
        doctrine = await store.read_l3(GLOBAL_L3_SCOPE)
        l3_audit = _l3_audit(doctrine.content if doctrine is not None else None, scopes)
        summary["l3"] = {
            "present": doctrine is not None,
            "version": doctrine.version if doctrine is not None else None,
            "content_sha256": hashlib.sha256(doctrine.content.encode()).hexdigest() if doctrine is not None else None,
            "audit": l3_audit,
        }
        return summary
    finally:
        store.close()


def _stage_fixture(root: Path, phase: str, task_id: str) -> Path:
    fixture = root / phase / task_id
    if not fixture.is_dir():
        raise RealExperienceError(f"missing fixture {fixture}")
    metadata = fixture / "fixture.json"
    if not metadata.is_file():
        raise RealExperienceError(f"fixture {fixture} has no fixture.json")
    try:
        value = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RealExperienceError(f"fixture {fixture} has invalid metadata") from error
    if not isinstance(value, Mapping) or value.get("status") != "ready":
        raise RealExperienceError(f"fixture {fixture} is not materialized and ready for evaluation")
    return fixture


def _command(
    *,
    adapter: Adapter,
    state: Path,
    adapter_output: Path,
    repository_id: str,
    model: str | None,
    timeout: float,
    max_budget_usd: float,
    l1_turn_threshold: int,
    memory_phase: str,
    memory_mode: Literal["warm", "cold"],
    claude_session_id: str | None,
    claude_experience: Literal["native", "resume"],
    pricing: Mapping[str, float | None],
) -> list[str]:
    executable = Path(__file__).with_name("real_experience_adapters.py").resolve()
    command = [
        sys.executable,
        str(executable),
        adapter,
        "--workspace",
        "{workspace}",
        "--state-dir",
        str(state),
        "--memory-mode",
        memory_mode,
        "--timeout",
        str(timeout),
        "--output",
        str(adapter_output),
    ]
    if model:
        command.extend(["--model", model])
    if adapter == "prale":
        command.extend(
            [
                "--repository-id",
                repository_id,
                "--l1-turn-threshold",
                str(l1_turn_threshold),
                "--memory-phase",
                memory_phase,
            ]
        )
        for flag, value in (
            ("--input-price-usd-per-million", pricing.get("input")),
            ("--cache-read-price-usd-per-million", pricing.get("cache_read")),
            ("--cache-write-price-usd-per-million", pricing.get("cache_write")),
            ("--output-price-usd-per-million", pricing.get("output")),
        ):
            if value is not None:
                command.extend([flag, str(value)])
    else:
        command.extend(["--max-budget-usd", str(max_budget_usd)])
        if claude_experience == "native":
            command.extend(["--native-memory-id", repository_id.replace("/", "--")])
        elif claude_session_id:
            command.extend(["--session-mode", "resume", "--session-id", claude_session_id])
    return command


def _run_task(
    *,
    pair: Mapping[str, Any],
    phase: Literal["learn", "transfer"],
    fixture_root: Path,
    repository: Mapping[str, str],
    capsule_root: Path,
    adapter: Adapter,
    state: Path,
    output: Path,
    model: str | None,
    timeout: float,
    max_budget_usd: float,
    l1_turn_threshold: int,
    claude_session_id: str | None,
    memory_mode: Literal["warm", "cold"],
    memory_phase: Literal["learn", "frozen", "cold"],
    pricing: Mapping[str, float | None],
    claude_experience: Literal["native", "resume"],
    public_stage_id: str | None = None,
) -> tuple[dict[str, Any], str | None]:
    task = _object(pair[phase], f"{pair['id']}.{phase}")
    task_id, repository_key = _text(pair, "id"), _text(task, "repo")
    fixture = _stage_fixture(fixture_root, phase, task_id)
    capsule = load_capsule(capsule_root / repository["capsule"])
    adapter_stage_id = public_stage_id or task_id
    adapter_output = state / f"adapter-{phase}-{adapter_stage_id}.json"
    command = _command(
        adapter=adapter,
        state=state,
        adapter_output=adapter_output,
        repository_id=repository["memory_scope"],
        model=model,
        timeout=timeout,
        max_budget_usd=max_budget_usd,
        l1_turn_threshold=l1_turn_threshold,
        memory_phase=memory_phase,
        memory_mode=memory_mode,
        claude_session_id=claude_session_id,
        claude_experience=claude_experience,
        pricing=pricing,
    )
    result = run_stage(
        capsule=capsule,
        fixture=fixture,
        agent_command=command,
        allow_host_execution=True,
        timeout_seconds=timeout + 30,
        task_text=_blinded_transfer_task(fixture, task_id, public_stage_id)
        if phase == "transfer" and public_stage_id is not None
        else None,
        oracle_stage_token=public_stage_id if phase == "transfer" else None,
        submission_dir=output.parent / f"{output.stem}.submissions" / phase / adapter_stage_id,
    )
    result.update(
        {
            "id": task_id,
            "public_stage_id": public_stage_id,
            "phase": phase,
            "repository": repository_key,
            "scope": _text(pair, "scope"),
        }
    )
    adapter_result = result.get("adapter_result")
    next_session_id = claude_session_id
    if adapter == "claude-code" and isinstance(adapter_result, Mapping):
        claude_result = adapter_result.get("claude_result")
        if isinstance(claude_result, Mapping) and isinstance(claude_result.get("session_id"), str):
            next_session_id = claude_result["session_id"]
    return result, next_session_id


def _freeze(
    *,
    live: Path,
    frozen: Path,
    adapter: Adapter,
    scopes: list[str],
    session_id: str | None,
    transfer_plan: Mapping[str, Any],
) -> dict[str, Any]:
    if not live.is_dir():
        raise RealExperienceError("learning state does not exist; run the learn phase first")
    if frozen.exists():
        raise RealExperienceError(f"refusing to overwrite existing frozen state {frozen}")
    shutil.copytree(live, frozen)
    report: dict[str, Any] = {
        "adapter": adapter,
        "state_sha256": _hash_tree(frozen),
        "claude_session_id": session_id if adapter == "claude-code" else None,
        "transfer_plan": dict(transfer_plan),
    }
    if adapter == "prale":
        memory = asyncio.run(_memory_audit(frozen, scopes))
        report["memory"] = memory
        l3_audit = memory["l3"]["audit"]
        (frozen / "L3-audit.json").write_text(
            json.dumps(l3_audit, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        if l3_audit["status"] != "passed":
            raise RealExperienceError("L3 audit rejected repository-specific or sensitive content")
    (frozen / "freeze-manifest.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return report


def _checkpoint_path(state_root: Path) -> Path:
    """Return the durable controller checkpoint for a resumable evaluation."""

    return state_root / "progress.json"


def _write_checkpoint(path: Path, report: Mapping[str, Any]) -> None:
    """Atomically persist completed stage results before starting the next stage."""

    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def _completed_ids(report: Mapping[str, Any], key: str) -> set[str]:
    stages = report.get(key)
    if not isinstance(stages, list):
        raise RealExperienceError(f"checkpoint {key} must be a list")
    completed: set[str] = set()
    for stage in stages:
        item = _object(stage, f"checkpoint {key} stage")
        stage_id = _text(item, "id")
        if stage_id in completed:
            raise RealExperienceError(f"checkpoint contains duplicate {key} stage {stage_id}")
        completed.add(stage_id)
    return completed


def _load_checkpoint(path: Path, *, adapter: Adapter, condition: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RealExperienceError(f"could not read checkpoint {path}") from error
    report = dict(_object(value, "checkpoint"))
    if report.get("adapter") != adapter or report.get("condition") != condition:
        raise RealExperienceError("checkpoint adapter or condition does not match this invocation")
    for key in ("learning", "transfer"):
        _completed_ids(report, key)
    if "freeze" not in report:
        raise RealExperienceError("checkpoint is missing freeze state")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter", choices=("prale", "claude-code"), required=True)
    parser.add_argument("--phase", choices=("learn", "freeze", "transfer", "cold-transfer", "all"), default="all")
    parser.add_argument("--task-manifest", type=Path, default=Path("evals/experience-crossrepo-v1/task-manifest.json"))
    parser.add_argument("--task-ids", help="comma-separated registered task IDs; defaults to all 30")
    parser.add_argument("--transfer-seed", type=int, help="optional reproducible seed for the blinded transfer order")
    parser.add_argument("--fixture-root", type=Path, default=Path("evals/experience-crossrepo-v1/fixtures"))
    parser.add_argument("--capsule-root", type=Path, default=Path("evals/experience-crossrepo-v1"))
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--resume",
        action="store_true",
        help="resume from the durable per-stage checkpoint in --state-dir",
    )
    parser.add_argument("--model")
    parser.add_argument("--max-budget-usd", type=float, default=10.0)
    parser.add_argument(
        "--claude-experience",
        choices=("native", "resume"),
        default="native",
        help="native uses Claude Code auto memory in new sessions; resume is a raw-history control only",
    )
    parser.add_argument("--l1-turn-threshold", type=int, default=5)
    parser.add_argument("--input-price-usd-per-million", type=float)
    parser.add_argument("--cache-read-price-usd-per-million", type=float)
    parser.add_argument("--cache-write-price-usd-per-million", type=float)
    parser.add_argument("--output-price-usd-per-million", type=float)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--allow-host-execution", action="store_true")
    args = parser.parse_args()
    if not args.allow_host_execution:
        raise RealExperienceError("host execution is disabled; invoke from the pinned runner or pass explicit opt-in")
    repositories, pairs = _manifest(args.task_manifest)
    if args.task_ids:
        selected = {item.strip() for item in args.task_ids.split(",") if item.strip()}
        known = {_text(pair, "id") for pair in pairs}
        if not selected or not selected.issubset(known):
            raise RealExperienceError("task_ids must be a non-empty subset of registered IDs")
        pairs = [pair for pair in pairs if _text(pair, "id") in selected]
    state_root = args.state_dir.resolve()
    fixture_root = args.fixture_root.resolve()
    capsule_root = args.capsule_root.resolve()
    live, frozen, forks = state_root / "live", state_root / "frozen", state_root / "transfer-forks"
    state_root.mkdir(parents=True, exist_ok=True)
    lock = (state_root / "runner.lock").open("a+", encoding="utf-8")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock.close()
        raise RealExperienceError(f"evaluation state is already being run: {state_root}") from error
    pricing = {
        "input": args.input_price_usd_per_million,
        "cache_read": args.cache_read_price_usd_per_million,
        "cache_write": args.cache_write_price_usd_per_million,
        "output": args.output_price_usd_per_million,
    }
    condition = "cold" if args.phase == "cold-transfer" else "evolved"
    checkpoint = _checkpoint_path(state_root)
    report: dict[str, Any] = {
        "adapter": args.adapter,
        "condition": condition,
        "learning": [],
        "freeze": None,
        "transfer": [],
    }
    if args.resume:
        if not checkpoint.is_file():
            raise RealExperienceError(f"cannot resume: checkpoint does not exist: {checkpoint}")
        report = _load_checkpoint(checkpoint, adapter=args.adapter, condition=condition)
    elif checkpoint.exists():
        raise RealExperienceError(f"checkpoint already exists: {checkpoint}; use --resume or a new state directory")
    session_id: str | None = None
    session_file = live / "claude-session.json"
    if session_file.is_file():
        value = json.loads(session_file.read_text(encoding="utf-8"))
        if isinstance(value, Mapping) and isinstance(value.get("session_id"), str):
            session_id = value["session_id"]
    if args.phase in {"learn", "all"}:
        if frozen.exists() and report["freeze"] is None:
            raise RealExperienceError("frozen state already exists; use a new state directory for another learning run")
        live.mkdir(parents=True, exist_ok=True)
        completed_learning = _completed_ids(report, "learning")
        for pair in pairs:
            pair_id = _text(pair, "id")
            if pair_id in completed_learning:
                continue
            task = _object(pair["learn"], "learn")
            result, session_id = _run_task(
                pair=pair,
                phase="learn",
                fixture_root=fixture_root,
                repository=repositories[_text(task, "repo")],
                capsule_root=capsule_root,
                adapter=args.adapter,
                state=live,
                output=args.output,
                model=args.model,
                timeout=args.timeout,
                max_budget_usd=args.max_budget_usd,
                l1_turn_threshold=args.l1_turn_threshold,
                claude_session_id=session_id,
                claude_experience=args.claude_experience,
                memory_mode="warm",
                memory_phase="learn",
                pricing=pricing,
            )
            report["learning"].append(result)
            if args.adapter == "claude-code" and args.claude_experience == "resume" and session_id:
                session_file.write_text(json.dumps({"session_id": session_id}) + "\n", encoding="utf-8")
            _write_checkpoint(checkpoint, report)
    if args.phase in {"freeze", "all"}:
        if report["freeze"] is None:
            seed = args.transfer_seed if args.transfer_seed is not None else secrets.randbits(63)
            transfer_plan = _transfer_plan(pairs, seed)
            report["freeze"] = _freeze(
                live=live,
                frozen=frozen,
                adapter=args.adapter,
                scopes=[item["memory_scope"] for item in repositories.values()],
                session_id=session_id if args.claude_experience == "resume" else None,
                transfer_plan=transfer_plan,
            )
            _write_checkpoint(checkpoint, report)
    if args.phase in {"transfer", "all"}:
        if not frozen.is_dir():
            raise RealExperienceError("frozen state does not exist; run the freeze phase first")
        freeze_manifest = json.loads((frozen / "freeze-manifest.json").read_text(encoding="utf-8"))
        frozen_session_id = freeze_manifest.get("claude_session_id") if isinstance(freeze_manifest, Mapping) else None
        transfer_plan = _object(freeze_manifest.get("transfer_plan"), "frozen transfer plan")
        if args.transfer_seed is not None and transfer_plan.get("seed") != args.transfer_seed:
            raise RealExperienceError("transfer seed does not match the frozen transfer plan")
        if (
            args.adapter == "claude-code"
            and args.claude_experience == "resume"
            and not isinstance(frozen_session_id, str)
        ):
            raise RealExperienceError("frozen Claude state does not contain a session id")
        completed_transfer = _completed_ids(report, "transfer")
        for public_stage_id, pair in _planned_pairs(pairs, transfer_plan):
            if _text(pair, "id") in completed_transfer:
                continue
            fork = forks / public_stage_id
            if fork.exists():
                raise RealExperienceError(f"refusing to overwrite transfer fork {fork}")
            shutil.copytree(frozen, fork)
            task = _object(pair["transfer"], "transfer")
            result, _ = _run_task(
                pair=pair,
                phase="transfer",
                fixture_root=fixture_root,
                repository=repositories[_text(task, "repo")],
                capsule_root=capsule_root,
                adapter=args.adapter,
                state=fork,
                output=args.output,
                model=args.model,
                timeout=args.timeout,
                max_budget_usd=args.max_budget_usd,
                l1_turn_threshold=args.l1_turn_threshold,
                claude_session_id=frozen_session_id if isinstance(frozen_session_id, str) else None,
                claude_experience=args.claude_experience,
                memory_mode="warm",
                memory_phase="frozen",
                pricing=pricing,
                public_stage_id=public_stage_id,
            )
            report["transfer"].append(result)
            _write_checkpoint(checkpoint, report)
    if args.phase == "cold-transfer":
        cold_forks = state_root / "cold-transfer-forks"
        seed = args.transfer_seed if args.transfer_seed is not None else secrets.randbits(63)
        transfer_plan = _transfer_plan(pairs, seed)
        report["transfer_plan"] = transfer_plan
        for public_stage_id, pair in _planned_pairs(pairs, transfer_plan):
            state = cold_forks / public_stage_id
            if state.exists():
                raise RealExperienceError(f"refusing to overwrite cold transfer state {state}")
            task = _object(pair["transfer"], "transfer")
            result, _ = _run_task(
                pair=pair,
                phase="transfer",
                fixture_root=fixture_root,
                repository=repositories[_text(task, "repo")],
                capsule_root=capsule_root,
                adapter=args.adapter,
                state=state,
                output=args.output,
                model=args.model,
                timeout=args.timeout,
                max_budget_usd=args.max_budget_usd,
                l1_turn_threshold=args.l1_turn_threshold,
                claude_session_id=None,
                claude_experience=args.claude_experience,
                memory_mode="cold",
                memory_phase="cold",
                pricing=pricing,
                public_stage_id=public_stage_id,
            )
            report["transfer"].append(result)
            _write_checkpoint(checkpoint, report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
