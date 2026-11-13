"""Validate comment-free faults against the real frozen production modules."""

import json
import shutil
import subprocess
import sys
import tarfile

import pytest
from build_real_experience_v3 import BENCHMARK_ID, REPO, ROOT, advanced, basic, render
from real_experience_eval import load_capsule, run_stage

CASES = [(False, f) for f in basic.FIXTURES] + [(True, f) for f in advanced.FIXTURES]


def test_generated_v3_is_current_and_independent():
    files = render()
    for path, content in files.items():
        assert (REPO / path).read_text() == content, path
    capsule = load_capsule(REPO / ROOT / "capsules/pi-b455975/capsule.json")
    assert capsule.benchmark_id == BENCHMARK_ID
    assert capsule.source_archive.resolve() == basic.CAPSULE.resolve()
    assert len([p for p in files if p.name == "mutation.patch"]) == 24


@pytest.fixture(scope="module")
def healthy(tmp_path_factory):
    root = tmp_path_factory.mktemp("v3-healthy")
    with tarfile.open(basic.CAPSULE) as archive:
        for name in {*advanced.MODULES, *(f.target for f in basic.FIXTURES)}:
            member = archive.extractfile(name)
            assert member is not None
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(member.read())
    return root


@pytest.mark.parametrize("is_advanced,fixture", CASES, ids=[f"{a}-{f.episode}-{f.stage}" for a, f in CASES])
def test_v3_faults_preserve_behavior_and_add_no_comments(tmp_path, healthy, is_advanced, fixture):
    root = tmp_path / "workspace"
    shutil.copytree(healthy, root)
    suite = (
        REPO / "scripts" / ("real_experience_advanced" if is_advanced else "real_experience_contracts") / "behavior.mjs"
    )

    def check():
        return subprocess.run(
            ["node", "--experimental-vm-modules", str(suite), str(root), fixture.episode],
            capture_output=True,
            text=True,
            timeout=15,
        )

    result = check()
    assert result.returncode == 0, result.stdout + result.stderr
    base = ROOT / ("advanced/fixtures" if is_advanced else "fixtures") / fixture.episode / fixture.stage
    subprocess.run(["git", "apply", str(REPO / base / "mutation.patch")], cwd=root, check=True, capture_output=True)
    faults = fixture.faults if is_advanced else (fixture,)
    for fault in faults:
        original = (healthy / fault.target).read_text()
        mutated = (root / fault.target).read_text()
        original_comments = {line.split("//", 1)[1] for line in original.splitlines() if "//" in line}
        assert all(line.split("//", 1)[1] in original_comments for line in mutated.splitlines() if "//" in line)
        assert "// Regression:" not in mutated
        assert "Existing destinations are incorrectly overwritten" not in mutated
    # Each individual faulty module must still be detected by hidden contracts.
    for remaining in faults:
        for fault in faults:
            target = root / fault.target
            source = (healthy / fault.target).read_text()
            from build_real_experience_v3 import mutate

            target.write_text(mutate(source, fault.before, fault.after) if fault == remaining else source)
        result = check()
        assert result.returncode != 0, "fault must fail hidden acceptance"
        assert "ERR_ASSERTION" in result.stderr, result.stdout + result.stderr


COMMENT_CASES = [
    (a, f) for a, f in CASES if any(fault.after.strip().startswith("//") for fault in (f.faults if a else (f,)))
]


@pytest.mark.parametrize("is_advanced,fixture", COMMENT_CASES)
def test_comment_removal_still_passes_external_fixed_fault_replay(healthy, is_advanced, fixture):
    import test_real_experience_advanced as advanced_tests
    import test_real_experience_behavior as basic_tests

    helpers = advanced_tests if is_advanced else basic_tests
    faults = fixture.faults if is_advanced else (fixture,)
    task_id = fixture.task_id if is_advanced else f"{fixture.episode}/{fixture.stage}"
    delivery = {
        "task_id": task_id,
        "repository": "earendil-works/pi",
        "mode": "repair",
        "validation": {
            "command": "node --experimental-vm-modules .prale-eval/regression.mjs",
            "status": "passed",
            "notes": "Assert actual production behavior at boundaries.",
        },
    }
    script = "from pathlib import Path\n"
    script += (
        "assert not any(p.name in {'oracle.py', 'fixture.json', 'mutation.patch'} "
        "for p in Path.cwd().parent.rglob('*'))\n"
    )
    for fault in faults:
        script += f"Path({fault.target!r}).write_text({(healthy / fault.target).read_text()!r})\n"
    script += f"Path('.prale-eval/local-boundaries.mjs').write_text({helpers.submission_boundaries()!r})\n"
    script += f"Path('.prale-eval/regression.mjs').write_text({helpers.REGRESSIONS[fixture.episode]!r})\n"
    script += f"Path('.prale-eval/result.json').write_text({json.dumps(delivery)!r})\n"
    if is_advanced:
        script += (
            "Path('.prale-eval/repair.md').write_text('Repair coupled production modules and preserve admission, "
            "cancellation and data invariants. Verify every changed module with executable assertions.')\n"
        )
    report = run_stage(
        capsule=load_capsule(REPO / ROOT / "capsules/pi-b455975/capsule.json"),
        fixture=REPO / ROOT / ("advanced/fixtures" if is_advanced else "fixtures") / fixture.episode / fixture.stage,
        agent_command=[sys.executable, "-c", script],
        allow_host_execution=True,
        timeout_seconds=15,
        target_visibility="hidden",
    )
    assert report["acceptance"] == "passed", report["oracle_output"]
    assert report["oracle_result"]["status"] == "passed"


def test_report_keeps_v3_identity():
    from report_real_experience_eval import build_report

    report = build_report({"metadata": {"benchmark_id": BENCHMARK_ID}, "runs": []})
    assert report["benchmark_id"] == BENCHMARK_ID


def test_v3_retains_private_file_admission(tmp_path):
    from real_experience_eval import RealExperienceError, build_capsule, materialize_stage
    from test_real_experience_eval import _fixture, _git, _source

    source = _source(tmp_path)
    (source / "oracle.py").write_text("private answer")
    _git(source, "add", ".")
    _git(source, "commit", "-m", "contaminated source")
    capsule = build_capsule(
        repository_root=source, output=tmp_path / "capsule", container_image="test", benchmark_id=BENCHMARK_ID
    )
    with pytest.raises(RealExperienceError, match="private validation artifact"):
        materialize_stage(capsule=capsule, fixture=_fixture(tmp_path), destination=tmp_path / "workspace")
