"""One basic-only warm/cold repetition, fresh state, checkpointed stages."""
import concurrent.futures
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

OUT = Path(__file__).resolve().parent
REPO = OUT.parents[1]
STATE = Path(json.loads((OUT / 'paths.json').read_text())['state'])
sys.path.insert(0, str(REPO / 'scripts'))
from real_experience_eval import load_capsule, run_stage
from report_real_experience_eval import build_report
from run_real_experience_batch import _fixtures

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)

def event(kind, **details):
    print(json.dumps({'time':datetime.datetime.now(datetime.UTC).isoformat(), 'event':kind, **details}), flush=True)

def load_settings():
    settings = {}
    for line in Path('/root/web.env').read_text().splitlines():
        line = line.strip().removeprefix('export ')
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key in {'PRALE_API_KEY', 'PRALE_MODEL', 'PRALE_BASE_URL'}:
            parts = shlex.split(value, comments=True)
            settings[key] = parts[0] if parts else ''
    os.environ['API_KEY'] = settings['PRALE_API_KEY']
    return settings

SETTINGS = load_settings()
MODEL = SETTINGS.get('PRALE_MODEL', 'deepseek-flash')
BASE_URL = SETTINGS.get('PRALE_BASE_URL', 'https://api.deepseek.com/chat/completions')
CAPSULE = load_capsule(REPO / 'evals/experience-real-v3/capsules/pi-b455975/capsule.json')
FIXTURES = _fixtures(REPO / 'evals/experience-real-v3/fixtures')
assert len(FIXTURES) == 12
assert all('advanced' not in str(fixture) for _, _, fixture in FIXTURES)

def condition(mode):
    name = 'basic-' + mode
    runs = []
    metadata = {'benchmark_id':'prale-experience-real-v3', 'system':'prale', 'memory_mode':mode, 'model':MODEL, 'suite':'basic',
                'fixture_revision':1, 'oracle_version':3, 'source_commit':CAPSULE.base_commit,
                'source_digest':CAPSULE.source_digest, 'execution_mode':'local_host',
                'stage_timeout_seconds':900, 'promotion_timeout_seconds':900,
                'target_visibility':'hidden', 'accounting_version':2, 'prompt_revision':2,
                'source_annotation_policy':'no injected fault comments', 'trace':'provider-neutral model outputs; observational wrapper only',
                'started_at':datetime.datetime.now(datetime.UTC).isoformat()}
    for index, (episode, stage, fixture) in enumerate(FIXTURES):
        record = OUT / 'stages' / name / episode / (stage + '.json')
        if record.exists():
            result = json.loads(record.read_text())
        else:
            local_state = STATE / name if mode == 'warm' else STATE / name / f'cold-{index:02d}'
            command = [sys.executable, str(OUT / 'adapter_with_trace.py'),
                       str(OUT / 'traces' / name / episode / (stage + '.jsonl')), 'prale',
                       '--workspace','{workspace}', '--state-dir',str(local_state), '--memory-mode',mode,
                       '--repository-id','pi-b455975-real-v3-basic', '--model',MODEL, '--base-url',BASE_URL,
                       '--timeout','900', '--promotion-timeout','900',
                       '--output',str(local_state / f'adapter-{episode}-{stage}.json')]
            event('stage_started', condition=name, episode=episode, stage=stage)
            save(OUT / 'progress' / (name + '.json'), {'status':'running','episode':episode,'stage':stage})
            try:
                result = run_stage(capsule=CAPSULE, fixture=fixture, agent_command=command,
                                   allow_host_execution=True, timeout_seconds=1920,
                                   validation_timeout_seconds=90, target_visibility='hidden',
                                   submission_dir=OUT / 'submissions' / name / episode / stage)
            except Exception as error:
                result = {'acceptance':'failed', 'agent_status':'controller_error',
                          'error':f'{type(error).__name__}: {error}'}
            result.update(episode=episode, stage=stage, memory_mode=mode)
            adapter = result.get('adapter_result')
            if isinstance(adapter, dict):
                result.update(tool_calls=len(adapter.get('tool_calls', [])),
                              memory_retrievals=adapter.get('memory_retrievals'), usage=adapter.get('usage', {}))
            save(record, result)
            event('stage_completed', condition=name, episode=episode, stage=stage,
                  acceptance=result['acceptance'], agent_status=result['agent_status'],
                  solving_seconds=result.get('duration_seconds'),
                  promotion_seconds=result.get('promotion',{}).get('duration_seconds'))
        runs.append(result)
        raw = {'metadata':metadata, 'runs':runs}
        save(OUT / (name + '.raw.json'), raw)
        save(OUT / (name + '.report.json'), build_report(raw))
        adapter = result.get('adapter_result') or {}
        if result['agent_status'] == 'controller_error' or adapter.get('error',{}).get('error_class') in {'AuthenticationError'}:
            event('condition_stopped', condition=name, reason='infrastructure error')
            break
    save(OUT / 'progress' / (name + '.json'), {'status':'completed','tasks':len(runs)})
    return name, runs

def main():
    started = time.monotonic()
    tracked = [REPO / 'scripts' / name for name in ('build_real_experience_v3.py',
        'real_experience_eval.py','real_experience_adapters.py','real_experience_tasks.py','real_experience_oracle.py')]
    save(OUT / 'run-config.json', {'model':MODEL, 'base_url':BASE_URL, 'tasks':24, 'suite':'basic', 'benchmark_id':'prale-experience-real-v3',
         'fixture_revision':1, 'advanced':False, 'execution_mode':'local_host', 'target_visibility':'hidden',
         'node':subprocess.check_output(['node','--version'],text=True).strip(),
         'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip(),
         'artifact_sha256':{str(path.relative_to(REPO)):hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked}})
    save(OUT / 'run-status.json', {'status':'running','pid':os.getpid()})
    event('started', output=str(OUT), model=MODEL, tasks=24)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        conditions = dict(pool.map(condition, ('warm','cold')))
    save(OUT / 'summary.json', {name:{'completed':len(runs),
         'passed':sum(r['acceptance']=='passed' for r in runs),
         'solving_seconds':sum(r.get('duration_seconds',0) for r in runs),
         'promotion_seconds':sum(r.get('promotion',{}).get('duration_seconds',0) for r in runs)}
         for name,runs in conditions.items()})
    save(OUT / 'run-status.json', {'status':'completed','wall_seconds':time.monotonic()-started})
    event('completed')

if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        save(OUT / 'run-status.json', {'status':'interrupted', 'error_class':type(error).__name__, 'error':str(error)})
        raise
