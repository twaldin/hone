import json
from pathlib import Path
import shutil
import tempfile
import unittest

from pilot.controls import CONTROL_ROWS
from pilot.search import _policy, _project_noise
from pilot import test_controls


@unittest.skipUnless(shutil.which("bun"), "Bun is unavailable")
class NativePolicyTests(unittest.TestCase):
    def test_measured_twenty_row_calibration_gates_both_search_sizes(self):
        fixture = test_controls.ControlTests()
        baseline = fixture.provider()
        calls = 0

        def provider(role, messages, tokens):
            nonlocal calls
            output = baseline(role, messages, tokens)
            if calls == 2 * CONTROL_ROWS:
                value = json.loads(output)
                value["answer"] = "0" if value["answer"] == "42" else "42"
                output = json.dumps(value)
            calls += 1
            return output

        with tempfile.TemporaryDirectory() as directory:
            noise = fixture.measure(fixture.task(), provider, Path(directory), {"evaluator": "synthetic-native-policy"})
        self.assertEqual(noise["noise_design"]["rows_per_arm"], 20)
        self.assertGreater(noise["calibration"]["noiseEnvelope"], 0)
        for size in (8, 90):
            with self.subTest(rows=size):
                projected, _ = _project_noise(noise, size)
                threshold = projected["calibration"]["noiseEnvelope"]
                below = _policy(0, 0, 0.25, 0.25 + threshold / 2, projected)
                above = _policy(0, 0, 0.25, 0.25 + threshold * 2, projected)
                self.assertFalse(below["gate"]["passed"])
                self.assertTrue(above["gate"]["passed"])
                self.assertEqual(above["gate"]["decision"], "promote")


if __name__ == "__main__":
    unittest.main()
