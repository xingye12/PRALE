import asyncio

from build_memory_eval_cases import build_benchmark
from eval_memory import run


def test_runner_executes_real_bm25_and_correction_paths_without_a_provider() -> None:
    raw = asyncio.run(run(build_benchmark(), prompt=None, mode="bm25", model_path=None))

    assert len(raw["generation"]) == 15
    assert all(item["error"] == "generation skipped" for item in raw["generation"])
    assert len(raw["semantic_recall"]) == 10
    assert all(item["mode"] == "bm25" for item in raw["semantic_recall"])
    assert len(raw["correction"]) == 10
    assert all("error" not in item for item in raw["correction"])
