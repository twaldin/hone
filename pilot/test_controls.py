from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.controls import ControlsFailed, measure
from pilot.tasks import Task


class ControlTests(unittest.TestCase):
    def task(self):
        return Task("aime", [{"id": str(index), "input": "unrelated problem", "answer": "42"} for index in range(8)], [], {}, {"prompt": "answer"})

    def test_correct_rank_and_measured_zero_noise_admit(self):
        with tempfile.TemporaryDirectory() as directory:
            result = measure(self.task(), lambda *args: "42", Path(directory), {"evaluator": "frozen"})
        self.assertEqual({name: value["mean"] for name, value in result["controls"].items()}, {"known-improved": 1.0, "naive": 0.5, "broken": 0.0, "shortcut": 0.0})
        self.assertTrue(result["ranking_passed"])
        self.assertTrue(result["noise_passed"])
        self.assertEqual(result["calibration"]["pairedDeltaTrials"], 16)
        self.assertEqual(result["calibration"]["noiseEnvelope"], 0)

    def test_invalid_metric_stops_before_noise_or_search(self):
        with tempfile.TemporaryDirectory() as directory, patch("pilot.controls.score_output", return_value=0):
            with self.assertRaises(ControlsFailed):
                measure(self.task(), lambda *args: self.fail("Noise model called after failed controls"), Path(directory), {})

    def test_unchanged_noise_can_refuse_admission(self):
        ordinal = [0]
        def call(*args):
            arm = ordinal[0] // 8
            ordinal[0] += 1
            return "42" if arm % 4 in (0, 3) else "0"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ControlsFailed, "noise"):
                measure(self.task(), call, Path(directory), {})


if __name__ == "__main__":
    unittest.main()
