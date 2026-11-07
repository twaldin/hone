import argparse
import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pilot.campaign import CampaignGuard, MATRIX, before_model_call

RUNNER = Path(__file__).resolve().parents[1] / "evidence/pilot/runtime-rerun-11e/run.py"
spec = importlib.util.spec_from_file_location("rerun11", RUNNER)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RerunTests(unittest.TestCase):
    def test_dispatch_executes_twelve_fresh_cells_and_keeps_old_safety_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = argparse.Namespace(out=root)
            guard = CampaignGuard(root)
            prior = [dict(seed=1, task="mbpp", method="hone", calls=16592, hidden_attempts=1,
                          usage_missing_calls=0, pause_seconds=5, status="completed", historical=True)]
            observed = []

            def search(args, pool, env, task, seed, method, smoke):
                observed.append((seed, task, method))
                self.assertEqual(args.remaining_pause_seconds, 21600 - 5)
                out = root / task / str(seed) / method
                out.mkdir(parents=True, exist_ok=False)
                before_model_call(SimpleNamespace(journal=out / "calls.jsonl", calls=0))
                return dict(seed=seed, task=task, method=method, calls=1, hidden_attempts=0,
                            usage_missing_calls=0, pause_seconds=0, status="completed")

            proof = {"predeclaration_file_hash": "decl", "declaration_commit": "commit"}
            with patch("pilot.campaign.os.statvfs", return_value=SimpleNamespace(f_bavail=100_000_000_000, f_frsize=1)), \
                 patch.object(runner.cli, "search_one", side_effect=search), \
                 patch.object(runner, "report_spend", return_value={}):
                rows, stopped = runner.dispatch(args, {}, {}, proof, prior, guard, lambda: None)
            self.assertIsNone(stopped)
            self.assertEqual(observed, [(1, "mbpp", "hone"), (1, "mbpp", "gepa"), (1, "mbpp", "plain"),
                                        (1, "hover", "hone"), (1, "hover", "gepa"), (1, "hover", "plain"),
                                        (2, "mbpp", "hone"), (2, "mbpp", "gepa"), (2, "mbpp", "plain"),
                                        (2, "hover", "hone"), (2, "hover", "gepa"), (2, "hover", "plain")])
            self.assertEqual(guard.actual, 12)
            self.assertEqual(len(rows), 12)
            self.assertEqual(len(prior), 13)
            self.assertEqual(prior[0]["calls"], 16592)

    def test_historical_streak_stops_without_a_new_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rows = [dict(seed=1, task="hover", method=method, calls=0, hidden_attempts=0,
                         status="infrastructure_failure") for method in ("gepa", "plain")]
            guard = CampaignGuard(root)
            proof = {"predeclaration_file_hash": "decl", "declaration_commit": "commit"}
            completed, stopped = runner.dispatch(argparse.Namespace(out=root), {}, {}, proof, rows, guard,
                                                 lambda: self.fail("Must not start another cell"))
            self.assertEqual(completed, [])
            self.assertEqual(stopped["reason"], "consecutive-infrastructure-failures")
            self.assertEqual(guard.actual, 0)


if __name__ == "__main__":
    unittest.main()
