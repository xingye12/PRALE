"""Run paired file-coverage evaluations against the annotated pinned repository.

Both conditions offer read/bash/edit/write in disposable exports, with bash
inside a network-disabled Docker container. --read-only reproduces the older
read-only comparison. Shell access and mutations are explicitly partial.
No provider calls occur when importing this module, and nothing is uploaded.
"""

import argparse
import asyncio
import io
import json
import os
import subprocess
import tarfile
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

from build_repository_explore_datasets import _item
from repository_explore_scoring import FileAccessCollector, answer_key_hash, compare_reports, score_output

from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.evaluation import parse_case, run_case
from agent_harness.runtime.generation import ChatProvider


def _parser() -> argparse.ArgumentParser:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", type=Path, default=root / "evals/repository_explore/tasks.json")
    parser.add_argument("--repository-root", type=Path, default=root)
    parser.add_argument("--output-dir", type=Path, default=root / "reports/repository-explore-files")
    parser.add_argument("--api-key-file", type=Path)
    parser.add_argument("--model", default=os.environ.get("PRALE_MODEL", "deepseek-flash"))
    parser.add_argument(
        "--base-url", default=os.environ.get("PRALE_BASE_URL", "https://api.deepseek.com/chat/completions")
    )
    parser.add_argument("--max-concurrency", type=int, default=4)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--read-only", action="store_true", help="offer only read and optional explorer; no Docker")
    mode.add_argument("--with-bash", action="store_true", help="compatibility alias for the default full tool set")
    parser.add_argument("--image", default="prale-eval/repository-explore-bash:v2-traced")
    return parser


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


async def run(args: argparse.Namespace, *, provider: ChatProvider | None = None) -> dict[str, Any]:
    if args.max_concurrency < 1:
        raise ValueError("--max-concurrency must be positive")
    source = json.loads(args.tasks.read_text(encoding="utf-8"))
    sha = source["pinned_git_sha"]
    key_hash = answer_key_hash(source)
    # Validate labels/version before any provider effects.
    empty = {"repository_git_sha": sha, "items": []}
    compare_reports(source, empty, empty)
    archive = subprocess.check_output(["git", "-C", str(args.repository_root), "archive", sha])
    if provider is None:
        key = args.api_key_file.read_text().strip() if args.api_key_file else os.environ.get("PRALE_API_KEY", "")
        if not key:
            raise ValueError("PRALE_API_KEY or --api-key-file is required")
        provider = DeepSeekProvider(api_key=key, model=args.model, base_url=args.base_url, timeout_seconds=180)
    head = subprocess.check_output(["git", "-C", str(args.repository_root), "rev-parse", "HEAD"], text=True).strip()
    reports: dict[str, Any] = {}
    for condition in ("baseline", "treatment"):
        reports[condition] = {
            "schema_version": 1,
            "dataset": f"prale/repository-explore-files-{condition}",
            "git_sha": head,
            "repository_git_sha": sha,
            "file_annotation_version": source["file_annotation_policy"]["version"],
            "answer_key_sha256": key_hash,
            "model": getattr(provider, "model", args.model),
            "tools": (["read"] if args.read_only else ["read", "bash", "edit", "write"])
            + (["repository_explore"] if condition == "treatment" else []),
            "workspace_mode": "disposable writable git archive; isolated bash; confined read/edit/write"
            if not args.read_only
            else "disposable git archive; read only tools",
            "items": [],
        }
        if not args.read_only:
            reports[condition]["bash_image"] = args.image
            reports[condition]["bash_timeout_seconds"] = 60
    semaphore = asyncio.Semaphore(args.max_concurrency)

    async def one(task: dict[str, Any], condition: str) -> None:
        report = reports[condition]
        raw = _item(
            task,
            condition=condition,
            sha=sha,
            tools=report["tools"],
            required=source["global_output_contract"]["required_fields"],
        )
        # The runner exports this SHA explicitly; run_case must not create a
        # second worktree or inherit the answering process's live checkout.
        case = replace(parse_case(raw), repository_snapshot=None)
        case = replace(
            case,
            prompt=case.prompt + "\n\n仓库根目录是当前工作目录（bash 中为 /workspace）；只探索此仓库，使用相对路径。",
        )
        async with semaphore:
            print(f"START {case.id}", flush=True)
            with tempfile.TemporaryDirectory(prefix=f"prale-files-{case.id}-") as directory:
                workdir = Path(directory)
                workspace = workdir / "workspace"
                workspace.mkdir()
                with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
                    bundle.extractall(workspace, filter="data")
                if not args.read_only:
                    from run_repository_explore_bash import run_export

                    output = await run_export(case, provider, workdir, args.image)
                else:
                    collector = FileAccessCollector(workspace)
                    result = await run_case(case, provider, workdir=workdir, telemetry=collector)
                    output = {**result.as_dict(), "file_access": collector.as_dict()}
            score = score_output(task, output)
            report["items"].append({"id": case.id, "task_id": task["id"], "output": output, "file_score": score})
            # Stable task order in checkpoint reports, regardless of completion order.
            report["items"].sort(key=lambda item: item["task_id"])
            write_json(args.output_dir / f"{condition}.json", report)
            print(f"DONE {case.id}: {output['terminal_status']}, file_access={score['status']}", flush=True)

    await asyncio.gather(*(one(task, condition) for task in source["tasks"] for condition in ("baseline", "treatment")))
    comparison = compare_reports(source, reports["baseline"], reports["treatment"])
    write_json(args.output_dir / "file-scores.json", comparison)
    print(json.dumps(comparison["summary"], ensure_ascii=False), flush=True)
    return comparison


def main() -> int:
    parser = _parser()
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
