"""Consumer-contract regressions for the four fresh calibration tasks (stdlib only)."""
import gzip
import importlib.util
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
NAMES = ("postings-intersection", "sequence-diff", "weighted-coverage", "online-cache")


def load(path):
    spec = importlib.util.spec_from_file_location("subject", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def module(name, file="checker.py"):
    return load(ROOT / ("calibration-" + name) / "baseline" / file)


class CalibrationChecks(unittest.TestCase):
    def test_fresh_fixtures_are_deterministic_and_candidate_results_are_checked(self):
        for name in NAMES:
            root = ROOT / ("calibration-" + name)
            generator = load(root / "tools/fixtures.py")
            checker = module(name)
            for split, seed in (("train", 32452843), ("validation", 49979687)):
                generated = generator.cases(seed)
                self.assertEqual(generated, generator.cases(seed))
                for row in generated:
                    row["id"] = split + ":" + row["id"]
                with gzip.open(root / "assets" / split / "cases.json.gz", "rt") as source:
                    self.assertEqual(json.load(source), generated)
                for variant in ("baseline", "diagnostics/improved"):
                    candidate = load(root / variant / "task.py")
                    for case in generated:
                        with self.subTest(name=name, split=split, variant=variant, case=case["id"]):
                            if name == "online-cache":
                                # New process-equivalent module state for each trace.
                                candidate = load(root / variant / "task.py")
                                ok, quality, detail = checker.evaluate(case["input"], candidate.solve, random.Random(seed))
                            else:
                                output = json.loads(json.dumps(candidate.solve(case["input"])))
                                ok, quality, detail = checker.check(case["input"], output)
                            self.assertTrue(ok, detail)
                            self.assertGreaterEqual(quality, 0)
                            self.assertLessEqual(quality, 1)

    def test_postings_rejects_numerically_equal_wrong_types_and_inexact_sets(self):
        check = module("postings-intersection").check
        payload = {"lists": [[1, 3, 8], [1, 4, 8]]}
        self.assertTrue(check(payload, [1, 8])[0])
        for result in ([True, 8], [1.0, 8], [1, 1, 8], [8, 1], [1], [1, 3, 8]):
            self.assertFalse(check(payload, result)[0])
        self.assertFalse(check({"lists": [[1, 1]]}, [1])[0])
        self.assertFalse(check({"lists": [[]] * 9}, [])[0])
        self.assertFalse(check({"lists": [list(range(20001))]}, [])[0])

    def test_diff_checks_minimality_without_requiring_one_tie_break(self):
        check = module("sequence-diff").check
        payload = {"before": ["a", "b"], "after": ["b", "a"]}
        for script in ([['delete', 'a'], ['equal', 'b'], ['insert', 'a']],
                       [['insert', 'b'], ['equal', 'a'], ['delete', 'b']]):
            self.assertTrue(check(payload, script)[0])
        self.assertFalse(check(payload, [['delete', 'a'], ['delete', 'b'], ['insert', 'b'], ['insert', 'a']])[0])
        self.assertFalse(check(payload, [['equal', 'b'], ['equal', 'a']])[0])
        self.assertFalse(check({"before": ["x"] * 1025, "after": []}, [])[0])

    def test_coverage_enforces_total_budget_and_counts_union_once(self):
        check = module("weighted-coverage").check
        payload = {"weights": [4, 3, 2], "sets": [
            {"elements": [0, 1], "cost": 3}, {"elements": [1, 2], "cost": 3}], "budget": 5}
        self.assertEqual(check(payload, [0])[:2], (True, 7 / 9))
        for selection in ([0, 1], [0, 0], [True], [-1], [2]):
            self.assertFalse(check(payload, selection)[0])
        payload["budget"] = 6
        self.assertEqual(check(payload, [1, 0])[:2], (True, 1.0))
        self.assertEqual(check({"weights": [0], "sets": [], "budget": 0}, [])[:2], (True, 1.0))

    def test_online_draws_only_after_prior_decision_and_parent_owns_cache(self):
        checker = module("online-cache")
        payload = {"capacity": 1, "phases": [{"length": 3, "pages": [10, 20], "weights": [1, 1]}]}
        calls, draws = [], []

        class Rng:
            def randrange(inner, limit):
                self.assertEqual(len(calls), len(draws))
                draws.append(len(draws))
                return (0, 1, 1)[len(draws) - 1]

        def call(request):
            self.assertEqual(set(request), {"request", "cache", "capacity", "hit"})
            calls.append(request)
            return request["cache"][0] if request["cache"] and not request["hit"] else None

        self.assertEqual(checker.evaluate(payload, call, Rng())[:2], (True, 1 / 3))
        self.assertEqual([entry["cache"] for entry in calls], [[], [10], [20]])
        for victim in (None, True, 99):
            with self.assertRaises(ValueError):
                checker.transition({10}, 1, 20, victim)
        with self.assertRaises(ValueError):
            checker.transition({10}, 1, 10, 10)
        with self.assertRaises(ValueError):
            checker.validate({"capacity": 1, "phases": [{"length": 10001, "pages": [1], "weights": [1]}]})

    def test_worker_cannot_promote_unsolicited_or_oversized_output(self):
        runtime = module("online-cache", "eval.py")
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "task.py").write_text('import os\nos.write(1, b"not evaluator output\\n")\ndef solve(payload):\n    return None\n')
            worker = runtime.Worker(workspace, offline=True)
            try:
                self.assertIsNone(worker.call({}))
            finally:
                worker.close()
            (workspace / "task.py").write_text('def solve(payload):\n    return "x" * 2100000\n')
            worker = runtime.Worker(workspace, offline=True)
            try:
                with self.assertRaisesRegex(ValueError, "byte limit"):
                    worker.call({})
            finally:
                worker.close()

    def test_production_refuses_unsealed_host_execution(self):
        completed = subprocess.run([sys.executable, "-I", "-B", str(ROOT / "calibration-online-cache/baseline/eval.py")],
                                   capture_output=True, text=True, timeout=5)
        self.assertNotEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, "")


if __name__ == "__main__":
    unittest.main()
