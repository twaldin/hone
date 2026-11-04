import unittest
import json
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

from pilot.run_plan import build, project
from pilot.runtime import ROOT


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

    def test_infrastructure_abort_cannot_create_a_fallback_or_a_full_matrix_estimate(self):
        result = build(ROOT / "evidence/pilot/controls-6")
        self.assertEqual(result["admission_status"], "infrastructure-aborted-no-panel-no-fallback")
        self.assertIsNone(result["selected_panel"])
        self.assertFalse(result["incomplete_ifbench_calibration"]["usable_for_projection"])
        self.assertIsNone(result["plans"]["three_task"]["projection"])
        fallback = result["plans"]["two_task_fallback"]
        self.assertTrue(fallback["projection_available"])
        self.assertFalse(fallback["admitted"])
        self.assertFalse(fallback["authorized"])
        self.assertGreater(fallback["projection"]["total_wall_hours_including_measured_setup"],
                           fallback["projection"]["wall_hours"])

    def test_unsealed_panel_cannot_override_a_sealed_infrastructure_abort(self):
        with tempfile.TemporaryDirectory(prefix=".pilot-plan-test-", dir=ROOT) as directory:
            controls = Path(directory) / "controls"
            shutil.copytree(ROOT / "evidence/pilot/controls-6", controls)
            (controls / "panel.json").write_text(json.dumps({
                "version": 6, "all_admitted": True, "tasks": ["mbpp", "hover"], "ifbench_status": "failed-gate"}))
            with self.assertRaises(ValueError):
                build(controls)

    def test_infrastructure_abort_after_partial_controls_never_supplies_a_calibration(self):
        from pilot.__main__ import seal
        with tempfile.TemporaryDirectory(prefix=".pilot-plan-test-", dir=ROOT) as directory:
            controls = Path(directory) / "controls"
            shutil.copytree(ROOT / "evidence/pilot/controls-6", controls)
            (controls / "ifbench/controls.json").write_text(json.dumps({
                "controls": {"naive": {"mean": 0.8}}, "rows": list(range(40))}))
            seal(controls)
            result = build(controls)
            self.assertIsNone(result["plans"]["three_task"]["projection"])
            self.assertFalse(result["incomplete_ifbench_calibration"]["usable_for_projection"])
