"""Build the deterministic benchmark for cross-session experience compounding.

Unlike the retrieval benchmark, each episode records an observation, then
requires an agent in a *new* session to apply it to a different task.  The
checked-in JSON is intentionally provider-neutral: PRALE, Claude Code, or a
human-operated runner can all produce the same result envelope.
"""

import argparse
import json
from pathlib import Path
from typing import Any

BENCHMARK_ID = "prale-experience-v1"


def _episode(
    identifier: str,
    title: str,
    lesson: str,
    transfer: str,
    evidence_id: str,
    avoidable_actions: list[str],
    correction: str,
) -> dict[str, Any]:
    fixture_root = f"evals/memory/experience-v1/fixtures/{identifier}"

    def stage(stage_id: str) -> dict[str, str]:
        return {
            "workspace_source": f"{fixture_root}/{stage_id}/workspace",
            "oracle_source": f"{fixture_root}/{stage_id}/oracle/verify.py",
            "acceptance_command": "python {oracle_source} {workspace}",
        }

    return {
        "id": identifier,
        "title": title,
        "stages": [
            {
                "id": "learn",
                "purpose": "Create verified experience; do not score this stage as transfer.",
                "task": lesson,
                "evidence_ids": [evidence_id],
                "fixture": stage("learn"),
            },
            {
                "id": "transfer",
                "purpose": "In a new session, apply the earlier evidence to a related task.",
                "task": transfer,
                "required_evidence_ids": [evidence_id],
                "avoidable_actions": avoidable_actions,
                "fixture": stage("transfer"),
            },
            {
                "id": "correction",
                "purpose": "Update the learned rule after contradictory verified evidence.",
                "task": correction,
                "required_evidence_ids": [f"{evidence_id}-corrected"],
                "avoidable_actions": avoidable_actions,
                "fixture": stage("correction"),
            },
        ],
    }


def build_benchmark() -> dict[str, Any]:
    episodes = [
        _episode(
            "migration-runner-transfer",
            "迁移方法跨任务复用",
            "Verify that direct SQLite edits bypass validation and that `uv run alembic upgrade head` is the "
            "approved migration path. Record the command and reason as evidence `migration-runner`.",
            "A different feature needs a schema change. Make the change through the approved migration path and "
            "report the validation you ran. Cite `migration-runner` if it was available.",
            "migration-runner",
            ["sqlite3", "direct schema edit", "ALTER TABLE"],
            "A verified repository change replaces Alembic with `uv run db:migrate`. Update durable guidance as "
            "`migration-runner-corrected`, then perform a second schema change with the new command.",
        ),
        _episode(
            "recovery-boundary-transfer",
            "崩溃恢复边界跨任务复用",
            "Verify that an interrupted never-replay tool has an unknown result and must not execute automatically. "
            "Record this as evidence `never-replay`.",
            "A separate deployment task finds an interrupted shell write. Safely resolve it, preserving the unknown "
            "outcome rather than replaying the write. Cite `never-replay` if it was available.",
            "never-replay",
            ["rerun the shell write", "automatically replay", "repeat the command"],
            "Verified tool metadata changes this command to idempotent safe replay. Record "
            "`never-replay-corrected` and recover the next interrupted task according to the new policy.",
        ),
        _episode(
            "scope-isolation-transfer",
            "仓库边界跨任务复用",
            "Verify that repository-scoped memories cannot be evidence in another repository. Record the boundary "
            "as `scope-boundary`.",
            "Investigate a similarly named service in another repository. Use only local evidence and explain any "
            "missing context. Cite `scope-boundary` if it was available.",
            "scope-boundary",
            ["reuse repository A memory", "copy prior repository evidence", "assume the other repository"],
            "The repositories are now linked by a reviewed shared doctrine. Record `scope-boundary-corrected`, "
            "then use only that doctrine for the cross-repository decision.",
        ),
        _episode(
            "redaction-transfer",
            "安全经验跨任务复用",
            "Verify that authentication headers are redacted before durable capture. Record the rule as "
            "`redaction-rule`.",
            "Capture and summarize another failed API operation containing a bearer token. Preserve diagnostic "
            "value without retaining the token. Cite `redaction-rule` if it was available.",
            "redaction-rule",
            ["Authorization: Bearer", "secret-token", "store the token"],
            "A verified logging format changes to a token fingerprint. Record `redaction-rule-corrected` and "
            "capture a new incident using the fingerprint but no raw credential.",
        ),
    ]
    return {
        "benchmark_id": BENCHMARK_ID,
        "version": 1,
        "protocol": {
            "session_boundary": "Each transfer and correction stage starts a fresh agent session.",
            "warm_run": "The system's normal durable memory may be available; no hand-written summary may be supplied.",
            "cold_run": "Use the same agent/model/configuration with durable memory disabled or empty.",
            "evidence_reporting": "Record only stable evidence IDs actually available to the agent; retain "
            "transcripts separately for audit.",
        },
        "episodes": episodes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="build experience-compounding benchmark cases")
    parser.add_argument("--output", type=Path, default=Path("evals/memory/experience-v1.json"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    rendered = json.dumps(build_benchmark(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.check:
        return 0 if args.output.is_file() and args.output.read_text() == rendered else 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
