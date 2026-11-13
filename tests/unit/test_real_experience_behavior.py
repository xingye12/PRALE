"""Exercise the shipped capsule, not a miniature substitute for the target code."""

import json
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest
from build_real_experience_fixtures import FIXTURES, render

REPO = Path(__file__).resolve().parents[2]
CAPSULE = REPO / "evals/experience-real-v2/capsules/pi-b455975/source.tar"


def submission_boundaries() -> str:
    # Caller-owned fakes for deterministic test submissions, not fixture support.
    # Execute these adapters through the same generic loader the agent receives.
    legacy = (REPO / "scripts/real_experience_contracts/subject.mjs").read_text()
    start = legacy.index("async function load(")
    end = legacy.index("/** Real migration functions", start)
    return legacy[:start] + "import {loadModule as load} from './subject.mjs';\n" + legacy[end:]


def test_every_stage_has_a_real_mutation_and_explicit_behavior_contract() -> None:
    files = render()
    for fixture in FIXTURES:
        root = Path("evals/experience-real-v2/fixtures") / fixture.episode / fixture.stage
        assert files[root / "mutation.patch"].strip()
        metadata = json.loads(files[root / "fixture.json"])
        assert metadata["oracle_version"] == 3
        assert metadata["target"] == fixture.target
        assert "regression.mjs" in files[root / "TASK.md"]
        assert "required not in" not in files[root / "oracle.py"]


@pytest.fixture(scope="module")
def sources(tmp_path_factory):
    root = tmp_path_factory.mktemp("real-v2-source")
    with tarfile.open(CAPSULE) as archive:
        for fixture in FIXTURES:
            path = root / fixture.target
            if not path.exists():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(fixture.target).read())
    return root


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f"{f.episode}/{f.stage}")
def test_hidden_behavior_accepts_original_and_rejects_every_injected_fault(tmp_path, sources, fixture) -> None:
    if shutil.which("node") is None:
        pytest.skip("Node 24 required for TypeScript behavioral contracts")
    root = tmp_path / "workspace"
    shutil.copytree(sources, root)
    suite = REPO / "scripts/real_experience_contracts/behavior.mjs"

    def run():
        return subprocess.run(
            ["node", "--experimental-vm-modules", str(suite), str(root), fixture.episode],
            capture_output=True,
            text=True,
            timeout=15,
        )

    healthy = run()
    assert healthy.returncode == 0, healthy.stdout + healthy.stderr
    files = render()
    patch = tmp_path / "fault.patch"
    patch.write_text(
        files[Path("evals/experience-real-v2/fixtures") / fixture.episode / fixture.stage / "mutation.patch"]
    )
    subprocess.run(["git", "apply", str(patch)], cwd=root, check=True, capture_output=True)
    broken = run()
    assert broken.returncode != 0, "baseline must fail behavioral acceptance"
    assert "ERR_ASSERTION" in broken.stderr, broken.stdout + broken.stderr
    # An expected snippet pasted into a comment must not repair behavior.
    target = root / fixture.target
    target.write_text(
        target.read_text()
        + "\n"
        + "\n".join("// " + line for line in (sources / fixture.target).read_text().splitlines())
        + "\n"
    )
    assert run().returncode != 0


REGRESSIONS = {
    "extension-trust": """
import assert from 'node:assert/strict';
import {createTrustSubject} from './local-boundaries.mjs';
for (const decision of [true, false]) {
  const {loader} = await createTrustSubject(process.cwd());
  const bootstrap = await loader.loadProjectTrustExtensions();
  assert.equal(bootstrap.extensions.some(e => e.path.endsWith('/project.ts')), false);
  let called = 0;
  await loader.reload({resolveProjectTrust: async () => {called++; return decision;}});
  assert.equal(called, 1);
  assert.equal(loader.getExtensions().extensions.some(e => e.path.endsWith('/project.ts')), decision);
}
""",
    "session-migration": """
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadMigrations} from './local-boundaries.mjs';
const dir = mkdtempSync(join(tmpdir(),'submitted-migration-'));
try {
  const subject = await loadMigrations(process.cwd(), dir);
  writeFileSync(join(dir,'oauth.json'), '\\uFEFF'+JSON.stringify({provider:{access:'token'}}));
  assert.equal(subject.migrateAuthToAuthJson().length,1);
  const cwd = 'C:\\\\Users\\\\dev';
  const content = JSON.stringify({type:'session',cwd});
  writeFileSync(join(dir,'a.jsonl'),content);
  const dest = join(dir,'sessions','--C--Users-dev--');
  mkdirSync(dest,{recursive:true});
  writeFileSync(join(dest,'a.jsonl'),'original');
  writeFileSync(join(dir,'z.jsonl'),content);
  subject.migrateSessionsFromAgentRoot();
  assert.equal(readFileSync(join(dest,'a.jsonl'),'utf8'),'original');
  assert.equal(existsSync(join(dir,'a.jsonl')),true);
  assert.equal(readFileSync(join(dir,'a.jsonl'),'utf8'),content);
  assert.equal(existsSync(join(dest,'z.jsonl')),true);
  assert.equal(readFileSync(join(dest,'z.jsonl'),'utf8'),content);
} finally {rmSync(dir,{recursive:true,force:true});}
""",
    "tool-recovery-order": """
import assert from 'node:assert/strict';
import {createRecoverySubject} from './local-boundaries.mjs';
const run = await createRecoverySubject(process.cwd());
for (const a of ['safe','never']) for (const b of ['safe','never',undefined]) {
  for (const cancelled of [true,false]) {
    const result = await run(a,b,cancelled);
    assert.equal(result.events.includes('invoke'), a==='safe' && b==='safe' && !cancelled);
  }
}
""",
}


def submission(tmp_path, sources, fixture):
    from real_experience_oracle import COMMAND

    root = tmp_path / "submission"
    shutil.copytree(sources, root)
    public = root / ".prale-eval"
    public.mkdir()
    shutil.copy2(REPO / "scripts/real_experience_public_subject.mjs", public / "subject.mjs")
    target = root / fixture.target
    original = target.read_text()
    target.write_text(original.replace(fixture.before, fixture.after, 1))
    fault = tmp_path / "original-fault.ts"
    fault.write_text(target.read_text())
    for args in (
        ("init",),
        ("config", "user.email", "test@example.invalid"),
        ("config", "user.name", "test"),
        ("add", "."),
        ("commit", "-m", "fixture baseline"),
    ):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
    baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    from real_experience_manifest import capture_manifest

    capture_manifest(root, fault.with_suffix(".baseline.json"), baseline)
    target.write_text(original)
    (public / "local-boundaries.mjs").write_text(submission_boundaries())
    (public / "regression.mjs").write_text(REGRESSIONS[fixture.episode])
    (public / "result.json").write_text(
        json.dumps(
            {
                "task_id": f"{fixture.episode}/{fixture.stage}",
                "repository": "earendil-works/pi",
                "mode": "repair",
                "validation": {
                    "command": COMMAND,
                    "status": "passed",
                    "notes": "Assertions exercise the real submitted source.",
                },
            }
        )
    )
    fixture_root = REPO / "evals/experience-real-v2/fixtures" / fixture.episode / fixture.stage
    return fixture_root, root, fault, baseline


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f"{f.episode}/{f.stage}")
def test_full_oracle_requires_behavior_and_mutation_sensitive_regression(tmp_path, sources, fixture):
    from real_experience_oracle import evaluate

    report = evaluate(*submission(tmp_path, sources, fixture))
    assert report["status"] == "passed", report
    assert report["checks"]["regression_fixed"]["exit_code"] == 0
    assert report["checks"]["regression_fault"]["exit_code"] == 42


@pytest.mark.parametrize(
    "regression",
    [
        "console.log('passed');",
        "throw new SyntaxError('not a regression assertion');",
        "import assert from 'node:assert/strict'; assert.fail('always fails');",
        # A runtime error that occurs only on the faulty code must not count as a kill.
        """import {createRecoverySubject} from './local-boundaries.mjs';
const run = await createRecoverySubject(process.cwd());
if (!(await run('safe','safe',false)).events.includes('invoke')) throw new TypeError('broken');""",
    ],
)
def test_oracle_rejects_vacuous_or_invalid_regressions(tmp_path, sources, regression):
    from real_experience_oracle import evaluate

    args = submission(tmp_path, sources, FIXTURES[10])
    (args[1] / ".prale-eval/regression.mjs").write_text(regression)
    assert evaluate(*args)["status"] == "failed"


def test_timeout_is_not_a_successful_mutation_kill(tmp_path):
    from real_experience_oracle import run_node

    script = tmp_path / "hang.mjs"
    script.write_text("setInterval(() => {}, 1000);")
    assert run_node([str(script)], tmp_path, timeout=0.2)["status"] == "timed_out"


@pytest.mark.parametrize("change", ["wrong-task", "helper", "scope", "missing-test"])
def test_delivery_and_scope_are_enforced(tmp_path, sources, change):
    from real_experience_oracle import evaluate

    args = submission(tmp_path, sources, FIXTURES[0])
    root = args[1]
    if change == "wrong-task":
        result = root / ".prale-eval/result.json"
        data = json.loads(result.read_text())
        data["task_id"] = "previous-task"
        result.write_text(json.dumps(data))
    elif change == "helper":
        (root / ".prale-eval/subject.mjs").write_text("// replaced")
    elif change == "scope":
        (root / "unrelated.txt").write_text("outside allowed scope")
    else:
        (root / ".prale-eval/regression.mjs").unlink()
    assert evaluate(*args)["status"] == "failed"


def test_equivalent_code_is_accepted_without_expected_snippet(tmp_path, sources):
    from real_experience_oracle import evaluate

    fixture = FIXTURES[4]
    args = submission(tmp_path, sources, fixture)
    target = args[1] / fixture.target
    target.write_text(
        target.read_text().replace(
            fixture.before,
            'JSON.parse((() => { const text = readFileSync(oauthPath, "utf-8"); return stripBom(text); })())',
        )
    )
    report = evaluate(*args)
    assert report["status"] == "passed", report


@pytest.mark.parametrize("visibility", ["listed", "hidden"])
@pytest.mark.parametrize("fixture", [FIXTURES[0], FIXTURES[4], FIXTURES[8]], ids=lambda f: f.episode)
def test_real_capsule_stage_runs_external_oracle_and_records_replay(tmp_path, sources, fixture, visibility):
    import sys

    from real_experience_eval import load_capsule, run_stage
    from real_experience_oracle import COMMAND

    result = {
        "task_id": f"{fixture.episode}/{fixture.stage}",
        "repository": "earendil-works/pi",
        "mode": "repair",
        "validation": {"command": COMMAND, "status": "passed", "notes": "Real production source assertions executed."},
    }
    script = (
        "from pathlib import Path; "
        "assert not list(Path.cwd().parent.glob('original-fault*')); "
        "assert not any(p.name in {'oracle.py', 'fixture.json', 'mutation.patch'} "
        "for p in Path.cwd().parent.rglob('*'))\n"
        f"assert {visibility!r} != 'hidden' or {fixture.target!r} not in Path('TASK.md').read_text(); "
        f"Path({fixture.target!r}).write_text({(sources / fixture.target).read_text()!r}); "
        f"Path('.prale-eval/local-boundaries.mjs').write_text({submission_boundaries()!r}); "
        f"Path('.prale-eval/regression.mjs').write_text({REGRESSIONS[fixture.episode]!r}); "
        f"Path('.prale-eval/result.json').write_text({json.dumps(result)!r})"
    )
    report = run_stage(
        capsule=load_capsule(CAPSULE.with_name("capsule.json")),
        fixture=REPO / "evals/experience-real-v2/fixtures" / fixture.episode / fixture.stage,
        agent_command=[sys.executable, "-c", script],
        allow_host_execution=True,
        timeout_seconds=10,
        target_visibility=visibility,
    )
    assert report["target_visibility"] == visibility
    assert report["acceptance"] == "passed", report["oracle_output"]
    assert report["oracle_result"]["oracle_version"] == 3
    assert report["oracle_result"]["checks"]["regression_fault"]["exit_code"] == 42


@pytest.mark.parametrize("change", ["hidden-index", "config", "mode"])
def test_scope_does_not_trust_git_index_or_ignore_permission_changes(tmp_path, sources, change):
    from real_experience_oracle import evaluate

    args = submission(tmp_path, sources, FIXTURES[0])
    root = args[1]
    unrelated = root / FIXTURES[4].target
    if change == "hidden-index":
        subprocess.run(["git", "update-index", "--assume-unchanged", FIXTURES[4].target], cwd=root, check=True)
        unrelated.write_text("// hidden out-of-scope modification")
    elif change == "config":
        subprocess.run(["git", "config", "core.ignorecase", "true"], cwd=root, check=True)
    else:
        unrelated.chmod(unrelated.stat().st_mode ^ 0o111)
    report = evaluate(*args)
    assert report["status"] == "failed", report
    assert not report["checks"]


def test_hidden_behavior_cannot_contaminate_regression_copy(tmp_path, sources, monkeypatch):
    import real_experience_oracle as oracle

    args = submission(tmp_path, sources, FIXTURES[0])
    run = oracle.run_node

    def mark_behavior(arguments, cwd, **kwargs):
        if len(arguments) > 1 and arguments[1].endswith("behavior.mjs"):
            (cwd / ".prale-eval/behavior-residue").write_text("hidden test side effect")
        return run(arguments, cwd, **kwargs)

    monkeypatch.setattr(oracle, "run_node", mark_behavior)
    regression = args[1] / ".prale-eval/regression.mjs"
    regression.write_text(
        "import {existsSync} from 'node:fs';\n"
        "if (existsSync('.prale-eval/behavior-residue')) throw new Error('contaminated replay');\n"
        + regression.read_text()
    )
    report = oracle.evaluate(*args)
    assert report["status"] == "passed", report


def test_node_output_with_invalid_utf8_is_retained_without_crashing(tmp_path):
    from real_experience_oracle import run_node

    script = tmp_path / "bytes.mjs"
    script.write_text("process.stdout.write(Buffer.from([255]));")
    result = run_node([str(script)], tmp_path)
    assert result["status"] == "completed"
    assert result["exit_code"] == 0
    assert result["stdout"] == "\ufffd"
