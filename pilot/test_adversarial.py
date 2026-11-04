import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot import adversarial
from pilot.__main__ import evaluator_identity, load_adversarial, save, seal
from pilot.controls import CONTROL_SEED, ControlsFailed, representative_rows
from pilot.runtime import digest
from pilot.tasks import Task


def fixture_tasks():
    tasks = []
    for name in adversarial.TASK_NAMES:
        rows = [{"id": f"{name}:train:{index}", "input": "Implement.\ndef target(value):",
                 "reference_code": "def target(value): return value + 1", "test_setup_code": "",
                 "test_list": ["assert target(1) == 2"], "answer": "42"} for index in range(100, 140)]
        seed = ({"prompt": "answer", "revision_prompt": "revise"} if name == "ifbench" else {"prompt": "answer"})
        tasks.append(Task(name, rows, [], {"task": name}, seed))
    return tasks


def admission_fixture(tasks=None, identities=None):
    tasks = tasks or fixture_tasks()
    identities = identities or {task.name: evaluator_identity(task) for task in tasks}
    proof = {"version": adversarial.VERSION, "seed": CONTROL_SEED, "identities": identities,
             "cohorts": adversarial.cohort_manifest(tasks), "attack_manifest": adversarial.manifest(),
             "text_attack_manifest": adversarial.text_manifest(),
             "model_calls": 0, "gradeability_hash": digest([]), "mbpp": [], "text_only": {}, "passed": True}
    mbpp = next(task for task in tasks if task.name == "mbpp")
    proof["gradeability"] = [{"id": row["id"], "gradeable": True, "reason": None} for row in mbpp.train + mbpp.selection]
    proof["gradeability_hash"] = digest(proof["gradeability"])
    for attack in adversarial.ATTACKS:
        for row in representative_rows(mbpp):
            source = adversarial.solution(attack, row)
            proof["mbpp"].append({"attack": attack.name, "row_id": row["id"], "artifact": adversarial.artifact(source),
                                  "source": source, "output": source, "score": 0.0})
    for task in tasks:
        if task.name == "mbpp":
            continue
        synthetic, row, good = adversarial.string_task(task)
        checks = {"row": row, "positive_output": good, "positive_score": 1.0, "records": []}
        proof["text_only"][task.name] = checks
        for payload in adversarial.text_manifest():
            source = payload["source"]
            for mode in ("protected-json", "raw-protocol"):
                fields = ["answer"] if task.name == "aime" else ["response", "final_response"]
                frames = [json.dumps({"reasoning": "", field: source}) for field in fields] if mode == "protected-json" else [source]
                checks["records"].append({"attack": payload["name"], "mode": mode, "source": source,
                                          "frames": frames, "outputs": [source] if mode == "protected-json" else [""],
                                          "direct_score": 0.0, "scores": [0.0]})
    return proof


class AdversarialTests(unittest.TestCase):
    def test_manifest_covers_named_attacks_and_original_shortcut_unchanged(self):
        names = {attack.name for attack in adversarial.ATTACKS}
        self.assertEqual(len(names), 15)
        self.assertTrue({"builtin-exec-override", "always-equal-eq-hash", "always-equal-builtin-subclass",
                         "sys-exit-zero", "os-exit-zero", "stdout-success-forgery", "completion-receipt-forgery",
                         "plain-data-frame-forgery", "dataframe-verdict-forgery", "unittest-assert-helper-monkeypatch",
                         "comparison-harness-monkeypatch", "expected-test-file-read", "expected-environment-read",
                         "atexit-result-rewriter", "original-shortcut"} == names)
        from pilot.controls import SHORTCUT_CODE
        self.assertEqual(adversarial.solution(adversarial.ATTACKS[-1], {}), SHORTCUT_CODE)
        for attack in adversarial.ATTACKS:
            source = adversarial.solution(attack, {"input": "def target(value):"})
            self.assertLess(len(adversarial.artifact(source)["program"].encode()), 262144)

    def test_positive_stops_immediately_retains_exact_artifact_and_no_models(self):
        tasks = fixture_tasks()
        calls = []
        def evaluate(task, candidate, rows, call):
            calls.append(candidate)
            return {"outputs": [adversarial.solution(adversarial.ATTACKS[0], rows[0])], "scores": [1.0]}
        with tempfile.TemporaryDirectory() as directory, patch("pilot.verification.prepare_plan", return_value={"gradeable": True, "reason": None}), patch(
            "pilot.adversarial.evaluate", side_effect=evaluate
        ), patch("pilot.__main__.calls_for") as transport:
            out = Path(directory)
            with self.assertRaisesRegex(ControlsFailed, "Adversarial positive"):
                adversarial.run(tasks, {task.name: {} for task in tasks}, out)
            proof = json.loads((out / "adversarial.json").read_text())
            records = [json.loads(line) for line in (out / "mbpp.jsonl").read_text().splitlines()]
            self.assertFalse(proof["passed"])
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["score"], 1)
            self.assertEqual(records[0]["artifact"], calls[0])
            transport.assert_not_called()
        self.assertEqual(len(calls), 1)

    def test_missing_old_positive_or_incomplete_proofs_are_rejected(self):
        proof = admission_fixture()
        adversarial.validate_result(proof, proof["identities"], proof["cohorts"])
        for defect in ("old", "positive", "missing_attack", "missing_text", "missing_passed"):
            broken = copy.deepcopy(proof)
            if defect == "old":
                broken["version"] = "pilot-adversarial-v2"
            elif defect == "positive":
                broken["mbpp"][0]["score"] = 1
            elif defect == "missing_attack":
                broken["mbpp"].pop()
            elif defect == "missing_text":
                broken["text_only"]["ifbench"]["records"].pop()
            else:
                del broken["passed"]
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                adversarial.validate_result(broken, proof["identities"], proof["cohorts"])

    def test_historical_proof_replays_its_own_identity_and_still_rejects_positives(self):
        tasks = fixture_tasks()
        identities = {task.name: {"contract": 3, "fixture": task.name} for task in tasks}
        proof = admission_fixture(tasks, identities)
        for name in ("ifbench", "aime"):
            rows = proof["cohorts"][name]["rows"][:20]
            proof["cohorts"][name] = {"rows": rows, "cohort_hash": digest(rows)}
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            save(out / "adversarial.json", proof)
            seal(out)
            self.assertTrue(load_adversarial(out, tasks)["passed"])
            proof["mbpp"][0]["score"] = 1.0
            save(out / "adversarial.json", proof)
            seal(out)
            with self.assertRaises(ValueError):
                load_adversarial(out, tasks)




    @unittest.skipUnless(os.environ.get("PILOT_OFFICIAL_METRIC_TESTS") == "1", "Parent-controlled pinned official checker proof")
    def test_official_text_checkers_treat_every_attack_as_data(self):
        from pilot import tasks as module
        from pilot.runtime import ROOT
        metric, _ = module._official_metric(ROOT / ".pilot-cache")
        tasks = fixture_tasks()
        for task in tasks:
            if task.name == "mbpp":
                continue
            synthetic, row, good = adversarial.string_task(task)
            with patch.dict(module._METRICS, {id(task.manifest): metric}):
                self.assertEqual(module.score_output(synthetic, row, good), 1)
                for payload in adversarial.text_manifest():
                    source = payload["source"]
                    self.assertEqual(module.score_output(synthetic, row, source), 0)
                    replies = iter([json.dumps({"reasoning": "", field: source}) for field in (
                        ["answer"] if task.name == "aime" else ["response", "final_response"])])
                    result = module.evaluate(synthetic, task.seed_candidate, [row], lambda *args: next(replies))
                    self.assertEqual(result["scores"], [0.0])
                    raw = module.evaluate(synthetic, task.seed_candidate, [row], lambda *args: source)
                    self.assertEqual(raw["scores"], [0.0])


if __name__ == "__main__":
    unittest.main()
