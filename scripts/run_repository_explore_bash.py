"""Run paired bash-enabled cases in disposable exports of the pinned commit.

Unlike repository_snapshot (strictly read-only), these workspaces permit bash.
The runtime, provider and scorers are shared with eval_harness. No uploads.
"""

import argparse
import asyncio
import io
import json
import os
import shlex
import subprocess
import tarfile
import tempfile
from dataclasses import replace
from pathlib import Path

from build_repository_explore_datasets import _item
from eval_harness import DEFAULT_EVALUATORS, ScoredItem, _score

from agent_harness.api.harness import Harness
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.evaluation import (
    _Collecting,
    _snapshot_explorer,
    _summarize,
    parse_case,
    run_metrics,
    sandbox_tools,
)
from agent_harness.storage.sqlite import SQLiteStorage


class ContainerBash:
    """Keep the built-in bash protocol while isolating its filesystem/network."""

    def __init__(self, tool, container):
        self.tool = tool
        self.container = container
        for name in ("name", "description", "input_schema", "replay_policy"):
            setattr(self, name, getattr(tool, name))

    async def execute(self, arguments):
        if not isinstance(arguments, dict) or not isinstance(arguments.get("command"), str):
            return await self.tool.execute(arguments)
        command = shlex.join(
            ["docker", "exec", "-w", "/workspace", self.container, "bash", "-lc", arguments["command"]]
        )
        return await self.tool.execute(
            {**arguments, "command": command, "timeout": min(arguments.get("timeout", 60), 60)}
        )


async def run_export(case, provider, workdir, image):
    workspace = workdir / "workspace"
    container = subprocess.check_output(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--network",
            "none",
            "--memory",
            "1g",
            "--cpus",
            "1",
            "--pids-limit",
            "128",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            f"type=bind,source={workspace},target=/workspace",
            image,
        ],
        text=True,
    ).strip()
    storage = SQLiteStorage(workdir / "session.sqlite")
    collector = _Collecting(None)
    identifier = f"eval:{case.id}"
    explorer = (
        _snapshot_explorer(workspace, workdir / "repository-index") if "repository_explore" in case.tools else None
    )
    tools = tuple(
        ContainerBash(tool, container) if tool.name == "bash" else tool
        for tool in sandbox_tools(workspace, case.tools, repository_explorer=explorer)
    )
    harness = None
    try:
        harness = await Harness.open(identifier, storage, tools=tools, telemetry=collector)
        lane = await harness.acquire_lane("main")
        await lane.prompt(case.prompt, operation_id=f"{case.id}-1")
        result = await lane.drive(provider)
        return _summarize(result, collector, session_id=identifier)
    finally:
        if harness is not None:
            await harness.close()
        storage.close()
        subprocess.run(["docker", "rm", "-f", container], check=False, capture_output=True)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def run(args):
    root = Path(__file__).resolve().parents[1]
    source = json.loads((root / "evals/repository_explore/tasks.json").read_text())
    sha = source["pinned_git_sha"]
    archive = subprocess.check_output(["git", "-C", str(root), "archive", sha])
    key = os.environ.get("PRALE_API_KEY", "")
    if args.api_key_file:
        key = args.api_key_file.read_text().strip()
    if not key:
        raise ValueError("PRALE_API_KEY or --api-key-file is required")
    provider = DeepSeekProvider(api_key=key, model=args.model, timeout_seconds=180)
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    reports = {}
    for condition in ("baseline", "treatment"):
        reports[condition] = {
            "dataset": f"prale/repository-explore-bash-{condition}",
            "git_sha": head,
            "repository_git_sha": sha,
            "model": args.model,
            "workspace_mode": "disposable git archive; bash in network-disabled container at /workspace",
            "bash_image": args.image,
            "bash_timeout_seconds": 60,
            "items": [],
            "metrics": [],
        }
    semaphore = asyncio.Semaphore(args.max_concurrency)

    async def one(task, condition):
        tools = ["read", "bash"] + (["repository_explore"] if condition == "treatment" else [])
        raw = _item(
            task,
            condition=f"{condition}-bash",
            sha=sha,
            tools=tools,
            required=source["global_output_contract"]["required_fields"],
        )
        case = replace(parse_case(raw), repository_snapshot=None)
        case = replace(
            case,
            prompt=case.prompt + "\n\n仓库根目录是当前工作目录（bash 中为 /workspace）；"
            "只探索此仓库，使用相对路径。不要搜索其他目录。",
        )
        async with semaphore:
            print(f"START {case.id}", flush=True)
            with tempfile.TemporaryDirectory(prefix=f"prale-{case.id}-") as directory:
                workdir = Path(directory)
                workspace = workdir / "workspace"
                workspace.mkdir()
                with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
                    bundle.extractall(workspace, filter="data")
                output = await run_export(case, provider, workdir, args.image)
            scored = ScoredItem(case_id=case.id, output=output.as_dict())
            scored.evaluations = _score(case, scored.output, DEFAULT_EVALUATORS)
            reports[condition]["items"].append(
                {
                    "id": case.id,
                    "output": scored.output,
                    "evaluations": [score.as_dict() for score in scored.evaluations],
                }
            )
            collected = [
                ScoredItem(
                    case_id=item["id"],
                    output=item["output"],
                    evaluations=_score(case, item["output"], DEFAULT_EVALUATORS),
                )
                for item in reports[condition]["items"]
            ]
            reports[condition]["metrics"] = [metric.as_dict() for metric in run_metrics(collected)]
            write_json(args.output_dir / f"{condition}.json", reports[condition])
            print(
                f"DONE {case.id}: {output.terminal_status}, tools={len(output.tool_calls)}, "
                f"duration={output.duration_ms}ms",
                flush=True,
            )

    # Interleave paired cases to reduce condition-specific time effects.
    await asyncio.gather(*(one(task, condition) for task in source["tasks"] for condition in ("baseline", "treatment")))
    print(json.dumps({key: report["metrics"] for key, report in reports.items()}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-key-file", type=Path)
    parser.add_argument("--model", default="deepseek-flash")
    parser.add_argument("--max-concurrency", type=int, default=4)
    parser.add_argument("--image", default="prale-eval/repository-explore-bash:v1")
    parser.add_argument("--output-dir", type=Path, default=Path("reports/repository-explore-bash"))
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
