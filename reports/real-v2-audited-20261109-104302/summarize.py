import collections
import datetime
import json
from pathlib import Path

root = Path(__file__).resolve().parent
conditions = {}
for path in sorted(root.glob('*.raw.json')):
    value = json.loads(path.read_text())
    conditions[path.name.removesuffix('.raw.json')] = value
lines = ['# real-v2 真实模型评测结果', '',
    '模型：`deepseek-flash`；系统：PRALE；运行：本地宿主模式；基础 fixture revision 4，进阶 revision 3。',
    '每个条件运行 12 题，warm 组内保留新建记忆，cold 每题独立状态。每阶段重新解包冻结源码。',
    '没有重跑失败题或人工补交产物；不是容器隔离下的正式排名。', '',
    '| 题库/条件 | 完成 | 通过 | 通过率 | 累计耗时(秒) | 输入 token | 输出 token | 缓存读取 token |',
    '|---|---:|---:|---:|---:|---:|---:|---:|']
for name, value in conditions.items():
    runs = value['runs']
    passed = sum(r['acceptance'] == 'passed' for r in runs)
    def tokens(key):
        return sum(r.get('usage', {}).get(key, 0) for r in runs)
    lines.append(f"| {name} | {len(runs)} | {passed} | {passed / len(runs):.1%} | {sum(r.get('duration_seconds', 0) for r in runs):.1f} | {tokens('input_tokens'):,} | {tokens('output_tokens'):,} | {tokens('cache_read_input_tokens'):,} |")
lines += ['', '累计耗时是单题耗时之和；四组并行，不能相加解释为墙钟时长。输入 token 已包含缓存读取；用量包含记忆模型调用。超时/崩溃且未生成 adapter_result 的任务缺少用量；表中 token 仅为已观测量，不是完整计费总量。未配置单价，不推算美元费用。', '',
          '## 按阶段对照', '', '| 题库 | 阶段 | warm | cold | 通过率差(warm−cold) |', '|---|---|---:|---:|---:|']
for suite in ('basic', 'advanced'):
    for stage in ('learn', 'transfer', 'correction', 'retransfer'):
        groups = [[r for r in conditions.get(f'{suite}-{mode}', {}).get('runs', []) if r['stage'] == stage] for mode in ('warm', 'cold')]
        counts = [sum(r['acceptance'] == 'passed' for r in group) for group in groups]
        rates = [count / len(group) if group else 0 for count, group in zip(counts, groups)]
        lines.append(f'| {suite} | {stage} | {counts[0]}/{len(groups[0])} | {counts[1]}/{len(groups[1])} | {(rates[0]-rates[1])*100:+.1f} 个百分点 |')
lines += ['', '## 逐题结果', '', '| 条件 | 题组 | learn | transfer | correction | retransfer |', '|---|---|---|---|---|---|']
for name, value in conditions.items():
    for episode in sorted({r['episode'] for r in value['runs']}):
        by_stage = {r['stage']: r for r in value['runs'] if r['episode'] == episode}
        cells = [by_stage.get(stage, {}).get('acceptance', '未完成') for stage in ('learn', 'transfer', 'correction', 'retransfer')]
        lines.append('| ' + ' | '.join([name, episode, *cells]) + ' |')
lines += ['', '## 失败原因', '']
failures = []
for name, value in conditions.items():
    for run in value['runs']:
        if run['acceptance'] == 'passed':
            continue
        oracle = run.get('oracle_result') or {}
        error = oracle.get('error') or run.get('error') or run.get('oracle_output', '')[-1000:]
        if run.get('agent_status') == 'timed_out' or 'TimeoutError' in run.get('agent_output', ''):
            error = '代理执行超时；' + error
        failures.append({'condition':name, 'episode':run['episode'], 'stage':run['stage'], 'error':error, 'agent_status':run['agent_status']})
        lines.append(f"- `{name}/{run['episode']}/{run['stage']}`：{error}；代理状态 `{run['agent_status']}`。详见相应 raw JSON 和 submissions 目录。")
if not failures:
    lines.append('无。')
lines += ['', '## 用量可观测性', '']
for name, value in conditions.items():
    measured = sum(isinstance(r.get('adapter_result'), dict) for r in value['runs'])
    lines.append(f'- `{name}`：{measured}/{len(value["runs"])} 次任务有适配器用量记录。')
lines += ['', '## 记忆调用与解释边界', '']
for name, value in conditions.items():
    if not name.endswith('-warm'):
        continue
    calls = collections.Counter(tool for r in value['runs'] for tool in (r.get('adapter_result') or {}).get('tool_calls', []) if tool.startswith('memory_'))
    memory_turns = sum((r.get('adapter_result') or {}).get('memory_model_turns', 0) for r in value['runs'])
    lines.append(f'- `{name}`：记忆模型调用 {memory_turns} 轮；显式记忆工具调用 {dict(calls)}。')
lines += ['', '适配器 memory_retrievals 字段只标记 memory_search，不能代表所有场景读取或自动注入。',
    '每条件仅一次运行，题目共用固定模块，样本相关；通过率差仅为本轮描述，不能证明记忆造成收益或损失。',
    '缺少交付文件的失败也不等于生产代码行为已证明错误；按完整任务交付契约计为失败。',
    '隐藏测试检查有限行为及提交测试的故障敏感性，不代表完整生产构建、上游测试或崩溃恢复均正确。', '',
    '原始证据：四个 *.raw.json、四个 *.report.json、summary.json、submissions/；controller.py 保存无密钥运行脚本；run-config.json 保存运行环境和验收文件指纹；memory-diagnostics*.json 保存记忆队列诊断。']
(root / 'RESULTS.md').write_text('\n'.join(lines) + '\n')
(root / 'failures.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2) + '\n')
print(root / 'RESULTS.md')
