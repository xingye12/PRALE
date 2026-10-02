import json
import subprocess
import sys
from pathlib import Path

from build_experience_eval_fixtures import FIXTURES, ROOT, render_files


def test_every_stage_has_an_isolated_workspace_and_an_executable_oracle(tmp_path: Path) -> None:
    rendered = render_files()

    assert len(FIXTURES) == 16
    assert len(rendered) == 49
    for fixture in FIXTURES:
        relative_oracle = ROOT / fixture.episode / fixture.stage / "oracle" / "verify.py"
        oracle = tmp_path / relative_oracle
        workspace = tmp_path / ROOT / fixture.episode / fixture.stage / "workspace"
        oracle.parent.mkdir(parents=True)
        workspace.mkdir(parents=True)
        oracle.write_text(rendered[relative_oracle], encoding="utf-8")
        (workspace / "decision.json").write_text(json.dumps(fixture.required), encoding="utf-8")

        completed = subprocess.run(
            [sys.executable, str(oracle), str(workspace)], capture_output=True, text=True, check=False
        )

        assert completed.returncode == 0, completed.stderr
