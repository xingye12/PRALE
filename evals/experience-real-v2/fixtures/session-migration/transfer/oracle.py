import sys
from pathlib import Path

workspace = Path(sys.argv[1])
target = workspace / 'packages/coding-agent/src/migrations.ts'
required = 'replace(/[/\\\\:]/g, "-")'
if required not in target.read_text(encoding='utf-8'):
    raise SystemExit(f'missing required behavior: {required}')
print('acceptance passed')
