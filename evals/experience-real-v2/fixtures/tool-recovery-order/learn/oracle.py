import sys
from pathlib import Path

workspace = Path(sys.argv[1])
target = workspace / 'packages/agent/src/harness/runtime/drive/tools.ts'
required = 'call.replay === "safe" && tool?.replay === "safe"'
if required not in target.read_text(encoding='utf-8'):
    raise SystemExit(f'missing required behavior: {required}')
print('acceptance passed')
