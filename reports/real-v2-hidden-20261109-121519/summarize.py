"""Summarize hidden-target results using solving-only accounting v2."""
import collections
import datetime
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = ROOT.parents[1] / '.eval-state' / ROOT.name


def mean(values):
    return sum(values) / len(values) if values else None


def metrics(runs):
    timed = [r for r in runs if r.get('accounting_version') == 2]
    usage = [r for r in timed if r.get('usage_complete') is True and 'total_tokens' in r.get('usage', {})]
    return {'tasks':len(runs), 'passed':sum(r['acceptance']=='passed' for r in runs),
            'solving_time_observations':len(timed), 'mean_solving_seconds':mean([r['duration_seconds'] for r in timed]),
            'complete_token_observations':len(usage), 'mean_solving_tokens':mean([r['usage']['total_tokens'] for r in usage]),
            'promotion_seconds':sum(r.get('promotion', {}).get('duration_seconds', 0) for r in runs),
            'promotion_tokens_observed':sum(r.get('promotion', {}).get('usage', {}).get('total_tokens', 0) for r in runs)}


def main():
    conditions = {p.name.removesuffix('.raw.json'):json.loads(p.read_text()) for p in ROOT.glob('*.raw.json')}
    stats = {name:metrics(value['runs']) for name, value in conditions.items()}
    lines = ['# 隐藏目标文件的 real-v2 评测结果', '',
             '模型：deepseek-flash；系统：PRALE；target_visibility=hidden；accounting_version=2。',
             '题目不列本题目标路径与文件数量；源码和跨阶段相同的公共测试加载器可供模型自行探索。',
             'warm 使用全新组内记忆，cold 每题独立状态；基础/进阶各 12 题、各 warm/cold，共 48 次。',
             '本地宿主模式，非正式容器隔离排名。初次进程中断后恢复：基础 warm 首题保留归档，通过离线复验恢复；其余未完成阶段重新启动。', '',
             '## 主结果：解题成本', '',
             '解题时间包含定位、查阅已有记忆、修改和本地验证，排除晋升与控制器隐藏验收。token 只计解题模型调用；缺失用量不计零。', '',
             '| 条件 | 完成 | 通过 | 解题平均秒 | 解题平均 token | 完整 token 样本 |',
             '|---|---:|---:|---:|---:|---:|']
    for name, m in sorted(stats.items()):
        seconds = f"{m['mean_solving_seconds']:.1f}" if m['mean_solving_seconds'] is not None else '未知'
        tokens = f"{m['mean_solving_tokens']:,.0f}" if m['mean_solving_tokens'] is not None else '未知'
        lines.append(f"| {name} | {m['tasks']} | {m['passed']} | {seconds} | {tokens} | {m['complete_token_observations']}/{m['tasks']} |")
    lines += ['', '上表平均耗时包含失败任务；token 平均仅使用用量完整的任务，样本数量显式列出。晋升请求不计入上述时间或 token。', '',
              '## 两组均通过的同题比较', '', '时间按两组均通过的同题配对；token 进一步要求两侧用量均完整。', '', '| 题库 | 时间配对数 | cold 秒 | warm 秒 | token 配对数 | cold token | warm token |', '|---|---:|---:|---:|---:|---:|---:|']
    paired = {}
    for suite in ('basic', 'advanced'):
        warm = conditions.get(f'{suite}-warm', {}).get('runs', [])
        cold = conditions.get(f'{suite}-cold', {}).get('runs', [])
        keys = {(r['episode'], r['stage']) for r in warm if r['acceptance']=='passed'} & {(r['episode'], r['stage']) for r in cold if r['acceptance']=='passed'}
        if not keys:
            continue
        pair = {mode:metrics([r for r in runs if (r['episode'], r['stage']) in keys]) for mode, runs in [('warm',warm),('cold',cold)]}
        token_keys = keys & {(r['episode'],r['stage']) for r in warm if r.get('usage_complete') is True} & {(r['episode'],r['stage']) for r in cold if r.get('usage_complete') is True}
        token_pair = {mode:metrics([r for r in runs if (r['episode'],r['stage']) in token_keys]) for mode,runs in [('warm',warm),('cold',cold)]}
        paired[suite] = {'time_pairs':len(keys),'time':pair,'token_pairs':len(token_keys),'tokens':token_pair}
        c, w = pair['cold'], pair['warm']
        ct, wt = token_pair['cold']['mean_solving_tokens'], token_pair['warm']['mean_solving_tokens']
        ct_text, wt_text = (f"{ct:,.0f}" if ct is not None else '未知'), (f"{wt:,.0f}" if wt is not None else '未知')
        lines.append(f"| {suite} | {len(keys)} | {c['mean_solving_seconds']:.1f} | {w['mean_solving_seconds']:.1f} | {len(token_keys)} | {ct_text} | {wt_text} |")
    lines += ['', '## 晋升开销：单独记账', '', '| 条件 | 晋升累计秒 | 晋升已观测 token |', '|---|---:|---:|']
    for name, m in sorted(stats.items()):
        lines.append(f"| {name} | {m['promotion_seconds']:.1f} | {m['promotion_tokens_observed']:,} |")
    lines += ['', '晋升用量可能因失败请求而不完整；没有单价配置，不推算美元费用。记忆注入/读取作为解题的一部分保留；仅排除产生新记忆的模型请求和晋升时间。', '',
              '## 逐题', '', '| 条件 | 题组 | learn | transfer | correction | retransfer |', '|---|---|---|---|---|---|']
    failures = []
    for name, value in sorted(conditions.items()):
        for episode in sorted({r['episode'] for r in value['runs']}):
            rs = {r['stage']:r for r in value['runs'] if r['episode']==episode}
            cells = [rs.get(stage, {}).get('acceptance', '未完成') for stage in ('learn','transfer','correction','retransfer')]
            lines.append('| ' + ' | '.join([name,episode,*cells]) + ' |')
        for r in value['runs']:
            if r['acceptance'] != 'passed':
                error = (r.get('oracle_result') or {}).get('error') or r.get('error') or r.get('agent_status')
                failures.append({'condition':name,'episode':r['episode'],'stage':r['stage'],'error':error,'agent_error':(r.get('adapter_result') or {}).get('error')})
    lines += ['', '## 失败原因', '']
    for r in failures:
        lines.append(f"- `{r['condition']}/{r['episode']}/{r['stage']}`：{r['error']}；代理错误 {r['agent_error']}。")
    if not failures:
        lines.append('无。')
    diagnostics = {}
    for name in ('basic-warm','advanced-warm'):
        path = STATE / name / 'memory.sqlite'
        if path.exists():
            db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
            diagnostics[name] = {'states':dict(db.execute('select status,count(*) from memory_jobs group by status')),
                                 'dead_letter':[{'stage':s,'error_class':e,'count':n} for s,e,n in db.execute("select stage,error_class,count(*) from memory_jobs where status='dead_letter' group by stage,error_class")]}
            db.close()
    lines += ['', '## 解释边界', '',
              '先前列出目标文件的运行中，两套题库均为 cold 12/12、warm 11/12。可参考其通过率，旧耗时/token 混合晋升开销，不能直接与本报告的解题指标比较。',
              '本轮每条件仅一次，题目共享固定模块；通过率差与配对效率为描述性结果，不能证明记忆的因果增益。原有记忆晋升策略未调整，可能仍发生 schema/超时/冲突；完整诊断见 memory-diagnostics.json。',
              '控制器仍按原目标范围、隐藏行为与提交回归的故障敏感性验收；没有公开目标清单不代表允许修改无关文件。',
              '原始证据：四个 raw.json、逐题 stages/、提交 submissions/、适配器检查点、run-config.json 与控制器脚本。中断前未完成尝试的用量没有完整记录，不混入已完成重启任务均值。']
    lines.insert(2, f"进度：{sum(m['tasks'] for m in stats.values())}/48 次已完成；未完成时为阶段性结果。")
    (ROOT/'RESULTS.md').write_text('\n'.join(lines)+'\n')
    (ROOT/'comparison.json').write_text(json.dumps({'conditions':stats,'matched_both_passed':paired},indent=2)+'\n')
    (ROOT/'failures.json').write_text(json.dumps(failures,ensure_ascii=False,indent=2)+'\n')
    (ROOT/'memory-diagnostics.json').write_text(json.dumps(diagnostics,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(stats,ensure_ascii=False))


if __name__ == '__main__':
    main()
