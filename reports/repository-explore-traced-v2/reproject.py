from pathlib import Path
import json,subprocess,tarfile,io,tempfile
from bash_file_access import opened_files
from repository_explore_scoring import FileAccessCollector,score_output,compare_reports
from agent_harness.runtime.telemetry import ToolTelemetry
p=Path('reports/repository-explore-traced-v2');source=json.loads((p/'tasks.json').read_text());tasks={t['id']:t for t in source['tasks']}
archive=subprocess.check_output(['git','archive',source['pinned_git_sha']])
with tempfile.TemporaryDirectory() as d:
 root=Path(d)
 with tarfile.open(fileobj=io.BytesIO(archive)) as tf:tf.extractall(root,filter='data')
 for condition in ['baseline','treatment']:
  file=p/f'{condition}.json';report=json.loads(file.read_text());(p/f'raw-{condition}.json').write_bytes(file.read_bytes())
  for item in report['items']:
   access=item['output']['file_access'];events=access['tool_trace'];oldroot=root
   for e in events:
    path=e.get('output',{}).get('details',{}).get('path')
    if isinstance(path,str) and '/workspace/' in path:
     oldroot=Path(path.split('/workspace/',1)[0]+'/workspace');break
   collector=FileAccessCollector(oldroot)
   for e in events:
    obs=e.get('file_access_observation')
    if e['name']=='bash' and isinstance(obs,dict):
     obs={**obs,'files':sorted(set(obs.get('files',[]))|set(opened_files(obs.get('trace',''),root)))}
     collector.register_bash(e['input']['command'],obs)
    collector.record(ToolTelemetry(session_id='reprojection',lane='main',operation_id=item['id'],tool_call_id=e['tool_call_id'],name=e['name'],attempt=e['attempt'],input=e['input'],output=e['output'],outcome=e['outcome'],is_error=e['is_error'],started_at=e['started_at'],ended_at=e['ended_at']))
   item['output']['file_access']=collector.as_dict();item['file_score']=score_output(tasks[item['task_id']],item['output'])
  file.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
 reports=[json.loads((p/f'{c}.json').read_text()) for c in ['baseline','treatment']]
 result=compare_reports(source,*reports);(p/'file-scores.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps(result['summary'],ensure_ascii=False))
