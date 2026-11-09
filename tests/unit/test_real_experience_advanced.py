"""Advanced fixtures must need every faulty module, not just two changed filenames."""

import itertools
import json
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
CAPSULE = REPO / "evals/experience-real-v2/capsules/pi-b455975/source.tar"


def test_advanced_corpus_has_twelve_multifile_tasks():
    from build_real_experience_advanced import FIXTURES, ROOT, render

    assert len(FIXTURES) == 12
    assert len({fixture.task_id for fixture in FIXTURES}) == 12
    files = render()
    for fixture in FIXTURES:
        assert len({fault.target for fault in fixture.faults}) >= 2
        base = ROOT / fixture.episode / fixture.stage
        metadata = json.loads(files[base / "fixture.json"])
        assert metadata["oracle_version"] == 4
        assert metadata["targets"] == [fault.target for fault in fixture.faults]
        for fault in fixture.faults:
            assert f"+++ b/{fault.target}" in files[base / "mutation.patch"]
        assert "every" in files[base / "TASK.md"]


@pytest.fixture(scope="module")
def healthy_sources(tmp_path_factory):
    from build_real_experience_advanced import MODULES

    root = tmp_path_factory.mktemp("advanced-source")
    with tarfile.open(CAPSULE) as archive:
        for name in MODULES:
            member = archive.extractfile(name)
            assert member is not None
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(member.read())
    return root


def cases():
    from build_real_experience_advanced import FIXTURES

    return [
        (fixture, subset)
        for fixture in FIXTURES
        for count in range(len(fixture.faults) + 1)
        for subset in itertools.combinations(range(len(fixture.faults)), count)
    ]


@pytest.mark.parametrize(
    "fixture,remaining", cases(), ids=lambda value: value.task_id if hasattr(value, "task_id") else str(value)
)
def test_healthy_passes_and_every_partial_repair_fails(tmp_path, healthy_sources, fixture, remaining):
    import shutil

    root = tmp_path / "workspace"
    shutil.copytree(healthy_sources, root)
    for index in remaining:
        fault = fixture.faults[index]
        target = root / fault.target
        source = target.read_text()
        assert source.count(fault.before) == 1
        target.write_text(source.replace(fault.before, fault.after, 1))
    suite = REPO / "scripts/real_experience_advanced/behavior.mjs"
    completed = subprocess.run(
        ["node", "--experimental-vm-modules", str(suite), str(root), fixture.episode],
        capture_output=True,
        text=True,
        timeout=15,
    )
    output = completed.stdout + completed.stderr
    if remaining:
        assert completed.returncode != 0, output
        assert "ERR_ASSERTION" in output, output
    else:
        assert completed.returncode == 0, output


# Independently written submitted regressions: these use only the public graph
# helper, not the hidden behavioral suite or reference implementation.
REGRESSIONS = {
    "resource-consistency": """
import assert from 'node:assert/strict';
import {createResourcePipeline} from './subject.mjs';
const p = await createResourcePipeline(process.cwd());
assert.equal(await p.resolve(), false);
const pre = await p.loader.loadProjectTrustExtensions();
assert.equal(pre.extensions.some(e => e.path.endsWith('/project.ts')), false);
assert.equal(Object.keys(p.settings.getProjectSettings()).length, 0);
p.scenario.override = false; p.scenario.policy = 'always';
assert.equal(await p.resolve(), false);
p.scenario.override = true;
let result = await p.reload();
assert.equal(result.calls, 1);
assert.equal(result.names.includes('project.ts'), true);
assert.equal(p.settings.getDefaultModel(), 'project-model');
p.settings.setProjectTrusted(false);
assert.equal(Object.keys(p.settings.getProjectSettings()).length, 0);
p.scenario.override = undefined; p.scenario.stored = false;
assert.equal(await p.resolve(), false);
p.scenario.stored = null; p.scenario.extension = {trusted:'yes',remember:false};
await p.reload();
assert.equal(p.consentWrites.length, 0);
p.scenario.extension = {trusted:'no',remember:true};
result = await p.reload();
assert.equal(result.names.includes('project.ts'), false);
assert.equal(p.consentWrites.length, 1);
""",
    "session-integrity": """
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,basename} from 'node:path';
import {createSessionPipeline} from './subject.mjs';
const dir = mkdtempSync(join(process.cwd(),'.prale-eval','advanced-authored-'));
try {
  const p = await createSessionPipeline(process.cwd(),dir);
  assert.equal(p.text.stripBom('\\uFEFFx'),'x');
  writeFileSync(join(dir,'oauth.json'),JSON.stringify({alpha:{access:'oauth'}}));
  writeFileSync(join(dir,'settings.json'),JSON.stringify({apiKeys:{alpha:'fallback',beta:'key'}}));
  p.migration.migrateAuthToAuthJson();
  assert.equal(JSON.parse(readFileSync(join(dir,'auth.json'),'utf8')).alpha.type,'oauth');
  const cwd = '/work/a:b\\\\c';
  const destination = p.session.getDefaultSessionDir(cwd,dir);
  assert.equal(basename(destination),'--work-a-b-c--');
  const records = [{type:'session',id:'session-1',cwd},{type:'message',id:'tail',text:'中文'}];
  const content = records.map(row=>JSON.stringify(row)).join('\\n');
  writeFileSync(join(dir,'a.jsonl'),JSON.stringify(records[0]));
  writeFileSync(join(destination,'a.jsonl'),'existing');
  writeFileSync(join(dir,'z.jsonl'),content);
  p.migration.migrateSessionsFromAgentRoot();
  assert.equal(readFileSync(join(destination,'a.jsonl'),'utf8'),'existing');
  assert.equal(existsSync(join(dir,'a.jsonl')),true);
  assert.equal(existsSync(join(destination,'z.jsonl')),true);
  assert.equal(p.session.loadEntriesFromFile(join(destination,'z.jsonl')).length,2);
  const invalid = join(destination,'invalid.jsonl');
  const bytes = JSON.stringify({type:'session',cwd});
  writeFileSync(invalid,bytes);
  assert.equal(p.session.loadEntriesFromFile(invalid).length,0);
  assert.equal(readFileSync(invalid,'utf8'),bytes);
} finally {rmSync(dir,{recursive:true,force:true});}
""",
    "execution-lifecycle": """
import assert from 'node:assert/strict';
import {createExecutionPipeline} from './subject.mjs';
const p = await createExecutionPipeline(process.cwd());
for (const persisted of ['safe','never']) for (const declared of ['safe','never',undefined]) {
  for (const cancelled of [false,true]) {
    const result = await p.run({persisted,declared,cancelled});
    assert.equal(result.events.includes('invoke'),persisted==='safe' && declared==='safe' && !cancelled);
    if (result.events.includes('invoke')) assert.equal(result.outcome.message.content[0].text,'persisted-arguments');
  }
}
for (const status of ['closed','aborting']) {
  const {gate,control} = p.gate.createGate();
  const error = new Error('terminal');
  if (status==='closed') {control.close(error); control.beginAbort(Promise.resolve());}
  else {control.beginAbort(Promise.resolve()); control.close(error);}
  assert.throws(()=>gate.admit(()=>{}),e=>e===error);
}
let result = await p.run({effect:async ({update})=>{
  update({content:[]}); update({content:[]},{checkpoint:true}); throw new Error('tool failed');
}});
assert.equal(result.checkpoints.length,1);
assert.equal(result.outcome.message.isError,true);
result = await p.run({effect:async ()=>{throw new Error('tool failed');},patch:{isError:false}});
assert.equal(result.outcome.message.isError,false);
result = await p.run({effect:async ({context,control})=>{
  control.beginAbort(Promise.resolve());control.signalAbort();
  assert.equal(context.abortSignal.aborted,true);return {content:[]};
}});
assert.equal(result.context.abortSignal.aborted,true);
result = await p.run();
const count = result.events.length;
result.callback({content:[]},{checkpoint:true});
assert.equal(result.events.length,count);
""",
}


def submitted(tmp_path, healthy_sources, fixture):
    import shutil

    from real_experience_oracle import COMMAND

    root = tmp_path / "submission"
    shutil.copytree(healthy_sources, root)
    public = root / ".prale-eval"
    public.mkdir()
    shutil.copy2(REPO / "scripts/real_experience_advanced/subject.mjs", public / "subject.mjs")
    originals = {}
    faults = tmp_path / "faults"
    for fault in fixture.faults:
        target = root / fault.target
        originals[fault.target] = target.read_text()
        target.write_text(originals[fault.target].replace(fault.before, fault.after, 1))
        captured = faults / fault.target
        captured.parent.mkdir(parents=True, exist_ok=True)
        captured.write_text(target.read_text())
    for args in (
        ("init",),
        ("config", "user.email", "test@example.invalid"),
        ("config", "user.name", "test"),
        ("add", "."),
        ("commit", "-m", "baseline"),
    ):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
    baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    from real_experience_advanced_oracle import capture_baseline

    capture_baseline(root, faults, baseline)
    for target, original in originals.items():
        (root / target).write_text(original)
    (public / "regression.mjs").write_text(REGRESSIONS[fixture.episode])
    (public / "repair.md").write_text(
        "Repair the producer and consumer together, preserving all trust, data safety and lifecycle boundaries. "
        "The executable assertions check every independent source fault."
    )
    (public / "result.json").write_text(
        json.dumps(
            {
                "task_id": fixture.task_id,
                "repository": "earendil-works/pi",
                "mode": "repair",
                "validation": {
                    "command": COMMAND,
                    "status": "passed",
                    "notes": "Independent deterministic module assertions.",
                },
            }
        )
    )
    return REPO / "evals/experience-real-v2/advanced/fixtures" / fixture.episode / fixture.stage, root, faults, baseline


def fixtures():
    from build_real_experience_advanced import FIXTURES

    return FIXTURES


@pytest.mark.parametrize("fixture", fixtures(), ids=lambda f: f.task_id)
def test_oracle_replays_fixed_combined_and_each_individual_fault(tmp_path, healthy_sources, fixture):
    from real_experience_advanced_oracle import evaluate

    report = evaluate(*submitted(tmp_path, healthy_sources, fixture))
    assert report["status"] == "passed", report
    assert len(report["checks"]["regression_individual"]) == len(fixture.faults)
    assert all(row["exit_code"] == 42 for row in report["checks"]["regression_individual"].values())


def test_regression_covering_only_one_file_is_rejected(tmp_path, healthy_sources):
    from real_experience_advanced_oracle import evaluate

    fixture = fixtures()[4]
    args = submitted(tmp_path, healthy_sources, fixture)
    (args[1] / ".prale-eval/regression.mjs").write_text("""
import assert from 'node:assert/strict';
import {createSessionPipeline} from './subject.mjs';
const p=await createSessionPipeline(process.cwd(),process.cwd());
assert.equal(p.text.stripBom('\\uFEFFx'),'x');
""")
    result = evaluate(*args)
    assert result["status"] == "failed", result
    assert "independent fault" in result["error"]


@pytest.mark.parametrize("change", ["missing-source-repair", "out-of-scope", "wrong-task", "helper", "no-op-test"])
def test_invalid_advanced_submissions_cannot_pass(tmp_path, healthy_sources, change):
    from real_experience_advanced_oracle import evaluate

    fixture = fixtures()[0]
    args = submitted(tmp_path, healthy_sources, fixture)
    root = args[1]
    if change == "missing-source-repair":
        fault = fixture.faults[0]
        (root / fault.target).write_bytes((args[2] / fault.target).read_bytes())
    elif change == "out-of-scope":
        (root / "outside.txt").write_text("not allowed")
    elif change == "wrong-task":
        result = root / ".prale-eval/result.json"
        data = json.loads(result.read_text())
        data["task_id"] = "old-task"
        result.write_text(json.dumps(data))
    elif change == "helper":
        (root / ".prale-eval/subject.mjs").write_text("// changed")
    else:
        (root / ".prale-eval/regression.mjs").write_text("console.log('passed');")
    assert evaluate(*args)["status"] == "failed"


@pytest.mark.parametrize("visibility", ["listed", "hidden"])
@pytest.mark.parametrize("fixture", [fixtures()[0], fixtures()[4], fixtures()[8]], ids=lambda f: f.episode)
def test_advanced_stage_captures_all_fault_sources_and_runs_external_oracle(healthy_sources, fixture, visibility):
    import sys

    from real_experience_eval import load_capsule, run_stage
    from real_experience_oracle import COMMAND

    delivery = {
        "task_id": fixture.task_id,
        "repository": "earendil-works/pi",
        "mode": "repair",
        "validation": {
            "command": COMMAND,
            "status": "passed",
            "notes": "Assertions verify coupled production modules.",
        },
    }
    changes = [(fault.target, (healthy_sources / fault.target).read_text()) for fault in fixture.faults]
    script = (
        "from pathlib import Path\n"
        f"targets = {[f.target for f in fixture.faults]!r}\n"
        f"assert {visibility!r} != 'hidden' or all(t not in Path('TASK.md').read_text() for t in targets)\n"
        f"changes = {changes!r}\n"
        "for target, content in changes: Path(target).write_text(content)\n"
        f"Path('.prale-eval/regression.mjs').write_text({REGRESSIONS[fixture.episode]!r})\n"
        f"Path('.prale-eval/result.json').write_text({json.dumps(delivery)!r})\n"
        "Path('.prale-eval/repair.md').write_text('Repair all interacting producer and consumer modules, "
        "preserving data, admission and configuration invariants. Every source fault is checked by real assertions.')\n"
    )
    result = run_stage(
        capsule=load_capsule(CAPSULE.with_name("capsule.json")),
        fixture=REPO / "evals/experience-real-v2/advanced/fixtures" / fixture.episode / fixture.stage,
        agent_command=[sys.executable, "-c", script],
        allow_host_execution=True,
        timeout_seconds=15,
        target_visibility=visibility,
    )
    assert result["target_visibility"] == visibility
    assert result["acceptance"] == "passed", result["oracle_output"]
    assert result["oracle_result"]["oracle_version"] == 4
    assert set(result["oracle_result"]["checks"]["regression_individual"]) == {f.target for f in fixture.faults}
    assert set(f.target for f in fixture.faults).issubset(result["files_changed"])


def test_advanced_batch_discovers_exactly_twelve_tasks():
    from build_real_experience_advanced import ROOT
    from run_real_experience_batch import _fixtures

    assert len(_fixtures(REPO / ROOT)) == 12


def test_equivalent_multimodule_repair_is_not_tied_to_source_snippets(tmp_path, healthy_sources):
    from build_real_experience_advanced import DRIVE, GUARD
    from real_experience_advanced_oracle import evaluate

    fixture = fixtures()[10]
    args = submitted(tmp_path, healthy_sources, fixture)
    target = args[1] / DRIVE
    target.write_text(
        target.read_text().replace(
            GUARD,
            'if (!(cancelled || call.replay !== "safe" || tool?.replay !== "safe")) {',
        )
    )
    report = evaluate(*args)
    assert report["status"] == "passed", report


def run_audit_script(tmp_path, script):
    path = tmp_path / "audit.mjs"
    path.write_text(script)
    return subprocess.run(["node", "--experimental-vm-modules", str(path)], capture_output=True, text=True, timeout=20)


def test_namespace_builtin_import_is_a_valid_equivalent_repair(tmp_path, healthy_sources):
    from build_real_experience_advanced import MIGRATION
    from real_experience_advanced_oracle import evaluate

    args = submitted(tmp_path, healthy_sources, fixtures()[5])
    target = args[1] / MIGRATION
    source = target.read_text()
    source = 'import * as nativePath from "node:path";\n' + source
    target.write_text(
        source.replace('join(agentDir, "sessions", safePath)', 'nativePath.join(agentDir, "sessions", safePath)')
    )
    report = evaluate(*args)
    assert report["status"] == "passed", report


def test_execution_helper_keeps_explicit_missing_policy_unsafe(tmp_path, healthy_sources):
    helper = (REPO / "scripts/real_experience_advanced/subject.mjs").as_uri()
    completed = run_audit_script(
        tmp_path,
        f"""
import assert from 'node:assert/strict';
import {{createExecutionPipeline}} from {json.dumps(helper)};
const p = await createExecutionPipeline({json.dumps(str(healthy_sources))});
for (const persisted of [undefined, null]) {{
  const result = await p.run({{persisted, declared:'safe'}});
  assert.equal(result.events.includes('invoke'), false, 'missing persisted policy is not safe');
}}
""",
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


def test_parallel_execution_helper_runs_do_not_share_checkpoints_or_publication(tmp_path, healthy_sources):
    helper = (REPO / "scripts/real_experience_advanced/subject.mjs").as_uri()
    completed = run_audit_script(
        tmp_path,
        f"""
import assert from 'node:assert/strict';
import {{createExecutionPipeline}} from {json.dumps(helper)};
const p = await createExecutionPipeline({json.dumps(str(healthy_sources))});
let entered, release;
const began = new Promise(resolve=>{{entered=resolve;}});
const barrier = new Promise(resolve=>{{release=resolve;}});
const first = p.run({{effect:async()=>{{entered();await barrier;return {{content:[{{type:'text',text:'A'}}]}};}}}});
await began;
const b = await p.run({{effect:async()=>({{content:[{{type:'text',text:'B'}}]}})}});
release();
const a = await first;
assert.ok(a.outcome, 'each run must receive its own published outcome');
assert.equal(a.outcome.message.content[0].text,'A');
assert.equal(b.outcome.message.content[0].text,'B');
assert.equal(a.events.filter(e=>e==='publish').length,1);
assert.equal(b.events.filter(e=>e==='publish').length,1);
""",
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


@pytest.mark.parametrize(
    "script",
    [
        "process.exit(0);",
        "console.error('PRALE_REGRESSION_ASSERTION'); process.exit(42);",
        "throw Object.assign(new Error('runtime failure'), {name:'AssertionError',code:'ERR_ASSERTION'});",
    ],
)
def test_regression_wrapper_rejects_direct_exit_and_shaped_errors(tmp_path, script):
    from real_experience_oracle import run_node

    target = tmp_path / "regression.mjs"
    target.write_text(script)
    wrapper = REPO / "scripts/real_experience_contracts/regression.mjs"
    result = run_node([str(wrapper), str(target)], tmp_path)
    assert result["exit_code"] not in {0, 42}, result


def test_real_assertion_marker_survives_large_diagnostics(tmp_path):
    from real_experience_oracle import run_node

    target = tmp_path / "regression.mjs"
    target.write_text("import assert from 'node:assert/strict'; assert.fail('x'.repeat(40000));")
    wrapper = REPO / "scripts/real_experience_contracts/regression.mjs"
    result = run_node([str(wrapper), str(target)], tmp_path)
    assert result["exit_code"] == 42, result
    assert "PRALE_REGRESSION_ASSERTION" in result["stderr"]


@pytest.mark.parametrize("change", ["hidden-index-change", "git-config"])
def test_scope_validation_does_not_trust_agent_git_index(tmp_path, healthy_sources, change):
    from build_real_experience_advanced import PATHS
    from real_experience_advanced_oracle import evaluate

    args = submitted(tmp_path, healthy_sources, fixtures()[4])
    root = args[1]
    if change == "hidden-index-change":
        subprocess.run(["git", "update-index", "--assume-unchanged", PATHS], cwd=root, check=True)
        other = root / PATHS
        other.write_text(other.read_text() + "\n// out-of-scope change hidden from git diff\n")
    else:
        subprocess.run(["git", "config", "core.ignoreCase", "true"], cwd=root, check=True)
    report = evaluate(*args)
    assert report["status"] == "failed", report


def test_hidden_suite_cannot_be_short_circuited_by_a_zero_exit(tmp_path, healthy_sources):
    from build_real_experience_advanced import MIGRATION
    from real_experience_advanced_oracle import evaluate

    args = submitted(tmp_path, healthy_sources, fixtures()[4])
    path = args[1] / MIGRATION
    path.write_text('import process from "node:process"; process.exit(0);\n' + path.read_text())
    report = evaluate(*args)
    assert report["status"] == "failed"
    assert report["checks"]["behavior"]["exit_code"] not in {0, 42}


def test_collision_fixture_order_is_independent_of_host_directory_order(tmp_path, healthy_sources):
    import shutil

    from build_real_experience_advanced import MIGRATION

    root = tmp_path / "workspace"
    shutil.copytree(healthy_sources, root)
    target = root / MIGRATION
    target.write_text(
        target.read_text().replace("if (existsSync(newPath)) continue;", "if (existsSync(newPath)) return;")
    )
    helper = (REPO / "scripts/real_experience_advanced/subject.mjs").as_uri()
    completed = run_audit_script(
        tmp_path,
        f"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {{syncBuiltinESMExports}} from 'node:module';
import {{join}} from 'node:path';
import {{createSessionPipeline}} from {json.dumps(helper)};
const native = fs.readdirSync;
fs.readdirSync = (...args)=>native(...args).reverse();
syncBuiltinESMExports();
const dir={json.dumps(str(tmp_path / "agent"))};fs.mkdirSync(dir);
const p=await createSessionPipeline({json.dumps(str(root))},dir);
const destination=p.session.getDefaultSessionDir('/work',dir);
const header=JSON.stringify({{type:'session',id:'s',cwd:'/work'}});
fs.writeFileSync(join(dir,'a.jsonl'),header);
fs.writeFileSync(join(destination,'a.jsonl'),'existing');
fs.writeFileSync(join(dir,'z.jsonl'),header);
p.migration.migrateSessionsFromAgentRoot();
assert.equal(fs.existsSync(join(destination,'z.jsonl')),false,
  'controlled enumeration must reach collision first, even when native fs order is reversed');
""",
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr


@pytest.mark.parametrize(
    "target,before,after",
    [
        (
            "packages/agent/src/harness/runtime/drive/tools.ts",
            'if (!cancelled && call.replay === "safe" && tool?.replay === "safe") {',
            'if (!cancelled && call.replay !== "never" && tool?.replay === "safe") {',
        ),
        (
            "packages/agent/src/harness/runtime/drive/tools.ts",
            "await latestUpdateDelivery;\n\tawait progress.drain();",
            "await latestUpdateDelivery;\n\t// missing drain",
        ),
        (
            "packages/agent/src/harness/execution/tools.ts",
            "usage: patch.usage === undefined ? executed.result.usage : patch.usage,",
            "usage: patch.usage,",
        ),
    ],
)
def test_audit_blind_spot_mutants_are_detected(tmp_path, healthy_sources, target, before, after):
    import shutil

    root = tmp_path / "workspace"
    shutil.copytree(healthy_sources, root)
    path = root / target
    source = path.read_text()
    assert source.count(before) == 1
    path.write_text(source.replace(before, after))
    suite = REPO / "scripts/real_experience_advanced/behavior.mjs"
    completed = subprocess.run(
        ["node", "--experimental-vm-modules", str(suite), str(root), "execution-lifecycle"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert completed.returncode != 0
    assert "ERR_ASSERTION" in completed.stderr, completed.stdout + completed.stderr


def test_regression_cannot_identify_faults_from_controller_directory_names(tmp_path, healthy_sources):
    from real_experience_advanced_oracle import evaluate

    args = submitted(tmp_path, healthy_sources, fixtures()[4])
    (args[1] / ".prale-eval/regression.mjs").write_text(r"""
import assert from 'node:assert/strict';
if (/\/(?:fault-\d+|all-faults)$/.test(process.cwd())) assert.fail('inferred condition from directory');
""")
    report = evaluate(*args)
    assert report["status"] == "failed", report


def test_advanced_scope_detects_permission_only_changes(tmp_path, healthy_sources):
    from real_experience_advanced_oracle import evaluate

    args = submitted(tmp_path, healthy_sources, fixtures()[0])
    subject = args[1] / ".prale-eval/subject.mjs"
    # A production file outside this episode, rather than allowed delivery.
    unrelated = args[1] / "packages/coding-agent/src/migrations.ts"
    assert subject.is_file()
    unrelated.chmod(unrelated.stat().st_mode ^ 0o111)
    report = evaluate(*args)
    assert report["status"] == "failed", report
    assert not report["checks"]


@pytest.mark.parametrize("policy", ["always", "never"])
def test_hidden_resource_contract_rejects_broken_default_policy(tmp_path, healthy_sources, policy):
    import shutil

    from build_real_experience_advanced import PROJECT

    root = tmp_path / "workspace"
    shutil.copytree(healthy_sources, root)
    target = root / PROJECT
    before = f'case "{policy}":\n\t\t\treturn {str(policy == "always").lower()};'
    after = f'case "{policy}":\n\t\t\treturn {str(policy != "always").lower()};'
    source = target.read_text()
    assert source.count(before) == 1
    target.write_text(source.replace(before, after))
    result = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(REPO / "scripts/real_experience_advanced/behavior.mjs"),
            str(root),
            "resource-consistency",
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "ERR_ASSERTION" in result.stderr
    assert f"FAIL default policy={policy}" in result.stderr
