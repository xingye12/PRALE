"""Run paired bash-enabled cases in disposable exports of the pinned commit.

Unlike repository_snapshot (strictly read-only), these workspaces permit bash/edit/write.
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
import uuid
from dataclasses import replace
from pathlib import Path

from bash_file_access import opened_files
from build_repository_explore_datasets import _item
from eval_harness import DEFAULT_EVALUATORS, ScoredItem, _score
from repository_explore_scoring import FileAccessCollector, answer_key_hash, compare_reports, score_output

from agent_harness.api.harness import Harness
from agent_harness.domain.approvals import RiskAssessment
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

    def __init__(self, tool, container, access=None, trace_dir=None):
        self.tool = tool
        self.container = container
        self.access = access
        self.trace_dir = trace_dir
        for name in ("name", "description", "input_schema", "replay_policy"):
            setattr(self, name, getattr(tool, name))

    def assess_risk(self, arguments):
        # Running this evaluation explicitly authorizes commands in its disposable,
        # network-disabled container. This policy does not apply to deployed BashTool.
        return RiskAssessment("allow", "explicit disposable-container evaluation", capability_version=self.container)

    async def execute(self, arguments):
        if not isinstance(arguments, dict) or not isinstance(arguments.get("command"), str):
            return await self.tool.execute(arguments)
        trace_name = uuid.uuid4().hex
        original_command = arguments["command"]
        inner = original_command
        if self.access is not None:
            inner = shlex.join(
                [
                    "strace",
                    "-f",
                    "-yy",
                    "-s",
                    "4096",
                    "-e",
                    "trace=open,openat,openat2",
                    "-o",
                    f"/prale-traces/{trace_name}",
                    "bash",
                    "-lc",
                    original_command,
                ]
            )
        command = shlex.join(["docker", "exec", "-w", "/workspace", self.container, "bash", "-lc", inner])
        result = await self.tool.execute(
            {**arguments, "command": command, "timeout": min(arguments.get("timeout", 60), 60)}
        )
        if self.access is not None:
            trace = self.trace_dir / trace_name
            text = trace.read_text(errors="replace") if trace.exists() else ""
            complete = bool(text) and "+++ exited with" in text
            self.access.register_bash(
                original_command,
                {
                    "complete": complete,
                    "files": opened_files(text, self.access.root),
                    "method": "strace-readable-opens-v1",
                    "trace": text,
                },
            )
        return result


async def run_export(case, provider, workdir, image):
    workspace = workdir / "workspace"
    trace_dir = workdir / "bash-traces"
    trace_dir.mkdir(exist_ok=True)
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
            "--mount",
            f"type=bind,source={trace_dir},target=/prale-traces",
            image,
        ],
        text=True,
    ).strip()
    storage = SQLiteStorage(workdir / "session.sqlite")
    access = FileAccessCollector(workspace)
    collector = _Collecting(access)
    identifier = f"eval:{case.id}"
    explorer = (
        _snapshot_explorer(workspace, workdir / "repository-index") if "repository_explore" in case.tools else None
    )
    tools = tuple(
        ContainerBash(tool, container, access, trace_dir) if tool.name == "bash" else tool
        for tool in sandbox_tools(workspace, case.tools, repository_explorer=explorer)
    )
    harness = None
    try:
        harness = await Harness.open(identifier, storage, tools=tools, telemetry=collector)
        lane = await harness.acquire_lane("main")
        await lane.prompt(case.prompt, operation_id=f"{case.id}-1")
        result = await lane.drive(provider)
        return {**_summarize(result, collector, session_id=identifier).as_dict(), "file_access": access.as_dict()}
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
            "file_annotation_version": source["file_annotation_policy"]["version"],
            "answer_key_sha256": answer_key_hash(source),
            "model": args.model,
            "tools": ["read", "bash", "edit", "write"] + (["repository_explore"] if condition == "treatment" else []),
            "workspace_mode": "disposable git archive; bash in network-disabled container at /workspace",
            "bash_image": args.image,
            "bash_timeout_seconds": 60,
            "items": [],
            "metrics": [],
        }
    semaphore = asyncio.Semaphore(args.max_concurrency)

    async def one(task, condition):
        tools = reports[condition]["tools"]
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
            scored = ScoredItem(case_id=case.id, output=output)
            scored.evaluations = _score(case, scored.output, DEFAULT_EVALUATORS)
            reports[condition]["items"].append(
                {
                    "id": case.id,
                    "output": scored.output,
                    "file_score": score_output(task, scored.output),
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
                f"DONE {case.id}: {output['terminal_status']}, tools={len(output['tool_calls'])}, "
                f"duration={output['duration_ms']}ms",
                flush=True,
            )

    # Interleave paired cases to reduce condition-specific time effects.
    await asyncio.gather(*(one(task, condition) for task in source["tasks"] for condition in ("baseline", "treatment")))
    write_json(args.output_dir / "file-scores.json", compare_reports(source, reports["baseline"], reports["treatment"]))
    print(json.dumps({key: report["metrics"] for key, report in reports.items()}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-key-file", type=Path)
    parser.add_argument("--model", default="deepseek-flash")
    parser.add_argument("--max-concurrency", type=int, default=4)
    parser.add_argument("--image", default="prale-eval/repository-explore-bash:v2-traced")
    parser.add_argument("--output-dir", type=Path, default=Path("reports/repository-explore-bash"))
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
