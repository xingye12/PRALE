import json
from pathlib import Path

import pytest
from real_experience_eval import RealExperienceError
from run_crossrepo_experience_eval import (
    _blinded_transfer_task,
    _command,
    _completed_ids,
    _l3_audit,
    _load_checkpoint,
    _manifest,
    _stage_fixture,
    _transfer_plan,
    _write_checkpoint,
)


def test_registered_crossrepo_manifest_has_exactly_thirty_complete_pairs() -> None:
    root = Path(__file__).parents[2]
    repositories, pairs = _manifest(root / "evals/experience-crossrepo-v1/task-manifest.json")

    assert set(repositories) == {"pi", "aider", "tdam", "wattclaw"}
    assert [pair["id"] for pair in pairs] == [f"{index:02d}" for index in range(1, 31)]
    assert sum(pair["scope"] == "l3-only" for pair in pairs) == 10


def test_draft_fixture_is_never_runnable(tmp_path: Path) -> None:
    fixture = tmp_path / "learn" / "01"
    fixture.mkdir(parents=True)
    (fixture / "fixture.json").write_text(json.dumps({"status": "draft"}), encoding="utf-8")

    with pytest.raises(RealExperienceError, match="not materialized"):
        _stage_fixture(tmp_path, "learn", "01")

    (fixture / "fixture.json").write_text(json.dumps({"status": "ready"}), encoding="utf-8")
    assert _stage_fixture(tmp_path, "learn", "01") == fixture


def test_cold_transfer_command_has_no_warm_state_or_claude_resume(tmp_path: Path) -> None:
    command = _command(
        adapter="claude-code",
        state=tmp_path / "cold",
        adapter_output=tmp_path / "adapter.json",
        repository_id="pi",
        model="deepseek-flash",
        timeout=60,
        max_budget_usd=10,
        l1_turn_threshold=5,
        memory_phase="cold",
        memory_mode="cold",
        claude_session_id=None,
        claude_experience="native",
        pricing={"input": None, "cache_read": None, "cache_write": None, "output": None},
    )

    assert command[command.index("--memory-mode") + 1] == "cold"
    assert "--resume" not in command


def test_transfer_plan_is_seeded_and_prompt_hides_internal_pair_id(tmp_path: Path) -> None:
    pairs = [{"id": "01"}, {"id": "02"}, {"id": "03"}]
    assert _transfer_plan(pairs, 7) == _transfer_plan(pairs, 7)
    assert [stage["public_id"] for stage in _transfer_plan(pairs, 7)["stages"]] == ["T01", "T02", "T03"]

    (tmp_path / "TASK.md").write_text(
        "# Cross-repository experience task transfer/02\n"
        "Write `task_id` exactly `02` and complete the task.\n",
        encoding="utf-8",
    )
    blinded = _blinded_transfer_task(tmp_path, "02", "T01")

    assert "transfer/02" not in blinded
    assert "`02`" not in blinded
    assert "`task_id` exactly `T01`" in blinded


def test_l3_audit_allows_procedures_but_rejects_repository_facts_and_secrets() -> None:
    scopes = [
        "earendil-works/pi",
        "aider-ai/aider",
        "tencentdb-agent-memory/tencentdb-agent-memory",
        "wattclaw/wattclaw",
    ]

    allowed = _l3_audit("For precedence, make a table-driven test that covers each source.", scopes)
    rejected = _l3_audit(
        "Read packages/coding-agent/src/core/settings-manager.ts and use deepMergeSettings. sk-secretvalue12345",
        scopes,
    )

    assert allowed["status"] == "passed"
    assert rejected["status"] == "rejected"
    assert {finding["kind"] for finding in rejected["findings"]} >= {
        "repository_path",
        "source_symbol",
        "token_shaped",
    }


def test_checkpoint_round_trip_tracks_completed_stages(tmp_path: Path) -> None:
    report = {
        "adapter": "prale",
        "condition": "evolved",
        "learning": [{"id": "01"}],
        "freeze": None,
        "transfer": [{"id": "02"}],
    }
    checkpoint = tmp_path / "progress.json"

    _write_checkpoint(checkpoint, report)
    loaded = _load_checkpoint(checkpoint, adapter="prale", condition="evolved")

    assert _completed_ids(loaded, "learning") == {"01"}
    assert _completed_ids(loaded, "transfer") == {"02"}
    with pytest.raises(RealExperienceError, match="duplicate"):
        _completed_ids({"learning": [{"id": "01"}, {"id": "01"}]}, "learning")
