"""Native PRALE and Claude Code adapters for real-repository evaluation stages."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
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
from agent_harness.runtime.generation import GenerationRequest
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


def _task(workspace: Path) -> str:
    return (
        f"Work only inside {workspace}. Read TASK.md, diagnose the regression, implement a minimal correct fix, "
        "and run the most focused relevant tests. Do not merely describe a patch.\n\n"
        + (workspace / "TASK.md").read_text(encoding="utf-8")
    )


class _NonStreamingProvider:
    def __init__(self, provider: DeepSeekProvider) -> None:
        self._provider = provider

    async def generate(self, request: GenerationRequest):
        return await self._provider.generate(request)


def _extractor(provider: DeepSeekProvider, prompt_path: Path) -> JsonMemoryExtractor:
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
) -> dict[str, Any]:
    if memory_mode not in {"warm", "cold"}:
        raise ValueError("memory_mode must be warm or cold")
    state_dir.mkdir(parents=True, exist_ok=True)
    store = SQLiteMemoryStore(state_dir / "memory.sqlite") if memory_mode == "warm" else None
    scope = MemoryScope(repository_id) if store is not None else None
    runtime = (
        MemoryRuntime(store, _extractor(provider, memory_prompt), l1_turn_threshold=1) if store is not None else None
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
        result = await asyncio.wait_for(lane.drive(_NonStreamingProvider(provider)), timeout=timeout_seconds)
        if runtime is not None and store is not None and scope is not None:
            await _promote(runtime, store, scope)
        return {
            "adapter": "prale",
            "terminal_status": result.status,
            "tool_calls": calls,
            "memory_retrievals": ["memory_search"] if "memory_search" in calls else [],
            "usage": {},
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


def run_claude(
    *,
    workspace: Path,
    state_dir: Path,
    memory_mode: str,
    model: str | None,
    max_budget_usd: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    if memory_mode not in {"warm", "cold"}:
        raise ValueError("memory_mode must be warm or cold")
    if max_budget_usd <= 0:
        raise ValueError("max_budget_usd must be positive")
    home = state_dir / ("claude-home" if memory_mode == "warm" else f"cold-{uuid.uuid4()}")
    home.mkdir(parents=True, exist_ok=True)
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
    if model:
        command.extend(["--model", model])
    command.append(_task(workspace))
    completed = subprocess.run(
        command,
        cwd=workspace,
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
    parsed = _claude_summary(completed.stdout)
    return {
        "adapter": "claude-code",
        "terminal_status": "completed" if completed.returncode == 0 else "failed",
        "tool_calls": parsed["tool_calls"],
        "memory_retrievals": None,
        "usage": parsed["usage"],
        "claude_result": parsed["result"],
        "stderr": completed.stderr[-20_000:],
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
    prale.add_argument("--memory-prompt", type=Path, default=Path("deploy/memory-code-prompt.md"))
    prale.add_argument("--base-url", default="https://api.deepseek.com/chat/completions")
    prale.add_argument("--model", default=os.environ.get("MODEL", "deepseek-flash"))
    claude = subparsers.choices["claude-code"]
    claude.add_argument("--model")
    claude.add_argument("--max-budget-usd", type=float, default=10.0)
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
        )
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
