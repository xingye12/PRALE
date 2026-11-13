"""Summarize actual basic-only runs, paired costs, traces, and memory health."""
import collections
import json
from pathlib import Path
import sqlite3
import statistics

from agent_harness.domain.memory import MemoryScope
from agent_harness.storage.memory_assets import MarkdownMemoryAssets

OUT = Path(__file__).resolve().parent
STATE = Path(json.loads((OUT / 'paths.json').read_text())['state'])
def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def mean(values):
    return statistics.mean(values) if values else None

runs = {}
summary = {}
failures = []
exploration = []
for mode in ('warm','cold'):
    name = 'advanced-' + mode
    path = OUT / (name + '.raw.json')
    rows = json.loads(path.read_text())['runs'] if path.exists() else []
    runs[mode] = rows
    passed = [r for r in rows if r['acceptance']=='passed']
    complete = [r for r in passed if r.get('usage_complete') is True and 'total_tokens' in r.get('usage',{})]
    summary[name] = {
        'completed':len(rows), 'passed':len(passed), 'expected':12,
        'mean_solving_seconds_given_pass':mean([r['duration_seconds'] for r in passed]),
        'mean_solving_tokens_given_pass_complete':mean([r['usage']['total_tokens'] for r in complete]),
        'complete_token_samples':len(complete),
        'mean_tool_calls_given_pass':mean([r.get('tool_calls',0) for r in passed]),
        'promotion_seconds':sum(r.get('promotion',{}).get('duration_seconds',0) for r in rows),
        'promotion_statuses':dict(collections.Counter(r.get('promotion',{}).get('status','unknown') for r in rows)),
        'explicit_memory_tool_calls':sum(len(r.get('memory_retrievals') or []) for r in rows),
        'solving_errors':[{'episode':r['episode'], 'stage':r['stage'], 'error':r['adapter_result']['error']}
                          for r in rows if r.get('adapter_result',{}).get('error')],
    }
    for row in rows:
        if row['acceptance']!='passed':
            failures.append({'condition':name, 'episode':row['episode'], 'stage':row['stage'],
                'agent_status':row.get('agent_status'),'oracle':row.get('oracle_result'),
                'error':row.get('error'), 'agent_output':row.get('agent_output')})
        trace = OUT / 'traces' / name / row['episode'] / (row['stage'] + '.jsonl')
        events = [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []
        calls = [c for e in events if e['event']=='model_completed' and e['lane']=='main'
                 for c in e['result']['tool_calls']]
        fixture = OUT.parents[1] / 'evals/experience-real-v3/advanced/fixtures' / row['episode'] / row['stage']
        targets = json.loads((fixture / 'fixture.json').read_text())['targets']
        first_target = next((i+1 for i,c in enumerate(calls) if any(target in json.dumps(c['arguments']) for target in targets)),None)
        helper = next((i+1 for i,c in enumerate(calls) if 'subject.mjs' in json.dumps(c['arguments'])),None)
        task = (OUT / 'submissions' / name / row['episode'] / row['stage'] / 'TASK.md').read_text()
        exploration.append({'condition':name,'episode':row['episode'],'stage':row['stage'],
            'target_absent_from_task':all(target not in task for target in targets),
            'requested_tools':dict(collections.Counter(c['name'] for c in calls)),
            'first_target_path_mention_tool_index':first_target,'first_helper_mention_tool_index':helper,
            'opening_requests':[{'name':c['name'], 'arguments_excerpt':str(c['arguments'])[:650]} for c in calls[:8]],
            'note':'Indices describe model tool requests, not verified successful execution; helper mentions can include imports.'})

paired = []
by_key = {(r['episode'],r['stage']):r for r in runs['cold']}
for w in runs['warm']:
    c = by_key.get((w['episode'],w['stage']))
    if not c or any(r['acceptance']!='passed' for r in (w,c)):
        continue
    paired.append({'episode':w['episode'],'stage':w['stage'], 'warm_seconds':w['duration_seconds'],
                   'cold_seconds':c['duration_seconds'],
                   'warm_tokens':w['usage'].get('total_tokens') if w.get('usage_complete') else None,
                   'cold_tokens':c['usage'].get('total_tokens') if c.get('usage_complete') else None})
valid_tokens = [r for r in paired if r['warm_tokens'] is not None and r['cold_tokens'] is not None]
comparison = {'paired_passes':len(paired),'warm_mean_seconds':mean([r['warm_seconds'] for r in paired]),
              'cold_mean_seconds':mean([r['cold_seconds'] for r in paired]),
              'complete_token_pairs':len(valid_tokens),
              'warm_mean_tokens':mean([r['warm_tokens'] for r in valid_tokens]),
              'cold_mean_tokens':mean([r['cold_tokens'] for r in valid_tokens]),'pairs':paired}
if paired:
    comparison['warm_time_reduction_fraction'] = 1-comparison['warm_mean_seconds']/comparison['cold_mean_seconds']
if valid_tokens:
    comparison['warm_token_reduction_fraction'] = 1-comparison['warm_mean_tokens']/comparison['cold_mean_tokens']

memory = {}
db = STATE / 'advanced-warm/memory.sqlite'
if db.exists():
    with sqlite3.connect(f'file:{db}?mode=ro',uri=True) as conn:
        memory['sqlite_counts'] = {table:conn.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] for table in
            ('trace_archives','atomic_memories','work_scene_memories','operating_doctrines')}
        memory['job_states'] = dict(conn.execute('SELECT status,COUNT(*) FROM memory_jobs GROUP BY status').fetchall())
        memory['job_stage_states'] = [{'stage':stage,'status':status,'count':count} for stage,status,count in
            conn.execute('SELECT stage,status,COUNT(*) FROM memory_jobs GROUP BY stage,status').fetchall()]
        columns = {r[1] for r in conn.execute('PRAGMA table_info(memory_jobs)')}
        if 'error_class' in columns:
            memory['dead_letter_errors'] = conn.execute("SELECT stage,error_class,COUNT(*) FROM memory_jobs WHERE status='dead_letter' GROUP BY stage,error_class").fetchall()
    assets = MarkdownMemoryAssets(STATE / 'advanced-warm/memory-assets')
    scenes = assets.read_scenes(MemoryScope('pi-b455975-real-v3-advanced'))
    doctrine = assets.read_doctrine()
    memory['counts'] = {
        'L0_archives': memory['sqlite_counts']['trace_archives'],
        'L1_memories': memory['sqlite_counts']['atomic_memories'],
        'L2_current_scenes': sum(scene.status == 'current' for scene in scenes),
        'L3_doctrines': int(doctrine is not None),
    }
    memory['scenes'] = [{'scenario_key':scene.scenario_key,'status':scene.status,
                         'version':scene.version,'summary':scene.summary} for scene in scenes]
    memory['doctrine_version'] = doctrine.version if doctrine else None
save('summary.json',summary)
save('comparison.json',comparison)
save('failures.json',failures)
save('exploration.json',exploration)
save('memory-diagnostics.json',memory)

def fmt(value):
    return '-' if value is None else f'{value:,.1f}'
lines = ['# Real-v3 进阶任务：隐藏目标后的执行观察','',
    'PRALE / deepseek-flash；进阶 fixture revision 1；warm/cold 各 12 题；仅运行 advanced，基础题未重跑。',
    '使用全新状态目录和本地宿主调试模式。解题耗时与 token 排除记忆晋升；未配置单价，不估算费用。','',
    '| 条件 | 已完成 | 隐藏验收通过 | 平均解题秒（通过题） | 平均解题 token（完整用量） | 完整用量样本 |',
    '|---|---:|---:|---:|---:|---:|']
for name, s in summary.items():
    lines.append(f"| {name} | {s['completed']}/12 | {s['passed']}/{s['completed']} | {fmt(s['mean_solving_seconds_given_pass'])} | {fmt(s['mean_solving_tokens_given_pass_complete'])} | {s['complete_token_samples']} |")
lines += ['', '| 题组/阶段 | warm | cold | warm 秒 | cold 秒 |','|---|---|---|---:|---:|']
for w in runs['warm']:
    c=by_key.get((w['episode'],w['stage']),{})
    lines.append(f"| {w['episode']}/{w['stage']} | {w['acceptance']} | {c.get('acceptance','pending')} | {fmt(w.get('duration_seconds'))} | {fmt(c.get('duration_seconds'))} |")
lines += ['', '同题通过配对统计见 comparison.json；各题隐藏行为、修复版通过、原故障断言失败的完整记录见 stages/ 与 submissions/。',
          '', '探索证据见 exploration.json 和 traces/。题面不列目标路径；公共 subject.mjs 为通用加载器；故障注入不再添加描述错误的源码注释。宿主调试模式仍不提供文件读取安全隔离。',
          '', '记忆晋升开销与 job 状态见 memory-diagnostics.json；promotion completed 只代表 drain 结束，不代表所有 job 成功。',
          '', '单次重复且题目较少；通过率相同或成本差异均不足以独立证明记忆收益。']
(OUT / 'RESULTS.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({'summary':summary,'comparison':{k:v for k,v in comparison.items() if k!='pairs'},'memory':memory},ensure_ascii=False,indent=2))
