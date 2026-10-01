"""Blindly score repository-exploration reports against the checked-in answer key."""

import argparse
import asyncio
import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.runtime.generation import GenerationRequest

DIMENSIONS = ("factual_correctness", "coverage", "architecture_reasoning", "evidence_quality")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", type=Path, default=Path("evals/repository_explore/tasks.json"))
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--treatment", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", default=os.environ.get("PRALE_MODEL", "deepseek-flash"))
    parser.add_argument(
        "--base-url", default=os.environ.get("PRALE_BASE_URL", "https://api.deepseek.com/chat/completions")
    )
    parser.add_argument("--max-concurrency", type=int, default=4)
    return parser


def _task_id(item: Mapping[str, Any]) -> str:
    identifier = str(item["id"])
    return identifier.split("--", 1)[1] if "--" in identifier else identifier


def _prompt(task: Mapping[str, Any], answer: str) -> str:
    material = {
        "prompt": task["prompt"],
        "required_facts": task["required_facts"],
        "disallowed_claims": task["disallowed_claims"],
        "reference_answer": task["reference_answer"],
    }
    return (
        "你是严格、盲测的代码仓库探索答案评审。不要猜测回答来自哪个实验条件，也不要奖励篇幅。"
        "只依据给出的参考材料评审回答；回答未提及某事实不等于错误，但会影响 coverage。"
        "若回答明确断言了 prohibited claim，factual_correctness 必须不高于 1。"
        "evidence_quality 只奖励真实且支持结论的仓库相对路径/符号证据。\n\n"
        "参考材料：\n"
        f"{json.dumps(material, ensure_ascii=False)}\n\n"
        "匿名待评回答：\n"
        f"{answer}\n\n"
        "只返回 JSON object："
        '{"factual_correctness":0,"coverage":0,"architecture_reasoning":0,'
        '"evidence_quality":0,"rationale":"不超过300字"}。四个分数必须是 0 到 4 的整数。'
    )


def _decode(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:]).strip()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("judge response is not an object")
    result: dict[str, Any] = {}
    for dimension in DIMENSIONS:
        score = value.get(dimension)
        if not isinstance(score, int) or isinstance(score, bool) or not 0 <= score <= 4:
            raise ValueError(f"invalid {dimension}")
        result[dimension] = score
    rationale = value.get("rationale", "")
    result["rationale"] = rationale if isinstance(rationale, str) else ""
    result["overall"] = sum(result[dimension] for dimension in DIMENSIONS) / len(DIMENSIONS)
    return result


async def _judge(
    provider: DeepSeekProvider,
    task: Mapping[str, Any],
    item: Mapping[str, Any],
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    output = item.get("output")
    answer = output.get("answer", "") if isinstance(output, Mapping) else ""
    if not isinstance(answer, str):
        answer = ""
    async with semaphore:
        try:
            response = await provider.generate(
                GenerationRequest(
                    session_id="repository-explore-judge",
                    lane="judge",
                    operation_id=f"judge-{_task_id(item)}",
                    messages=({"role": "user", "content": _prompt(task, answer)},),
                )
            )
            score = _decode(response.content)
            return {"id": item["id"], "task_id": _task_id(item), "score": score, "usage": response.usage}
        except Exception as error:
            return {"id": item["id"], "task_id": _task_id(item), "error": type(error).__name__}


def _summary(items: list[dict[str, Any]]) -> dict[str, float | int]:
    scored = [item["score"] for item in items if isinstance(item.get("score"), Mapping)]
    if not scored:
        return {"scored": 0}
    return {
        "scored": len(scored),
        **{dimension: sum(float(score[dimension]) for score in scored) / len(scored) for dimension in DIMENSIONS},
        "overall": sum(float(score["overall"]) for score in scored) / len(scored),
    }


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    api_key = os.environ.get("PRALE_API_KEY", "")
    if not api_key:
        raise ValueError("PRALE_API_KEY is required")
    tasks = {task["id"]: task for task in json.loads(args.tasks.read_text(encoding="utf-8"))["tasks"]}
    reports = {
        "baseline": json.loads(args.baseline.read_text(encoding="utf-8")),
        "treatment": json.loads(args.treatment.read_text(encoding="utf-8")),
    }
    provider = DeepSeekProvider(api_key=api_key, model=args.model, base_url=args.base_url)
    semaphore = asyncio.Semaphore(args.max_concurrency)
    result: dict[str, list[dict[str, Any]]] = {}
    for condition, report in reports.items():
        items = report["items"]
        result[condition] = await asyncio.gather(
            *(_judge(provider, tasks[_task_id(item)], item, semaphore) for item in items)
        )
    return {
        "model": args.model,
        "dimensions": DIMENSIONS,
        "items": result,
        "summary": {key: _summary(value) for key, value in result.items()},
    }


def main() -> int:
    args = _parser().parse_args()
    payload = asyncio.run(_run(args))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
