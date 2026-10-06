"""Native PRALE and Claude Code adapters for real-repository evaluation stages."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import time
import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from agent_harness.api.harness import Harness
from agent_harness.domain.memory import MemoryScope
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.local_tools import create_builtin_tools
from agent_harness.integrations.memory_provider import JsonMemoryExtractor
from agent_harness.integrations.memory_tools import create_memory_tools
from agent_harness.memory.runtime import MemoryRuntime
from agent_harness.runtime.generation import AssistantResult, GenerationRequest
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


def _task(workspace: Path) -> str:
    return (
        f"Work only inside {workspace}. Read TASK.md and complete its requested task. Create every requested "
        "artifact, make only the minimal necessary changes, and run the most focused relevant validation. "
        "Before finishing, re-open `.prale-eval/result.json` and verify that its task_id, repository, mode, "
        "claim citations, and requested deliverables exactly match the current TASK.md; current TASK.md "
        "metadata is authoritative over any remembered prior task. "
        "Do not merely describe what should be done. Never search, read, write, or execute outside the workspace; "
        "do not install dependencies or scan the filesystem. If an optional validation dependency is unavailable, "
        "record that limitation in the required validation artifact instead.\n\n"
        + (workspace / "TASK.md").read_text(encoding="utf-8")
    )


class _NonStreamingProvider:
    def __init__(self, provider: _MeteredProvider) -> None:
        self._provider = provider

    async def generate(self, request: GenerationRequest):
        return await self._provider.generate(request)


class _MeteredProvider:
    """Collect provider-neutral usage for every billable generation in a stage."""

    def __init__(self, provider: DeepSeekProvider) -> None:
        self._provider = provider
        self._calls: list[dict[str, Any]] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        started = time.monotonic()
        result = await self._provider.generate(request)
        self._calls.append(
            {
                "lane": request.lane,
                "duration_ms": round((time.monotonic() - started) * 1000),
                "usage": _numeric_usage(result.usage),
            }
        )
        return result

    def metrics(self, pricing: Mapping[str, float | None]) -> dict[str, Any]:
        usage = _aggregate_usage([call["usage"] for call in self._calls])
        provider_costs = [
            value
            for call in self._calls
            for key, value in call["usage"].items()
            if key in {"cost", "cost_usd", "total_cost_usd"}
        ]
        cost = sum(provider_costs) if provider_costs else _estimated_cost(usage, pricing)
        agent_turns = sum(call["lane"] == "main" for call in self._calls)
        return {
            "model_turns": len(self._calls),
            "agent_model_turns": agent_turns,
            "memory_model_turns": len(self._calls) - agent_turns,
            "model_duration_ms": sum(call["duration_ms"] for call in self._calls),
            "usage": usage,
            "cost_usd": cost,
        }


def _numeric_usage(value: Mapping[str, object]) -> dict[str, int | float]:
    return {
        key: item
        for key, item in value.items()
        if isinstance(item, (int, float)) and not isinstance(item, bool)
    }


def _aggregate_usage(rows: list[Mapping[str, int | float]]) -> dict[str, int | float]:
    """Normalize OpenAI/DeepSeek usage aliases without inventing missing data."""

    totals: dict[str, int | float] = {}
    for row in rows:
        for key, value in row.items():
            totals[key] = totals.get(key, 0) + value

    def pick(*keys: str) -> int | float | None:
        for key in keys:
            if key in totals:
                return totals[key]
        return None

    normalized: dict[str, int | float] = dict(totals)
    input_tokens = pick("input_tokens", "prompt_tokens")
    output_tokens = pick("output_tokens", "completion_tokens")
    cache_read = pick("cache_read_input_tokens", "prompt_cache_hit_tokens", "cached_tokens")
    cache_write = pick("cache_creation_input_tokens", "cache_write_tokens")
    if input_tokens is not None:
        normalized["input_tokens"] = input_tokens
    if output_tokens is not None:
        normalized["output_tokens"] = output_tokens
    if cache_read is not None:
        normalized["cache_read_input_tokens"] = cache_read
    if cache_write is not None:
        normalized["cache_creation_input_tokens"] = cache_write
    if input_tokens is not None and output_tokens is not None:
        normalized["total_tokens"] = input_tokens + output_tokens
    return normalized


def _estimated_cost(usage: Mapping[str, int | float], pricing: Mapping[str, float | None]) -> float | None:
    input_tokens, output_tokens = usage.get("input_tokens"), usage.get("output_tokens")
    input_rate, output_rate = pricing.get("input"), pricing.get("output")
    if not isinstance(input_tokens, (int, float)) or not isinstance(output_tokens, (int, float)):
        return None
    if input_rate is None or output_rate is None:
        return None
    cache_read = usage.get("cache_read_input_tokens", 0)
    cache_write = usage.get("cache_creation_input_tokens", 0)
    if not isinstance(cache_read, (int, float)) or not isinstance(cache_write, (int, float)):
        return None
    uncached_input = max(0, input_tokens - cache_read - cache_write)
    cache_read_rate = pricing.get("cache_read") if pricing.get("cache_read") is not None else input_rate
    cache_write_rate = pricing.get("cache_write") if pricing.get("cache_write") is not None else input_rate
    return round(
        (
            uncached_input * input_rate
            + cache_read * cache_read_rate
            + cache_write * cache_write_rate
            + output_tokens * output_rate
        )
        / 1_000_000,
        12,
    )


def _extractor(provider: _MeteredProvider, prompt_path: Path) -> JsonMemoryExtractor:
    system = prompt_path.read_text(encoding="utf-8")

    async def complete(stage: str, payload: dict[str, object]) -> str:
        result = await provider.generate(
            GenerationRequest(
                session_id="real-experience-extractor",
                lane=stage,
                operation_id=f"extract-{uuid.uuid4()}",
                messages=(
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps({"stage": stage, **payload}, ensure_ascii=False)},
                ),
                tools=(),
            )
        )
        return result.content

    return JsonMemoryExtractor(complete)


async def _promote(runtime: MemoryRuntime, store: SQLiteMemoryStore, scope: MemoryScope) -> None:
    for session, bound_scope in tuple(runtime._sessions.values()):  # noqa: SLF001 - evaluation drains durable jobs.
        if bound_scope == scope:
            await runtime._dispatch_session(session, scope)  # noqa: SLF001 - see above.
    while (job := await store.claim_job(10**15, f"real-eval-{uuid.uuid4()}", 30_000)) is not None:
        await runtime._run_job(job)  # noqa: SLF001 - deterministic evaluation drain.


async def run_prale(
    *,
    workspace: Path,
    state_dir: Path,
    memory_mode: str,
    repository_id: str,
    provider: DeepSeekProvider,
    memory_prompt: Path,
    timeout_seconds: float,
    l1_turn_threshold: int,
    memory_phase: str,
    pricing: Mapping[str, float | None],
) -> dict[str, Any]:
    if memory_mode not in {"warm", "cold"}:
        raise ValueError("memory_mode must be warm or cold")
    if memory_phase not in {"learn", "frozen", "cold"}:
        raise ValueError("memory_phase must be learn, frozen, or cold")
    if l1_turn_threshold < 1:
        raise ValueError("l1_turn_threshold must be positive")
    state_dir.mkdir(parents=True, exist_ok=True)
    store = SQLiteMemoryStore(state_dir / "memory.sqlite") if memory_mode == "warm" else None
    scope = MemoryScope(repository_id) if store is not None else None
    metered_provider = _MeteredProvider(provider)
    runtime = (
        MemoryRuntime(store, _extractor(metered_provider, memory_prompt), l1_turn_threshold=l1_turn_threshold)
        if store is not None
        else None
    )
    calls: list[str] = []
    try:
        tools = tuple(create_builtin_tools(workspace))
        if store is not None and scope is not None:
            tools = (*tools, *create_memory_tools(store, scope))
        harness = await Harness.open(
            f"real-experience-{uuid.uuid4()}",
            MemoryStorage(),
            tools,
            memory_scope=scope,
            memory_runtime=runtime,
        )

        def observe(event: Any) -> None:
            if (
                event.type == "tool_start"
                and isinstance(event.data, dict)
                and isinstance(event.data.get("tool_name"), str)
            ):
                calls.append(event.data["tool_name"])

        harness.subscribe(observe)
        lane = await harness.acquire_lane("main")
        await lane.prompt(_task(workspace), operation_id=f"stage-{uuid.uuid4()}")
        result = await asyncio.wait_for(lane.drive(_NonStreamingProvider(metered_provider)), timeout=timeout_seconds)
        if memory_phase == "learn" and runtime is not None and store is not None and scope is not None:
            await _promote(runtime, store, scope)
        return {
            "adapter": "prale",
            "terminal_status": result.status,
            "tool_calls": calls,
            "memory_retrievals": ["memory_search"] if "memory_search" in calls else [],
            "memory_phase": memory_phase,
            **metered_provider.metrics(pricing),
        }
    finally:
        if runtime is not None:
            await runtime.aclose()
        if store is not None:
            store.close()


def _claude_summary(output: str) -> dict[str, Any]:
    tools: list[str] = []
    usage: dict[str, int | float] = {}
    result: dict[str, Any] = {}
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, Mapping):
            continue
        if event.get("type") == "assistant" and isinstance(event.get("message"), Mapping):
            content = event["message"].get("content")
            if isinstance(content, list):
                tools.extend(
                    block.get("name")
                    for block in content
                    if (
                        isinstance(block, Mapping)
                        and block.get("type") == "tool_use"
                        and isinstance(block.get("name"), str)
                    )
                )
        if event.get("type") == "result":
            result = dict(event)
            raw_usage = event.get("usage")
            if isinstance(raw_usage, Mapping):
                usage = {key: value for key, value in raw_usage.items() if isinstance(value, (int, float))}
    return {"tool_calls": tools, "usage": usage, "result": result}


def _claude_metrics(result: Mapping[str, Any]) -> dict[str, int | float | None]:
    def number(key: str) -> int | float | None:
        value = result.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    return {
        "model_turns": number("num_turns"),
        "model_duration_ms": number("duration_api_ms"),
        "cost_usd": number("total_cost_usd"),
    }


def _claude_preexec(workspace: Path, home: Path, config_dir: Path | None = None) -> Any | None:
    """Drop root before invoking Claude Code's permission-bypass mode.

    Claude Code intentionally rejects ``--dangerously-skip-permissions`` as
    root. The evaluation controller may itself run as root in a container, so
    hand the ephemeral workspace and Claude state directory to an unprivileged
    uid before launching it. UID/GID 1000 is the image's normal non-root user;
    callers can override it for a differently-built runner image.
    """

    if os.geteuid() != 0:
        return None
    uid = int(os.environ.get("PRALE_EVAL_CLAUDE_UID", "1000"))
    # Do not default to the uid-matching primary group: in the standard image
    # it is the group owning /root with no traversal bit, while the uid can
    # traverse /root through its ``other`` permission.
    gid = int(os.environ.get("PRALE_EVAL_CLAUDE_GID", "65534"))
    # ``run_stage`` creates a mode-0700 temporary parent. It must be
    # traversable too, otherwise the dropped process cannot reach workspace.
    shutil.chown(workspace.parent, user=uid, group=gid)
    temp_dir = home / "tmp"
    temp_dir.mkdir(exist_ok=True)
    targets = (workspace, home, config_dir) if config_dir is not None else (workspace, home)
    for target in targets:
        if target is None:
            continue
        shutil.chown(target, user=uid, group=gid)
        for child in target.rglob("*"):
            shutil.chown(child, user=uid, group=gid)

    def drop_privileges() -> None:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)

    return drop_privileges


def _native_memory_inventory(config_dir: Path, native_memory_id: str | None) -> dict[str, Any] | None:
    if native_memory_id is None:
        return None
    root = config_dir / "projects" / native_memory_id / "memory"
    files = [path for path in sorted(root.rglob("*")) if path.is_file()] if root.is_dir() else []
    return {
        "root": str(root),
        "present": root.is_dir(),
        "files": [
            {
                "path": path.relative_to(root).as_posix(),
                "size_bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in files
        ],
    }


def run_claude(
    *,
    workspace: Path,
    state_dir: Path,
    memory_mode: str,
    model: str | None,
    max_budget_usd: float,
    timeout_seconds: float,
    session_mode: str,
    session_id: str | None,
    native_memory_id: str | None,
) -> dict[str, Any]:
    if memory_mode not in {"warm", "cold"}:
        raise ValueError("memory_mode must be warm or cold")
    if max_budget_usd <= 0:
        raise ValueError("max_budget_usd must be positive")
    if session_mode not in {"new", "resume"}:
        raise ValueError("session_mode must be new or resume")
    if session_mode == "resume" and not session_id:
        raise ValueError("session_id is required when session_mode is resume")
    home = state_dir / ("claude-home" if memory_mode == "warm" else f"cold-{uuid.uuid4()}")
    home.mkdir(parents=True, exist_ok=True)
    config_dir = state_dir / "claude-config" if native_memory_id else home / ".claude"
    config_dir.mkdir(parents=True, exist_ok=True)
    if native_memory_id:
        settings = config_dir / "settings.json"
        if not settings.exists():
            settings.write_text(json.dumps({"autoMemoryEnabled": True}) + "\n", encoding="utf-8")
    command = [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--max-budget-usd",
        str(max_budget_usd),
    ]
    if session_mode == "resume":
        command.extend(["--resume", session_id])
    if model:
        command.extend(["--model", model])
    command.append(_task(workspace))
    environment = {
        **os.environ,
        "HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "CLAUDE_CONFIG_DIR": str(config_dir),
    }
    if native_memory_id:
        # In a self-hosted compatible endpoint Claude Code disables auto memory
        # by default. This only enables its own native per-project mechanism;
        # it does not inject an external handoff or a prior chat transcript.
        environment["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "0"
        environment["CLAUDE_CODE_PROJECT_DIR_NAME"] = native_memory_id
    try:
        completed = subprocess.run(
            command,
            cwd=workspace,
            env=environment,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
            preexec_fn=_claude_preexec(workspace, home, config_dir),
        )
    except subprocess.TimeoutExpired as error:
        parsed = _claude_summary(error.stdout or "")
        return {
            "adapter": "claude-code",
            "terminal_status": "timed_out",
            "tool_calls": parsed["tool_calls"],
            "memory_retrievals": None,
            "usage": parsed["usage"],
            "claude_result": parsed["result"],
            **_claude_metrics(parsed["result"]),
            "stderr": (error.stderr or "")[-20_000:],
            "native_memory": _native_memory_inventory(config_dir, native_memory_id),
        }
    parsed = _claude_summary(completed.stdout)
    return {
        "adapter": "claude-code",
        "terminal_status": "completed" if completed.returncode == 0 else "failed",
        "tool_calls": parsed["tool_calls"],
        "memory_retrievals": None,
        "usage": parsed["usage"],
        "claude_result": parsed["result"],
        **_claude_metrics(parsed["result"]),
        "stderr": completed.stderr[-20_000:],
        "native_memory": _native_memory_inventory(config_dir, native_memory_id),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="adapter", required=True)
    for name in ("prale", "claude-code"):
        item = subparsers.add_parser(name)
        item.add_argument("--workspace", type=Path, required=True)
        item.add_argument("--state-dir", type=Path, required=True)
        item.add_argument("--memory-mode", choices=("warm", "cold"), required=True)
        item.add_argument("--timeout", type=float, default=900)
        item.add_argument("--output", type=Path, required=True)
    prale = subparsers.choices["prale"]
    prale.add_argument("--repository-id", required=True)
    prale.add_argument(
        "--memory-prompt",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "deploy/memory-code-prompt.md",
    )
    prale.add_argument("--base-url", default="https://api.deepseek.com/chat/completions")
    prale.add_argument("--model", default=os.environ.get("MODEL", "deepseek-flash"))
    prale.add_argument("--l1-turn-threshold", type=int, default=5)
    prale.add_argument("--memory-phase", choices=("learn", "frozen", "cold"), default="learn")
    prale.add_argument("--input-price-usd-per-million", type=float)
    prale.add_argument("--cache-read-price-usd-per-million", type=float)
    prale.add_argument("--cache-write-price-usd-per-million", type=float)
    prale.add_argument("--output-price-usd-per-million", type=float)
    claude = subparsers.choices["claude-code"]
    claude.add_argument("--model")
    claude.add_argument("--max-budget-usd", type=float, default=10.0)
    claude.add_argument("--session-mode", choices=("new", "resume"), default="new")
    claude.add_argument("--session-id")
    claude.add_argument("--native-memory-id")
    args = parser.parse_args()
    if args.adapter == "prale":
        key = os.environ.get("API_KEY", "").strip()
        if not key:
            raise ValueError("API_KEY is required for the PRALE adapter")
        output = asyncio.run(
            run_prale(
                workspace=args.workspace,
                state_dir=args.state_dir,
                memory_mode=args.memory_mode,
                repository_id=args.repository_id,
                provider=DeepSeekProvider(key, args.model, args.base_url),
                memory_prompt=args.memory_prompt,
                timeout_seconds=args.timeout,
                l1_turn_threshold=args.l1_turn_threshold,
                memory_phase=args.memory_phase,
                pricing={
                    "input": args.input_price_usd_per_million,
                    "cache_read": args.cache_read_price_usd_per_million,
                    "cache_write": args.cache_write_price_usd_per_million,
                    "output": args.output_price_usd_per_million,
                },
            )
        )
    else:
        output = run_claude(
            workspace=args.workspace,
            state_dir=args.state_dir,
            memory_mode=args.memory_mode,
            model=args.model,
            max_budget_usd=args.max_budget_usd,
            timeout_seconds=args.timeout,
            session_mode=args.session_mode,
            session_id=args.session_id,
            native_memory_id=args.native_memory_id,
        )
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
