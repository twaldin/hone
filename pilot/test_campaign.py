import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from pilot.campaign import CampaignGuard, CampaignStop, MATRIX, before_model_call, campaign_scope, check_disk


class CampaignTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.space = patch("pilot.campaign.os.statvfs", return_value=SimpleNamespace(f_bavail=100_000_000_000, f_frsize=1))
        self.space.start()
        self.addCleanup(self.space.stop)
        self.ledger = SimpleNamespace(journal=self.root / "calls.jsonl", calls=0)

    def test_projection_crossing_stops_before_next_cell(self):
        guard = CampaignGuard(self.root)
        guard.before_cell(MATRIX[0])
        guard.finish_cell(dict(seed=1, task="mbpp", method="hone", status="completed", calls=5000))
        # A completed matched cell raises the seed-2 forecast by 1,566.
        with self.assertRaises(CampaignStop) as raised:
            # Reserve actual new usage without counting any historical ledger totals.
            for _ in range(3500):
                guard.before_model_call(self.ledger)
            guard.before_cell(MATRIX[1])
        self.assertEqual(raised.exception.receipt["reason"], "completion-projection")
        self.assertEqual(raised.exception.receipt["projected"], 35070)
        self.assertIsNone(guard.current)

    def test_initial_projection_and_equality(self):
        guard = CampaignGuard(self.root, cap=33438)
        guard.before_cell(MATRIX[0])
        self.assertEqual(guard.current, (1, "mbpp", "hone"))

    def test_failed_cell_never_lowers_or_raises_forecast(self):
        guard = CampaignGuard(self.root)
        guard.before_cell(MATRIX[0])
        guard.finish_cell(dict(seed=1, task="mbpp", method="hone", status="infrastructure_failure", calls=9000))
        guard.before_cell(MATRIX[1])
        self.assertEqual(guard.forecasts["mbpp", "hone"], 3434)

    def test_hard_cap_counts_dispatches_not_old_ledger(self):
        guard = CampaignGuard(self.root, cap=2)
        self.ledger.calls = 16592
        with campaign_scope(guard):
            before_model_call(self.ledger)
            before_model_call(self.ledger)
            with self.assertRaises(CampaignStop) as raised:
                before_model_call(self.ledger)
        self.assertEqual(guard.actual, 2)
        self.assertEqual(raised.exception.receipt["projected"], 3)
        self.assertTrue((self.root / "campaign-journal.jsonl").read_text().count('"event":"stop"') == 1)

    def test_disk_exact_floor_and_rejection(self):
        guard = CampaignGuard(self.root)
        self.assertEqual(guard.check_disk(), 100_000_000_000)
        with patch("pilot.campaign.os.statvfs", return_value=SimpleNamespace(f_bavail=99_999_999_999, f_frsize=1)):
            with self.assertRaises(CampaignStop) as raised:
                guard.before_model_call(self.ledger)
        self.assertEqual(guard.actual, 0)
        self.assertEqual(raised.exception.receipt["disk_observed"], 99_999_999_999)

    def test_hooks_are_scoped_and_restore(self):
        with patch("pilot.campaign.os.statvfs", side_effect=AssertionError("must not inspect disk")):
            check_disk()
            before_model_call(self.ledger)
        guard = CampaignGuard(self.root)
        with campaign_scope(guard):
            before_model_call(self.ledger)
        before_model_call(self.ledger)
        self.assertEqual(guard.actual, 1)

    def test_full_fixed_order_and_no_partial_restart(self):
        guard = CampaignGuard(self.root)
        with self.assertRaises(ValueError):
            guard.before_cell(MATRIX[1])
        for cell in MATRIX:
            guard.before_cell(cell)
            with self.assertRaises(ValueError):
                guard.before_cell(cell)
            seed, task, method = cell
            guard.finish_cell(dict(seed=seed, task=task, method=method, status="completed", calls=1))
        with self.assertRaises(ValueError):
            guard.before_cell(MATRIX[0])


if __name__ == "__main__":
    unittest.main()
