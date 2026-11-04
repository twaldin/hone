import json
import random
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from pilot.admission import text_admission
from pilot.controls import (CONTROL_SEED, P_CONTROL_ROWS, PREVIOUS_MBPP_ROWS,
                            ControlsFailed, measure, representative_rows)
from pilot.tasks import Task
from pilot import tasks


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


if __name__ == "__main__":
    unittest.main()
