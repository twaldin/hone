import argparse
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.__main__ import replay, resume_result, save, verify_bundle
from pilot.runtime import append_json, digest
from pilot.tasks import Task


class ReplayTests(unittest.TestCase):
    def test_recomputes_scores_and_rejects_forged_success(self):
        task = Task("aime", [{"id": "dev:1", "input": "p", "answer": "42"}], [{"id": "dev:2", "input": "q", "answer": "7"}], {"task": "aime"}, {"prompt": "answer"})
        with tempfile.TemporaryDirectory() as directory, patch("pilot.__main__.os.environ", {}):
            out = Path(directory)
            save(out / "manifest.json", {"identity": {"task": task.manifest}})
            record = {"row_ids": ["dev:1", "dev:2"], "outputs": ["42", "not an integer"], "scores": [1.0, 0.0]}
            save(out / "evaluations.jsonl", record)
            args = argparse.Namespace(out=out, cache=out / "cache")
            stream = StringIO()
            with patch("pilot.tasks.load_task", return_value=task), redirect_stdout(stream):
                replay(args)
            self.assertEqual(json.loads(stream.getvalue()), {"replayed_rollouts": 2, "model_calls": 0, "scored_final_tests_loaded": False})
            record["scores"] = [1.0, 1.0]
            save(out / "evaluations.jsonl", record)
            with patch("pilot.tasks.load_task", return_value=task), self.assertRaisesRegex(ValueError, "disagrees"):
                replay(args)

    def test_interrupted_cell_preserves_usage_prefix_and_last_accepted_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            append_json(out / "calls.jsonl", {"reported_tokens": 100, "usd_equivalent": 0.002, "role": "task", "retry_observation": {"hiddenAttempts": 2}})
            append_json(out / "incumbents.jsonl", {"candidate": {"prompt": "accepted"}, "selection_score": 0.75})
            with (out / "incumbents.jsonl").open("a") as stream:
                stream.write('{"candidate":')
            result = resume_result(out, "aime", 0, "plain")
            self.assertEqual(result["status"], "infrastructure_failure")
            self.assertEqual(result["candidate_hash"], digest({"prompt": "accepted"}))
            self.assertEqual(result["selection_score"], 0.75)
            self.assertEqual(result["tokens"], 100)
            self.assertEqual(result["hidden_attempts"], 2)
            self.assertEqual(resume_result(out, "aime", 0, "plain"), result)
            verify_bundle(out)

    def test_bundle_rejects_paths_outside_its_root_before_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            files = {"../outside.json": "sha256:irrelevant"}
            save(out / "bundle.json", {"files": files, "bundle_hash": digest(files)})
            with patch("pilot.__main__.file_hash", side_effect=AssertionError("outside file read")), self.assertRaises(ValueError):
                verify_bundle(out)


if __name__ == "__main__":
    unittest.main()
