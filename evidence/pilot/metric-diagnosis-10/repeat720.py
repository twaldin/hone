import argparse
import collections
import hashlib
import inspect
import json
import os
from pathlib import Path
import sys
import time

import pyarrow.parquet as parquet
from pilot import verification

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--n', type=int, default=200)
args = parser.parse_args()
assert 1 <= args.n <= 200 and not args.out.exists()
assert os.sched_getaffinity(0) == {6} and os.getpriority(os.PRIO_PROCESS, 0) == 10
root = Path('/home/tim/worktrees/hone/hone-hone-pilot-seeds12-1')
raw = root / 'evidence/pilot/seeds12-search-10-rerun1/raw'
manifest = json.loads((raw / 'mbpp/1/plain/manifest.json').read_text())
source_paths = ('pilot/tasks.py', 'pilot/program.py', 'pilot/verification.py', 'pilot/hover.py')
file_hash = lambda path: 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
assert all(file_hash(root / name) == manifest['identity']['evaluator_files'][name] for name in source_paths)
assert file_hash(root / '.pilot-cache/mbpp_train.parquet') == 'sha256:09d125ca31edacb7800be8c67c45abff618faf0214ff551291817d06bdb914ae'
row = next(row for row in parquet.read_table(root / '.pilot-cache/mbpp_train.parquet').to_pylist() if row['task_id'] == 720)
record = json.loads((raw / 'mbpp/1/plain/evaluations.jsonl').read_text().splitlines()[46])
assert record['row_ids'][3] == 'mbpp:train:720' and record['scores'][3] == 0.0
output = record['outputs'][3]
assert hashlib.sha256(output.encode()).hexdigest() == 'abff8eae1323b36fa2aa9732bacb3d7e1e6c5137857752dc966a90a85ec34af6'
source, start_line = inspect.getsourcelines(verification._run)
read_line = start_line + next(index for index, line in enumerate(source) if line.strip() == 'if not chunk:')
invocations = []
active = {}
executables = collections.Counter()


def audit(event, details):
    if event == 'subprocess.Popen':
        assert Path(details[0]).name == 'docker', 'Only the original protected Docker grader may execute'
        executables['docker'] += 1
        images = [arg for arg in details[1] if '@sha256:' in arg]
        assert not images or images == [manifest['identity']['image']]
    if event in {'urllib.Request', 'socket.connect'}:
        raise RuntimeError('Offline-only diagnostic forbids Python network access')


def observe(frame, event, value):
    if frame.f_code is not verification._run.__code__:
        return None
    if event == 'call':
        active[id(frame)] = {'prefix': frame.f_locals['prefix'], 'start': time.monotonic(), 'stderr': '', 'exceptions': []}
    elif event == 'line' and frame.f_lineno == read_line:
        values = frame.f_locals
        if values['key'].fileobj is values['process'].stderr:
            active[id(frame)]['stderr'] += values['chunk'].decode(errors='replace')
    elif event == 'exception':
        active[id(frame)]['exceptions'].append({'type': value[0].__name__, 'message': str(value[1])})
    elif event == 'return':
        item = active.pop(id(frame))
        item['seconds'] = time.monotonic() - item.pop('start')
        item.update(returned_none=value is None, exit_code=None if value is None else value[0],
                    stdout=None if value is None else value[1].decode(errors='replace'),
                    received=frame.f_locals.get('received'), remaining=frame.f_locals.get('remaining'))
        invocations.append(item)
    return observe


def emit(item):
    with args.out.open('a') as stream:
        stream.write(json.dumps(item, sort_keys=True) + '\n')
        stream.flush()


sys.addaudithook(audit)
sys.settrace(observe)
started = time.monotonic()
emit({'event': 'start', 'n': args.n, 'row_id': 'mbpp:train:720', 'original_expected': 0.0,
      'output_sha256': hashlib.sha256(output.encode()).hexdigest(), 'image': manifest['identity']['image'],
      'model_calls': 0, 'source_files_unchanged': list(source_paths), 'fresh_worker_per_trial': True,
      'trusted_plan_cache': 'original in-process row-keyed cache; no cache clearing or scoring override',
      'observation': 'sys.settrace reads original invocation stderr, timing and return values without changing them'})
counts = collections.Counter()
for trial in range(1, args.n + 1):
    invocations.clear()
    before = time.monotonic()
    score = verification.score_solution(output, row['code'], row['test_setup_code'] or '', row['test_list'])
    counts[score] += 1
    emit({'event': 'trial', 'trial': trial, 'score': score, 'seconds': time.monotonic() - before,
          'protected_invocations': list(invocations)})
sys.settrace(None)
assert all(file_hash(root / name) == manifest['identity']['evaluator_files'][name] for name in source_paths)
summary = {'event': 'finished', 'trials': args.n, 'counts': dict(counts), 'wall_seconds': time.monotonic() - started,
           'subprocesses': dict(executables), 'model_calls': 0, 'scoring_changes': False, 'retained_files_changed': False}
emit(summary)
print(json.dumps(summary), flush=True)
