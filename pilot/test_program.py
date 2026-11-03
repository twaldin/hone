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

from pilot import program
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
                    # Wait for the real candidate exit before the real Docker pause.
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

    def score(self, output, setup="", assertions=None):
        if assertions is None:
            assertions = ["assert target(7) == 8"]
        with patch.object(program, "docker_command", local_command), patch.object(program, "_remove", local_remove):
            return program.score_solution(output, setup, assertions)

    def test_native_python_objects_and_mutation(self):
        source = """class Pair:
    def __init__(self, first, second):
        self.first, self.second = first, second
def target(pair):
    pair.first += pair.second
    return pair
def values(items):
    items.append(9)
    return iter(items)
"""
        setup = "pair = Pair(4, 7)\nitems = [1, 2]"
        assertions = ["assert target(pair) is pair",
                      "assert pair.first == 11",
                      "assert pair.second == 7",
                      "assert list(values(items)) == [1, 2, 9]",
                      "assert items == [1, 2, 9]"]
        self.assertEqual(self.score(source, setup, assertions), 1.0)

    def test_setup_definitions_share_candidate_namespace(self):
        self.assertEqual(self.score("def target(x): return Helper(x).value",
                                    "class Helper:\n    def __init__(self, x): self.value = x + 1"), 1.0)

    def test_official_setup_and_every_assertion_must_succeed(self):
        source = "def target(x): return x + 1"
        failures = [
            ("raise RuntimeError('setup failure')", ["assert target(7) == 8"]),
            ("", ["assert target(7) == 8", "assert target(9) == 0"]),
            ("", ["assert target(7) == 8", "raise RuntimeError('assertion failure')"]),
            ("", ["assert target(7) == 8", "not valid Python"]),
            ("", ["assert target(7) == 8", "import sys; sys.exit(0)"]),
        ]
        for setup, assertions in failures:
            with self.subTest(setup=setup, assertions=assertions):
                self.assertEqual(self.score(source, setup, assertions), 0.0)

    def test_invalid_program_and_candidate_exception_score_zero(self):
        for source in ("not valid Python", "raise RuntimeError('failed')",
                       "def target(x): raise RuntimeError('failed')"):
            with self.subTest(source=source):
                self.assertEqual(self.score(source), 0.0)

    def test_premature_successful_exit_and_stdout_frames_cannot_pass(self):
        for source in ("import sys; sys.exit(0)",
                       "import os; os._exit(0)",
                       'print(\'{"result":"8"}\\nready\\nhone-pilot-complete:fake\', flush=True)\n'
                       'def target(x): return -1'):
            with self.subTest(source=source):
                self.assertEqual(self.score(source), 0.0)

    def test_even_matching_completion_receipt_on_stdout_cannot_pass(self):
        source = "import sys\nprint('hone-pilot-complete:known', flush=True)\nsys.exit(0)"
        with patch.object(program.uuid, "uuid4") as identity:
            identity.return_value.hex = "known"
            self.assertEqual(self.score(source), 0.0)

    def test_receipt_requires_successful_process_exit(self):
        source = "import atexit,os\natexit.register(lambda: os._exit(7))\ndef target(x): return x + 1"
        self.assertEqual(self.score(source), 0.0)

    def test_candidate_output_is_not_the_score(self):
        source = 'print("arbitrary candidate output")\ndef target(x): return x + 1'
        self.assertEqual(self.score(source), 1.0)

    def test_source_and_combined_output_are_bounded(self):
        self.assertEqual(self.score("x" * (program.MAX_WIRE_BYTES + 1)), 0.0)
        for stream in ("sys.stdout", "sys.stderr"):
            with self.subTest(stream=stream):
                source = f"import sys\n{stream}.write('x' * {program.MAX_WIRE_BYTES + 1})\ndef target(x): return x + 1"
                self.assertEqual(self.score(source), 0.0)

    def test_timeout_stops_and_removes_worker(self):
        selector = program.selectors.DefaultSelector()
        removed = []
        def remove(name, process):
            local_remove(name, process)
            removed.append(process.returncode)
        with (patch.object(program, "docker_command", local_command),
              patch.object(program, "_remove", remove),
              patch.object(program.selectors, "DefaultSelector", return_value=selector),
              patch.object(selector, "select", return_value=[])):
            self.assertEqual(program.score_solution("while True: pass", "", []), 0.0)
        self.assertEqual(len(removed), 1)
        self.assertIsNotNone(removed[0])

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

    def test_scoring_applies_extraction_without_repair(self):
        outputs = [
            "def target(x): return x + 1",
            "prose\n```python\ndef target(x): return x + 1\n```\n```python\ninvalid\n```",
            "```javascript\nnot Python\n```\n```\ndef target(x): return x + 1\n```",
            "prose\n```python\ndef target(x): return x + 1",
        ]
        for output in outputs:
            with self.subTest(output=output):
                self.assertEqual(self.score(output), 1.0)
        self.assertEqual(self.score("```ruby\ndef target(x): return x + 1\n```"), 0.0)
        self.assertEqual(self.score("```python\n    def target(x): return x + 1\n```"), 0.0)

    def test_seed_program_preserves_answer_for_shared_scoring(self):
        output = "prose\n```python\ndef target(x): return x + 1"
        answer, traces = self.execute(program.SEED_PROGRAM, lambda *args: output)
        self.assertEqual(answer, output)
        self.assertEqual(len(traces), 1)
        self.assertEqual(self.score(answer), 1.0)

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_native_pair_and_mutation(self):
        source = """class Pair:
    def __init__(self, first, second): self.first, self.second = first, second
def target(pair):
    pair.first += pair.second
    return pair
"""
        self.assertEqual(program.score_solution(source, "pair = Pair(4, 7)",
                         ["assert target(pair) is pair", "assert pair.first == 11"]), 1.0)

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_native_assertion_failures_and_premature_exit(self):
        cases = [
            ("def target(x): return x + 1", "raise RuntimeError('setup failure')", ["assert target(7) == 8"]),
            ("def target(x): return x + 1", "", ["assert target(7) == 8", "assert target(9) == 0"]),
            ("import os; os._exit(0)", "", ["assert target(7) == 8"]),
            ("import sys; sys.exit(0)", "", ["assert target(7) == 8"]),
            ("import atexit,os\natexit.register(lambda: os._exit(7))\ndef target(x): return x + 1",
             "", ["assert target(7) == 8"]),
        ]
        for source, setup, assertions in cases:
            with self.subTest(source=source, setup=setup):
                self.assertEqual(program.score_solution(source, setup, assertions), 0.0)

    @unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
    def test_docker_scoring_timeout(self):
        self.assertEqual(program.score_solution("while True: pass", "", []), 0.0)

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
