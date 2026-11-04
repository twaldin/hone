import unittest
from unittest.mock import patch

from pilot.run_plan import project


class ProjectionTests(unittest.TestCase):
    def test_first_cap_preserves_polling_and_pause_time_outside_active_budget(self):
        sample = {"usd_equivalent": 2, "tokens": 100, "calls": 10,
                  "active_seconds": 20, "wall_seconds": 50,
                  "throttle_seconds": 30, "pause_seconds": 10}
        with patch("pilot.run_plan.LIMITS", {"usd": 10, "tokens": 1000, "calls": 1000, "active_seconds": 60}):
            result = project(sample)
        self.assertEqual(result["binding_projection"], "active_seconds")
        self.assertEqual(result["tokens"], 300)
        self.assertEqual(result["usd_equivalent"], 6)
        self.assertEqual(result["active_hours"], 60 / 3600)
        self.assertEqual(result["usage_polling_hours"], 60 / 3600)
        self.assertEqual(result["observed_pause_hours"], 30 / 3600)
        self.assertEqual(result["wall_hours"], 150 / 3600)

    def test_dollars_bind_before_active_time_and_zero_samples_cannot_look_free(self):
        sample = {"usd_equivalent": 5, "tokens": 100, "calls": 10,
                  "active_seconds": 10, "wall_seconds": 15, "throttle_seconds": 5}
        with patch("pilot.run_plan.LIMITS", {"usd": 10, "tokens": 1000, "calls": 1000, "active_seconds": 60}):
            result = project(sample)
            self.assertEqual(result["binding_projection"], "usd")
            self.assertEqual(result["tokens"], 200)
            self.assertEqual(result["usd_equivalent"], 10)
            with self.assertRaises(ValueError):
                project(dict(sample, usd_equivalent=0))
