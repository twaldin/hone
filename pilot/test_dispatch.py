from contextlib import ExitStack
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from pilot import __main__ as cli
from pilot import runtime
from pilot.tasks import Task


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
            seeds = seed if isinstance(seed, tuple) else (seed,)
            stack.enter_context(patch.object(sys, "argv", ["pilot", "pilot", "--seed", *map(str, seeds), "--out", str(out)]))
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

    def test_seed_pair_runs_serially_in_seed_major_order(self):
        visited, report, _ = self.dispatch(seed=(1, 2))
        self.assertEqual(visited, [(task, seed, method) for seed in (1, 2)
                                   for task in ("mbpp", "hover") for method in cli.METHODS])
        self.assertEqual(report["seeds"], [1, 2])
        self.assertIsNone(report["dispatch_stop"])

    def test_pause_allowance_is_not_reset_between_seeds(self):
        changes = [{"pause_seconds": 20000}] + [{}] * 5 + [{"pause_seconds": 1601}]
        visited, report, _ = self.dispatch(changes, seed=(1, 2))
        self.assertEqual(visited[-1], ("mbpp", 2, "hone"))
        self.assertEqual(report["dispatch_stop"]["reason"], "pause-limit")
        self.assertEqual(report["dispatch_stop"]["pause_seconds"], 21601)
        self.assertEqual(len(visited), 7)

    def test_infrastructure_failure_streak_crosses_seed_boundary(self):
        changes = [{}] * 5 + [{"status": "infrastructure_failure"}] * 2
        visited, report, _ = self.dispatch(changes, seed=(1, 2))
        self.assertEqual(len(visited), 7)
        self.assertEqual(report["dispatch_stop"]["reason"], "consecutive-infrastructure-failures")

    def test_duplicate_seeds_are_rejected_before_startup(self):
        with patch.object(sys, "argv", ["pilot", "pilot", "--seed", "1", "1"]), patch.object(
                cli, "configure_nlp", side_effect=AssertionError("duplicate seeds reached startup")), patch("sys.stderr"):
            with self.assertRaises(SystemExit) as error:
                cli.main()
        self.assertEqual(error.exception.code, 2)

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


class StartupPauseTests(unittest.TestCase):
    def test_failed_startup_preserves_pauses_and_next_cell_remaining_allowance(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            out = Path(directory) / "runs"
            real_search = cli.search_one
            visited = []
            throttles = []

            def throttle(pool, env, journal, **kwargs):
                now = [1000.0]
                index = len(throttles)
                elapsed = 12600 if index == 0 else 10800
                readings = iter([{"generatedAt": 1000 * now[0], "reports": []}] * (elapsed // 900) + [None])

                def read():
                    if next(readings) is None:
                        return {"generatedAt": now[0] * 1000, "reports": []}
                    raise runtime.TransportError("broker moving")

                def sleep(seconds):
                    now[0] += seconds
                    if now[0] > 20000:
                        raise AssertionError("pause allowance did not stop dispatch")

                item = runtime.Throttle(pool, env, journal, interval=900, reader=read,
                                        clock=lambda: now[0], sleep=sleep, **kwargs)
                throttles.append(item)
                return item

            def search(args, pool, env, task, seed, method, smoke):
                visited.append((task, seed, method))
                if len(visited) == 1:
                    return {"task": task, "seed": seed, "method": method, "status": "completed",
                            "calls": 100, "hidden_attempts": 0, "usage_missing_calls": 0, "pause_seconds": 7200}
                return real_search(args, pool, env, task, seed, method, smoke)

            stack.enter_context(patch.object(sys, "argv", ["pilot", "pilot", "--seed", "0", "--out", str(out)]))
            stack.enter_context(patch.object(cli, "execution_limits"))
            stack.enter_context(patch.object(cli, "load_panel", return_value=("mbpp", "hover")))
            stack.enter_context(patch.object(cli, "machine_proof"))
            stack.enter_context(patch.object(cli, "environment", return_value=({"anthropic": {"accounts": []}}, {})))
            stack.enter_context(patch.object(cli, "load_control", return_value={}))
            stack.enter_context(patch.object(cli, "evaluator_identity", return_value={}))
            stack.enter_context(patch("pilot.tasks.load_task", side_effect=lambda name, cache: Task(name, [], [], {}, {"prompt": "seed"})))
            stack.enter_context(patch.object(cli, "Throttle", side_effect=throttle))
            stack.enter_context(patch.object(cli, "search_one", side_effect=search))
            stack.enter_context(patch("pilot.runtime.capacity_reason", side_effect=lambda reading, pool, now: None))
            stack.enter_context(patch("pilot.runtime.Gateway", side_effect=runtime.TransportError("bad ready frame")))
            stack.enter_context(patch("pilot.runtime.broker_healthy", return_value=True))
            cli.main()
            report = json.loads((out / "comparison.json").read_text())
            self.assertEqual(visited, [("mbpp", 0, method) for method in cli.METHODS])
            self.assertEqual(report["runs"][1]["pause_seconds"], 12600)
            self.assertEqual(throttles[1].pause_limit_seconds, 1800)
            self.assertEqual(report["runs"][2]["status"], "pause_limit_exceeded")
            self.assertEqual(report["dispatch_stop"]["reason"], "pause-limit")
            self.assertEqual(report["dispatch_stop"]["pause_seconds"], 22500)


    def test_interrupted_cell_replays_closed_and_open_pause_prefixes(self):
        for closed in (False, True):
            with self.subTest(closed=closed), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                out = Path(directory) / "runs"
                finished = out / "mbpp/0/hone"
                row = {"task": "mbpp", "seed": 0, "method": "hone", "status": "completed",
                       "calls": 100, "hidden_attempts": 0, "usage_missing_calls": 0, "pause_seconds": 7200}
                cli.save(finished / "result.json", row)
                cli.seal(finished)
                interrupted = out / "mbpp/0/gepa"
                interrupted.mkdir(parents=True)
                events = [{"event": "paused", "at": 0}, {"event": "paused", "at": 12600}]
                if closed:
                    events.append({"event": "resumed", "at": 12600, "seconds": 12600})
                (interrupted / "pauses.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events) + '{"event":')
                real_search = cli.search_one
                remaining = []

                def search(args, pool, env, task, seed, method, smoke):
                    if (out / task / str(seed) / method).exists():
                        return real_search(args, pool, env, task, seed, method, smoke)
                    remaining.append(args.remaining_pause_seconds)
                    return {"task": task, "seed": seed, "method": method, "status": "completed",
                            "calls": 0, "hidden_attempts": 0, "usage_missing_calls": 0, "pause_seconds": 0}

                stack.enter_context(patch.object(sys, "argv", ["pilot", "pilot", "--seed", "0", "--out", str(out)]))
                stack.enter_context(patch.object(cli, "execution_limits"))
                stack.enter_context(patch.object(cli, "load_panel", return_value=("mbpp", "hover")))
                stack.enter_context(patch.object(cli, "machine_proof"))
                stack.enter_context(patch.object(cli, "environment", return_value=({}, {})))
                stack.enter_context(patch.object(cli, "load_control", return_value={}))
                stack.enter_context(patch.object(cli, "evaluator_identity", return_value={}))
                stack.enter_context(patch("pilot.tasks.load_task", side_effect=lambda name, cache: Task(name, [], [], {}, {"prompt": "seed"})))
                stack.enter_context(patch.object(cli, "search_one", side_effect=search))
                stack.enter_context(patch("pilot.runtime.Gateway", side_effect=AssertionError("resumed prefix must not dispatch")))
                cli.main()
                report = json.loads((out / "comparison.json").read_text())
                self.assertEqual(report["runs"][1]["pause_seconds"], 12600)
                self.assertEqual(report["runs"][1]["pauses"], 1)
                self.assertEqual(report["runs"][1]["pause_accounting_incomplete"], not closed)
                self.assertEqual(remaining, [1800] * 4)


    def test_interrupted_pause_limit_retains_terminal_reason_without_double_counting(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            events = [{"event": "paused", "at": 0}, {"event": "paused", "at": 5},
                      {"event": "resumed", "at": 10, "seconds": 10},
                      {"event": "paused", "at": 20}, {"event": "paused", "at": 25},
                      {"event": "pause-limit", "at": 30, "seconds": 10}]
            (out / "pauses.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
            result = cli.resume_result(out, "mbpp", 0, "hone")
            self.assertEqual(result["pause_seconds"], 20)
            self.assertEqual(result["pauses"], 2)
            self.assertFalse(result["pause_accounting_incomplete"])
            self.assertEqual(result["status"], "pause_limit_exceeded")
            self.assertEqual(result["stop_reason"], "PauseLimitExceeded")
            self.assertEqual(cli.dispatch_stop([result])["reason"], "pause-limit")


if __name__ == "__main__":
    unittest.main()
