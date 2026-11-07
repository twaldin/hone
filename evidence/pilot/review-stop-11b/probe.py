import argparse
import ast
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

from pilot import program, verification

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=False)
functions = '\n\n'.join(ast.get_source_segment(verification._WORKER, node)
                        for node in ast.parse(verification._WORKER).body
                        if isinstance(node, ast.FunctionDef) and node.name in ('_kill', '_supervise'))
fixture = '''
results = []
frames = [("pass", {"results": [{"t": "int", "v": "0x3"}, {"t": "int", "v": "0x4"}]}),
          ("candidate-error", {"failure": {"reason": "call 0 raised TypeError"}})]
for label, frame in frames:
    expected = (json.dumps(frame) + "\\n").encode()
    reader, writer = os.pipe()
    ready_reader, ready_writer = os.pipe()
    child = os.fork()
    if child == 0:
        os.setpgid(0, 0)
        os.close(reader)
        descendant = os.fork()
        if descendant == 0:
            os.close(ready_reader)
            os.setsid()
            os.write(ready_writer, b"R")
            os.close(ready_writer)
            time.sleep(30)
            os._exit(0)
        os.close(ready_writer)
        assert os.read(ready_reader, 1) == b"R"
        os.close(ready_reader)
        os.write(writer, expected)
        os.close(writer)
        os._exit(0)
    os.close(writer)
    os.close(ready_writer)
    os.close(ready_reader)
    observed_exit = os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
    observed_at = time.monotonic()
    deadline = observed_at + 0.05
    time.sleep(0.1)
    resumed_at = time.monotonic()
    readable_before = bool(select.select([reader], [], [], 0)[0])
    captured = _supervise(child, reader, deadline)
    queued = os.read(reader, len(expected))
    status = os.waitpid(child, 0)[1]
    os.close(reader)
    results.append({"case": label, "child_exit": os.waitstatus_to_exitcode(status),
                    "exit_observed_before_deadline": observed_exit is not None and observed_at < deadline,
                    "supervisor_resumed_after_deadline": resumed_at > deadline,
                    "pipe_readable_before_supervision": readable_before,
                    "captured_hex": captured.hex() if captured is not None else None,
                    "queued_after_return_hex": queued.hex(), "expected_hex": expected.hex()})
print(json.dumps(results), flush=True)
'''
script = 'import os,select,signal,time,json\n_WIRE=262144\n' + functions + '\n' + fixture
name = 'hone-queued-frame-' + uuid.uuid4().hex
command = program.docker_command(name) + ['-c', script]
try:
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
finally:
    subprocess.run(['docker','rm','-f',name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, check=False)
assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
observed = json.loads(result.stdout)
for row in observed:
    assert row['child_exit'] == 0 and row['exit_observed_before_deadline'] and row['supervisor_resumed_after_deadline']
    assert row['pipe_readable_before_supervision']
    assert row['captured_hex'] == '' and row['queued_after_return_hex'] == row['expected_hex']
    verification._frame(bytes.fromhex(row['expected_hex']))
    try:
        verification._frame(bytes.fromhex(row['captured_hex']))
    except ValueError:
        row['actual_unchanged_frame_decoder_rejects'] = True
    else:
        raise AssertionError('Empty capture unexpectedly decoded')
proof = {'head': '7040004e6c51b1960cc83750320424731fb3f20a', 'real_pinned_docker': True,
         'fixture': 'Unmodified _kill and _supervise extracted from current worker; completed child and valid queued frame before deadline, supervisor invocation delayed past deadline. This is a deterministic function-boundary fixture, not an end-to-end model evaluation.',
         'grader_or_engine_source_changes': False, 'model_calls': 0,
         'functions_sha256': hashlib.sha256(functions.encode()).hexdigest(),
         'docker_returncode': result.returncode, 'docker_stderr': result.stderr,
         'results': observed, 'finding_reproduced': True}
(args.out/'result.json').write_text(json.dumps(proof,indent=2,sort_keys=True)+'\n')
(args.out/'fixture.py').write_text(script)
print(json.dumps(proof,sort_keys=True),flush=True)
