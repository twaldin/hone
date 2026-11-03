import json
import os
import sys
import signal
import unittest
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from pilot import program
from pilot.controls import SHORTCUT_CODE


def local_command(name, path=None):
    return [sys.executable, "-I", "-B"] + ([str(path)] if path is not None else [])


def local_remove(name, process):
    if process.poll() is None:
        process.kill()
    process.wait()
    for stream in (process.stdin, process.stdout, process.stderr):
        if stream is not None:
            stream.close()



class ProgramTests(unittest.TestCase):
    def execute(self, source, call):
        original_popen = program.subprocess.Popen
        owned = []
        def spawn(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            owned.append(process)
            return process
        def pause(name, paused):
            os.kill(owned[0].pid, signal.SIGSTOP if paused else signal.SIGCONT)
            if paused:
                os.waitpid(owned[0].pid, os.WUNTRACED)
        with (patch.object(program, "docker_command", local_command),
              patch.object(program, "_remove", local_remove),
              patch.object(program.subprocess, "Popen", spawn),
              patch.object(program, "_pause", pause)):
            return program.run_program({"prompt": "solve", "program": source}, "def target(x):", call)

    def test_owned_process_cannot_work_while_provider_is_waiting(self):
        with tempfile.TemporaryDirectory() as directory:
            progress = Path(directory) / "progress"
            source = f'''import json,sys,threading
sys.stdin.readline()
def burn():
    n=0
    while True:
        n+=1
        with open({str(progress)!r},'w') as stream:
            stream.write(str(n))
threading.Thread(target=burn,daemon=True).start()
print(json.dumps({{"type":"model","messages":[{{"role":"user","content":"solve"}}],"max_tokens":1}}),flush=True)
sys.stdin.readline()
print(json.dumps({{"type":"result","code":"done"}}),flush=True)
'''
            def call(*args):
                before = progress.read_bytes() if progress.exists() else None
                time.sleep(0.05)
                after = progress.read_bytes() if progress.exists() else None
                self.assertEqual(before, after)
                return "answer"
            self.assertEqual(self.execute(source, call)[0], "done")


    def test_third_call_is_denied(self):
        source = '''import json,sys
json.loads(sys.stdin.readline())
for i in range(3):
 print(json.dumps({"type":"model","messages":[{"role":"user","content":"solve"}],"max_tokens":1}),flush=True)
 sys.stdin.readline()
'''
        calls = []
        with self.assertRaises(program.ProgramError):
            self.execute(source, lambda *args: calls.append(args) or "x")
        self.assertEqual(len(calls), 2)

    def test_token_cap_denied_before_call(self):
        source = '''import json,sys
sys.stdin.readline()
print(json.dumps({"type":"model","messages":[{"role":"user","content":"solve"}],"max_tokens":4097}),flush=True)
sys.stdin.readline()
'''
        with self.assertRaises(program.ProgramError):
            self.execute(source, lambda *args: self.fail("Over-cap request called model"))

    def test_prompt_cap_denied_before_call(self):
        source = '''import json,sys
sys.stdin.readline()
print(json.dumps({"type":"model","messages":[{"role":"user","content":"x"*70000}],"max_tokens":1}),flush=True)
sys.stdin.readline()
'''
        with self.assertRaises(program.ProgramError):
            self.execute(source, lambda *args: self.fail("Over-cap prompt called model"))

    def test_unknown_protocol_cannot_request_tools(self):
        with self.assertRaises(program.ProgramError):
            self.execute('import sys\nsys.stdin.readline()\nprint(\'{"type":"tool","name":"shell"}\',flush=True)', lambda *args: self.fail("called"))

    def test_literal_rpc_preserves_supported_return_types(self):
        source = "def target(x): return (x + 1, {'items': [1, 2]}, {3, 4})"
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            score = program.score_solution(source, "", ["assert target(4) == (5, {'items': [1, 2]}, {3, 4})"], ["target"])
        self.assertEqual(score, 1.0)

    def test_nonliteral_return_is_rejected(self):
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            score = program.score_solution("def target(x): return iter([x])", "",
                                           ["assert target(7) == 7"], ["target"])
        self.assertEqual(score, 0.0)

    def test_frame_marker_shortcut_cannot_pass_assertions(self):
        source = """import sys
frame=sys._getframe()
while frame is not None:
    for namespace in (frame.f_locals, frame.f_globals):
        payload=namespace.get('payload')
        if isinstance(payload,dict) and 'marker' in payload:
            print(payload['marker'],flush=True)
            sys.exit(0)
    frame=frame.f_back
def target(x): return -1
"""
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            score = program.score_solution(source, "", ["assert target(7) == 42"], ["target"])
        self.assertEqual(score, 0.0)

    def test_spoofed_worker_frames_do_not_bypass_real_assertions(self):
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            score = program.score_solution(SHORTCUT_CODE, "", ["assert target(7) == 42"], ["target"])
        self.assertEqual(score, 0.0)

    def test_always_equal_object_cannot_cross_literal_boundary(self):
        source = """class AlwaysEqual:
    def __eq__(self, other): return True
    def __repr__(self): return 'AlwaysEqual()'
def target(x): return AlwaysEqual()
"""
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            score = program.score_solution(source, "", ["assert target(7) == 42"], ["target"])
        self.assertEqual(score, 0.0)

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_spoofed_rpc_frames_score_zero(self):
        self.assertEqual(program.score_solution(SHORTCUT_CODE, "", ["assert target(7) == 42"], ["target"]), 0.0)

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_worker_never_receives_assertions(self):
        source = """import sys
def target(x):
    frame=sys._getframe()
    while frame is not None:
        for namespace in (frame.f_locals,frame.f_globals):
            assert 'payload' not in namespace
            assert 'tests' not in namespace
            assert 'marker' not in namespace
        frame=frame.f_back
    return x + 1
"""
        self.assertEqual(program.score_solution(source, "", ["assert target(7) == 8"], ["target"]), 1.0)
        attack = """import sys
frame=sys._getframe()
while frame is not None:
    for namespace in (frame.f_locals,frame.f_globals):
        payload=namespace.get('payload')
        if isinstance(payload,dict) and 'marker' in payload:
            print(payload['marker'],flush=True)
            sys.exit(0)
    frame=frame.f_back
def target(x): return -1
"""
        self.assertEqual(program.score_solution(attack, "", ["assert target(7) == 8"], ["target"]), 0.0)

    def test_unpinned_runtime_image_is_rejected(self):
        with patch.dict(os.environ, {"PILOT_PYTHON_IMAGE": "python:latest"}):
            with self.assertRaises(RuntimeError):
                program.docker_command("owned-name")

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_container_denies_host_credentials_and_network(self):
        source = '''import json,os,socket,sys
sys.stdin.readline()
assert not any(k in os.environ for k in ('ANTHROPIC_API_KEY','OPENAI_API_KEY','HOME_AUTH_TOKEN'))
assert not os.path.exists('/home/tim')
try:
 socket.create_connection(('1.1.1.1',443),timeout=1)
 raise AssertionError('network available')
except OSError:
 pass
try:
 open('/forbidden-write','w').write('x')
 raise AssertionError('root writable')
except OSError:
 pass
print(json.dumps({'type':'result','code':'isolated'}),flush=True)
'''
        code, _ = program.run_program({"prompt": "", "program": source}, "", lambda *args: self.fail("called"))
        self.assertEqual(code, "isolated")


if __name__ == "__main__":
    unittest.main()
