import json
import time
from pathlib import Path

from pilot.runtime import digest
from pilot.verification import GraderInfrastructureError, grader_journal, score_solution, validate_grader_receipt

out = Path('/tmp/tmp.3XgHpA9HnO/review-counterexample-11a')
out.mkdir(exist_ok=False)
reference = 'def add(a,b): return a+b'
tests = ['assert add(1,2)==3', 'assert add(2,2)==4']
cases = {
    'direct-worker-exit-7': 'import os\nos._exit(7)',
    'exited-worker-escaped-descendant-holds-pipe': '''import os, time
reader, writer = os.pipe()
child = os.fork()
if child == 0:
    os.close(reader)
    os.setsid()
    os.write(writer, b'R')
    os.close(writer)
    time.sleep(30)
    os._exit(0)
os.close(writer)
assert os.read(reader, 1) == b'R'
os.close(reader)
os._exit(7)
''',
}
results = []
for name, code in cases.items():
    started = time.monotonic()
    with grader_journal(out / 'grader-outcomes.jsonl', purpose='review-counterexample', task='mbpp', row_id='synthetic-add', case=name):
        try:
            score = score_solution(code, reference, '', tests)
            outcome = 'pass' if score == 1.0 else 'wrong_answer'
        except GraderInfrastructureError as error:
            validate_grader_receipt(error.receipt)
            outcome, score = error.receipt['outcome'], error.receipt['score']
    receipts = [row for line in (out / 'grader-outcomes.jsonl').read_text().splitlines()
                if (row := json.loads(line)).get('event') == 'grader-outcome']
    receipt = receipts[-1]
    validate_grader_receipt(receipt)
    result = {'case': name, 'code': code, 'code_hash': digest(code), 'outcome': outcome,
              'score': score, 'elapsed_seconds': time.monotonic() - started,
              'receipt_hash': receipt['receipt_hash'], 'receipt': receipt,
              'expected_outcome': 'nonzero_exit', 'expected_score': None}
    results.append(result)
    print(json.dumps({key: value for key, value in result.items() if key not in ('receipt', 'code')}, sort_keys=True), flush=True)
proof = {'reviewed_head': 'f3b00bbedf9f0b3045a30c5f362731945abbc310',
         'model_calls': 0, 'grader_or_engine_changes': False, 'real_pinned_docker': True,
         'finding_reproduced': results[0]['outcome'] == 'nonzero_exit' and results[0]['score'] is None and results[1]['outcome'] == 'wrong_answer' and results[1]['score'] == 0.0,
         'results': results}
(out / 'result.json').write_text(json.dumps(proof, indent=2, sort_keys=True) + '\n')
assert proof['finding_reproduced'], proof
