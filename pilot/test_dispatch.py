from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from pilot import __main__ as cli


class DispatchTests(unittest.TestCase):
    def dispatch(self, changes=(), seed=0):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        out = Path(directory.name) / "runs"
        visited = []

        def search(args, pool, env, task, run_seed, method, smoke):
            row = {"task": task, "seed": run_seed, "method": method,
                   "status": "completed", "calls": 100, "hidden_attempts": 0,
                   "usage_missing_calls": 0, "pause_seconds": 0}
            if len(visited) < len(changes):
                row.update(changes[len(visited)])
            visited.append((task, run_seed, method))
            return row

        with ExitStack() as stack:
            stack.enter_context(patch.object(sys, "argv", ["pilot", "pilot", "--seed", str(seed), "--out", str(out)]))
            stack.enter_context(patch.object(cli, "execution_limits"))
            stack.enter_context(patch.object(cli, "load_panel", return_value=("mbpp", "hover")))
            stack.enter_context(patch.object(cli, "machine_proof"))
            stack.enter_context(patch.object(cli, "environment", return_value=({}, {})))
            stack.enter_context(patch.object(cli, "search_one", side_effect=search))
            stack.enter_context(patch("pilot.spend.report_spend", return_value={}))
            cli.main()
        return visited, json.loads((out / "comparison.json").read_text()), out

    def test_declared_seed_dispatches_exactly_six_cells(self):
        for seed in (0, 2):
            with self.subTest(seed=seed):
                visited, report, _ = self.dispatch(seed=seed)
                self.assertEqual(visited, [(task, seed, method) for task in ("mbpp", "hover") for method in cli.METHODS])
                self.assertIsNone(report["dispatch_stop"])

    def test_hidden_attempt_rate_stops_before_next_cell(self):
        visited, report, out = self.dispatch([{"hidden_attempts": 2}])
        self.assertEqual(visited, [("mbpp", 0, "hone")])
        self.assertEqual(report["dispatch_stop"]["reason"], "hidden-attempt-rate")
        self.assertEqual(json.loads((out / "stop.json").read_text()), report["dispatch_stop"])
        self.assertEqual(len(report["runs"]), 1)

    def test_hidden_attempt_rate_uses_all_finished_calls(self):
        visited, report, _ = self.dispatch([{"hidden_attempts": 1}, {"hidden_attempts": 2}])
        self.assertEqual(len(visited), 2)
        self.assertEqual(report["dispatch_stop"]["hidden_attempts"], 3)
        self.assertEqual(report["dispatch_stop"]["calls"], 200)

    def test_unknown_usage_is_per_cell_not_diluted_by_previous_cells(self):
        visited, report, _ = self.dispatch([{"calls": 10000}, {"usage_missing_calls": 2}])
        self.assertEqual(len(visited), 2)
        self.assertEqual(report["dispatch_stop"]["reason"], "unknown-usage-rate")
        self.assertEqual(report["dispatch_stop"]["cell"], {"task": "mbpp", "seed": 0, "method": "gepa"})

    def test_exactly_one_percent_does_not_stop(self):
        visited, report, _ = self.dispatch([{"hidden_attempts": 1, "usage_missing_calls": 1}] * 6)
        self.assertEqual(len(visited), 6)
        self.assertIsNone(report["dispatch_stop"])

    def test_two_consecutive_infrastructure_failures_stop(self):
        visited, report, _ = self.dispatch([{"status": "infrastructure_failure"}] * 2)
        self.assertEqual(len(visited), 2)
        self.assertEqual(report["dispatch_stop"]["reason"], "consecutive-infrastructure-failures")

    def test_completed_cell_resets_infrastructure_failure_streak(self):
        visited, report, _ = self.dispatch([{"status": "infrastructure_failure"}, {},
                                          {"status": "infrastructure_failure"}, {"status": "infrastructure_failure"}])
        self.assertEqual(len(visited), 4)
        self.assertEqual(report["dispatch_stop"]["reason"], "consecutive-infrastructure-failures")

    def test_six_hour_pause_handback_is_run_wide(self):
        visited, report, _ = self.dispatch([{"pause_seconds": 10800}, {"pause_seconds": 10801}])
        self.assertEqual(len(visited), 2)
        self.assertEqual(report["dispatch_stop"]["reason"], "pause-limit")

    def test_last_cell_can_finish_and_still_records_abort_evidence(self):
        visited, report, _ = self.dispatch([{}, {}, {}, {}, {}, {"usage_missing_calls": 2}])
        self.assertEqual(len(visited), 6)
        self.assertEqual(report["dispatch_stop"]["reason"], "unknown-usage-rate")
        self.assertEqual(len(report["runs"]), 6)


if __name__ == "__main__":
    unittest.main()
