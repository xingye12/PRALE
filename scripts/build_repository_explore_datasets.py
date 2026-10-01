"""Derive runnable baseline/treatment datasets from the PRALE answer key.

The answer key stays outside the dataset input so an answering model cannot
read it.  Both emitted files pin the same repository commit and differ only
in the available tool list.
"""

import argparse
import json
from pathlib import Path
from typing import Any


def _item(task: dict[str, Any], *, condition: str, sha: str, tools: list[str], required: list[str]) -> dict[str, Any]:
    contract = ", ".join(required)
    prompt = (
        f"{task['prompt']}\n\n"
        "只返回一个 JSON object，不要使用 Markdown。它必须包含以下字段："
        f"{contract}。evidence 的每项必须给出 repository-relative path、symbol 和该证据支持的 claim。"
    )
    return {
        "input": {
            "prompt": prompt,
            "repository_snapshot": {"git_sha": sha},
            "tools": tools,
        },
        "expected_output": {
            "terminal_status": "completed",
            "answer_contract": {"json": True, "schema": {"required": required}},
        },
        # Langfuse dataset item IDs are project-global rather than
        # dataset-local, so paired datasets must not reuse task["id"].
        "metadata": {"id": f"{condition}--{task['id']}", "risk": "normal", "category": task["category"]},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("evals/repository_explore/tasks.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("evals/repository_explore/generated"))
    parser.add_argument(
        "--id-suffix",
        default="",
        help="suffix appended to condition-prefixed item IDs, for example -v2",
    )
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    sha = source["pinned_git_sha"]
    required = source["global_output_contract"]["required_fields"]
    tasks = source["tasks"]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for filename, condition, tools in (
        ("baseline.json", "baseline", ["read"]),
        ("with_explorer.json", "with-explorer", ["read", "repository_explore"]),
    ):
        payload = [
            _item(task, condition=f"{condition}{args.id_suffix}", sha=sha, tools=tools, required=required)
            for task in tasks
        ]
        (args.output_dir / filename).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
