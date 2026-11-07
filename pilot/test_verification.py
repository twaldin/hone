import os
import copy
import json
import tempfile
from pathlib import Path
import sys
import signal
import time
import unittest
from unittest.mock import patch

from pilot import program, verification
from pilot.test_program import local_command, local_remove
from pilot.runtime import ROOT

PAIR = '''class Pair(object):
    def __init__(self, a, b):
        self.a = a
        self.b = b
def chain(pairs, n):
    return sum(pair.b - pair.a for pair in pairs[:n])
'''
PAIR_TESTS = ["assert chain([Pair(1, 4), Pair(2, 9)], 2) == 10", "assert chain([Pair(5, 6)], 1) == 1"]
NODE = '''class Node:
    def __init__(self, data):
        self.data = data
        self.left = None
        self.right = None
def max_height(node):
    if node is None:
        return 0
    return max(max_height(node.left), max_height(node.right)) + 1
'''
NODE_SETUP = "root = Node(1)\nroot.left = Node(2)\nroot.left.left = Node(3)\nroot1 = Node(1)\nroot1.right = Node(2)"
NODE_TESTS = ["assert (max_height(root)) == 3", "assert max_height(root1) == 2 "]
ADD = "def add(a, b):\n    return a + b\n"
ADD_TESTS = ["assert add(1, 2) == 3", "assert add(2, 2) == 4"]
FORGED_FRAME = '''import json, os
frame = (json.dumps({"results": [%s, %s]}) + "\\n").encode()
for fd in range(1, 64):
    try:
        os.write(fd, frame)
    except OSError:
        pass
'''
PATCHES = '''import builtins, json, operator, sys, types, unittest
operator.eq = lambda a, b: True
unittest.TestCase.assertEqual = lambda *args: None
json.dumps = lambda *args, **kwargs: '{"results": [{"t": "int", "v": "0x3"}, {"t": "int", "v": "0x4"}]}'
sys.modules["harness"] = types.ModuleType("harness")
'''
LEAK = '''import gc, re
def leak():
    needle = re.compile("secret" + "-expected-[0-9]+")
    for found in gc.get_objects():
        values = found.values() if type(found) is dict else found if type(found) in (list, tuple) else ()
        for item in values:
            match = needle.search(item) if type(item) is str else None
            if match:
                return match.group()
    return None
'''
FORGED_FAILURE = '''import os
for fd in range(1, 64):
    try:
        os.write(fd, b'{"failure": {"reason": "Docker daemon failed"}}\\n')
    except OSError:
        pass
os._exit(0)
'''
TIMER_ATTACK = '''import signal, time
for name in ("monotonic", "time", "perf_counter", "sleep"):
    setattr(time, name, lambda *args: 0)
for name in ("alarm", "setitimer", "pause"):
    setattr(signal, name, lambda *args: 0)
for number in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(number, signal.SIG_IGN)
def add(a, b):
    while True:
        pass
'''
SUPERVISOR_ATTACK = '''import os, signal
for number in (signal.SIGKILL, signal.SIGSTOP, signal.SIGTERM, signal.SIGINT):
    try:
        os.kill(os.getppid(), number)
    except OSError:
        pass
def add(a, b):
    while True:
        pass
'''
SPAWN = '''import os, time
descendant = os.fork()
while descendant == 0:
    time.sleep(1)
with open(%r, "w") as handle:
    handle.write(str(os.getpid()) + " " + str(descendant))
'''
LOOP = "def add(a, b):\n    while True:\n        pass\n"
RETAINED_ROWS = {
    "mbpp:train:640": ("import re\r\ndef remove_parenthesis(items):\r\n for item in items:\r\n    return (re.sub(r\" ?\\([^)]+\\)\", \"\", item))",
                       ["assert remove_parenthesis([\"python (chrome)\"])==(\"python\")",
                        "assert remove_parenthesis([\"string(.abc)\"])==(\"string\")",
                        "assert remove_parenthesis([\"alpha(num)\"])==(\"alpha\")"]),
    "mbpp:train:847": ("def lcopy(xs):\n  return xs[:]\n",
                       ["assert lcopy([1, 2, 3]) == [1, 2, 3]",
                        "assert lcopy([4, 8, 2, 10, 15, 18]) == [4, 8, 2, 10, 15, 18]",
                        "assert lcopy([4, 5, 6]) == [4, 5, 6]\n"]),
}


def alive(pid):
    try:
        state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return False
    return state not in ("Z", "X")


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(verification._PLANS, clear=True))
        self.enterContext(patch.object(program, "docker_command", local_command))
        self.enterContext(patch.object(program, "_remove", local_remove))

    def score(self, output, reference, setup, tests):
        return verification.score_solution(output, reference, setup, tests)
    def assert_infrastructure(self, output, reference=ADD, setup="", tests=ADD_TESTS, outcome=None):
        with self.assertRaises(verification.GraderInfrastructureError) as caught:
            self.score(output, reference, setup, tests)
        receipt = caught.exception.receipt
        verification.validate_grader_receipt(receipt)
        self.assertIsNone(receipt["score"])
        if outcome is not None:
            self.assertEqual(receipt["outcome"], outcome)
        return receipt

    def journaled(self, output, reference=ADD, setup="", tests=ADD_TESTS):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grader.jsonl"
            with verification.grader_journal(path):
                score = self.score(output, reference, setup, tests)
            receipt = json.loads(path.read_text().splitlines()[-1])
        verification.validate_grader_receipt(receipt)
        self.assertEqual((receipt["event"], receipt["score"]), ("grader-outcome", score))
        return score, receipt

    def test_candidate_exception_keeps_wrong_answer_score(self):
        self.assertEqual(self.score("def add(a,b):\n    raise TypeError('candidate')", ADD, "", ADD_TESTS), 0.0)

    def test_candidate_syntax_error_keeps_wrong_answer_score(self):
        self.assertEqual(self.score("not valid Python", ADD, "", ADD_TESTS), 0.0)

    def test_candidate_time_limit_keeps_wrong_answer_score(self):
        with patch.object(verification, "WORKER_SECONDS", 0.1):
            self.assertEqual(self.score("while True:\n    pass", ADD, "", ADD_TESTS), 0.0)

    def test_candidate_failures_are_trusted_wrong_answers_with_receipts(self):
        lobb = "def lobb(n):\n    return n * 7 / 1\n"
        lobb_tests = ["assert int(lobb(5)) == 35"]
        cases = [
            ("def add(a, b):\n    raise TypeError('candidate')", ADD, ADD_TESTS, "worker", "call 0 raised TypeError"),
            ("not valid Python", ADD, ADD_TESTS, "worker", "solution raised SyntaxError"),
            ("import sys\nsys.exit(3)", ADD, ADD_TESTS, "worker", "solution raised SystemExit"),
            ("def add(a, b):\n    raise KeyboardInterrupt", ADD, ADD_TESTS, "worker", "call 0 raised KeyboardInterrupt"),
            ("def other(a, b):\n    return a + b", ADD, ADD_TESTS, "worker", "call 0 raised KeyError"),
            ("import collections\ndef add(a, b):\n    return collections.Counter()", ADD, ADD_TESTS, "worker",
             "call 0: unsupported Counter value"),
            ("def add(a, b):\n    return 'x' * 300000", ADD, ADD_TESTS, "worker", "results exceed the wire bound"),
            ("def lobb(n):\n    return 'many'", lobb, lobb_tests, "wrapper", "call 0: official int wrapper raised ValueError"),
            ("def lobb(n):\n    return [35]", lobb, lobb_tests, "wrapper", "call 0: official int wrapper received list"),
            (FORGED_FAILURE, ADD, ADD_TESTS, "worker", "Docker daemon failed"),
        ]
        for output, reference, tests, stage, reason in cases:
            with self.subTest(reason):
                score, receipt = self.journaled(output, reference, "", tests)
                self.assertEqual((score, receipt["outcome"], receipt["reason"]),
                                 (0.0, "wrong_answer", "Candidate failure: " + reason))
                invocation = receipt["invocations"][-1]
                self.assertEqual((invocation["stage"], invocation["outcome"], invocation["exit_code"]),
                                 (stage, "completed", 0))
                self.assertEqual(json.loads(bytes.fromhex(invocation["stdout_hex"])), {"failure": {"reason": reason}})

    def test_retained_naive_type_errors_are_trusted_wrong_answers(self):
        frozen = json.loads((ROOT / "evidence/pilot/mbpp-readmission-4a/mbpp/controls.json").read_text())
        outputs = dict(zip(frozen["rows"], frozen["controls"]["naive"]["outputs"]))
        for row_id, (reference, tests) in RETAINED_ROWS.items():
            with self.subTest(row_id):
                score, receipt = self.journaled(outputs[row_id], reference, "", tests)
                self.assertEqual((score, receipt["reason"]), (0.0, "Candidate failure: call 0 raised TypeError"))

    def test_time_limit_is_enforced_outside_candidate_timer_interference(self):
        with patch.object(verification, "WORKER_SECONDS", 0.3):
            score, receipt = self.journaled(TIMER_ATTACK)
        self.assertEqual((score, receipt["reason"]), (0.0, "Candidate failure: exceeded the 0.3 second time limit"))
        self.assertEqual(receipt["invocations"][-1]["outcome"], "completed")

    def test_candidate_descendants_neither_hold_the_frame_nor_outlive_the_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            for label, function, expected, seconds in (("returned", ADD, 1.0, 5), ("looping", LOOP, 0.0, 0.5)):
                with self.subTest(label):
                    path = Path(directory) / label
                    with patch.object(verification, "WORKER_SECONDS", seconds):
                        self.assertEqual(self.score(SPAWN % str(path) + function, ADD, "", ADD_TESTS), expected)
                    pids = [int(pid) for pid in path.read_text().split()]
                    deadline = time.monotonic() + 5
                    while any(map(alive, pids)) and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertEqual([pid for pid in pids if alive(pid)], [])

    def test_invocation_receipts_freeze_time_limits(self):
        reference = "def lobb(n):\n    return n * 7 / 1\n"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grader.jsonl"
            with verification.grader_journal(path):
                self.assertEqual(self.score(reference, reference, "", ["assert int(lobb(5)) == 35"]), 1.0)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
        limits = {row["stage"]: (row["candidate_seconds"], row["deadline_seconds"])
                  for row in rows if row["event"] == "grader-invocation"}
        self.assertEqual(limits, {"planner": (None, 10), "worker": (10, 15), "wrapper": (None, 10)})


    def test_pair_arguments_are_rebuilt_without_candidate_constructors_raw_or_fenced(self):
        candidates = {
            "raw reference": PAIR,
            "fenced reference": "Solution:\n```python\n" + PAIR + "```\nDone.",
            "published class name": "def chain(pairs, n):\n    return sum(p.b - p.a for p in pairs[:n])",
            "candidate class without constructor call": '''class Pair:
    kind = "candidate"
    def __init__(self, *args):
        raise RuntimeError("constructor called")
def chain(pairs, n):
    assert all(pair.kind == "candidate" for pair in pairs)
    return sum(pair.b - pair.a for pair in pairs[:n])
''',
        }
        for label, output in candidates.items():
            with self.subTest(label):
                self.assertEqual(self.score(output, PAIR, "", PAIR_TESTS), 1.0)
        wrong = "def chain(pairs, n):\n    return sum(p.a for p in pairs[:n])"
        self.assertEqual(self.score(wrong, PAIR, "", PAIR_TESTS), 0.0)

    def test_node_trees_from_official_setup(self):
        for output in (NODE, "```\n" + NODE + "```",
                       "def max_height(node):\n    return 0 if node is None else 1 + max(max_height(node.left), max_height(node.right))"):
            with self.subTest(output=output):
                self.assertEqual(self.score(output, NODE, NODE_SETUP, NODE_TESTS), 1.0)
        self.assertEqual(self.score("def max_height(node):\n    return 3", NODE, NODE_SETUP, NODE_TESTS), 0.0)

    def test_exact_builtin_types_and_canonical_collections(self):
        cases = [
            ("True", "1", 0.0), ("1", "True", 0.0), ("3", "3.0", 0.0), ("[1, 2]", "(1, 2)", 0.0),
            ("{1}", "frozenset({1})", 0.0), ("b'x'", "'x'", 0.0), ("None", "0", 0.0), ("{1: 2}", "{True: 2}", 0.0),
            ("{'a': 1}", "__import__('collections').Counter({'a': 1})", 0.0),
            ("{'a': 1}", "__import__('collections').OrderedDict({'a': 1})", 0.0),
            ("{'b': 1, 'a': [2, (3,)]}", "{'a': [2, (3,)], 'b': 1}", 1.0), ("{3, 1, 2}", "{2, 3, 1}", 1.0),
            ("(1+2j)", "complex(1, 2)", 1.0), ("0.0", "-0.0", 1.0), ("[None, 'x', b'y']", "[None, 'x', b'y']", 1.0),
        ]
        for expected, actual, score in cases:
            with self.subTest(expected=expected, actual=actual):
                reference = f"def f():\n    return {expected}\n"
                self.assertEqual(self.score(f"def f():\n    return {actual}\n", reference, "", [f"assert f() == {expected}"]), score)

    def test_always_equal_objects_cannot_pass(self):
        always = '''class AlwaysEqual(%s):
    def __eq__(self, other):
        return True
    def __ne__(self, other):
        return False
    def __hash__(self):
        return 0
    def __repr__(self):
        return "3"
def add(a, b):
    return AlwaysEqual(%s)
'''
        for base, argument in (("object", ""), ("int", "3"), ("float", "3"), ("str", "'3'"), ("tuple", ""), ("dict", "")):
            with self.subTest(base=base):
                self.assertEqual(self.score(always % (base, argument), ADD, "", ADD_TESTS), 0.0)

    def test_structural_records_compare_class_name_and_exact_fields(self):
        reference = "class Point:\n    def __init__(self, x, y):\n        self.x, self.y = x, y\ndef make(x):\n    return Point(x, x + 1)\n"
        tests = ["assert make(1) == Point(1, 2)"]
        self.assertEqual(self.score(reference, reference, "", tests), 1.0)
        for output in (reference.replace("Point", "Other"),
                       reference.replace("self.x, self.y = x, y", "self.x, self.y, self.z = x, y, 0"),
                       reference.replace("x + 1", "x + 1.0"),
                       "class Point:\n    def __eq__(self, other):\n        return True\n    __hash__ = object.__hash__\ndef make(x):\n    return Point()\n"):
            with self.subTest(output=output):
                self.assertEqual(self.score(output, reference, "", tests), 0.0)

    def test_official_int_wrapper_accepts_only_plain_builtin_values(self):
        reference = "def lobb(n):\n    return n * 7 / 1\n"
        tests = ["assert int(lobb(5)) == 35"]
        for output, score in ((reference, 1.0), ("def lobb(n):\n    return 35", 1.0), ("def lobb(n):\n    return 35.9", 1.0),
                              ("def lobb(n):\n    return 36.0", 0.0), ("def lobb(n):\n    return [35]", 0.0),
                              ("class Fake:\n    def __int__(self):\n        return 35\ndef lobb(n):\n    return Fake()", 0.0)):
            with self.subTest(output=output):
                self.assertEqual(self.score(output, reference, "", tests), score)

    def test_plan_fingerprint_ignores_set_order_but_not_expected_values(self):
        import copy
        reference = "def count(items):\n    return len(items)\n"
        first = verification.prepare_plan(reference, "", ["assert count({'a', 'b', 'c'}) == 3"])
        reordered = copy.deepcopy(first)
        reordered["calls"][0]["args"][0]["v"].reverse()
        self.assertEqual(verification.plan_digest(first), verification.plan_digest(reordered))
        reordered["calls"][0]["expected"] = {"t": "int", "v": "0x2"}
        self.assertNotEqual(verification.plan_digest(first), verification.plan_digest(reordered))

    def test_type_arguments_and_runtime_dependent_expected_values(self):
        drop = "def drop(items, kind):\n    return [item for item in items if not isinstance(item, kind)]\n"
        self.assertEqual(self.score(drop, drop, "", ["assert drop((1, 2.5, 'x'), int) == [2.5, 'x']"]), 1.0)
        size = "import sys\ndef size(items):\n    return sys.getsizeof(items)\n"
        tests = ["assert size((1, 'a')) == sys.getsizeof((1, 'a'))"]
        self.assertEqual(self.score("def size(items):\n    import sys\n    return sys.getsizeof(items)", size, "", tests), 1.0)
        self.assertEqual(self.score("def size(items):\n    return 0", size, "", tests), 0.0)

    def test_expected_values_reference_and_setup_never_reach_candidate(self):
        reference = "def leak():\n    return 'secret-expected-829'\n"
        tests = ["assert leak() == 'secret-expected-829'"]
        self.assertEqual(self.score(reference, reference, "unused = 'secret-expected-829'", tests), 1.0)
        self.assertEqual(self.score(LEAK, reference, "unused = 'secret-expected-829'", tests), 0.0)

    def test_every_official_assertion_runs_in_order(self):
        reference = "count = 0\ndef tick(x):\n    global count\n    count += x\n    return count\n"
        tests = ["assert tick(1) == 1", "assert tick(2) == 3", "assert tick(0) == 3"]
        self.assertEqual(self.score(reference, reference, "", tests), 1.0)
        for output in ("def tick(x):\n    return 1", "def tick(x):\n    return 3", "def tick(x):\n    raise RuntimeError()",
                       "not valid Python", "raise RuntimeError('import failure')"):
            with self.subTest(output=output):
                self.assertEqual(self.score(output, reference, "", tests), 0.0)

    def test_early_exit_forgery_and_patches_cannot_alter_decision(self):
        attacks = {
            "exec replacement": ("import builtins\nbuiltins.exec = lambda *args, **kwargs: None", 0.0),
            "sys exit": ("import sys\nsys.exit(0)", 0.0),
            "os exit": ("import os\nos._exit(0)", "frame_failure"),
            "exit inside call": ("import os\ndef add(a, b):\n    os._exit(0)", "frame_failure"),
            "guessed frame then exit": (FORGED_FRAME % ('{"t": "bool", "v": True}', '{"t": "bool", "v": True}') + "os._exit(0)",
                                        0.0),
            "correct frame plus worker frame": (FORGED_FRAME % ('{"t": "int", "v": "0x3"}', '{"t": "int", "v": "0x4"}')
                                                + "def add(a, b):\n    return 0", "frame_failure"),
            "receipt": ("print('hone-pilot-complete:known', flush=True)\nimport sys\nsys.stderr.write('hone-pilot-complete:known')",
                        0.0),
            "atexit rewrite": ("import atexit, os\natexit.register(lambda: [os.write(fd, b'{\"results\": []}\\n') for fd in (1, 2, 3, 4)])",
                               0.0),
            "helper patches": (PATCHES + "builtins.isinstance = lambda *args: True\ndef add(a, b):\n    return 0\n", "nonzero_exit"),
            "environment search": ("import os\ndef add(a, b):\n    return next((value for key, value in os.environ.items() if 'EXPECTED' in key), None)",
                                   0.0),
        }
        for label, (output, expected) in attacks.items():
            with self.subTest(label):
                if type(expected) is str:
                    self.assert_infrastructure(output, outcome=expected)
                else:
                    self.assertEqual(self.score(output, ADD, "", ADD_TESTS), expected)
        self.assertEqual(self.score(PATCHES + ADD, ADD, "", ADD_TESTS), 1.0)

    def test_extraction_is_shared_without_repair(self):
        for output in (ADD, "prose\n```python\n" + ADD + "```\n```python\ninvalid\n```",
                       "```javascript\nnot Python\n```\n```\n" + ADD + "```", "prose\n```python\n" + ADD):
            with self.subTest(output=output):
                self.assertEqual(self.score(output, ADD, "", ADD_TESTS), 1.0)
        for output in ("```ruby\n" + ADD + "```", "```python\n    def add(a, b): return a + b\n```"):
            with self.subTest(output=output):
                self.assertEqual(self.score(output, ADD, "", ADD_TESTS), 0.0)

    def test_source_output_and_time_are_bounded(self):
        self.assertEqual(self.score("x" * (program.MAX_WIRE_BYTES + 1), ADD, "", ADD_TESTS), 0.0)
        flood = "import os\nfor fd in range(1, 64):\n    try: os.write(fd, b'x' * 262145)\n    except OSError: pass\n" + ADD
        self.assert_infrastructure(flood, outcome="frame_failure")
        verification.prepare_plan(ADD, "", ADD_TESTS)
        removed = []
        def remove(name, process):
            local_remove(name, process)
            removed.append(process.returncode)
        with patch.object(verification, "WORKER_SECONDS", 0.5), patch.object(program, "_remove", remove):
            self.assertEqual(self.score("while True:\n    pass", ADD, "", ADD_TESTS), 0.0)
        self.assertEqual(len(removed), 1)
        self.assertIsNotNone(removed[0])

    def test_unrepresentable_official_rows_are_explicit_and_score_zero(self):
        reference = "def f(*args, **kwargs):\n    return 1\n"
        rows = [
            ("", ["assert f(1) != 2"]),
            ("", ["assert f(1) == 1 and f(2) == 1"]),
            ("", ["assert f(1) == 1, 'message'"]),
            ("", ["assert f(value=1) == 1"]),
            ("", ["assert f(lambda: 1) == 1"]),
            ("", ["assert len([1]) == 1"]),
            ("", ["assert f(1) == float('nan')"]),
            ("items = [1]", ["assert f(items, items) == 1"]),
            ("items = [1]", ["assert f(items) == 1", "assert f(items) == 1"]),
            ("loop = []\nloop.append(loop)", ["assert f(loop) == 1"]),
            ("import collections\ncounts = collections.Counter('aa')", ["assert f(counts) == 1"]),
            ("raise RuntimeError('official setup failure')", ["assert f(1) == 1"]),
            ("", ["assert f(missing) == 1"]),
        ]
        for setup, tests in rows:
            with self.subTest(setup=setup, tests=tests):
                plan = verification.prepare_plan(reference, setup, tests)
                self.assertFalse(plan["gradeable"])
                self.assertIsInstance(plan["reason"], str)
                self.assertEqual(self.score(reference, reference, setup, tests), 0.0)

    def test_planning_infrastructure_failures_raise_instead_of_relabeling(self):
        for command in (["-c", "raise SystemExit(3)"], ["-c", "print('{}')"], ["-c", "print('not json')"]):
            with self.subTest(command=command), patch.object(program, "docker_command",
                                                             lambda name, path=None: [sys.executable, "-I", *command]):
                with self.assertRaises(RuntimeError):
                    verification.prepare_plan(ADD, "", ADD_TESTS)
                with self.assertRaises(RuntimeError):
                    self.score(ADD, ADD, "", ADD_TESTS)


class InfrastructureOutcomeTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(verification._PLANS, clear=True))
        self.enterContext(patch.object(program, "docker_command", local_command))
        self.enterContext(patch.object(program, "_remove", local_remove))
        verification.prepare_plan(ADD, "", ADD_TESTS)

    def assert_infrastructure(self, source, outcome):
        with self.assertRaises(verification.GraderInfrastructureError) as caught:
            verification.score_solution(source, ADD, "", ADD_TESTS)
        self.assertEqual(caught.exception.receipt["outcome"], outcome)
        self.assertIsNone(caught.exception.receipt["score"])
        verification.validate_grader_receipt(caught.exception.receipt)
        return caught.exception.receipt

    def test_outer_timeout_without_trusted_verdict_is_unscored_infrastructure(self):
        def hang(name, path=None):
            return [sys.executable, "-I", "-c", "import time; time.sleep(60)"]

        with patch.object(verification, "WORKER_SECONDS", 0.1), \
                patch.object(verification, "SUPERVISOR_MARGIN_SECONDS", 0.4), \
                patch.object(program, "docker_command", hang):
            receipt = self.assert_infrastructure(ADD, "timeout")
        self.assertEqual(receipt["invocations"][-1]["stage"], "worker")

    def test_nonzero_exit_is_unscored_infrastructure(self):
        self.assert_infrastructure("import os\nos._exit(7)", "nonzero_exit")

    def test_missing_frame_is_unscored_infrastructure(self):
        self.assert_infrastructure("import os\nos._exit(0)", "frame_failure")

    def test_signal_death_is_unscored_infrastructure(self):
        receipt = self.assert_infrastructure("import os, signal\ndef add(a, b):\n    os.kill(os.getpid(), signal.SIGKILL)",
                                             "nonzero_exit")
        self.assertEqual(receipt["invocations"][-1]["exit_code"], 128 + signal.SIGKILL)

    def test_trusted_payload_errors_are_infrastructure_not_candidate_failures(self):
        plan = {"gradeable": True, "reason": None, "calls": [{
            "function": "add", "wrapper": None, "expected": {"t": "int", "v": "0x1"},
            "args": [{"t": "dict", "v": [[{"t": "list", "v": []}, {"t": "int", "v": "0x1"}]]}]}]}
        with patch.object(verification, "prepare_plan", return_value=plan):
            receipt = self.assert_infrastructure(ADD, "nonzero_exit")
        self.assertIn(b"TypeError", bytes.fromhex(receipt["invocations"][-1]["stderr_hex"]))

    def test_malformed_and_overlarge_frames_are_unscored(self):
        attacks = [
            FORGED_FRAME % ('{"t": "bool", "v": True}', '{"t": "bool", "v": True}') + ADD,
            "import os\nfor fd in range(1, 64):\n    try: os.write(fd, b'x' * 262145)\n    except OSError: pass\n" + ADD,
        ]
        for source in attacks:
            with self.subTest(source=source):
                receipt = self.assert_infrastructure(source, "frame_failure")
                invocation = receipt["invocations"][-1]
                self.assertLessEqual(len(bytes.fromhex(invocation["stdout_hex"])) +
                                     len(bytes.fromhex(invocation["stderr_hex"])), 262144)

    def test_durable_receipts_keep_scope_original_output_and_outcomes(self):
        from pilot.runtime import call_scope, digest

        wrong = "def add(a, b):\n    return 0"
        raising = "def add(a, b):\n    raise TypeError('candidate')"
        dying = "import os\nos._exit(9)"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grader.jsonl"
            with call_scope(row_id=720, arm="plain"), verification.grader_journal(path, task="mbpp"):
                with verification.grader_journal(artifact_hash=digest("artifact")):
                    self.assertEqual(verification.score_solution(ADD, ADD, "", ADD_TESTS), 1.0)
                    self.assertEqual(verification.score_solution(wrong, ADD, "", ADD_TESTS), 0.0)
                    self.assertEqual(verification.score_solution(raising, ADD, "", ADD_TESTS), 0.0)
                    failure = self.assert_infrastructure(dying, "nonzero_exit")
            rows = [json.loads(line) for line in path.read_text().splitlines()]
        outcomes = [row for row in rows if row["event"] == "grader-outcome"]
        self.assertEqual([row["outcome"] for row in outcomes], ["pass", "wrong_answer", "wrong_answer", "nonzero_exit"])
        self.assertEqual([row["score"] for row in outcomes], [1.0, 0.0, 0.0, None])
        self.assertEqual([row["reason"] for row in outcomes],
                         [None, None, "Candidate failure: call 0 raised TypeError", "Invocation exited nonzero"])
        self.assertEqual(outcomes[-1], failure)
        for row, output in zip(outcomes, (ADD, wrong, raising, dying)):
            verification.validate_grader_receipt(row)
            self.assertEqual(row["context"]["task"], "mbpp")
            self.assertEqual(row["context"]["row_id"], 720)
            self.assertEqual(row["context"]["arm"], "plain")
            self.assertEqual(row["context"]["artifact_hash"], digest("artifact"))
            self.assertEqual(row["context"]["original_output"]["text"], output)
            self.assertEqual(row["context"]["output_hash"], digest(output))
            self.assertEqual(row["input_hash"], digest({"output": output, "reference_code": ADD,
                                                      "setup": "", "tests": ADD_TESTS}))

    def test_receipt_validation_rejects_missing_inconsistent_and_tampered_provenance(self):
        from pilot.runtime import digest

        valid = self.assert_infrastructure("import os\nos._exit(9)", "nonzero_exit")
        for mutation in (
            lambda row: row.update(score=0.0),
            lambda row: row.update(outcome="wrong_answer", score=0.0),
            lambda row: row.update(invocations=[]),
            lambda row: row.update(outcome="timeout"),
            lambda row: row["invocations"][-1].update(stdout_hash=digest("other")),
            lambda row: row["invocations"][-1].update(exit_code=0),
            lambda row: row["invocations"][-1].update(script_hash=digest("other")),
            lambda row: row["invocations"][-1].update(deadline_seconds=60),
            lambda row: row["invocations"][-1].pop("candidate_seconds"),
            lambda row: row["context"].update(input_hash=digest("other")),
            lambda row: row.update(source_hash=digest("other")),
        ):
            row = copy.deepcopy(valid)
            mutation(row)
            row["receipt_hash"] = digest({key: value for key, value in row.items() if key != "receipt_hash"})
            with self.assertRaises(ValueError):
                verification.validate_grader_receipt(row)
        with self.assertRaises(ValueError):
            verification.validate_grader_receipt({})

    def test_planning_and_wrapper_failures_have_stage_receipts(self):
        verification._PLANS.clear()
        with patch.object(program, "docker_command", lambda name: [sys.executable, "-I", "-c", "print('{}')"]):
            receipt = self.assert_infrastructure(ADD, "frame_failure")
        self.assertEqual(receipt["invocations"][-1]["stage"], "planner")

        def wrapper_dies(name, path=None):
            if name.startswith("hone-pilot-wrapper-"):
                return [sys.executable, "-I", "-c", "raise SystemExit(5)"]
            return local_command(name, path)

        reference = "def f():\n    return 3.0"
        with patch.object(program, "docker_command", wrapper_dies), \
                self.assertRaises(verification.GraderInfrastructureError) as caught:
            verification.score_solution(reference, reference, "", ["assert int(f()) == 3"])
        verification.validate_grader_receipt(caught.exception.receipt)
        self.assertEqual(caught.exception.receipt["invocations"][-1]["stage"], "wrapper")
        self.assertEqual(caught.exception.receipt["outcome"], "nonzero_exit")

    def test_invocation_preserves_real_exit_stdout_stderr(self):
        script = "import sys; sys.stdout.write('partial'); sys.stderr.write('diagnostic'); sys.exit(13)"
        with patch.object(program, "docker_command", lambda name: [sys.executable, "-I", "-c", script]):
            receipt = self.assert_infrastructure(ADD, "nonzero_exit")
        invocation = receipt["invocations"][-1]
        self.assertEqual(invocation["exit_code"], 13)
        self.assertEqual(bytes.fromhex(invocation["stdout_hex"]), b"partial")
        self.assertEqual(bytes.fromhex(invocation["stderr_hex"]), b"diagnostic")
        self.assertGreaterEqual(invocation["elapsed_seconds"], 0)

    def test_successful_plan_preparation_is_not_a_task_score(self):
        verification._PLANS.clear()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grader.jsonl"
            with verification.grader_journal(path, task="mbpp", stage="preparation"):
                plan = verification.prepare_plan(ADD, "", ADD_TESTS)
            rows = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertTrue(plan["gradeable"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["event"], "grader-invocation")
        self.assertEqual(rows[0]["outcome"], "completed")
        self.assertEqual(rows[0]["stage"], "planner")
        self.assertNotIn("score", rows[0])

    def test_oversized_source_boundary_is_explicit_and_retains_bounded_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grader.jsonl"
            output = "é" * 262145
            with verification.grader_journal(path):
                self.assertEqual(verification.score_solution(output, ADD, "", ADD_TESTS), 0.0)
            receipt = json.loads(path.read_text())
        verification.validate_grader_receipt(receipt)
        self.assertEqual(receipt["outcome"], "wrong_answer")
        original = receipt["context"]["original_output"]
        self.assertTrue(original["truncated"])
        self.assertEqual(original["bytes"], len(output.encode()))
        self.assertLessEqual(len(original["text"].encode()), 262144)


@unittest.skipUnless(os.environ.get("PILOT_DOCKER_TESTS") == "1", "Parent-controlled real Docker smoke")
class DockerVerificationTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(verification._PLANS, clear=True))

    def test_exited_worker_with_escaped_descendant_preserves_verdict(self):
        spawn = '''import os, time
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
'''
        cases = [("exit7", "os._exit(7)", "nonzero_exit", None),
                 ("exit0", "os._exit(0)", "frame_failure", None),
                 ("pass", ADD, "pass", 1.0),
                 ("exception", "def add(a,b): raise TypeError('candidate')", "wrong_answer", 0.0)]
        with tempfile.TemporaryDirectory() as directory:
            for name, ending, expected_outcome, expected_score in cases:
                with self.subTest(name):
                    journal = Path(directory) / (name + ".jsonl")
                    with verification.grader_journal(journal):
                        if expected_score is None:
                            with self.assertRaises(verification.GraderInfrastructureError) as caught:
                                verification.score_solution(spawn + ending, ADD, "", ADD_TESTS)
                            receipt = caught.exception.receipt
                        else:
                            self.assertEqual(verification.score_solution(spawn + ending, ADD, "", ADD_TESTS), expected_score)
                            receipt = json.loads(journal.read_text().splitlines()[-1])
                    verification.validate_grader_receipt(receipt)
                    self.assertEqual((receipt["outcome"], receipt["score"]), (expected_outcome, expected_score))
                    if name == "exit7":
                        self.assertEqual(receipt["invocations"][-1]["exit_code"], 7)
                    elif name == "exception":
                        self.assertIn("TypeError", receipt["reason"])

    def test_docker_official_shapes_and_attacks(self):
        size = "import sys\ndef size(items):\n    return sys.getsizeof(items)\n"
        size_tests = ["assert size((1, 'a')) == sys.getsizeof((1, 'a'))"]
        wrapped = "def lobb(n):\n    return n * 7 / 1\n"
        for output, reference, setup, tests in ((PAIR, PAIR, "", PAIR_TESTS), ("```python\n" + PAIR + "```", PAIR, "", PAIR_TESTS),
                                                (NODE, NODE, NODE_SETUP, NODE_TESTS), (size, size, "", size_tests),
                                                (wrapped, wrapped, "", ["assert int(lobb(5)) == 35"])):
            with self.subTest(reference=reference, output=output):
                self.assertEqual(verification.score_solution(output, reference, setup, tests), 1.0)
        search = '''import os
def leak():
    for value in os.environ.values():
        if "secret" in value:
            return value
    for directory in ("/", "/tmp", "/home", "/root", "/mnt", "/srv", "/data", os.getcwd()):
        try:
            names = os.listdir(directory)
        except OSError:
            continue
        for name in names:
            try:
                with open(os.path.join(directory, name)) as stream:
                    text = stream.read(1048576)
            except (OSError, UnicodeError):
                continue
            if "secret-expected" in text:
                return "secret-expected-829"
    return None
'''
        reference = "def leak():\n    return 'secret-expected-829'\n"
        tests = ["assert leak() == 'secret-expected-829'"]
        self.assertEqual(verification.score_solution(reference, reference, "", tests), 1.0)
        for output in (search, LEAK):
            with self.subTest(output=output):
                self.assertEqual(verification.score_solution(output, reference, "", tests), 0.0)
        for output in ("import os\nos._exit(0)", "import os, signal\nos.kill(os.getpid(), signal.SIGKILL)"):
            with self.subTest(output=output):
                with self.assertRaises(verification.GraderInfrastructureError) as caught:
                    verification.score_solution(output, ADD, "", ADD_TESTS)
                verification.validate_grader_receipt(caught.exception.receipt)
                self.assertIsNone(caught.exception.receipt["score"])
        with patch.object(verification, "WORKER_SECONDS", 1):
            for output in ("import builtins\nbuiltins.exec = lambda *args, **kwargs: None", "while True:\n    pass",
                           TIMER_ATTACK, SUPERVISOR_ATTACK):
                with self.subTest(output=output):
                    self.assertEqual(verification.score_solution(output, ADD, "", ADD_TESTS), 0.0)
        forged_wrong = FORGED_FRAME % ('{"t": "bool", "v": True}', '{"t": "bool", "v": True}') + "os._exit(0)"
        self.assertEqual(verification.score_solution(forged_wrong, ADD, "", ADD_TESTS), 0.0)


if __name__ == "__main__":
    unittest.main()
