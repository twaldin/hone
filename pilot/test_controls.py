import json
import random
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from pilot.admission import text_admission
from pilot.controls import (CONTROL_SEED, NEGATIVE_PROBE, P_CONTROL_ROWS, PREVIOUS_MBPP_ROWS, SHORTCUT_CODE,
                            ControlsFailed, measure, representative_rows)
from pilot.runtime import current_call_scope
from pilot.tasks import Task
from pilot.test_adversarial import admission_fixture, fixture_tasks, grader_failure
from pilot.verification import GraderInfrastructureError
from pilot import adversarial, tasks


class MbppControlTests(unittest.TestCase):
    def setUp(self):
        rows = [{"id": f"mbpp:train:{index}", "input": f"Implement {index}.\ndef target(value):",
                 "reference_code": "def target(value): return value + 1", "test_setup_code": "",
                 "test_list": ["assert target(1) == 2"]} for index in range(100, 140)]
        self.task = Task("mbpp", rows, [], {"task": "mbpp"}, {"prompt": "answer", "program": "seed"})
        self.proof = admission_fixture([self.task, *fixture_tasks()[1:]])
        self.identity = self.proof["identities"]["mbpp"]
        self.rows = representative_rows(self.task)
        self.fails = lambda row, output: output == SHORTCUT_CODE
        self.failure = grader_failure
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.out = Path(self.directory.name)
        self.enterContext(patch("pilot.tasks.run_program", side_effect=self.program))
        self.enterContext(patch("pilot.tasks.score_output", side_effect=self.score))
        self.enterContext(patch("pilot.controls.score_output", side_effect=self.score))

    def program(self, candidate, text, call):
        if "AlwaysEqual" in candidate["program"]:
            return SHORTCUT_CODE, []
        return ("good" if int(text.split()[1].rstrip(".")) % 2 else "bad"), []

    def score(self, task, row, output):
        if self.fails(row, output):
            raise self.failure(row, output)
        return float(output in ("good", row["reference_code"]))

    def measure(self):
        return measure(self.task, lambda *args: self.fail("model call"), self.out, self.identity,
                       rows=self.rows, adversarial=self.proof)

    def evaluations(self):
        path = self.out / "evaluations.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_receipted_shortcut_infrastructure_is_rejected_unscored_without_a_task_mean(self):
        result = self.measure()
        ids = [row["id"] for row in self.rows]
        shortcut = result["controls"]["shortcut"]
        self.assertEqual(shortcut["scores"], [None] * len(ids))
        self.assertEqual(shortcut["outputs"], [SHORTCUT_CODE] * len(ids))
        self.assertIsNone(shortcut["mean"])
        self.assertEqual(list(shortcut["unscored_receipts"]), ids)
        for row_id, receipt in shortcut["unscored_receipts"].items():
            self.assertEqual((receipt["outcome"], receipt["score"]), ("frame_failure", None))
            self.assertEqual({key: receipt["context"][key] for key in ("stage", "arm", "row_id")},
                             {"stage": NEGATIVE_PROBE, "arm": "shortcut", "row_id": row_id})
        self.assertEqual(result["controls"]["broken"]["scores"], [0.0] * len(ids))
        self.assertEqual(result["controls"]["known-improved"]["mean"], 1.0)
        self.assertGreater(result["controls"]["naive"]["mean"], 0)
        self.assertTrue(result["ranking_passed"])
        self.assertTrue(result["noise_passed"])
        self.assertEqual(result["calibration"]["noiseEnvelope"], 0)
        record = next(record for record in self.evaluations() if record["control"] == "shortcut")
        self.assertEqual((record["row_ids"], record["scores"], record["unscored_receipts"]),
                         (ids, shortcut["scores"], shortcut["unscored_receipts"]))

    def test_positive_and_noise_infrastructure_abort_instead_of_scoring(self):
        reference = self.rows[0]["reference_code"]
        cases = (("known-improved", lambda row, output: output == reference, []),
                 ("naive", lambda row, output: output == "good", ["known-improved"]),
                 ("unchanged:3:second", lambda row, output: current_call_scope().get("arm") == "unchanged:3:second",
                  ["known-improved", "naive", "broken", "shortcut"] + ["unchanged"] * 6))
        for arm, fails, recorded in cases:
            with self.subTest(arm=arm):
                self.out = Path(self.directory.name) / arm
                self.fails = fails
                with self.assertRaises(GraderInfrastructureError) as caught:
                    self.measure()
                self.assertEqual(caught.exception.receipt["context"]["arm"], arm)
                self.assertNotIn("stage", caught.exception.receipt["context"])
                self.assertEqual([record["control"] for record in self.evaluations()], recorded)
                self.assertNotIn("noise_passed", json.loads((self.out / "controls.json").read_text())
                                 if (self.out / "controls.json").exists() else {})

    def test_unrelated_receipts_positive_shortcuts_and_legacy_proofs_are_not_rejections(self):
        other = self.rows[1]
        for name, failure in (("row", lambda row, output: grader_failure(other, output)),
                              ("output", lambda row, output: grader_failure(row, "unrelated"))):
            with self.subTest(defect=name):
                self.out = Path(self.directory.name) / name
                self.failure = failure
                with self.assertRaises(ValueError):
                    self.measure()
                self.assertNotIn("shortcut", [record["control"] for record in self.evaluations()])
        self.out = Path(self.directory.name) / "positive"
        with patch("pilot.tasks.score_output", side_effect=lambda task, row, output: float(output != "bad")):
            with self.assertRaises(ControlsFailed):
                self.measure()
        positive = json.loads((self.out / "controls.json").read_text())
        self.assertEqual((positive["controls"]["shortcut"]["mean"], positive["ranking_passed"]), (1.0, False))
        self.out = Path(self.directory.name) / "legacy"
        self.proof["version"] = adversarial.LEGACY_VERSION
        with self.assertRaises(ValueError):
            self.measure()
        self.assertEqual(self.evaluations(), [])


class ControlTests(unittest.TestCase):
    def task(self):
        return Task("aime", [{"id": str(index), "input": "problem " + str(index), "answer": "42"}
                             for index in range(45)], [], {}, {"prompt": "baseline"})

    def measure(self, task, call, out, identity):
        rows = representative_rows(task)
        proof = text_admission(task, identity, rows)
        with patch("pilot.published.control_artifact", return_value={"prompt": "published"}):
            return measure(task, call, out, identity, rows=rows, adversarial=proof)

    def provider(self, noise=False):
        baseline = 0
        def call(role, messages, tokens):
            nonlocal baseline
            index = int(messages[-1]["content"].split()[-1])
            if messages[1]["content"] == "published":
                answer = "0" if index == 5 else "42"
            else:
                arm = baseline // P_CONTROL_ROWS
                baseline += 1
                answer = "42" if index % 2 == 0 else "0"
                if noise and arm > 0:
                    answer = "0" if arm % 4 in (0, 1) else "42"
            return json.dumps({"reasoning": "working", "answer": answer})
        return call

    def test_measured_positive_and_paired_noise_admit_only_a_real_contrast(self):
        task = self.task()
        with tempfile.TemporaryDirectory() as directory:
            result = self.measure(task, self.provider(), Path(directory), {"evaluator": "frozen"})
        values = {name: value["mean"] for name, value in result["controls"].items()}
        self.assertGreater(values["known-improved"], values["naive"])
        self.assertGreater(values["naive"], values["shortcut"])
        self.assertEqual(values["broken"], 0)
        self.assertTrue(result["noise_passed"])
        self.assertEqual(result["calibration"]["noiseEnvelope"], 0)

    def test_published_positive_is_measured_not_awarded_a_reference_answer(self):
        def wrong(*args):
            return '{"reasoning":"","answer":"0"}'
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            with self.assertRaises(ControlsFailed):
                self.measure(self.task(), wrong, out, {})
            result = json.loads((out / "controls.json").read_text())
            self.assertEqual(result["controls"]["known-improved"]["mean"], 0)
            self.assertEqual(set(result["controls"]["known-improved"]["outputs"]), {"0"})
            self.assertFalse((out / "noise-pairs.json").exists())

    def test_unchanged_noise_can_refuse_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ControlsFailed, "noise"):
                self.measure(self.task(), self.provider(noise=True), Path(directory), {})

    def test_existing_evidence_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "controls-declaration.json"
            path.write_text("prior evidence")
            with self.assertRaises(FileExistsError):
                self.measure(self.task(), self.provider(), Path(directory), {})
            self.assertEqual(path.read_text(), "prior evidence")

    def test_fresh_p_draw_is_fixed_and_independent_of_source_order(self):
        for name, seed in (("aime", 20261105), ("ifbench", 20261106), ("hover", 20261105)):
            with self.subTest(task=name):
                task = self.task()
                task.name = name
                expected = random.Random(seed).sample(sorted(task.train, key=lambda row: row["id"]), 40)
                self.assertEqual(representative_rows(task), expected)
                task.train.reverse()
                self.assertEqual(representative_rows(task), expected)

    def test_fresh_mbpp_draw_excludes_prior_rows_without_mutating_partition(self):
        rows = [{"id": f"mbpp:train:{index}"} for index in range(601, 975)]
        original_ids = [row["id"] for row in rows]
        current = Task("mbpp", rows, [], {}, {})
        chosen = representative_rows(current)
        self.assertTrue({row["id"] for row in chosen}.isdisjoint(PREVIOUS_MBPP_ROWS))
        eligible = sorted((row for row in rows if row["id"] not in PREVIOUS_MBPP_ROWS), key=lambda row: row["id"])
        self.assertEqual(chosen, random.Random(CONTROL_SEED).sample(eligible, 20))
        self.assertEqual([row["id"] for row in current.train], original_ids)
        current.train.reverse()
        self.assertEqual(chosen, representative_rows(current))

    def test_control_draw_refuses_insufficient_training_rows(self):
        for current in (Task("mbpp", [{"id": value} for value in PREVIOUS_MBPP_ROWS], [], {}, {}),
                        Task("aime", [{"id": str(i)} for i in range(39)], [], {}, {})):
            with self.assertRaises(ValueError):
                representative_rows(current)

    def test_ifbench_headroom_boundary_precedes_improved_and_noise(self):
        for correct, replaced in ((36, True), (35, False)):
            task = Task("ifbench", [{"id": str(index), "input": f"problem {index}", "instruction_id_list": [], "kwargs": []}
                                    for index in range(40)], [], {}, {"prompt": "seed generation", "revision_prompt": "seed revision"})
            def metric(row, prediction):
                return SimpleNamespace(score=float(prediction.response in {"good", "heliotropeproofword"}), feedback="checked")
            improved_calls = 0
            def call(role, messages, tokens):
                nonlocal improved_calls
                field = "final_response" if "final_response" in messages[0]["content"] else "response"
                if messages[1]["content"].startswith("published"):
                    improved_calls += 1
                    if replaced:
                        self.fail("Headroom replacement made an improved-control call")
                    output = "good"
                else:
                    query = json.loads(messages[-1]["content"])["query"] if field == "final_response" else messages[-1]["content"]
                    output = "good" if int(query.split()[-1]) < correct else "bad"
                return json.dumps({"reasoning": "", field: output})
            with tempfile.TemporaryDirectory() as directory, patch.dict(tasks._METRICS, {id(task.manifest): metric}), patch(
                "pilot.published.control_artifact", return_value={"prompt": "published generation", "revision_prompt": "published revision"}
            ):
                rows = representative_rows(task)
                proof = text_admission(task, {}, rows)
                result = measure(task, call, Path(directory), {}, rows=rows, adversarial=proof)
                self.assertEqual(result.get("headroom_replacement") == "hover", replaced)
                self.assertEqual((Path(directory) / "noise-pairs.json").exists(), not replaced)
                self.assertEqual(result["controls"]["naive"]["mean"], correct / 40)
                if replaced:
                    self.assertEqual(set(result["controls"]), {"naive"})
                    self.assertIsNone(result["ranking_passed"])
                else:
                    self.assertTrue(result["noise_passed"])
                    self.assertGreater(improved_calls, 0)

    def test_refusals_are_measured_zero_and_counted_by_real_row_and_arm(self):
        from pilot.runtime import ProviderRefusal, current_call_scope
        task = self.task()
        provider = self.provider()
        observed = []
        refused_row = representative_rows(task)[0]["id"]
        def call(role, messages, tokens):
            context = current_call_scope()
            observed.append(context)
            response = provider(role, messages, tokens)
            if context["row_id"] == refused_row:
                raise ProviderRefusal("terminal refusal")
            return response
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            result = self.measure(task, call, out, {})
            records = [json.loads(line) for line in (out / "evaluations.jsonl").read_text().splitlines()]
        self.assertEqual(result["refusals"], 34)
        self.assertEqual(result["refusals_by_row"], {refused_row: 34})
        self.assertEqual(result["refusals_by_arm"]["naive"], 1)
        self.assertEqual(result["refusals_by_arm"]["known-improved"], 1)
        self.assertEqual(result["refusals_by_arm"]["broken"], 0)
        self.assertEqual(result["refusals_by_arm"]["shortcut"], 0)
        for trial in range(16):
            for arm in ("first", "second"):
                self.assertEqual(result["refusals_by_arm"][f"unchanged:{trial}:{arm}"], 1)
        self.assertTrue(all(context["task"] == "aime" for context in observed))
        self.assertEqual({context["arm"] for context in observed}, {
            "naive", "known-improved",
            *(f"unchanged:{trial}:{arm}" for trial in range(16) for arm in ("first", "second"))})
        for record in records:
            for row_id in record["refusals"]:
                index = record["row_ids"].index(row_id)
                self.assertEqual(record["outputs"][index], "")
                self.assertEqual(record["scores"][index], 0.0)


if __name__ == "__main__":
    unittest.main()
