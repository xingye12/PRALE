import asyncio

import pytest
from real_experience_adapters import _claude_metrics, _claude_summary, _MeteredProvider

from agent_harness.runtime.generation import AssistantResult, GenerationRequest


def test_claude_stream_summary_extracts_tool_calls_and_final_usage() -> None:
    output = "\n".join(
        [
            '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}',
            '{"type":"result","usage":{"input_tokens":12,"output_tokens":4},"result":"done"}',
        ]
    )

    assert _claude_summary(output) == {
        "tool_calls": ["Read"],
        "usage": {"input_tokens": 12, "output_tokens": 4},
        "result": {"type": "result", "usage": {"input_tokens": 12, "output_tokens": 4}, "result": "done"},
    }


def test_claude_metrics_normalize_result_scalars() -> None:
    assert _claude_metrics({"num_turns": 3, "duration_api_ms": 42, "total_cost_usd": 0.12}) == {
        "model_turns": 3,
        "model_duration_ms": 42,
        "cost_usd": 0.12,
    }


def test_prale_meter_counts_agent_and_memory_turns_tokens_and_priced_cost() -> None:
    class Provider:
        def __init__(self) -> None:
            self.results = iter(
                (
                    AssistantResult(
                        content="agent",
                        usage={"prompt_tokens": 100, "completion_tokens": 10, "prompt_cache_hit_tokens": 40},
                    ),
                    AssistantResult(content="memory", usage={"prompt_tokens": 50, "completion_tokens": 5}),
                )
            )

        async def generate(self, request: GenerationRequest) -> AssistantResult:
            return next(self.results)

    async def collect() -> dict[str, object]:
        provider = _MeteredProvider(Provider())  # type: ignore[arg-type]
        await provider.generate(GenerationRequest("session", "main", "agent", ()))
        await provider.generate(GenerationRequest("session", "l1", "memory", ()))
        return provider.metrics({"input": 1.0, "cache_read": 0.1, "cache_write": None, "output": 2.0})

    metrics = asyncio.run(collect())

    assert metrics["model_turns"] == 2
    assert metrics["agent_model_turns"] == 1
    assert metrics["memory_model_turns"] == 1
    assert metrics["usage"] == {
        "completion_tokens": 15,
        "input_tokens": 150,
        "output_tokens": 15,
        "prompt_cache_hit_tokens": 40,
        "prompt_tokens": 150,
        "cache_read_input_tokens": 40,
        "total_tokens": 165,
    }
    assert metrics["cost_usd"] == pytest.approx(0.000144)
