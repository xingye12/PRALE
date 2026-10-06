import json
import subprocess
import sys
from pathlib import Path

from materialize_crossrepo_oracles import _oracle


def test_generated_oracle_accepts_complete_evidence_and_rejects_missing_artifact(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    required = ("source/a.ts", "source/b.ts")
    for path in required:
        target = workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("export const marker = true;\n", encoding="utf-8")
    evidence = [
        {
            "path": path,
            "symbol": "marker",
            "start_line": 1,
            "end_line": 1,
            "observation": "The marker demonstrates the required boundary.",
        }
        for path in required
    ]
    result = {
        "task_id": "01",
        "repository": "pi",
        "mode": "contract",
        "evidence": evidence,
        "claims": [
            {
                "claim": "The source marker proves the required boundary is present in this local fixture.",
                "evidence_paths": [path],
            }
            for path in required
        ],
        "conclusion": (
            "The two source locations show the contract boundary and provide sufficient repository-specific evidence."
        ),
        "validation": {"command": "node test", "status": "passed", "notes": "Focused local fixture passed."},
    }
    output = workspace / ".prale-eval"
    output.mkdir()
    (output / "result.json").write_text(json.dumps(result), encoding="utf-8")
    oracle = tmp_path / "oracle.py"
    oracle.write_text(
        _oracle(task_id="01", phase="learn", repository="pi", mode="contract", paths=required), encoding="utf-8"
    )

    failed = subprocess.run([sys.executable, str(oracle), str(workspace)], capture_output=True, text=True)
    assert failed.returncode == 1
    assert "missing contract deliverable" in failed.stderr

    (output / "contract-deliverable.md").write_text("A" * 100, encoding="utf-8")
    passed = subprocess.run([sys.executable, str(oracle), str(workspace)], capture_output=True, text=True)
    assert passed.returncode == 0
    assert passed.stdout.strip() == "acceptance passed"
