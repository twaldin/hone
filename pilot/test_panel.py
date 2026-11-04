import copy
import json
import math
import statistics
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pilot import __main__ as cli
from pilot.admission import text_admission
from pilot.controls import artifacts, representative_rows
from pilot.panel import OFFICIAL_PANEL, FALLBACK_PANEL, panel_tasks, reuse_control, validate_measurement
from pilot.tasks import Task


def fixture_score(task, row, output):
    if row["id"].startswith("adversarial:"):
        return float(output == "heliotropeproofword")
    return float(output) if output in ("0", "1") else 0.0


class PanelTests(unittest.TestCase):
    def test_only_measured_ifbench_outcomes_choose_a_panel(self):
        self.assertEqual(panel_tasks("passed"), OFFICIAL_PANEL)
        self.assertEqual(panel_tasks("failed-gate"), FALLBACK_PANEL)
        for status in ("infrastructure_failure", "missing", "", "failed", None):
            with self.subTest(status=status), self.assertRaises(ValueError):
                panel_tasks(status)
        self.assertNotIn("aime", OFFICIAL_PANEL + FALLBACK_PANEL)

    def test_invalid_ifbench_and_withdrawn_tasks_cannot_be_reused(self):
        for name in ("aime", "ifbench"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                reuse_control(Task(name, [], [], {}, {}))

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "pilot").mkdir()
        for name in ("__main__.py", "tasks.py"):
            (self.root / "pilot" / name).write_text("original\n")
        declarations = self.root / "evidence/pilot"
        declarations.mkdir(parents=True)
        for name in ("predeclaration-4.md", "predeclaration-4a.md"):
            (declarations / name).write_text(name)
        self.local = declarations / "controls-4a/ifbench"
        self.local.mkdir(parents=True)
        self.task = Task("ifbench", [{"id": f"row:{i}"} for i in range(40)], [],
                         {"task": "ifbench", "source": "frozen"}, {"prompt": "seed", "revision_prompt": "revise"})
        self.rows = representative_rows(self.task)
        self.ids = [row["id"] for row in self.rows]
        self.original = {"contract": 4, "task": self.task.manifest, "route": {"model": "frozen"},
                         "image": "sealed-image", "decoding": {"temperature": 0},
                         "evaluator_files": {"pilot/" + name: cli.file_hash(self.root / "pilot" / name)
                                             for name in ("__main__.py", "tasks.py")},
                         "predeclaration_hash": cli.file_hash(declarations / "predeclaration-4.md"),
                         "transport_correction_hash": cli.file_hash(declarations / "predeclaration-4a.md")}
        self.current = copy.deepcopy(self.original)
        self.current["contract"] = 5
        self.current["prior_predeclaration_hash"] = self.original["predeclaration_hash"]
        (self.root / "pilot/__main__.py").write_text("orchestration changed\n")
        self.current["evaluator_files"]["pilot/__main__.py"] = cli.file_hash(self.root / "pilot/__main__.py")
        self.start_patch(patch.object(cli, "ROOT", self.root))
        self.start_patch(patch.object(cli, "evaluator_identity", side_effect=lambda task: self.current))
        self.start_patch(patch("pilot.tasks.score_output", side_effect=fixture_score))
        self.start_patch(patch("pilot.adversarial.score_output", side_effect=fixture_score))
        self.start_patch(patch.dict("pilot.tasks._METRICS", {id(self.task.manifest): lambda row, pred:
            SimpleNamespace(score=float(pred.response == "heliotropeproofword"), feedback="checked")}))
        self.proof = text_admission(self.task, self.original, self.rows)
        self.control = {"task": "ifbench", "identity": self.original, "rows": self.ids,
                        "adversarial_hash": cli.digest(self.proof), "artifacts": artifacts(self.task),
                        "noise_design": {"paired_trials": 16, "rows_per_arm": 40, "model_calls_cached": False,
                                         "draw_seed": 20261106, "excluded_prior_mbpp_rows": [],
                                         "seed_artifact_hash": cli.digest(self.task.seed_candidate), "cohort_hash": cli.digest(self.ids)}}
        self.declaration = copy.deepcopy(self.control)
        self.evaluations = []
        self.control["controls"] = {}
        for name, positives in (("known-improved", 38), ("naive", 32), ("broken", 0), ("shortcut", 0)):
            outputs = ["1"] * positives + ["0"] * (40 - positives)
            scores = [float(value) for value in outputs]
            self.control["controls"][name] = {"scores": scores, "outputs": outputs, "mean": positives / 40}
            self.evaluations.append({"control": name, "row_ids": self.ids, "outputs": outputs, "scores": scores})
        self.pairs = []
        for trial in range(16):
            scores = self.control["controls"]["naive"]["scores"]
            self.pairs.append({"trial": trial, "first": scores, "second": scores, "delta": 0.0})
            for arm in ("first", "second"):
                self.evaluations.append({"control": "unchanged", "trial": trial, "arm": arm,
                                         "row_ids": self.ids, "outputs": [str(int(x)) for x in scores], "scores": scores})
        identity_hash = cli.digest(self.original)
        self.control.update(ranking_passed=True, noise_passed=True, calibration={
            "gateVersion": "noise-envelope-v3", "evidenceVersion": "pilot-direct-paired-v1",
            "capsuleId": "cap_" + identity_hash.removeprefix("sha256:")[:12],
            "admittedCapsuleDigest": identity_hash, "executionImage": "sealed-image",
            "assetGroupId": "development-calibration", "measurementEpoch": identity_hash,
            "sourceCohortSha256": [cli.digest({"identity": self.original, "rows": self.ids,
                                              "seed": self.task.seed_candidate, "pair": pair}) for pair in self.pairs],
            "maxObservedPairDelta": 0.0, "noiseFloor": 0.0, "noiseEnvelope": 0.0,
            "informationFreePairs": 16, "informationFreePositive": 0,
            "estimator": "direct-local-paired-delta-sd-v1", "pairedDeltaTrials": 16,
            "pairedDeltaDegreesOfFreedom": 15, "pairedDeltaSd": 0.0,
            "localArmBaselineHash": cli.digest(self.task.seed_candidate)})
        self.seal_fixture()

    def start_patch(self, patcher):
        patcher.start()
        self.addCleanup(patcher.stop)

    def seal_fixture(self):
        for name, value in (("controls.json", self.control), ("admission.json", self.proof),
                            ("controls-declaration.json", self.declaration), ("noise-pairs.json", self.pairs),
                            ("manifest.json", {"identity": self.original}), ("usage.json", {})):
            cli.save(self.local / name, value)
        (self.local / "calls.jsonl").write_text("")
        (self.local / "evaluations.jsonl").write_text("".join(json.dumps(value) + "\n" for value in self.evaluations))
        cli.seal(self.local)
        cli.seal(self.local.parent)

    def test_current_ifbench_validates_raw_measurements(self):
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof), "passed")

    def test_headroom_failure_requires_complete_naive_measurement(self):
        naive = {"scores": [1.0] * 40, "outputs": ["1"] * 40, "mean": 1.0}
        self.control.update(controls={"naive": naive}, ranking_passed=None, noise_passed=None)
        self.evaluations = [{"control": "naive", "row_ids": self.ids, **{key: naive[key] for key in ("scores", "outputs")}}]
        self.seal_fixture()
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof, allow_failure=True), "headroom")
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof)
        self.evaluations[0]["outputs"].pop()
        self.seal_fixture()
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof, allow_failure=True)

    def test_ranking_failure_is_measured_not_a_flag(self):
        self.control["controls"]["known-improved"] = copy.deepcopy(self.control["controls"]["naive"])
        self.control["ranking_passed"] = False
        self.evaluations = [record for record in self.evaluations if record["control"] != "unchanged"]
        for record in self.evaluations:
            if record["control"] == "known-improved":
                record.update({key: self.control["controls"]["known-improved"][key] for key in ("scores", "outputs")})
        self.seal_fixture()
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof, allow_failure=True), "ranking")
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof)

    def test_noise_failure_requires_the_original_envelope_arithmetic(self):
        self.pairs = []
        self.evaluations = [record for record in self.evaluations if record["control"] != "unchanged"]
        for trial in range(16):
            first = [float(trial % 2)] * 40
            second = [1.0 - first[0]] * 40
            self.pairs.append({"trial": trial, "first": first, "second": second, "delta": second[0] - first[0]})
            for arm, scores in (("first", first), ("second", second)):
                self.evaluations.append({"control": "unchanged", "trial": trial, "arm": arm,
                                         "row_ids": self.ids, "scores": scores, "outputs": [str(int(value)) for value in scores]})
        sd = statistics.stdev(pair["delta"] for pair in self.pairs)
        calibration = self.control["calibration"]
        calibration.update(noiseFloor=3 / math.sqrt(2) * sd, noiseEnvelope=4.5 / math.sqrt(2) * sd,
                           pairedDeltaSd=sd, maxObservedPairDelta=1.0, informationFreePositive=8,
                           sourceCohortSha256=[cli.digest({"identity": self.original, "rows": self.ids,
                              "seed": self.task.seed_candidate, "pair": pair}) for pair in self.pairs])
        self.control["noise_passed"] = False
        self.seal_fixture()
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof, allow_failure=True), "noise")
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof)
        calibration["noiseEnvelope"] = 0.0
        self.seal_fixture()
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof, allow_failure=True)

    def test_changed_current_identity_or_cohort_is_rejected(self):
        changed = copy.deepcopy(self.original)
        changed["route"] = "changed-model"
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, changed, self.proof)
        self.task.train[0]["id"] = "changed-row"
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof)

    def test_sealed_forged_measurements_cannot_pass_by_flags(self):
        for defect in ("noise", "contrast", "score", "proof", "calibration"):
            with self.subTest(defect=defect):
                before = copy.deepcopy((self.control, self.pairs, self.proof))
                if defect == "noise":
                    self.pairs[0]["delta"] = 0.5
                elif defect == "contrast":
                    self.control["controls"]["known-improved"]["mean"] = 0.8
                elif defect == "score":
                    self.control["controls"]["naive"]["scores"][0] = 0.0
                elif defect == "proof":
                    self.proof["checks"]["records"][0]["scores"] = [1.0]
                    self.control["adversarial_hash"] = cli.digest(self.proof)
                else:
                    self.control["calibration"]["noiseEnvelope"] = 0.1
                self.seal_fixture()
                with self.assertRaises(ValueError):
                    validate_measurement(self.local, self.task, self.original, self.proof)
                self.control, self.pairs, self.proof = before
                self.seal_fixture()


if __name__ == "__main__":
    unittest.main()
