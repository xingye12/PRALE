import json
import sys
from pathlib import Path

from real_experience_eval import _capture_validation


def _submission(workspace: Path, command: str) -> None:
    delivery = workspace / ".prale-eval"
    delivery.mkdir()
    (delivery / "result.json").write_text(
        json.dumps({"mode": "contract", "validation": {"command": command, "status": "passed"}})
    )


def test_capture_preserves_full_streams_and_original_submission(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    script = workspace / "check.py"
    script.write_text(
        "import sys\nfrom pathlib import Path\n"
        "print('x' * 25000)\nprint('diagnostic', file=sys.stderr)\n"
        "Path('.prale-eval/result.json').write_text('modified by validation')\n"
        "Path('.prale-eval/observed.json').write_text('{\"value\":42}')\n"
        "sys.exit(3)\n"
    )
    _submission(workspace, f"{sys.executable} check.py")
    capture = tmp_path / "capture"

    result = _capture_validation(workspace, capture, timeout_seconds=2)

    assert result["status"] == "completed"
    assert result["exit_code"] == 3
    assert (capture / "stdout.txt").read_text() == "x" * 25000 + "\n"
    assert (capture / "stderr.txt").read_text() == "diagnostic\n"
    assert json.loads((workspace / ".prale-eval/result.json").read_text())["mode"] == "contract"
    assert not (workspace / ".prale-eval/observed.json").exists()
    assert json.loads((capture / "artifacts/observed.json").read_text()) == {"value": 42}
    assert json.loads((capture / "execution.json").read_text()) == result


def test_capture_times_out_and_keeps_partial_output(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "check.py").write_text("import time\nprint('started', flush=True)\ntime.sleep(30)\n")
    _submission(workspace, f"{sys.executable} check.py")
    capture = tmp_path / "capture"

    result = _capture_validation(workspace, capture, timeout_seconds=0.2)

    assert result["status"] == "timed_out"
    assert result["exit_code"] != 0
    assert (capture / "stdout.txt").read_text() == "started\n"


def test_missing_command_is_recorded_without_claiming_execution(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _submission(workspace, " ")
    capture = tmp_path / "capture"

    result = _capture_validation(workspace, capture, timeout_seconds=1)

    assert result["status"] == "not_run"
    assert result["exit_code"] is None
    assert (capture / "execution.json").is_file()
