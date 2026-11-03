import json
from pathlib import Path
import tempfile
import unittest

from pilot.controls import ControlsFailed, measure
from pilot.tasks import Task


class ControlTests(unittest.TestCase):
    def task(self):
        return Task("aime", [{"id": str(index), "input": "problem " + str(index), "answer": "42"}
                             for index in range(45)], [], {}, {"prompt": "baseline"})

    def provider(self, noise=False):
        baseline = [0]
        requests = []
        def call(role, messages, tokens):
            requests.append(messages)
            text = str(messages)
            if "quick intuitive" in text:
                answer = "42" if messages[-1]["content"] in {"problem 0", "problem 6", "problem 12", "problem 18"} else "0"
            else:
                arm = baseline[0] // 8
                baseline[0] += 1
                answer = "0" if noise and arm % 4 in (1, 2) else "42"
            return json.dumps({"reasoning": "working", "answer": answer})
        return call, requests

    def test_real_artifact_rank_and_fresh_unchanged_noise(self):
        call, requests = self.provider()
        with tempfile.TemporaryDirectory() as directory:
            result = measure(self.task(), call, Path(directory), {"evaluator": "frozen"})
            declaration = json.loads((Path(directory) / "controls-declaration.json").read_text())
        self.assertEqual({name: value["mean"] for name, value in result["controls"].items()},
                         {"known-improved": 1.0, "naive": 0.5, "broken": 0.0, "shortcut": 0.0})
        self.assertNotIn("controls", declaration)
        self.assertIn("expected_rank", declaration)
        self.assertTrue(result["noise_passed"])
        self.assertEqual(result["calibration"]["noiseEnvelope"], 0)

    def test_failed_actual_rank_stops_before_noise(self):
        requests = []
        def call(*args):
            requests.append(args)
            return '{"reasoning":"","answer":"0"}'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ControlsFailed):
                measure(self.task(), call, Path(directory), {})
            self.assertFalse((Path(directory) / "noise-pairs.json").exists())

    def test_unchanged_noise_can_refuse_admission(self):
        call, _ = self.provider(noise=True)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ControlsFailed, "noise"):
                measure(self.task(), call, Path(directory), {})

    def test_existing_evidence_is_not_overwritten(self):
        call, _ = self.provider()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "controls-declaration.json"
            path.write_text("prior evidence")
            with self.assertRaises(FileExistsError):
                measure(self.task(), call, Path(directory), {})
            self.assertEqual(path.read_text(), "prior evidence")


if __name__ == "__main__":
    unittest.main()
