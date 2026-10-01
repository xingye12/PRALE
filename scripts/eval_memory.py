"""Run the long-term-memory benchmark against real extraction and retrieval.

Generation calls the configured JSON memory extractor.  Recall uses the real
SQLite store, optionally with the local BGE-M3 provider.  Correction exercises
the store's actual conflict/state transitions; it does not ask an LLM to invent
conflict decisions, because that would conflate extraction quality with the
durable correction contract.
"""

import argparse
import asyncio
import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from agent_harness.domain.memory import (
    AtomicCandidate,
    MemoryScope,
    RecallBudget,
    RecallQuery,
    SessionTraceArchive,
    TraceItem,
    content_hash,
)
from agent_harness.integrations.bge_m3 import LocalBgeM3EmbeddingProvider
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.memory_provider import JsonMemoryExtractor
from agent_harness.runtime.generation import GenerationRequest
from agent_harness.storage.memory_sqlite import SQLiteMemoryStore


def _read(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get("benchmark_id") != "prale-memory-v1":
        raise ValueError("expected a prale-memory-v1 benchmark JSON object")
    return value


def _archive(case: dict[str, Any], number: int) -> SessionTraceArchive:
    items = tuple(
        TraceItem(
            f"{case['id']}-entry-{index}",
            index,
            index,
            "message",
            item["role"],
            item["content"],
            {"role": item["role"], "content": item["content"]},
        )
        for index, item in enumerate(case["archive"]["items"], 1)
    )
    source_ids = tuple(item.source_entry_id for item in items)
    return SessionTraceArchive(
        f"archive-{number}",
        MemoryScope(case["archive"]["scope"]),
        f"session-{number}",
        "main",
        f"operation-{number}",
        "run",
        None,
        source_ids[-1] if source_ids else None,
        source_ids,
        content_hash("\0".join(source_ids)),
        "conversation-v1",
        number,
        content_hash(json.dumps([item.payload for item in items], sort_keys=True)),
        items,
    )


def _extractor(prompt: Path) -> JsonMemoryExtractor:
    api_key = os.environ.get("PRALE_API_KEY", "").strip()
    if not api_key:
        raise ValueError("PRALE_API_KEY is required for generation evaluation")
    provider = DeepSeekProvider(
        api_key=api_key,
        model=os.environ.get("PRALE_MODEL", "deepseek-flash"),
        base_url=os.environ.get("PRALE_BASE_URL", "https://api.deepseek.com/chat/completions"),
        timeout_seconds=float(os.environ.get("PRALE_TIMEOUT_SECONDS", "60")),
    )
    system_prompt = prompt.read_text(encoding="utf-8")

    async def complete(stage: str, payload: dict[str, object]) -> str:
        result = await provider.generate(
            GenerationRequest(
                session_id="memory-eval",
                lane="generation",
                operation_id=stage,
                messages=(
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": json.dumps({"stage": stage, **payload}, ensure_ascii=False)},
                ),
                tools=(),
            )
        )
        return result.content

    return JsonMemoryExtractor(complete)


async def _generation(cases: list[dict[str, Any]], prompt: Path | None) -> list[dict[str, Any]]:
    if prompt is None:
        return [{"id": case["id"], "candidates": [], "error": "generation skipped"} for case in cases]
    extractor = _extractor(prompt)
    results = []
    for index, case in enumerate(cases, 1):
        try:
            candidates = await extractor.extract_l1((_archive(case, index),))
            results.append(
                {
                    "id": case["id"],
                    "candidates": [
                        {"type": item.type, "content": item.content, "scene_key": item.scene_key} for item in candidates
                    ],
                }
            )
        except Exception as error:
            results.append({"id": case["id"], "candidates": [], "error": type(error).__name__})
    return results


def _ids(values: list[str]) -> Callable[[], str]:
    iterator = iter(values)
    return lambda: next(iterator)


def _fact(
    content: str,
    source: str,
    *,
    scene_key: str | None = None,
    decision: str = "create",
    supersedes: tuple[str, ...] = (),
) -> AtomicCandidate:
    return AtomicCandidate(
        "work_fact",
        content,
        "memory evaluation fixture",
        scene_key or source,
        80,
        1.0,
        {"work_object": "memory-eval", "status": "verified", "activity_start_time": "0", "activity_end_time": "0"},
        (source,),
        decision,  # type: ignore[arg-type] -- benchmark decision vocabulary is validated by the domain.
        supersedes,
        "memory evaluation fixture",
    )


async def _recall(cases: list[dict[str, Any]], mode: str, model_path: Path | None) -> list[dict[str, Any]]:
    if mode == "hybrid" and model_path is None:
        raise ValueError("--embedding-model is required for hybrid recall")
    provider = LocalBgeM3EmbeddingProvider(model_path) if model_path is not None else None
    results = []
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for case in cases:
        key = (case["scope"], json.dumps(case["corpus"], sort_keys=True))
        groups.setdefault(key, []).append(case)
    for (_, _), group in groups.items():
        first = group[0]
        corpus = first["corpus"]
        ids = [item["id"] for item in corpus]
        store = SQLiteMemoryStore(":memory:", id_factory=_ids(ids), embedding_provider=provider)
        scope = MemoryScope(first["scope"])
        try:
            await store.apply_candidates(scope, tuple(_fact(item["content"], item["id"]) for item in corpus), 1)
            for case in group:
                bundle = await store.search(
                    scope,
                    RecallQuery(case["query"]),
                    RecallBudget(max_l1_items=5, min_score=0.0, include_l2=False, include_l3=False),
                )
                results.append(
                    {"id": case["id"], "mode": mode, "retrieved_ids": [item.id for item in bundle.items]}
                )
        except Exception as error:
            results.extend(
                {"id": case["id"], "mode": mode, "retrieved_ids": [], "error": type(error).__name__} for case in group
            )
        finally:
            store.close()
    return results


async def _correction(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results = []
    for case in cases:
        old = case["initial"]
        store = SQLiteMemoryStore(":memory:", id_factory=_ids([old["memory_id"], f"new-{case['id']}"]))
        scope = MemoryScope("repo-memory-eval")
        try:
            await store.apply_candidates(scope, (_fact(old["content"], "initial", scene_key="correction"),), 1)
            decision = case["expected_decision"]
            if decision == "reject":
                active_scope = scope
            elif decision == "separate_scope":
                active_scope = MemoryScope("other-repository")
                await store.apply_candidates(
                    active_scope, (_fact(case["new_evidence"], "new", scene_key="correction"),), 2
                )
            else:
                action = "merge" if decision == "merge" else "supersede"
                await store.apply_candidates(
                    scope,
                    (
                        _fact(
                            case["new_evidence"],
                            "new",
                            scene_key="correction",
                            decision=action,
                            supersedes=(old["memory_id"],),
                        ),
                    ),
                    2,
                )
                active_scope = scope
            old_row = next(
                row for row in await store.list_l1(scope, None, None, 20) if row.memory_id == old["memory_id"]
            )
            active_rows = await store.list_l1(active_scope, "active", None, 20)
            recall = await store.search(
                scope,
                RecallQuery(" ".join(case["must_not_recall"] or [case["new_evidence"]])),
                RecallBudget(min_score=0.0, include_l2=False, include_l3=False),
            )
            results.append(
                {
                    "id": case["id"],
                    "decision": decision,
                    "old_status": old_row.status,
                    "active_contents": [row.content for row in active_rows],
                    "retrieved_contents": [item.content for item in recall.items],
                }
            )
        except Exception as error:
            results.append({"id": case["id"], "error": type(error).__name__})
        finally:
            store.close()
    return results


async def run(benchmark: dict[str, Any], *, prompt: Path | None, mode: str, model_path: Path | None) -> dict[str, Any]:
    started = time.time()
    generation = await _generation(benchmark["generation"], prompt)
    recall = await _recall(benchmark["semantic_recall"], mode, model_path if mode == "hybrid" else None)
    correction = await _correction(benchmark["correction"])
    return {
        "metadata": {
            "benchmark_id": benchmark["benchmark_id"],
            "mode": mode,
            "embedding_model": str(model_path) if model_path else None,
            "generation_prompt": str(prompt) if prompt else None,
            "duration_seconds": round(time.time() - started, 3),
        },
        "generation": generation,
        "semantic_recall": recall,
        "correction": correction,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="run long-term-memory evaluation cases")
    parser.add_argument("--benchmark", type=Path, default=Path("evals/memory/benchmark-v1.json"))
    parser.add_argument("--output", type=Path, required=True, help="write raw results JSON")
    parser.add_argument("--mode", choices=("bm25", "hybrid"), default="bm25")
    parser.add_argument("--embedding-model", type=Path)
    parser.add_argument("--memory-prompt", type=Path, help="enables real L1 extractor evaluation")
    args = parser.parse_args()
    raw = asyncio.run(
        run(_read(args.benchmark), prompt=args.memory_prompt, mode=args.mode, model_path=args.embedding_model)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(raw, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
