import json
import subprocess
import sys
import time
from pathlib import Path

root = Path(__file__).resolve().parent
while True:
    status = json.loads((root / 'run-status.json').read_text())
    if status['status'] == 'completed':
        break
    if status['status'] != 'running':
        raise SystemExit('Controller stopped without completing all conditions')
    time.sleep(5)
for name in ('basic-warm','basic-cold','advanced-warm','advanced-cold'):
    runs = json.loads((root / f'{name}.raw.json').read_text())['runs']
    assert len(runs) == 12, (name,len(runs))
    assert len({(r['episode'],r['stage']) for r in runs}) == 12
    for run in runs:
        archive = root / 'submissions' / name / run['episode'] / run['stage'] / 'manifest.json'
        assert json.loads(archive.read_text())['acceptance'] == run['acceptance']
subprocess.run([sys.executable,str(root/'summarize.py')],check=True)
(root/'evidence-check.json').write_text(json.dumps({'tasks':48,'conditions':4,'stage_ids_unique':True,'manifests_match':True})+'\n')
