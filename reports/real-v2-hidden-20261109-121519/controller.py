import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import sys
import time

REPO = Path('/root/vibe/CoLe/PRALE')
sys.path.insert(0, str(REPO / 'scripts'))
from real_experience_eval import load_capsule, run_stage
from report_real_experience_eval import build_report
from run_real_experience_batch import _fixtures

stamp = datetime.datetime.now(datetime.UTC).strftime('%Y%m%d-%H%M%S')
out = REPO / 'reports' / f'real-v2-hidden-{stamp}'
state = REPO / '.eval-state' / f'real-v2-hidden-{stamp}'
out.mkdir(parents=True)
state.mkdir(parents=True)
(out/'controller.py').write_text(Path(__file__).read_text())
print(json.dumps({'event':'started','output':str(out),'state':str(state),'model':'deepseek-flash','tasks':48}),flush=True)
(REPO / '.eval-state/real-v2-hidden-latest.json').write_text(json.dumps({'output':str(out),'state':str(state)}))
capsule = load_capsule(REPO / 'evals/experience-real-v2/capsules/pi-b455975/capsule.json')

def condition(suite, mode):
    fixture_root = REPO / 'evals/experience-real-v2' / ('advanced/fixtures' if suite == 'advanced' else 'fixtures')
    name = f'{suite}-{mode}'
    runs = []
    metadata = {'system':'prale','memory_mode':mode,'model':'deepseek-flash','suite':suite,
                'fixture_revision':3 if suite == 'advanced' else 4,'oracle_version':4 if suite == 'advanced' else 3,
                'source_commit':capsule.base_commit,'source_digest':capsule.source_digest,
                'execution_mode':'local_host','stage_timeout_seconds':900,'promotion_timeout_seconds':900,
                'target_visibility':'hidden','accounting_version':2,'prompt_revision':1,'started_at':stamp}
    for index,(episode,stage,fixture) in enumerate(_fixtures(fixture_root)):
        local_state = state / name if mode == 'warm' else state / name / f'cold-{index:02d}'
        command = [sys.executable,str(REPO/'scripts/real_experience_adapters.py'),'prale',
                   '--workspace','{workspace}','--state-dir',str(local_state),'--memory-mode',mode,
                   '--repository-id',f'pi-b455975-{suite}','--model','deepseek-flash',
                   '--timeout','900','--promotion-timeout','900','--output',str(local_state / f'adapter-{episode}-{stage}.json')]
        print(json.dumps({'event':'stage_started','condition':name,'episode':episode,'stage':stage}),flush=True)
        try:
            result = run_stage(capsule=capsule,fixture=fixture,agent_command=command,allow_host_execution=True,
                               timeout_seconds=1920,validation_timeout_seconds=90,target_visibility="hidden",
                               submission_dir=out/'submissions'/name/episode/stage)
        except Exception as error:
            result = {'acceptance':'failed','agent_status':'controller_error','error':f'{type(error).__name__}: {error}'}
        result.update({'episode':episode,'stage':stage,'memory_mode':mode})
        adapter = result.get('adapter_result')
        if isinstance(adapter,dict):
            result.update({'tool_calls':len(adapter.get('tool_calls',[])),
                           'memory_retrievals':adapter.get('memory_retrievals'),'usage':adapter.get('usage',{})})
        runs.append(result)
        raw = {'metadata':metadata,'runs':runs}
        (out/f'{name}.raw.json').write_text(json.dumps(raw,ensure_ascii=False,indent=2)+'\n')
        (out/f'{name}.report.json').write_text(json.dumps(build_report(raw),ensure_ascii=False,indent=2)+'\n')
        oracle = result.get('oracle_result') or {}
        print(json.dumps({'event':'stage_completed','condition':name,'episode':episode,'stage':stage,
                          'acceptance':result['acceptance'],'agent_status':result['agent_status'],
                          'solving_seconds':result.get('duration_seconds'),'promotion_seconds':result.get('promotion',{}).get('duration_seconds'),'error':oracle.get('error') or result.get('error')}),flush=True)
        # Infrastructure-wide failures should not consume twelve task timeouts.
        if result.get('agent_status') == 'controller_error':
            break
    return name,runs

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    futures=[pool.submit(condition,suite,mode) for suite in ('basic','advanced') for mode in ('warm','cold')]
    conditions=dict(future.result() for future in concurrent.futures.as_completed(futures))
summary={name:{'completed':len(runs),'passed':sum(r['acceptance']=='passed' for r in runs),
               'seconds':sum(r.get('duration_seconds',0) for r in runs),
               'solving_tokens_observed':sum(r.get('usage',{}).get('total_tokens',0) for r in runs),
               'promotion_seconds':sum(r.get('promotion',{}).get('duration_seconds',0) for r in runs),
               'promotion_tokens_observed':sum(r.get('promotion',{}).get('usage',{}).get('total_tokens',0) for r in runs)} for name,runs in conditions.items()}
(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps({'event':'completed','output':str(out),'summary':summary}),flush=True)
