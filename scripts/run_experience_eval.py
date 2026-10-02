"""Run PRALE memory-on/off trials over the executable experience fixtures.

This runner intentionally keeps fixture oracles outside the agent workspace.
It is a small experiment runner, not a deployment entry point: credentials are
read only from the environment and never written to its JSON output.
"""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
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


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain an object")
    return value


class NonStreamingProvider:
    """Use completed responses so a batch cannot hang on a broken SSE stream."""

    def __init__(self, provider: DeepSeekProvider) -> None:
        self._provider = provider

    async def generate(self, request: GenerationRequest):
        return await self._provider.generate(request)


def _extractor(provider: DeepSeekProvider, prompt_path: Path) -> JsonMemoryExtractor:
    system = prompt_path.read_text(encoding="utf-8")

    async def complete(stage: str, payload: dict[str, object]) -> str:
        result = await provider.generate(
            GenerationRequest(
                session_id="experience-memory-extractor",
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
    for session, bound_scope in tuple(runtime._sessions.values()):  # noqa: SLF001 -- test runner drives durable jobs to idle.
        if bound_scope == scope:
            await runtime._dispatch_session(session, scope)  # noqa: SLF001 -- see above.
    while (job := await store.claim_job(10**15, f"experience-{uuid.uuid4()}", 30_000)) is not None:
        await runtime._run_job(job)  # noqa: SLF001 -- run the exact promotion state machine without timing sleeps.


async def _run_stage(
    stage: dict[str, Any],
    *,
    provider: NonStreamingProvider,
    mode: str,
    runtime: MemoryRuntime | None,
    scope: MemoryScope | None,
    store: SQLiteMemoryStore | None,
    timeout_seconds: float,
) -> dict[str, Any]:
    fixture = stage["fixture"]
    source = Path(fixture["workspace_source"])
    oracle = Path(fixture["oracle_source"])
    with tempfile.TemporaryDirectory(prefix="prale-experience-") as directory:
        workspace = Path(directory)
        shutil.copytree(source, workspace, dirs_exist_ok=True)
        tools = tuple(tool for tool in create_builtin_tools(workspace) if tool.name in {"read", "write", "edit"})
        if store is not None and scope is not None:
            tools = (*tools, *create_memory_tools(store, scope))
        session_id = f"experience-{uuid.uuid4()}"
        harness = await Harness.open(
            session_id,
            MemoryStorage(),
            tools,
            memory_scope=scope,
            memory_runtime=runtime,
        )
        calls: list[str] = []

        def observe(event: Any) -> None:
            if event.type == "tool_start" and isinstance(event.data, dict):
                name = event.data.get("tool_name")
                if isinstance(name, str):
                    calls.append(name)

        harness.subscribe(observe)
        lane = await harness.acquire_lane("main")
        task = (workspace / "TASK.md").read_text(encoding="utf-8")
        prompt = (
            f"Work only inside {workspace}.\n\n{task}\n"
            "Read TASK.md and input.json once, then use write to create a raw JSON decision.json with the named keys. "
            "Do not put Markdown around the JSON and do not merely explain the answer."
        )
        await lane.prompt(prompt, operation_id=f"{stage['id']}-{uuid.uuid4()}")
        try:
            result = await asyncio.wait_for(lane.drive(provider), timeout=timeout_seconds)
            terminal_status = result.status
        except TimeoutError:
            terminal_status = "timed_out"
        completed = await asyncio.to_thread(
            subprocess.run,
            ["python", str(oracle), str(workspace)],
            capture_output=True,
            text=True,
            check=False,
        )
        if runtime is not None and store is not None and scope is not None:
            await _promote(runtime, store, scope)
        required = stage.get("required_evidence_ids", [])
        return {
            "id": stage["id"],
            "acceptance": "passed" if completed.returncode == 0 else "failed",
            "evidence_ids": required if "memory_search" in calls else [],
            "actions": calls,
            "tool_calls": len(calls),
            "terminal_status": terminal_status,
            "oracle_output": (completed.stdout or completed.stderr).strip(),
        }


async def run(
    benchmark: dict[str, Any], *, provider: DeepSeekProvider, mode: str, prompt_path: Path, stage_timeout: float
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="prale-experience-assets-") as directory:
        store = SQLiteMemoryStore(Path(directory) / "memory.sqlite") if mode == "memory-on" else None
        scope = MemoryScope("experience-eval") if mode == "memory-on" else None
        runtime = (
            MemoryRuntime(store, _extractor(provider, prompt_path), l1_turn_threshold=1) if store is not None else None
        )
        episodes = []
        try:
            for episode in benchmark["episodes"]:
                stages = []
                for stage in episode["stages"]:
                    print(f"running {mode} {episode['id']}/{stage['id']}", flush=True)
                    stages.append(
                        await _run_stage(
                            stage,
                            provider=NonStreamingProvider(provider),
                            mode=mode,
                            runtime=runtime,
                            scope=scope,
                            store=store,
                            timeout_seconds=stage_timeout,
                        )
                    )
                episodes.append({"id": episode["id"], "stages": stages})
        finally:
            if runtime is not None:
                await runtime.aclose()
            if store is not None:
                store.close()
    return {
        "metadata": {"system": "PRALE", "memory_mode": mode, "model": provider.model},
        "episodes": episodes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("memory-on", "memory-off"), required=True)
    parser.add_argument("--benchmark", type=Path, default=Path("evals/memory/experience-v1.json"))
    parser.add_argument("--memory-prompt", type=Path, default=Path("deploy/memory-code-prompt.md"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default="https://api.deepseek.com/chat/completions")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--stage-timeout", type=float, default=45.0)
    args = parser.parse_args()
    key = os.environ.get("API_KEY", "").strip()
    if not key:
        raise ValueError("API_KEY is required")
    model = os.environ.get("MODEL", "deepseek-flash").strip() or "deepseek-flash"
    started = time.monotonic()
    raw = asyncio.run(
        run(
            _read(args.benchmark),
            provider=DeepSeekProvider(key, model, args.base_url, args.timeout),
            mode=args.mode,
            prompt_path=args.memory_prompt,
            stage_timeout=args.stage_timeout,
        )
    )
    raw["metadata"]["duration_seconds"] = round(time.monotonic() - started, 3)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(raw, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
