import datetime
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
pointer = json.loads((root.parents[1] / '.eval-state/real-v2-audited-latest.json').read_text())
state = Path(pointer['state'])
all_runs = []
for name in ('basic-warm', 'basic-cold', 'advanced-warm', 'advanced-cold'):
    runs = json.loads((root / f'{name}.raw.json').read_text())['runs']
    assert len(runs) == 12, (name, len(runs))
    assert len({(r['episode'], r['stage']) for r in runs}) == 12
    for run in runs:
        manifest = root / 'submissions' / name / run['episode'] / run['stage'] / 'manifest.json'
        assert manifest.is_file(), str(manifest)
        assert json.loads(manifest.read_text())['acceptance'] == run['acceptance']
    all_runs.extend(runs)
diagnostics = {'captured_at':datetime.datetime.now(datetime.UTC).isoformat(), 'conditions':{}}
for path in sorted(state.glob('*warm/memory.sqlite')):
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    diagnostics['conditions'][path.parent.name] = {
        'job_states':dict(db.execute('select status,count(*) from memory_jobs group by status')),
        'job_errors':[{'status':s, 'error_class':e, 'count':n} for s,e,n in db.execute('select status,error_class,count(*) from memory_jobs where error_class is not null group by status,error_class')],
    }
    db.close()
(root / 'memory-diagnostics.json').write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2) + '\n')
subprocess.run([sys.executable, str(root / 'summarize.py')], check=True)
with (root / 'RESULTS.md').open('a') as output:
    output.write('\n## 记忆队列最终状态\n\n')
    for name, data in diagnostics['conditions'].items():
        output.write(f"- `{name}`：{data['job_states']}。\n")
    output.write('\n记忆作业存在 dead-letter 及超时/schema/冲突记录，完整分类见 memory-diagnostics.json；不能将这次运行解释为记忆机制正常发挥后的受控因果实验。\n')
    output.write('\n证据完整性检查：四组各 12 条、每组任务不重复、48 份提交 manifest 与原始判定一致。\n')
print(json.dumps({'runs':len(all_runs), 'passed':sum(r['acceptance']=='passed' for r in all_runs), 'diagnostics':diagnostics}, ensure_ascii=False))
