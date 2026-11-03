import json
import random
from pathlib import Path
import tempfile
import unittest

from pilot.controls import CONTROL_ROWS, CONTROL_SEED, PREVIOUS_MBPP_ROWS, ControlsFailed, measure, representative_rows
from pilot.tasks import Task
from pilot.test_adversarial import admission_fixture, fixture_tasks


class ControlTests(unittest.TestCase):
    def task(self):
        return Task("aime", [{"id": str(index), "input": "problem " + str(index), "answer": "42"}
                             for index in range(45)], [], {}, {"prompt": "baseline"})

    def measure(self, task, call, out, identity):
        tasks = [task if value.name == task.name else value for value in fixture_tasks()]
        identities = {value.name: identity if value.name == task.name else {"fixture": value.name} for value in tasks}
        proof = admission_fixture(tasks, identities)
        return measure(task, call, out, identity, rows=representative_rows(task), adversarial=proof)

    def provider(self, noise=False):
        baseline = [0]
        def call(role, messages, tokens):
            arm = baseline[0] // CONTROL_ROWS
            baseline[0] += 1
            answer = "42" if int(messages[-1]["content"].split()[-1]) % 2 == 0 else "0"
            if noise and arm > 0:
                answer = "0" if arm % 4 in (0, 1) else "42"
            return json.dumps({"reasoning": "working", "answer": answer})
        return call

    def test_real_artifact_rank_and_fresh_unchanged_noise(self):
        call = self.provider()
        with tempfile.TemporaryDirectory() as directory:
            result = self.measure(self.task(), call, Path(directory), {"evaluator": "frozen"})
            declaration = json.loads((Path(directory) / "controls-declaration.json").read_text())
        values = {name: value["mean"] for name, value in result["controls"].items()}
        self.assertEqual(values["known-improved"], 1)
        self.assertEqual(values["broken"], 0)
        self.assertEqual(values["shortcut"], 0)
        self.assertGreater(values["naive"], 0)
        self.assertLess(values["naive"], 1)
        self.assertNotIn("controls", declaration)
        self.assertIn("expected_rank", declaration)
        self.assertTrue(result["noise_passed"])
        self.assertEqual(result["calibration"]["noiseEnvelope"], 0)

    def test_failed_actual_rank_stops_before_noise(self):
        def call(*args):
            return '{"reasoning":"","answer":"0"}'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ControlsFailed):
                self.measure(self.task(), call, Path(directory), {})
            self.assertFalse((Path(directory) / "noise-pairs.json").exists())

    def test_unchanged_noise_can_refuse_admission(self):
        call = self.provider(noise=True)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ControlsFailed, "noise"):
                self.measure(self.task(), call, Path(directory), {})

    def test_existing_evidence_is_not_overwritten(self):
        call = self.provider()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "controls-declaration.json"
            path.write_text("prior evidence")
            with self.assertRaises(FileExistsError):
                self.measure(self.task(), call, Path(directory), {})
            self.assertEqual(path.read_text(), "prior evidence")

    def test_fresh_mbpp_draw_excludes_prior_rows_without_mutating_partition(self):
        rows = [{"id": f"mbpp:train:{index}"} for index in range(601, 975)]
        original_ids = [row["id"] for row in rows]
        current = Task("mbpp", rows, [], {}, {})
        chosen = representative_rows(current)
        self.assertEqual(len(chosen), 20)
        self.assertEqual(len({row["id"] for row in chosen}), 20)
        self.assertTrue({row["id"] for row in chosen}.isdisjoint(PREVIOUS_MBPP_ROWS))
        self.assertEqual(CONTROL_SEED, 20261104)
        self.assertEqual(len(PREVIOUS_MBPP_ROWS), 28)
        eligible = sorted((row for row in rows if row["id"] not in PREVIOUS_MBPP_ROWS), key=lambda row: row["id"])
        self.assertEqual(chosen, random.Random(20261104).sample(eligible, 20))
        self.assertEqual([row["id"] for row in current.train], original_ids)
        current.train = list(reversed(rows))
        self.assertEqual(chosen, representative_rows(current))

    def test_control_draw_refuses_insufficient_unseen_training_rows(self):
        current = Task("mbpp", [{"id": value} for value in PREVIOUS_MBPP_ROWS], [], {}, {})
        with self.assertRaises(ValueError):
            representative_rows(current)


if __name__ == "__main__":
    unittest.main()
