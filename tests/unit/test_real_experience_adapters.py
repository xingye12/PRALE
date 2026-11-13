import asyncio
from pathlib import Path

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


def test_meter_separates_failed_agent_requests_and_memory_usage():
    class Provider:
        async def generate(self, request):
            if request.operation_id == "failure":
                raise TimeoutError("provider timeout")
            return AssistantResult(content="[]", usage={"prompt_tokens": 20, "completion_tokens": 2})

    async def collect():
        meter = _MeteredProvider(Provider())
        with pytest.raises(TimeoutError):
            await meter.generate(GenerationRequest("s", "main", "failure", ()))
        await meter.generate(GenerationRequest("s", "l2", "memory", ()))
        return meter.metrics({}, phase="solving"), meter.metrics({}, phase="promotion")

    solving, promotion = asyncio.run(collect())
    assert solving["model_attempts"] == 1
    assert solving["failed_model_attempts"] == 1
    assert solving["unknown_usage_attempts"] == 1
    assert solving["usage"] == {}
    assert solving["cost_usd"] is None
    assert promotion["usage"]["total_tokens"] == 22
    assert promotion["failed_model_attempts"] == 0


@pytest.mark.parametrize("promotion_failure", [False, True])
def test_prale_primary_metrics_exclude_promotion(tmp_path, monkeypatch, promotion_failure):
    from types import SimpleNamespace

    import real_experience_adapters as adapter

    clock = [0.0]
    monkeypatch.setattr(adapter, "time", SimpleNamespace(monotonic=lambda: clock[0]))

    class Provider:
        async def generate(self, request):
            memory = request.lane != "main"
            clock[0] += 5 if memory else 2
            return AssistantResult(
                content="[]" if memory else "done",
                usage={"prompt_tokens": 20 if memory else 10, "completion_tokens": 1},
            )

    async def promote(runtime, store, scope):
        await runtime._extractor.extract_l1(())
        if promotion_failure:
            raise RuntimeError("promotion failed")

    monkeypatch.setattr(adapter, "_promote", promote)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "TASK.md").write_text("Finish without tools.")
    prompt = tmp_path / "memory.md"
    prompt.write_text("Return JSON.")
    result = asyncio.run(
        adapter.run_prale(
            workspace=workspace,
            state_dir=tmp_path / "state",
            memory_mode="warm",
            repository_id="test",
            provider=Provider(),
            memory_prompt=prompt,
            timeout_seconds=5,
            l1_turn_threshold=5,
            memory_phase="learn",
            pricing={"input": 1.0, "output": 2.0},
        )
    )
    assert result["terminal_status"] == "completed"
    assert result["duration_seconds"] == 2
    assert result["usage"]["total_tokens"] == 11
    assert result["promotion"]["duration_seconds"] == 5
    assert result["promotion"]["usage"]["total_tokens"] == 21
    assert result["promotion"]["status"] == ("failed" if promotion_failure else "completed")
    assert result["total"]["duration_seconds"] == 7
    assert result["total"]["usage"]["total_tokens"] == 32
    assert result["cost_usd"] == pytest.approx(0.000012)
    assert result["promotion"]["cost_usd"] == pytest.approx(0.000022)


def test_failed_solve_is_checkpointed_before_promotion(tmp_path, monkeypatch):
    import json

    import real_experience_adapters as adapter

    class Provider:
        async def generate(self, request):
            await asyncio.Event().wait()

    progress = tmp_path / "state/adapter.json"

    async def promote(runtime, store, scope):
        checkpoint = json.loads(progress.read_text())
        assert checkpoint["terminal_status"] == "timed_out"
        assert checkpoint["unknown_usage_attempts"] == 1
        assert checkpoint["promotion"]["status"] == "not_run"

    monkeypatch.setattr(adapter, "_promote", promote)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "TASK.md").write_text("Solve the incident.")
    prompt = tmp_path / "memory.md"
    prompt.write_text("Return JSON.")
    result = asyncio.run(
        adapter.run_prale(
            workspace=workspace,
            state_dir=tmp_path / "state",
            memory_mode="warm",
            repository_id="test",
            provider=Provider(),
            memory_prompt=prompt,
            timeout_seconds=0.02,
            l1_turn_threshold=5,
            memory_phase="learn",
            pricing={},
            progress_path=progress,
        )
    )
    assert result["terminal_status"] == "timed_out"
    assert result["usage_complete"] is False
    assert result["cost_usd"] is None
    assert result["promotion"]["status"] == "completed"
    assert json.loads(progress.read_text()) == result


def test_eval_shell_hides_repository_and_custom_state(tmp_path):
    import real_experience_adapters as adapter

    state = tmp_path / "custom-state"
    executor = adapter._eval_shell_executor(state)
    masked = executor._hidden_directories()
    assert Path(adapter.__file__).resolve().parents[1] / ".eval-state" in masked
    assert state.resolve() in masked
