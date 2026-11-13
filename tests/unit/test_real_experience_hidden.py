import json
from pathlib import Path
from types import SimpleNamespace

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
    assert hidden == original
    for target in metadata.get("targets", [metadata.get("target")]):
        assert target not in hidden
    assert metadata["task_id"] in hidden
    assert ".prale-eval/regression.mjs" in hidden
    assert ".prale-eval/result.json" in hidden
    assert "every listed" not in hidden
    assert "Only modify the listed" not in hidden
    assert "Locate" in hidden


def test_generated_basic_and_advanced_tasks_require_repository_discovery():
    from build_real_experience_advanced import render as advanced_render
    from build_real_experience_fixtures import render as basic_render

    for render in (basic_render, advanced_render):
        files = render()
        tasks = [path for path in files if path.name == "TASK.md"]
        assert len(tasks) == 12
        for path in tasks:
            metadata = json.loads(files[path.with_name("fixture.json")])
            text = files[path]
            for target in metadata.get("targets", [metadata.get("target")]):
                assert target not in text
            assert "Locate" in text
            assert "Only modify the listed" not in text
            assert text == (REPO / path).read_text()


@pytest.mark.parametrize("advanced", [False, True])
def test_hidden_presentation_still_supports_legacy_listed_tasks(tmp_path, advanced):
    target = "src/example.ts"
    if advanced:
        text = (
            "Investigate the producer/consumer flow across these source modules;\n"
            f"- `{target}`\n\n## Delivery and local validation\n\n"
            "Modify every listed production file, and add regression tests.\n"
            "Only modify the listed source modules and add files under `.prale-eval/`.\n"
        )
    else:
        text = (
            f"Repair `{target}` with minimal changes.\n"
            "Only modify the target source and add regression files under `.prale-eval/`.\n"
        )
    (tmp_path / "TASK.md").write_text(text)
    (tmp_path / "fixture.json").write_text(
        json.dumps({"oracle_version": 4 if advanced else 3, "targets": [target], "target": target})
    )
    assert task_for_visibility(tmp_path, "listed") == text
    hidden = task_for_visibility(tmp_path, "hidden")
    assert target not in hidden
    assert "Locate" in hidden


@pytest.mark.parametrize("batch", [False, True])
def test_real_v2_cli_defaults_to_hidden_tasks(tmp_path, monkeypatch, batch):
    import sys

    import run_real_experience_batch
    import run_real_experience_stage

    module = run_real_experience_batch if batch else run_real_experience_stage
    calls = []

    def run_stage(**kwargs):
        calls.append(kwargs)
        return {"acceptance": "passed", "duration_seconds": 0}

    monkeypatch.setattr(module, "run_stage", run_stage)
    monkeypatch.setattr(module, "load_capsule", lambda path: SimpleNamespace(benchmark_id="prale-experience-real-v2"))
    args = ["runner", "--capsule", "capsule.json", "--output", str(tmp_path / "report.json"), "--allow-host-execution"]
    if batch:
        monkeypatch.setattr(module, "_fixtures", lambda root: [("episode", "learn", tmp_path)])
        args += ["--adapter", "prale", "--memory-mode", "cold", "--state-dir", str(tmp_path / "state")]
    else:
        args += ["--fixture", str(tmp_path), "--episode", "episode", "--stage", "learn", "--agent-command", "unused"]
    monkeypatch.setattr(sys, "argv", args)
    assert module.main() == 0
    assert len(calls) == 1
    assert calls[0]["target_visibility"] == "hidden"


def test_public_support_has_no_repository_targets_or_business_adapters():
    from build_real_experience_advanced import render as advanced_render
    from build_real_experience_fixtures import render as basic_render

    helpers = []
    for render in (basic_render, advanced_render):
        files = render()
        for path, text in files.items():
            if path.name != "fixture.json":
                continue
            metadata = json.loads(text)
            helper = files[path.parent / "workspace/.prale-eval/subject.mjs"]
            helpers.append(helper)
            for target in metadata.get("targets", [metadata.get("target")]):
                assert target not in helper
                assert Path(target).name not in helper
            for symbol in (
                "recoverToolInvocation",
                "setProjectTrusted",
                "createTrustSubject",
                "createResourcePipeline",
            ):
                assert symbol not in helper
            assert metadata["public_support_version"] == 1
    assert len(helpers) == 24
    assert len(set(helpers)) == 1


def test_public_support_version_preserves_legacy_oracles_and_rejects_unknown_versions():
    from real_experience_support import PUBLIC_SUBJECT, subject_path

    for directory in ("real_experience_contracts", "real_experience_advanced"):
        legacy = REPO / "scripts" / directory
        assert subject_path({}, legacy) == legacy / "subject.mjs"
        assert subject_path({"public_support_version": 1}, legacy) == PUBLIC_SUBJECT
        with pytest.raises(ValueError, match="unsupported"):
            subject_path({"public_support_version": 99}, legacy)
