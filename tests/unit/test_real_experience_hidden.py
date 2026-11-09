import json
from pathlib import Path

import pytest
from real_experience_tasks import task_for_visibility

REPO = Path(__file__).resolve().parents[2]
FIXTURES = sorted((REPO / "evals/experience-real-v2").glob("fixtures/*/*/fixture.json")) + sorted(
    (REPO / "evals/experience-real-v2/advanced").glob("fixtures/*/*/fixture.json")
)


@pytest.mark.parametrize("metadata_path", FIXTURES, ids=lambda p: str(p.parent.relative_to(REPO)))
def test_hidden_task_removes_targets_and_preserves_executable_delivery(metadata_path):
    metadata = json.loads(metadata_path.read_text())
    fixture = metadata_path.parent
    original = (fixture / "TASK.md").read_text()
    assert task_for_visibility(fixture, "listed") == original
    hidden = task_for_visibility(fixture, "hidden")
    for target in metadata.get("targets", [metadata.get("target")]):
        assert target not in hidden
    assert metadata["task_id"] in hidden
    assert ".prale-eval/regression.mjs" in hidden
    assert ".prale-eval/result.json" in hidden
    assert "every listed" not in hidden
    assert "Only modify the listed" not in hidden
    assert "Locate" in hidden
