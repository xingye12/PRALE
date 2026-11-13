"""Run the unchanged native adapter and record provider-neutral outputs externally."""
import dataclasses
import datetime
import json
from pathlib import Path
import sys

REPO = Path('/root/vibe/CoLe/PRALE')
sys.path.insert(0, str(REPO / 'scripts'))
import real_experience_adapters as adapter

trace = Path(sys.argv[1])
trace.parent.mkdir(parents=True, exist_ok=True)
original = adapter.DeepSeekProvider.generate

def record(event, **data):
    with trace.open('a') as stream:
        stream.write(json.dumps({'time': datetime.datetime.now(datetime.UTC).isoformat(),
                                 'event': event, **data}, ensure_ascii=False, default=str) + '\n')

async def generate(self, request):
    record('model_started', lane=request.lane)
    try:
        result = await original(self, request)
    except BaseException as error:
        record('model_failed', lane=request.lane, error_class=type(error).__name__)
        raise
    record('model_completed', lane=request.lane, result=dataclasses.asdict(result))
    return result

adapter.DeepSeekProvider.generate = generate
sys.argv = [str(REPO / 'scripts/real_experience_adapters.py'), *sys.argv[2:]]
raise SystemExit(adapter.main())
