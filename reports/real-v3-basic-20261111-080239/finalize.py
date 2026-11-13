import json
import subprocess
import sys
import time
from pathlib import Path
out=Path(__file__).resolve().parent
while True:
    path=out/'run-status.json'
    status=json.loads(path.read_text()) if path.exists() else {}
    if status.get('status') in {'completed','interrupted'}:
        with (out/'final-summary.log').open('w') as log:
            result=subprocess.run([sys.executable,str(out/'summarize.py')],stdout=log,stderr=subprocess.STDOUT)
        (out/'summary-status.json').write_text(json.dumps({'returncode':result.returncode})+'\n')
        break
    time.sleep(5)
