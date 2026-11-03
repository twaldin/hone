import copy
import pickle
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.admission import mbpp_ast, mbpp_source_contract, text_admission, validate_text_admission
from pilot import published
from pilot.tasks import Task


class _Reducer:
    def __reduce__(self):
        return eval, ("(_ for _ in ()).throw(RuntimeError('UPSTREAM CODE EXECUTED'))",)


class PublishedTests(unittest.TestCase):
    def test_reducers_are_data_and_opaque_strings_are_not_decoded(self):
        result = published._parse(pickle.dumps({"payload": _Reducer(), "opaque": "\ud800"}, protocol=5))
        self.assertIsInstance(result[published._Text(b"payload")], published._Node)
        self.assertEqual(result[published._Text(b"opaque")].raw, b"\xed\xa0\x80")

    def test_pinned_program_mismatch_is_rejected_before_parsing(self):
        with self.assertRaisesRegex(ValueError, "digest"):
            published.extract_program(pickle.dumps(_Reducer()), "aime")

    def test_truncation_trailing_bytes_and_unsupported_protocol_fail(self):
        valid = pickle.dumps({"value": 7}, protocol=5)
        for invalid in (valid[:-1], valid + b"x", b"\x80\x03N.", b"\x80\x05\xff."):
            with self.subTest(data=invalid):
                with self.assertRaises(ValueError):
                    published._parse(invalid)

    def test_external_control_requires_validation_improvement_not_a_test_score(self):
        state = {"track_scores_on": "val", "program_full_scores_val_set": [40.0, 60.0],
                 "per_program_tracked_scores": [40.0, 60.0]}
        result = published._validation_provenance(pickle.dumps(state, protocol=5))
        self.assertEqual(result["compile_selected_index"], 1)
        self.assertEqual(result["selected_validation_percent"], 60.0)
        for defect in ("no-improvement", "test-selection", "different-tracked-scores"):
            wrong = copy.deepcopy(state)
            if defect == "no-improvement":
                wrong["program_full_scores_val_set"] = wrong["per_program_tracked_scores"] = [40.0, 39.0]
            elif defect == "test-selection":
                wrong["track_scores_on"] = "test"
            else:
                wrong["per_program_tracked_scores"] = [40.0, 99.0]
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                published._validation_provenance(pickle.dumps(wrong, protocol=5))



class AdmissionTests(unittest.TestCase):
    def test_mbpp_branch_changes_cannot_reuse_a_p_only_source_equivalence(self):
        original = 'def evaluate(task):\n    if task.name == "mbpp":\n        return 7\n    else:\n        return 0\n'
        p_change = original.replace("return 0", "return 9")
        mbpp_change = original.replace("return 7", "return 8")
        self.assertEqual(mbpp_ast(original, "pilot/tasks.py"), mbpp_ast(p_change, "pilot/tasks.py"))
        self.assertNotEqual(mbpp_ast(original, "pilot/tasks.py"), mbpp_ast(mbpp_change, "pilot/tasks.py"))
        with_effect = 'def evaluate(task):\n    if observe() and task.name != "mbpp":\n        return 0\n    return 7\n'
        self.assertNotEqual(mbpp_ast(original, "pilot/tasks.py"), mbpp_ast(with_effect, "pilot/tasks.py"))

    def test_literal_worker_change_invalidates_execution_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "pilot").mkdir()
            for name in ("program.py", "verification.py", "runtime.py", "gateway.mjs"):
                (root / "pilot" / name).write_text("frozen")
            for name in ("tasks.py", "search.py"):
                (root / "pilot" / name).write_text("pass\n")
            before = mbpp_source_contract(root)
            (root / "pilot/verification.py").write_text("different")
            self.assertNotEqual(before, mbpp_source_contract(root))

    def test_text_admission_rejects_changed_identity_cohort_or_missing_attack(self):
        task = Task("aime", [{"id": "train:one", "answer": "42"}], [], {}, {"prompt": "official"})
        proof = text_admission(task, {"identity": 1}, task.train)
        validate_text_admission(proof, task, {"identity": 1}, task.train)
        for defect in ("identity", "cohort", "attack", "positive"):
            broken = copy.deepcopy(proof)
            if defect == "identity":
                broken["identity"] = {"identity": 2}
            elif defect == "cohort":
                broken["rows"] = []
            elif defect == "attack":
                broken["checks"]["records"].pop()
            else:
                broken["checks"]["positive_score"] = 0
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                validate_text_admission(broken, task, {"identity": 1}, task.train)

    def test_positive_attack_in_protected_pipeline_refuses_admission(self):
        task = Task("aime", [{"id": "train:one", "answer": "42"}], [], {}, {"prompt": "official"})
        with patch("pilot.tasks._response", return_value="739"):
            proof = text_admission(task, {}, task.train)
        self.assertFalse(proof["passed"])
        self.assertEqual(len(proof["checks"]["records"]), 1)
        self.assertEqual(proof["checks"]["records"][0]["direct_score"], 0)
        self.assertEqual(proof["checks"]["records"][0]["scores"], [1.0])
        with self.assertRaises(ValueError):
            validate_text_admission(proof, task, {}, task.train)

    def test_decoder_failure_before_dispatch_cannot_masquerade_as_attack_rejection(self):
        task = Task("aime", [{"id": "train:one", "answer": "42"}], [], {}, {"prompt": "official"})
        with patch("pilot.tasks._response", side_effect=ValueError("broken decoder before dispatch")):
            proof = text_admission(task, {}, task.train)
        self.assertFalse(proof["passed"])
        self.assertEqual(proof["checks"]["records"][0]["scores"], [0.0])
        self.assertEqual(proof["checks"]["records"][0]["frames"], [])
        with self.assertRaises(ValueError):
            validate_text_admission(proof, task, {}, task.train)



if __name__ == "__main__":
    unittest.main()
