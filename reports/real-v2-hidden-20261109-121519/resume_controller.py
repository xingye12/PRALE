"""Resume hidden-target conditions from controller-owned per-stage JSON records."""
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import sys
import time

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
STATE = REPO / '.eval-state' / OUT.name
sys.path.insert(0, str(REPO / 'scripts'))
from real_experience_eval import load_capsule, run_stage
from report_real_experience_eval import build_report
from run_real_experience_batch import _fixtures

CAPSULE = load_capsule(REPO / 'evals/experience-real-v2/capsules/pi-b455975/capsule.json')


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def event(kind, **details):
    print(json.dumps({'time':datetime.datetime.now(datetime.UTC).isoformat(), 'event':kind, **details}), flush=True)


def condition(suite, mode):
    name = f'{suite}-{mode}'
    fixture_root = REPO / 'evals/experience-real-v2' / ('advanced/fixtures' if suite == 'advanced' else 'fixtures')
    runs = []
    metadata = {'system':'prale', 'memory_mode':mode, 'model':'deepseek-flash', 'suite':suite,
                'fixture_revision':3 if suite == 'advanced' else 4, 'oracle_version':4 if suite == 'advanced' else 3,
                'source_commit':CAPSULE.base_commit, 'source_digest':CAPSULE.source_digest,
                'execution_mode':'local_host', 'stage_timeout_seconds':900, 'promotion_timeout_seconds':900,
                'target_visibility':'hidden', 'accounting_version':2, 'prompt_revision':1,
                'interruption_note':'Initial process interrupted; one archived passing task recovered by offline replay. Unfinished tasks restarted.'}
    for index, (episode, stage, fixture) in enumerate(_fixtures(fixture_root)):
        record = OUT / 'stages' / name / episode / f'{stage}.json'
        archive = OUT / 'submissions' / name / episode / stage
        if record.is_file():
            result = json.loads(record.read_text())
            event('stage_restored', condition=name, episode=episode, stage=stage, acceptance=result['acceptance'])
        else:
            if archive.exists():
                raise RuntimeError(f'Unsettled archive requires offline recovery: {archive}')
            local_state = STATE / name if mode == 'warm' else STATE / name / f'cold-{index:02d}'
            checkpoint = local_state / f'adapter-{episode}-{stage}.json'
            command = [sys.executable, str(REPO / 'scripts/real_experience_adapters.py'), 'prale',
                       '--workspace', '{workspace}', '--state-dir', str(local_state), '--memory-mode', mode,
                       '--repository-id', f'pi-b455975-{suite}', '--model', 'deepseek-flash',
                       '--timeout', '900', '--promotion-timeout', '900', '--output', str(checkpoint)]
            event('stage_started', condition=name, episode=episode, stage=stage)
            save(OUT / 'progress' / f'{name}.json', {'episode':episode, 'stage':stage, 'status':'running'})
            try:
                result = run_stage(capsule=CAPSULE, fixture=fixture, agent_command=command,
                                   allow_host_execution=True, timeout_seconds=1920, validation_timeout_seconds=90,
                                   target_visibility='hidden', submission_dir=archive)
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
                  acceptance=result['acceptance'], solving_seconds=result.get('duration_seconds'),
                  promotion_seconds=result.get('promotion', {}).get('duration_seconds'),
                  error=(result.get('oracle_result') or {}).get('error') or result.get('error'))
        runs.append(result)
        raw = {'metadata':metadata, 'runs':runs}
        save(OUT / f'{name}.raw.json', raw)
        save(OUT / f'{name}.report.json', build_report(raw))
    save(OUT / 'progress' / f'{name}.json', {'status':'completed', 'tasks':len(runs)})
    return name, runs


def main():
    if not os.environ.get('API_KEY'):
        raise ValueError('API_KEY is required')
    started = time.monotonic()
    event('resumed', output=str(OUT))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(condition, suite, mode) for suite in ('basic', 'advanced') for mode in ('warm', 'cold')]
        conditions = dict(f.result() for f in concurrent.futures.as_completed(futures))
    summary = {name:{'completed':len(runs), 'passed':sum(r['acceptance']=='passed' for r in runs),
                     'solving_seconds':sum(r.get('duration_seconds', 0) for r in runs),
                     'solving_tokens_observed':sum(r.get('usage', {}).get('total_tokens', 0) for r in runs),
                     'promotion_seconds':sum(r.get('promotion', {}).get('duration_seconds', 0) for r in runs),
                     'promotion_tokens_observed':sum(r.get('promotion', {}).get('usage', {}).get('total_tokens', 0) for r in runs)}
               for name, runs in conditions.items()}
    save(OUT / 'summary.json', summary)
    save(OUT / 'run-status.json', {'status':'completed', 'resumed_wall_seconds':time.monotonic()-started})
    event('completed', summary=summary)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        save(OUT / 'run-status.json', {'status':'interrupted', 'error_class':type(error).__name__, 'error':str(error)})
        raise
