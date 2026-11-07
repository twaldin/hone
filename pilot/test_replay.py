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
            self.assertEqual(json.loads(stream.getvalue())["replayed_rollouts"], 2)
            record["scores"] = [1.0, 1.0]
            save(out / "evaluations.jsonl", record)
            with patch("pilot.tasks.load_task", return_value=task), self.assertRaisesRegex(ValueError, "disagrees"):
                replay(args)

    def test_controls_root_replays_nested_rollouts_and_rejects_a_forged_score(self):
        task = Task("hover", [{"id": "dev:1", "supporting_facts": [{"key": "Alpha"}]}],
                    [{"id": "dev:2", "supporting_facts": [{"key": "Beta"}]}],
                    {"task": "hover"}, {})
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            save(out / "adversarial.json", {"version": "pilot-adversarial-v5"})
            save(out / "hover/manifest.json", {"identity": {"task": task.manifest}})
            record = {"row_ids": ["dev:1", "dev:2"], "outputs": ['["Alpha | abstract"]', "invalid"],
                      "scores": [1.0, 0.0]}
            save(out / "hover/evaluations.jsonl", record)
            proof = {"checks": {"records": []}, "passed": True}
            args = argparse.Namespace(out=out, cache=out / "cache")
            with patch("pilot.__main__.load_admission", return_value=({}, {}, proof)), patch(
                "pilot.tasks.load_task", return_value=task
            ):
                with redirect_stdout(StringIO()) as stream:
                    replay(args)
                self.assertEqual(json.loads(stream.getvalue()).get("replayed_rollouts"), 2)
                record["scores"][1] = 1.0
                save(out / "hover/evaluations.jsonl", record)
                with self.assertRaisesRegex(ValueError, "disagrees"):
                    replay(args)
    def test_invalid_ifbench_cohort_is_replay_only_and_requires_exact_archived_manifest(self):
        from pilot import __main__ as cli
        from pilot import tasks
        original = {"task": "ifbench", "train_ids": ["ifbench:train:1", "ifbench:train:2"],
                    "selection_ids": ["ifbench:train:0"], "adaptation": "archived 300-row cohort"}
        current = dict(original, train_ids=["ifbench:train:2"], adaptation="official 150-row sample")
        task = Task("ifbench", [], [], current, {"prompt": "unchanged"})
        raw = [{"prompt": str(index), "instruction_id_list": [], "kwargs": []} for index in range(3)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "evidence/pilot/controls-4a"
            save(source / "ifbench/controls.json", {"identity": {"task": original}})
            cli.seal(source)
            metric = object()
            with patch.object(cli, "ROOT", root), patch("pilot.tasks._data", return_value=(raw, {})), patch.dict(
                tasks._METRICS, {id(current): metric}
            ):
                archived = cli.archived_ifbench(task, original, root / "cache")
                self.assertEqual([row["id"] for row in archived.train], original["train_ids"])
                self.assertIs(tasks._METRICS[id(archived.manifest)], metric)
                forged = dict(original, train_ids=["ifbench:train:0"])
                with self.assertRaisesRegex(ValueError, "Archived"):
                    cli.archived_ifbench(task, forged, root / "cache")


    def test_refused_mbpp_replay_requires_a_metered_row_and_never_executes_a_solution(self):
        task = Task("mbpp", [{"id": "dev:1", "input": "fixture"}], [], {"task": "mbpp"}, {})
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            save(out / "manifest.json", {"identity": {"task": task.manifest}})
            save(out / "evaluations.jsonl", {"row_ids": ["dev:1"], "outputs": [""], "scores": [0.0],
                                             "control": "naive", "refusals": ["dev:1"]})
            save(out / "calls.jsonl", {"outcome": "refusal", "row_id": "dev:1", "context": {"arm": "naive"}})
            args = argparse.Namespace(out=out, cache=out / "cache")
            with patch("pilot.tasks.load_task", return_value=task), patch(
                "pilot.tasks.score_output", side_effect=AssertionError("Refusal is not candidate code")
            ), redirect_stdout(StringIO()) as stream:
                replay(args)
            self.assertEqual(json.loads(stream.getvalue())["replayed_rollouts"], 1)
            (out / "calls.jsonl").unlink()
            with patch("pilot.tasks.load_task", return_value=task), self.assertRaises(ValueError):
                replay(args)

    def test_interrupted_refusal_preserves_estimated_charges_and_distinct_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            append_json(out / "calls.jsonl", {"reported_tokens": 10, "estimated_tokens": 32,
                                             "charged_tokens": 42, "usd_equivalent": .001,
                                             "role": "task", "outcome": "refusal", "failed": True,
                                             "usage_missing": True})
            result = resume_result(out, "ifbench", 0, "plain", "RefusalNondeterminism")
            self.assertEqual(result["tokens"], 42)
            self.assertEqual(result["reported_tokens"], 10)
            self.assertEqual(result["estimated_tokens"], 32)
            self.assertEqual(result["refusals"], 1)
            self.assertEqual(result["status"], "refusal-nondeterminism")

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
