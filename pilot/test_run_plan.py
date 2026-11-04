import hashlib
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

    def test_estimated_refusals_bind_caps_without_becoming_reported_projection(self):
        sample = {"usd_equivalent": 5, "tokens": 100, "reported_tokens": 20, "estimated_tokens": 80,
                  "reported_usd_equivalent": 1, "estimated_usd_equivalent": 4, "refusals": 2,
                  "calls": 10, "active_seconds": 10, "wall_seconds": 15, "throttle_seconds": 5}
        for limits, binding, scale in (({"usd": 10, "tokens": 1000, "calls": 1000, "active_seconds": 60}, "usd", 2),
                                       ({"usd": 100, "tokens": 150, "calls": 1000, "active_seconds": 60}, "tokens", 1.5)):
            with self.subTest(binding=binding), patch("pilot.run_plan.LIMITS", limits):
                result = project(sample)
                self.assertEqual(result["binding_projection"], binding)
                self.assertEqual(result["charged_tokens"], 100 * scale)
                self.assertEqual(result["reported_tokens"], 20 * scale)
                self.assertEqual(result["estimated_tokens"], 80 * scale)
                self.assertEqual(result["reported_usd_equivalent"], scale)
                self.assertEqual(result["estimated_usd_equivalent"], 4 * scale)
                self.assertEqual(result["refusals"], 2 * scale)
                self.assertIn("assumption", result)
        for field, value in (("reported_tokens", 21), ("estimated_tokens", -1),
                             ("reported_usd_equivalent", 2), ("usd_equivalent", float("nan"))):
            with self.subTest(field=field), self.assertRaises(ValueError):
                project(dict(sample, **{field: value}))

    def current_controls(self, directory, *, failure=None, pairs=16, admitted=True):
        from pilot.__main__ import seal
        controls = Path(directory) / "controls"
        local = controls / "ifbench"
        local.mkdir(parents=True)
        declaration_hash = "sha256:" + hashlib.sha256(
            (ROOT / "evidence/pilot/predeclaration-8.md").read_bytes()).hexdigest()
        identity = {"contract": 8, "predeclaration_hash": declaration_hash}
        if failure is not None:
            (local / "failure.json").write_text(json.dumps({"status": failure}))
        else:
            (controls / "panel.json").write_text(json.dumps({
                "version": 8, "all_admitted": True,
                "tasks": ["mbpp", "ifbench", "hover"] if admitted else ["mbpp", "hover"],
                "ifbench_status": "passed" if admitted else "failed-gate",
                "predeclaration_hash": declaration_hash}))
            if not admitted:
                (local / "failure.json").write_text(json.dumps({"status": "admission-failed", "gate": "noise"}))
        (local / "controls.json").write_text(json.dumps({
            "identity": identity, "controls": {name: {"mean": mean} for name, mean in
                (("naive", .4), ("known-improved", .8), ("broken", 0), ("shortcut", .1))},
            "rows": list(range(40)), "calibration": {"pairedDeltaTrials": pairs},
            "noise_design": {"paired_trials": 16},
            "ranking_passed": True, "noise_passed": admitted}))
        (local / "noise-pairs.json").write_text(json.dumps([{"trial": trial} for trial in range(pairs)]))
        (local / "usage.json").write_text(json.dumps({
            "tokens": 100, "reported_tokens": 20, "estimated_tokens": 80, "usd_equivalent": 5,
            "reported_usd_equivalent": 1, "estimated_usd_equivalent": 4, "refusals": 2,
            "refusals_by_row": {"row": 2}, "refusals_by_arm": {"naive": 2},
            "calls": 10, "active_seconds": 10, "wall_seconds": 15, "throttle_seconds": 5}))
        seal(controls)
        return controls

    def test_current_complete_and_failed_gate_measurements_preserve_charged_usage(self):
        for admitted in (True, False):
            with self.subTest(admitted=admitted), tempfile.TemporaryDirectory(prefix=".pilot-plan-test-", dir=ROOT) as directory:
                controls = self.current_controls(directory, admitted=admitted)
                result = build(controls)
                self.assertEqual(result["schema"], "pilot-measured-run-plan-v8")
                self.assertEqual(result["plans"]["three_task"]["admitted"], admitted)
                self.assertTrue(result["plans"]["three_task"]["projection_available"])
                self.assertTrue(result["plans"]["two_task_fallback"]["admitted"])
                self.assertEqual(result["calibrations"]["ifbench"]["usage"]["reported_tokens"], 20)
                self.assertGreater(result["plans"]["three_task"]["projection"]["estimated_tokens"], 0)
                self.assertIn(str(controls.relative_to(ROOT)), result["next_lane_command_not_authorized"])
                self.assertFalse(any(plan["authorized"] for plan in result["plans"].values()))

    def test_partial_noise_and_terminal_stops_never_supply_a_full_calibration(self):
        for failure in (None, "infrastructure-failure", "refusal-nondeterminism"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix=".pilot-plan-test-", dir=ROOT) as directory:
                controls = self.current_controls(directory, failure=failure, pairs=3 if failure is None else 16, admitted=False)
                result = build(controls)
                self.assertFalse(result["plans"]["three_task"]["projection_available"])
                self.assertIsNone(result["plans"]["three_task"]["projection"])
                self.assertFalse(result["incomplete_ifbench_calibration"]["usable_for_projection"])
                if failure is not None:
                    self.assertFalse(result["plans"]["two_task_fallback"]["admitted"])
                    self.assertIn(failure, result["incomplete_ifbench_calibration"]["status"])

    def test_current_panel_requires_the_frozen_predeclaration(self):
        from pilot.__main__ import seal
        with tempfile.TemporaryDirectory(prefix=".pilot-plan-test-", dir=ROOT) as directory:
            controls = self.current_controls(directory)
            panel = json.loads((controls / "panel.json").read_text())
            panel["predeclaration_hash"] = "sha256:wrong"
            (controls / "panel.json").write_text(json.dumps(panel))
            seal(controls)
            with self.assertRaises(ValueError):
                build(controls)

    def test_historical_abort_preserves_every_available_forecast(self):
        retained = json.loads((ROOT / "evidence/pilot/run-plan-6.json").read_text())
        current = build(ROOT / "evidence/pilot/controls-6")
        for key, value in retained["plans"]["two_task_fallback"]["projection"].items():
            self.assertEqual(current["plans"]["two_task_fallback"]["projection"][key], value)
        for method, smoke in retained["smokes"].items():
            for key, value in smoke["projection"].items():
                self.assertEqual(current["smokes"][method]["projection"][key], value)
