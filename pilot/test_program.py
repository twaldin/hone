import json
import os
import sys
import signal
import subprocess
import unittest
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from pilot import program, verification
from pilot.runtime import BudgetExhausted, TransportError
from pilot.tasks import Task, evaluate


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
    def execute(self, source, call, unpause_error=None):
        original_popen = program.subprocess.Popen
        owned = []
        def spawn(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            owned.append(process)
            return process
        def pause(name, paused):
            if not paused and unpause_error is not None:
                raise unpause_error
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

    def test_container_control_failures_are_program_errors(self):
        for paused in (True, False):
            command = ["docker", "pause" if paused else "unpause", "owned"]
            for error in (subprocess.CalledProcessError(1, command),
                          subprocess.TimeoutExpired(command, 15)):
                with self.subTest(paused=paused, error=type(error).__name__):
                    with patch.object(program.subprocess, "run", side_effect=error):
                        with self.assertRaises(program.ProgramError) as caught:
                            program._pause("owned", paused)
                    self.assertIs(caught.exception.__cause__, error)

    def test_missing_container_runtime_is_not_a_program_error(self):
        error = FileNotFoundError("docker")
        with patch.object(program.subprocess, "run", side_effect=error):
            with self.assertRaises(FileNotFoundError) as caught:
                program._pause("owned", True)
        self.assertIs(caught.exception, error)

    def test_provider_errors_survive_without_resuming_candidate(self):
        errors = (BudgetExhausted("cap"), TransportError("provider"),
                  OSError("provider"), BrokenPipeError("provider"),
                  RuntimeError("unexpected provider bug"))
        for error in errors:
            with self.subTest(error=type(error).__name__):
                def call(*args):
                    raise error
                with self.assertRaises(type(error)) as caught:
                    self.execute(program.SEED_PROGRAM, call,
                                 unpause_error=AssertionError("Failed call resumed candidate"))
                self.assertIs(caught.exception, error)

    def test_refusal_retains_trace_without_resuming_or_delivering_an_answer(self):
        from pilot.runtime import ProviderRefusal
        calls = []
        def refused(*args):
            calls.append(args)
            raise ProviderRefusal("terminal refusal")
        with self.assertRaises(ProviderRefusal) as caught:
            self.execute(program.SEED_PROGRAM, refused,
                         unpause_error=AssertionError("Refused call resumed candidate"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(caught.exception.traces, [{
            "messages": calls[0][1], "output": "", "max_tokens": 4096, "outcome": "refusal"}])
    def test_second_stage_refusal_retains_answered_and_refused_traces(self):
        from pilot.runtime import ProviderRefusal
        source = '''import json,sys
sys.stdin.readline()
for stage in range(2):
 print(json.dumps({"type":"model","messages":[{"role":"user","content":str(stage)}],"max_tokens":1}),flush=True)
 sys.stdin.readline()
print(json.dumps({"type":"result","code":"should not run"}),flush=True)
'''
        requests = []
        def call(*args):
            requests.append(args)
            if len(requests) == 2:
                raise ProviderRefusal("terminal refusal")
            return "first response"
        with self.assertRaises(ProviderRefusal) as caught:
            self.execute(source, call)
        self.assertEqual(len(requests), 2)
        self.assertEqual(caught.exception.traces, [
            {"messages": [{"role": "user", "content": "0"}], "output": "first response", "max_tokens": 1},
            {"messages": [{"role": "user", "content": "1"}], "output": "", "max_tokens": 1, "outcome": "refusal"}])



    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_model_frame_then_exit_is_program_error_and_zero(self):
        source = '''import json,os,sys
sys.stdin.readline()
print(json.dumps({"type":"model","messages":[{"role":"user","content":"solve"}],"max_tokens":1}),flush=True)
os._exit(0)
'''
        candidate = {"prompt": "solve", "program": source}
        row = {"id": "dev:exit", "input": "solve"}
        task = Task("mbpp", [row], [], {}, candidate)
        original_pause = program._pause
        for through_evaluate in (False, True):
            names = []
            def pause_after_exit(name, paused):
                names.append(name)
                if paused:
                    subprocess.run(["docker", "wait", name], stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, timeout=15, check=False)
                original_pause(name, paused)
            with self.subTest(through_evaluate=through_evaluate):
                with patch.object(program, "_pause", pause_after_exit):
                    call = lambda *args: self.fail("Exited candidate called provider")
                    if through_evaluate:
                        self.assertEqual(evaluate(task, candidate, [row], call)["scores"], [0.0])
                    else:
                        with self.assertRaises(program.ProgramError) as caught:
                            program.run_program(candidate, "solve", call)
                        self.assertIsInstance(caught.exception.__cause__, subprocess.CalledProcessError)
                self.assertEqual(len(names), 1)
                state = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^{names[0]}$", "--format", "{{.State}}"],
                                       capture_output=True, text=True, timeout=15, check=True)
                self.assertNotIn(state.stdout.strip(), {"running", "paused", "restarting"})

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_candidate_is_paused_during_provider_wait_and_resumes(self):
        source = '''import json,sys,threading
sys.stdin.readline()
def burn():
    while True:
        pass
threading.Thread(target=burn,daemon=True).start()
print(json.dumps({"type":"model","messages":[{"role":"user","content":"solve"}],"max_tokens":1}),flush=True)
answer=json.loads(sys.stdin.readline())["text"]
print(json.dumps({"type":"result","code":answer}),flush=True)
'''
        names = []
        original_command = program.docker_command
        def command(name, path=None):
            names.append(name)
            return original_command(name, path)
        def call(*args):
            for _ in range(2):
                paused = subprocess.run(["docker", "inspect", "--format", "{{.State.Paused}}", names[0]],
                                        capture_output=True, text=True, timeout=15, check=True)
                self.assertEqual(paused.stdout.strip(), "true")
                time.sleep(0.05)
            return "def target(x): return x + 1"
        with patch.object(program, "docker_command", command):
            code, traces = program.run_program({"prompt": "solve", "program": source},
                                               "def target(x):", call)
        self.assertEqual(code, "def target(x): return x + 1")
        self.assertEqual(len(traces), 1)
        state = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^{names[0]}$", "--format", "{{.State}}"],
                               capture_output=True, text=True, timeout=15, check=True)
        self.assertNotIn(state.stdout.strip(), {"running", "paused", "restarting"})

    def test_shared_extraction_uses_first_eligible_block(self):
        cases = [
            ("def target(x): return x + 1", "def target(x): return x + 1"),
            ("before\n```python\ndef target(x): return x + 1\n```\nafter",
             "def target(x): return x + 1\n"),
            ("before\n \t``` \t\r\ndef target(x): return x + 1\r\n\t```\t\r\nafter",
             "def target(x): return x + 1\r\n"),
            ("```python\nfirst\n```\n```python\nsecond\n```", "first\n"),
            ("```javascript\nignored\n```\n```python\nchosen\n```", "chosen\n"),
            ("```ruby\nignored\n```", "```ruby\nignored\n```"),
            ("```Python\nignored\n```\n```python\nchosen\n```", "chosen\n"),
            ("```python extra\nignored\n```\n```\nchosen\n```", "chosen\n"),
            ("before\n```python\ndef target(x): return x + 1",
             "def target(x): return x + 1"),
            ("before\n```\ndef target(x): return x + 1", "def target(x): return x + 1"),
            ("inline ```python is not an opening fence", "inline ```python is not an opening fence"),
        ]
        for output, expected in cases:
            with self.subTest(output=output):
                self.assertEqual(program.extract_solution(output), expected)

    def test_seed_program_preserves_answer_for_shared_scoring(self):
        output = "prose\n```python\ndef target(x): return x + 1"
        answer, traces = self.execute(program.SEED_PROGRAM, lambda *args: output)
        self.assertEqual(answer, output)
        self.assertEqual(len(traces), 1)
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            self.assertEqual(verification.score_solution(answer, "def target(x): return x + 1", "",
                                                         ["assert target(7) == 8"]), 1.0)

    def test_unpinned_runtime_image_is_rejected(self):
        with patch("pilot.program.os.environ", {"PILOT_PYTHON_IMAGE": "python:latest"}):
            with self.assertRaises(RuntimeError):
                program.docker_command("owned-name")

    def test_container_cpu_matches_explicit_process_affinity(self):
        with patch.object(program.os, "sched_getaffinity", return_value={7, 3}):
            command = program.docker_command("owned-name")
        self.assertEqual(command[command.index("--cpuset-cpus") + 1], "3")
        self.assertEqual(command[command.index("--cpus") + 1], "1")

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
