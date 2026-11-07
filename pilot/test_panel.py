import copy
import json
import math
import os
import statistics
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from pilot import __main__ as cli
from pilot.admission import text_admission
from pilot.controls import (CONTROL_SEED, NEGATIVE_PROBE, PREVIOUS_MBPP_ROWS, SHORTCUT_CODE, artifacts,
                            representative_rows)
from pilot.panel import OFFICIAL_PANEL, FALLBACK_PANEL, panel_tasks, reuse_control, validate_measurement
from pilot.runtime import IMAGE
from pilot.tasks import Task
from pilot.test_adversarial import grader_failure
from pilot.verification import GraderInfrastructureError, grader_journal


def fixture_score(task, row, output):
    if row["id"].startswith("adversarial:"):
        return float(output == "heliotropeproofword")
    return float(output) if output in ("0", "1") else 0.0


def negative_receipt(row, output, arm):
    with grader_journal(stage=NEGATIVE_PROBE, arm=arm):
        return grader_failure(row, output).receipt


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
        self.infrastructure, self.replayed = set(), {}
        self.start_patch(patch("pilot.tasks.score_output", side_effect=self.score))
        self.start_patch(patch("pilot.adversarial.score_output", side_effect=self.score))
        self.start_patch(patch.dict("pilot.tasks._METRICS", {id(self.task.manifest): lambda row, pred:
            SimpleNamespace(score=float(pred.response == "heliotropeproofword"), feedback="checked")}))
        self.proof = text_admission(self.task, self.original, self.rows)
        self.build()

    def score(self, task, row, output):
        if output in self.infrastructure:
            raise grader_failure(row, output)
        return self.replayed.get(output, fixture_score(task, row, output))

    def build(self):
        count = len(self.rows)
        mbpp = self.task.name == "mbpp"
        self.control = {"task": self.task.name, "identity": self.original, "rows": self.ids,
                        "adversarial_hash": cli.digest(self.proof), "artifacts": artifacts(self.task),
                        "noise_design": {"paired_trials": 16, "rows_per_arm": count, "model_calls_cached": False,
                                         "draw_seed": CONTROL_SEED if mbpp else 20261106,
                                         "excluded_prior_mbpp_rows": sorted(PREVIOUS_MBPP_ROWS) if mbpp else [],
                                         "seed_artifact_hash": cli.digest(self.task.seed_candidate), "cohort_hash": cli.digest(self.ids)}}
        self.declaration = copy.deepcopy(self.control)
        self.evaluations = []
        self.control["controls"] = {}
        for name, positives in (("known-improved", count - 2), ("naive", count - 8), ("broken", 0), ("shortcut", 0)):
            outputs = ["1"] * positives + ["0"] * (count - positives)
            scores = [float(value) for value in outputs]
            self.control["controls"][name] = {"scores": scores, "outputs": outputs, "mean": positives / count}
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
            "admittedCapsuleDigest": identity_hash, "executionImage": self.original["image"],
            "assetGroupId": "development-calibration", "measurementEpoch": identity_hash,
            "sourceCohortSha256": [cli.digest({"identity": self.original, "rows": self.ids,
                                              "seed": self.task.seed_candidate, "pair": pair}) for pair in self.pairs],
            "maxObservedPairDelta": 0.0, "noiseFloor": 0.0, "noiseEnvelope": 0.0,
            "informationFreePairs": 16, "informationFreePositive": 0,
            "estimator": "direct-local-paired-delta-sd-v1", "pairedDeltaTrials": 16,
            "pairedDeltaDegreesOfFreedom": 15, "pairedDeltaSd": 0.0,
            "localArmBaselineHash": cli.digest(self.task.seed_candidate)})
        self.seal_fixture()

    def use_mbpp(self):
        self.task = Task("mbpp", [{"id": f"mbpp:train:{index}", "input": f"Implement {index}.",
                                   "reference_code": "def target(value): return value + 1", "test_setup_code": "",
                                   "test_list": ["assert target(1) == 2"]} for index in range(100, 140)], [],
                         {"task": "mbpp", "source": "frozen"}, {"prompt": "seed", "program": "seed"})
        self.rows = representative_rows(self.task)
        self.ids = [row["id"] for row in self.rows]
        self.original.update(task=self.task.manifest, image=os.environ.get("PILOT_PYTHON_IMAGE", IMAGE))
        self.proof = {"fixture": "receipted MBPP adversarial proof"}
        self.build()

    def shortcut(self, unscored):
        outputs = [SHORTCUT_CODE] * len(self.rows)
        scores = [None if unscored else 0.0] * len(self.rows)
        summary = {"scores": scores, "outputs": outputs, "mean": None if unscored else 0.0}
        record = next(record for record in self.evaluations if record["control"] == "shortcut")
        record.update(outputs=outputs, scores=scores)
        if unscored:
            summary["unscored_receipts"] = record["unscored_receipts"] = {
                row["id"]: negative_receipt(row, SHORTCUT_CODE, "shortcut") for row in self.rows}
        self.control["controls"]["shortcut"] = summary
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

    def test_refusal_counts_bind_empty_zero_rows_to_metered_arms(self):
        self.original["contract"] = 8
        self.control["adversarial_hash"] = cli.digest(self.proof)
        self.declaration["identity"] = self.original
        self.declaration["adversarial_hash"] = self.control["adversarial_hash"]
        self.declaration.update(refusals=0, refusals_by_row={}, refusals_by_arm={})
        row_id = self.ids[-1]
        outputs, scores = ["1"] * 39 + [""], [1.0] * 39 + [0.0]
        self.control.update(controls={"naive": {"outputs": outputs, "scores": scores, "mean": .975,
                                               "refusals": 1, "refusals_by_row": {row_id: 1}}},
                            ranking_passed=None, noise_passed=None, refusals=1,
                            refusals_by_row={row_id: 1}, refusals_by_arm={"naive": 1})
        self.evaluations = [{"control": "naive", "row_ids": self.ids, "outputs": outputs,
                             "scores": scores, "refusals": [row_id]}]
        self.seal_fixture()
        cli.save(self.local / "calls.jsonl", {"outcome": "refusal", "row_id": row_id,
                                            "context": {"arm": "naive"}})
        cli.seal(self.local)
        cli.seal(self.local.parent)
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof,
                                              allow_failure=True), "headroom")
        self.control["refusals_by_row"][row_id] = 2
        cli.save(self.local / "controls.json", self.control)
        cli.seal(self.local)
        cli.seal(self.local.parent)
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof, allow_failure=True)

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

    def test_mbpp_unscored_negative_rows_are_rejected_without_a_task_mean(self):
        self.use_mbpp()
        self.shortcut(unscored=True)
        retained = (self.local / "evaluations.jsonl").read_bytes()
        for infrastructure in (set(), {SHORTCUT_CODE}):
            with self.subTest(current="infrastructure" if infrastructure else "scored zero"):
                self.infrastructure = infrastructure
                self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof), "passed")
        self.assertEqual((self.local / "evaluations.jsonl").read_bytes(), retained)
        self.infrastructure, self.replayed = set(), {SHORTCUT_CODE: 1.0}
        with self.assertRaises(ValueError):
            validate_measurement(self.local, self.task, self.original, self.proof)

    def test_retained_mbpp_zero_replayed_as_infrastructure_is_not_rewritten(self):
        self.use_mbpp()
        self.shortcut(unscored=False)
        retained = (self.local / "evaluations.jsonl").read_bytes()
        self.infrastructure = {SHORTCUT_CODE}
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof), "passed")
        self.assertEqual((self.local / "evaluations.jsonl").read_bytes(), retained)

    def test_mbpp_unscored_rows_need_bound_negative_receipts_and_no_imputed_mean(self):
        receipts = lambda: self.control["controls"]["shortcut"]["unscored_receipts"]
        def positive_arm():
            naive = self.control["controls"]["naive"]
            record = next(record for record in self.evaluations if record["control"] == "naive")
            scores = [None, *naive["scores"][1:]]
            unscored = {self.ids[0]: negative_receipt(self.rows[0], naive["outputs"][0], "naive")}
            naive.update(scores=scores, mean=None, unscored_receipts=unscored)
            record.update(scores=scores, unscored_receipts=unscored)
        defects = {
            "imputed-mean": lambda: self.control["controls"]["shortcut"].update(mean=0.0),
            "other-row": lambda: receipts().update({self.ids[0]: negative_receipt(self.rows[1], SHORTCUT_CODE, "shortcut")}),
            "outside-negative-probe": lambda: receipts().update({self.ids[0]: grader_failure(self.rows[0], SHORTCUT_CODE).receipt}),
            "other-arm": lambda: receipts().update({self.ids[0]: negative_receipt(self.rows[0], SHORTCUT_CODE, "broken")}),
            "missing": lambda: receipts().pop(self.ids[0]),
            "positive-arm": positive_arm,
        }
        for name, defect in defects.items():
            with self.subTest(defect=name):
                self.use_mbpp()
                self.shortcut(unscored=True)
                defect()
                self.seal_fixture()
                with self.assertRaises(ValueError):
                    validate_measurement(self.local, self.task, self.original, self.proof)

    def test_mbpp_positive_or_noise_replay_infrastructure_aborts_validation(self):
        self.use_mbpp()
        self.shortcut(unscored=True)
        noise = next(record for record in self.evaluations if record.get("trial") == 3 and record["arm"] == "second")
        noise["outputs"] = ["noise" if score else "0" for score in noise["scores"]]
        self.replayed = {"noise": 1.0}
        self.seal_fixture()
        self.assertEqual(validate_measurement(self.local, self.task, self.original, self.proof), "passed")
        for output in ("1", "noise"):
            with self.subTest(output=output):
                self.infrastructure = {output}
                with self.assertRaises(GraderInfrastructureError):
                    validate_measurement(self.local, self.task, self.original, self.proof)


if __name__ == "__main__":
    unittest.main()
