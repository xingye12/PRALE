"""Build the source-controlled v1 benchmark for long-term memory.

The cases are deliberately synthetic and deterministic: every source trace,
expected memory, retrieval target, and correction decision is inspectable in
Git.  They test the memory pipeline, not a particular chat model's ability to
write a polished answer.
"""

import argparse
import json
from pathlib import Path
from typing import Any

BENCHMARK_ID = "prale-memory-v1"


def _trace(*events: tuple[str, str]) -> list[dict[str, str]]:
    return [{"role": role, "content": content} for role, content in events]


def _generation_cases() -> list[dict[str, Any]]:
    facts = [
        (
            "architecture-boundary",
            _trace(
                ("user", "Can runtime import SQLite directly?"),
                ("tool", "grep confirms domain/ has no sqlite imports."),
            ),
            "work_fact",
            "domain must not import SQLite or other storage drivers",
            "architecture",
            "verified dependency boundary",
        ),
        (
            "migration-command",
            _trace(("tool", "README: run uv run alembic upgrade head for schema migrations.")),
            "work_method",
            "Use uv run alembic upgrade head for schema migration",
            "database-migration",
            "verified migration method",
        ),
        (
            "blocked-task",
            _trace(("user", "Please wait for the database credentials before deploying.")),
            "work_task",
            "Deployment is blocked pending database credentials",
            "deployment",
            "open work item",
        ),
        (
            "artifact-reference",
            _trace(("tool", "Build succeeded: artifact dist/prale-0.1.0.whl.")),
            "work_artifact",
            "The build artifact is dist/prale-0.1.0.whl",
            "release",
            "verified artifact",
        ),
        (
            "tool-success-is-evidence",
            _trace(
                ("assistant", "I think the tests may pass."),
                ("tool", "pytest tests/unit/test_memory.py: 18 passed"),
            ),
            "work_fact",
            "tests/unit/test_memory.py passed with 18 tests",
            "testing",
            "only the tool result is evidence",
        ),
        (
            "tool-failure-is-not-success",
            _trace(("tool", "pytest tests/integration/test_api.py failed: connection refused")),
            "work_fact",
            "tests/integration/test_api.py failed because the service connection was refused",
            "testing",
            "failure outcome retained accurately",
        ),
        (
            "path-has-meaning",
            _trace(("tool", "src/agent_harness/memory/runtime.py owns asynchronous capture dispatch.")),
            "work_fact",
            "src/agent_harness/memory/runtime.py owns asynchronous memory capture dispatch",
            "memory-runtime",
            "path includes role",
        ),
        (
            "symbol-has-meaning",
            _trace(("tool", "MemoryRuntime.recall catches store failures and returns an empty degraded bundle.")),
            "work_fact",
            "MemoryRuntime.recall degrades to an empty bundle when the store fails",
            "memory-recall",
            "symbol includes behavior",
        ),
        (
            "duplicate-no-op",
            _trace(("tool", "Confirmed: source entries are frozen in the capture outbox.")),
            "work_fact",
            "capture outbox freezes source entry identifiers",
            "capture",
            "duplicate candidate should be no_op when the same active fact exists",
        ),
        (
            "merge-related-facts",
            _trace(("tool", "Both legacy migration scripts A and B were replaced by uv run alembic upgrade head.")),
            "work_method",
            "Use uv run alembic upgrade head instead of either legacy migration script",
            "database-migration",
            "candidate may merge two superseded methods",
        ),
        (
            "large-output-summary",
            _trace(
                (
                    "tool",
                    "Repository scan: 12000 lines omitted; relevant result: "
                    "Session owns outbox, MemoryStore owns archives.",
                ),
            ),
            "work_fact",
            "Session owns capture outbox while MemoryStore owns archives",
            "ownership",
            "retain conclusion, not raw dump",
        ),
        (
            "reject-unverified-plan",
            _trace(("assistant", "I will probably fix the bug by changing every retry to infinite retries.")),
            None,
            None,
            "retries",
            "assistant plan without a verified outcome must be rejected",
        ),
        (
            "reject-secret",
            _trace(("tool", "Authorization: Bearer secret-token-value; request succeeded.")),
            "work_fact",
            "The authenticated request succeeded",
            "security",
            "secret must be redacted and never appear in candidate content",
        ),
        (
            "task-metadata",
            _trace(("user", "Alice owns the release checklist; due 2026-10-01; status in_progress.")),
            "work_task",
            "Alice owns the release checklist due 2026-10-01",
            "release",
            "requires owner, deadline, and status metadata",
        ),
        (
            "method-not-playbook",
            _trace(
                ("tool", "Verified: editing SQLite directly bypasses migration validation; use the migration runner."),
            ),
            "work_method",
            "Do not edit SQLite directly; use the migration runner because it preserves validation",
            "database-migration",
            "principle, not a step-by-step executable playbook",
        ),
    ]
    cases = []
    for case_id, trace, memory_type, content, scene_key, note in facts:
        expected = [] if memory_type is None else [{"type": memory_type, "content": content, "scene_key": scene_key}]
        cases.append(
            {
                "id": f"generation--{case_id}",
                "archive": {"scope": "repo-memory-eval", "items": trace},
                "expected_memories": expected,
                "forbidden_terms": ["secret-token-value"] if case_id == "reject-secret" else [],
                "note": note,
            }
        )
    return cases


def _recall_cases() -> list[dict[str, Any]]:
    memories = {
        "migration-runner": "Use uv run alembic upgrade head for schema migrations; do not edit SQLite directly.",
        "intent-recovery": "Before any provider call, persist effect intent; recovery reuses the frozen request.",
        "never-tool": "Never-replay tools settle as unknown after interruption and are not automatically rerun.",
        "scope-isolation": (
            "MemoryScope uses repository_id; one repository cannot retrieve another repository's memory."
        ),
        "outbox-freeze": "Terminal settlement freezes source entry IDs and hash in the capture outbox.",
        "rrf": "Hybrid recall combines BM25 and dense embedding ranks with reciprocal-rank fusion.",
        "l2-dormant": "Scenes beyond the capacity limit become dormant instead of being deleted.",
        "trace-redaction": "L0 archive materialization redacts credentials before durable long-term storage.",
        "l3-doctrine": "OperatingDoctrine is global and stores stable principles, not task progress.",
        "budget": "Recall has a bounded total character budget and therefore cannot inject unlimited memory.",
    }
    queries = [
        ("safe database field rollout", "migration-runner"),
        ("what request is used after a crash during model streaming", "intent-recovery"),
        ("should an interrupted shell write be attempted again", "never-tool"),
        ("can memory from a different project influence this agent", "scope-isolation"),
        ("why does later branch navigation not change captured history", "outbox-freeze"),
        ("how are lexical and semantic retrieval results combined", "rrf"),
        ("what happens when there are too many work contexts", "l2-dormant"),
        ("are authentication headers kept in long lived archives", "trace-redaction"),
        ("where should durable engineering principles live", "l3-doctrine"),
        ("why cannot all historical notes be put in the model prompt", "budget"),
    ]
    corpus = [{"id": memory_id, "content": content} for memory_id, content in memories.items()]
    return [
        {
            "id": f"recall--{index:02d}",
            "scope": "repo-memory-eval",
            "query": query,
            "corpus": corpus,
            "must_recall": [target],
            "must_not_recall": [],
            "note": "semantic wording intentionally differs from the memory text",
        }
        for index, (query, target) in enumerate(queries, 1)
    ]


def _correction_cases() -> list[dict[str, Any]]:
    changes = [
        ("migration-command", "make migrate", "uv run alembic upgrade head", "supersede"),
        ("api-endpoint", "/v1/complete", "/v1/chat/completions", "supersede"),
        ("test-command", "pytest -q", "uv run pytest -q", "supersede"),
        ("task-status", "release checklist is blocked", "release checklist is in_progress", "supersede"),
        ("task-completion", "migration task is in_progress", "migration task is completed", "supersede"),
        ("artifact-path", "dist/prale.whl", "artifacts/prale-0.2.0.whl", "supersede"),
        ("merged-methods", "legacy script A and legacy script B", "uv run alembic upgrade head", "merge"),
        ("unverified-claim", "provider timeout is caused by DNS", "assistant merely suspects DNS", "reject"),
        ("failed-evidence", "API health check passes", "health check failed: connection refused", "reject"),
        ("scope-boundary", "repo A uses migration runner X", "repo B uses migration runner Y", "separate_scope"),
    ]
    cases = []
    for case_id, old, new, decision in changes:
        cases.append(
            {
                "id": f"correction--{case_id}",
                "initial": {"memory_id": f"old-{case_id}", "content": old, "status": "active"},
                "new_evidence": new,
                "expected_decision": decision,
                "expected_active": [] if decision == "reject" else [new],
                "expected_old_status": "active" if decision in {"reject", "separate_scope"} else "superseded",
                "must_not_recall": [old] if decision in {"supersede", "merge"} else [],
            }
        )
    return cases


def build_benchmark() -> dict[str, Any]:
    benchmark = {
        "benchmark_id": BENCHMARK_ID,
        "version": 1,
        "generation": _generation_cases(),
        "semantic_recall": _recall_cases(),
        "correction": _correction_cases(),
    }
    assert len(benchmark["generation"]) == 15
    assert len(benchmark["semantic_recall"]) == 10
    assert len(benchmark["correction"]) == 10
    return benchmark


def main() -> int:
    parser = argparse.ArgumentParser(description="build deterministic long-term-memory evaluation cases")
    parser.add_argument("--output", type=Path, default=Path("evals/memory/benchmark-v1.json"))
    parser.add_argument(
        "--check", action="store_true", help="fail if the checked-in file differs from generated output"
    )
    args = parser.parse_args()
    rendered = json.dumps(build_benchmark(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.check:
        return 0 if args.output.is_file() and args.output.read_text() == rendered else 1
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
