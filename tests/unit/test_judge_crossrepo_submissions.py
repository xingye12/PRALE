import json
import shutil
from pathlib import Path

import pytest
from judge_crossrepo_submissions import JudgeError, _score_submission, _submission_prompt, _validate_verdict
from real_experience_eval import _capture_validation, sha256


def test_judge_verdict_requires_every_rubric_criterion_and_minimum() -> None:
    rubric = {
        "pass_score": 7,
        "criteria": [
            {"id": "evidence_accuracy", "max_score": 4, "minimum_score": 2},
            {"id": "objective_coverage", "max_score": 4, "minimum_score": 2},
            {"id": "validation_and_delivery", "max_score": 2, "minimum_score": 1},
        ],
    }
    verdict = {
        "criteria": [
            {"id": "evidence_accuracy", "score": 4, "rationale": "grounded"},
            {"id": "objective_coverage", "score": 3, "rationale": "complete"},
            {"id": "validation_and_delivery", "score": 1, "rationale": "focused"},
        ],
        "summary": "pass",
        "critical_failures": [],
    }

    scored = _validate_verdict(verdict, rubric)

    assert scored["passed"] is True
    assert scored["score"] == 8
    with pytest.raises(JudgeError, match="omitted"):
        _validate_verdict({**verdict, "criteria": verdict["criteria"][:-1]}, rubric)


def test_judge_reads_complete_code_diff_and_controller_streams(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    delivery = workspace / ".prale-eval"
    delivery.mkdir()
    (delivery / "result.json").write_text(json.dumps({"mode": "demo", "validation": {"command": "echo replay"}}))
    (delivery / "demo.py").write_text("#" * 13000 + "\nCODE_TAIL\n")
    (workspace / "TASK.md").write_text("Demonstrate the boundary")
    (workspace / "workspace.diff").write_text("+" * 13000 + "\nDIFF_TAIL\n")
    _capture_validation(workspace, tmp_path / "execution", timeout_seconds=1)
    shutil.copytree(tmp_path / "execution", workspace / "execution")
    (workspace / "manifest.json").write_text(
        json.dumps({"execution_sha256": sha256(workspace / "execution/execution.json")})
    )

    prompt = _submission_prompt({"submission": {"path": str(workspace)}}, {"mode": "demo"})

    assert "CODE_TAIL" in prompt
    assert "DIFF_TAIL" in prompt
    assert "FULL STDOUT:\nreplay\n" in prompt
    assert '"origin": "controller_replay"' in prompt
    (workspace / "execution/stdout.txt").write_text("forged success")
    with pytest.raises(JudgeError, match="hash mismatch"):
        _submission_prompt({"submission": {"path": str(workspace)}}, {"mode": "demo"})


@pytest.mark.parametrize(
    "mode,status,passed",
    [("contract", None, False), ("demo", "timed_out", False), ("operate", "completed", True), ("explore", None, True)],
)
def test_quality_cannot_pass_without_completed_nonexplore_execution(
    tmp_path: Path, mode: str, status: str | None, passed: bool
) -> None:
    (tmp_path / ".prale-eval").mkdir()
    (tmp_path / ".prale-eval/result.json").write_text(json.dumps({"mode": mode}))
    if status is not None:
        (tmp_path / "execution").mkdir()
        (tmp_path / "execution/execution.json").write_text(json.dumps({"status": status}))
    rubric = {
        "criteria": [{"id": "validation_and_delivery", "max_score": 2, "minimum_score": 1}],
        "pass_score": 1,
        "mode": mode,
    }
    verdict = {"criteria": [{"id": "validation_and_delivery", "score": 2}]}

    quality = _score_submission(verdict, rubric, tmp_path)

    assert quality["passed"] is passed
    assert quality["score"] == (2 if passed else 0)
