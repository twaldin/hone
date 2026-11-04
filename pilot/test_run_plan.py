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
                  "usage_missing_calls": 2, "unbounded_missing_usage_calls": 0,
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
                self.assertEqual(result["usage_accounting"], "reported-plus-estimated-charges")
                self.assertEqual(result["unbounded_missing_usage_calls"], 0)
                self.assertIn("assumption", result)
        for field, value in (("reported_tokens", 21), ("estimated_tokens", -1),
                             ("reported_usd_equivalent", 2), ("usd_equivalent", float("nan"))):
            with self.subTest(field=field), self.assertRaises(ValueError):
                project(dict(sample, **{field: value}))

    def test_unknown_transport_is_not_bounded_by_another_calls_refusal_estimate(self):
        sample = {"usd_equivalent": 5, "tokens": 100, "reported_tokens": 20, "estimated_tokens": 80,
                  "reported_usd_equivalent": 1, "estimated_usd_equivalent": 4, "refusals": 1,
                  "usage_missing_calls": 2, "unbounded_missing_usage_calls": 1,
                  "calls": 10, "active_seconds": 10, "wall_seconds": 15, "throttle_seconds": 5}
        with patch("pilot.run_plan.LIMITS", {"usd": 10, "tokens": 1000, "calls": 1000, "active_seconds": 60}):
            result = project(sample)
        self.assertEqual(result["charged_tokens"], 200)
        self.assertEqual(result["reported_tokens"], 40)
        self.assertEqual(result["estimated_tokens"], 160)
        self.assertEqual(result["usage_missing_calls"], 4)
        self.assertEqual(result["unbounded_missing_usage_calls"], 2)
        self.assertEqual(result["usage_accounting"], "conditional-known-charge-lower-bound")
        self.assertIn("unbounded", result["usage_limit"])

    def test_missing_usage_without_receipt_classification_cannot_borrow_an_estimate(self):
        sample = {"usd_equivalent": 5, "tokens": 100, "reported_tokens": 20, "estimated_tokens": 80,
                  "reported_usd_equivalent": 1, "estimated_usd_equivalent": 4,
                  "usage_missing_calls": 1, "calls": 10, "active_seconds": 10,
                  "wall_seconds": 15, "throttle_seconds": 5}
        with self.assertRaises(ValueError):
            project(sample)

    def current_controls(self, directory, *, failure=None, pairs=16, admitted=True,
                         missing_transport=False, estimated_refusals=True):
        from pilot.__main__ import seal
        controls = Path(directory) / "controls"
        local = controls / "ifbench"
        local.mkdir(parents=True)
        declaration_hash = "sha256:" + hashlib.sha256(
            (ROOT / "evidence/pilot/predeclaration-8.md").read_bytes()).hexdigest()
        identity = {"contract": 8, "predeclaration_hash": declaration_hash}
        (local / "manifest.json").write_text(json.dumps({"identity": identity}))
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
        usage_path = local / "usage.json"
        usage = json.loads(usage_path.read_text())
        calls = [{"call": number, "usage_missing": number <= 2,
                  "outcome": "refusal" if number <= 2 else "answered", "status": 502 if number <= 2 else 200}
                 for number in range(1, 11)]
        if not estimated_refusals:
            usage.update(reported_tokens=100, estimated_tokens=0,
                         reported_usd_equivalent=5, estimated_usd_equivalent=0, refusals=0,
                         refusals_by_row={}, refusals_by_arm={})
            for call in calls:
                call.update(usage_missing=False, outcome="answered", status=200)
        if missing_transport:
            calls[-1].update(usage_missing=True, status=502)
            calls[-1].pop("outcome")
        usage["usage_missing_calls"] = sum(call["usage_missing"] for call in calls)
        usage_path.write_text(json.dumps(usage))
        (local / "calls.jsonl").write_text("".join(json.dumps(call) + "\n" for call in calls))
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

    def test_calibration_discloses_unknown_transport_separately_from_estimated_refusals(self):
        for estimated_refusals in (True, False):
            with self.subTest(estimated_refusals=estimated_refusals), tempfile.TemporaryDirectory(
                    prefix=".pilot-plan-test-", dir=ROOT) as directory:
                controls = self.current_controls(
                    directory, missing_transport=True, estimated_refusals=estimated_refusals)
                result = build(controls)
                calibration = result["calibrations"]["ifbench"]
                self.assertEqual(calibration["usage"]["unbounded_missing_usage_calls"], 1)
                self.assertEqual(calibration["usage"]["usage_missing_calls"], 3 if estimated_refusals else 1)
                projection = calibration["projection"]
                self.assertEqual(projection["usage_accounting"], "conditional-known-charge-lower-bound")
                self.assertGreater(projection["unbounded_missing_usage_calls"], 0)
                self.assertEqual(projection["estimated_tokens"] > 0, estimated_refusals)
                calls = controls / "ifbench/calls.jsonl"
                self.assertEqual(result["input_hashes"][str(calls.relative_to(ROOT))],
                                 "sha256:" + hashlib.sha256(calls.read_bytes()).hexdigest())
                matrix = result["plans"]["three_task"]
                self.assertTrue(matrix["projection_available"])
                self.assertFalse(matrix["authorized"])
                self.assertEqual(matrix["projection"]["usage_accounting"], "conditional-known-charge-lower-bound")
                self.assertAlmostEqual(matrix["projection"]["unbounded_missing_usage_calls"],
                                       projection["unbounded_missing_usage_calls"] * 9)

    def test_current_setup_is_added_once_for_current_panels_and_terminal_manifests(self):
        setup_path = ROOT / "evidence/pilot/setup-overhead-8.json"
        setup = json.loads(setup_path.read_text())
        setup_hours = (setup["cold_mbpp_load_seconds"]
                       + setup["revalidations_per_matrix"] * setup["warm_mbpp_revalidation_seconds"]) / 3600
        for failure in (None, "infrastructure-failure"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(
                    prefix=".pilot-plan-test-", dir=ROOT) as directory:
                controls = self.current_controls(directory, failure=failure)
                result = build(controls)
                self.assertEqual(result["measured_setup"], setup)
                self.assertEqual(result["input_hashes"][str(setup_path.relative_to(ROOT))],
                                 "sha256:" + hashlib.sha256(setup_path.read_bytes()).hexdigest())
                self.assertNotIn("evidence/pilot/setup-overhead-6.json", result["input_hashes"])
                for plan in result["plans"].values():
                    if plan["projection_available"]:
                        projection = plan["projection"]
                        self.assertEqual(projection["retained_admission_setup_hours"], setup_hours)
                        self.assertEqual(projection["total_wall_hours_including_measured_setup"],
                                         projection["wall_hours"] + setup_hours)

    def test_historical_abort_preserves_every_available_forecast(self):
        retained = json.loads((ROOT / "evidence/pilot/run-plan-6.json").read_text())
        current = build(ROOT / "evidence/pilot/controls-6")
        for key, value in retained["plans"]["two_task_fallback"]["projection"].items():
            self.assertEqual(current["plans"]["two_task_fallback"]["projection"][key], value)
        for method, smoke in retained["smokes"].items():
            for key, value in smoke["projection"].items():
                self.assertEqual(current["smokes"][method]["projection"][key], value)
