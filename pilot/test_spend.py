import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pilot.spend import report_spend


def call_record(number, role="task", tokens=10, usd=0.01, *, failed=False, missing=False, hidden=0, logs=0):
    return {"call": number, "role": role, "model": "fixture", "request_hash": "sha256:request",
            "response_hash": "sha256:response", "status": 502 if failed else 200,
            "stop_reason": None if failed else "stop", "reported_usage": {"input": tokens, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "reported_tokens": tokens, "usd_equivalent": usd, "seconds": 1,
            "retry_observation": {"hiddenAttempts": hidden, "logEvents": logs}, "usage_missing": missing, "failed": failed}


def evaluation(partition, calls, tokens, usd):
    return {"artifact_hash": "sha256:artifact", "row_ids": ["row"], "partition": partition,
            "scores": [1], "outputs": ["output"], "deployment_calls": calls,
            "deployment_tokens": tokens, "deployment_usd": usd}


class SpendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def journals(self, calls, evaluations):
        for name, rows in (("calls.jsonl", calls), ("evaluations.jsonl", evaluations)):
            (self.root / name).write_text("".join(json.dumps(row) + "\n" for row in rows))

    def test_interleaved_roles_multiple_partitions_and_exact_conservation(self):
        calls = [call_record(1, tokens=10, usd=0.01), call_record(2, tokens=20, usd=0.02),
                 call_record(3, tokens=30, usd=0.03),
                 call_record(4, "proposer", 40, 0.04, failed=True, hidden=2, logs=3),
                 call_record(5, "proposer", 50, 0.05), call_record(6, "repair", 60, 0.06, failed=True),
                 call_record(7, tokens=70, usd=0.07, failed=True), call_record(8, tokens=80, usd=0.08),
                 call_record(9, "judge", 90, 0.09), call_record(10, tokens=100, usd=0.10),
                 call_record(11, "proposer", 110, 0.11), call_record(12, tokens=120, usd=0.12),
                 call_record(13, "judge", 130, 0.13)]
        self.journals(calls, [evaluation("selection", 2, 30, 0.03), evaluation("training", 1, 30, 0.03),
                             evaluation("training", 3, 240, 0.24), evaluation("selection", 1, 100, 0.10),
                             evaluation("training", 1, 120, 0.12), evaluation("selection", 1, 130, 0.13)])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["buckets"]["proposal"], {"calls": 4, "tokens": 260, "usd_equivalent": 0.26})
        self.assertEqual(result["buckets"]["training_evaluation"], {"calls": 5, "tokens": 390, "usd_equivalent": 0.39})
        self.assertEqual(result["buckets"]["selection_evaluation"], {"calls": 4, "tokens": 260, "usd_equivalent": 0.26})
        self.assertEqual(result["buckets"]["unassigned"], {"calls": 0, "tokens": 0, "usd_equivalent": 0})
        self.assertEqual(result["total"], {"calls": 13, "tokens": 910, "usd_equivalent": 0.91})
        self.assertEqual(result["hidden_attempts"], 2)
        self.assertEqual(result["hidden_attempt_rate"], 2 / 13)
        self.assertEqual(result["calls_with_hidden_attempts"], 1)
        self.assertEqual(result["retry_log_events"], 3)
        self.assertEqual(result["failed_calls"], 3)
        self.assertEqual(result["usage_missing_calls"], 0)
        self.assertEqual(result["by_role"]["judge"], {"calls": 2, "tokens": 220, "usd_equivalent": 0.22})
        self.assertEqual([span["call_ids"] for span in result["evaluation_spans"]], [[1, 2], [3], [7, 8, 9], [10], [12], [13]])
        self.assertEqual(result["issues"], [])
        for name in ("calls.jsonl", "evaluations.jsonl"):
            self.assertEqual(result["input_hashes"][name], "sha256:" + hashlib.sha256((self.root / name).read_bytes()).hexdigest())

    def test_failed_retry_and_missing_usage_stay_in_evaluation_span(self):
        self.journals([call_record(1, tokens=0, usd=0, failed=True, missing=True),
                       call_record(2, hidden=1, logs=2)], [evaluation("training", 2, 10, 0.01)])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["buckets"]["training_evaluation"], {"calls": 2, "tokens": 10, "usd_equivalent": 0.01})
        self.assertEqual(result["total"], result["buckets"]["training_evaluation"])
        self.assertEqual(result["failed_calls"], 1)
        self.assertEqual(result["usage_missing_calls"], 1)
        self.assertEqual(result["hidden_attempts"], 1)
        self.assertEqual(result["hidden_attempt_rate"], 0.5)
        self.assertEqual(result["issues"], [{"reason": "missing_reported_usage", "calls": 1}])

    def test_failed_repair_without_usage_is_still_a_proposal_call(self):
        self.journals([call_record(1), call_record(2, "repair", 0, 0, failed=True, missing=True)],
                      [evaluation("selection", 1, 10, 0.01)])
        result = report_spend(self.root)
        self.assertEqual(result["buckets"]["proposal"], {"calls": 1, "tokens": 0, "usd_equivalent": 0})
        self.assertEqual(result["total"], {"calls": 2, "tokens": 10, "usd_equivalent": 0.01})
        self.assertEqual(result["failed_calls"], 1)
        self.assertEqual(result["usage_missing_calls"], 1)
        self.assertEqual(result["status"], "incomplete")

    def test_unfinished_evaluation_preserves_its_calls_without_guessing_partition(self):
        self.journals([call_record(1), call_record(2, "proposer"), call_record(3, tokens=20, usd=0.02),
                       call_record(4, "judge", 30, 0.03, failed=True)], [evaluation("selection", 1, 10, 0.01)])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["buckets"]["unassigned"], {"calls": 2, "tokens": 50, "usd_equivalent": 0.05})
        self.assertEqual(result["total"], {"calls": 4, "tokens": 70, "usd_equivalent": 0.07})
        self.assertEqual(result["unassigned_calls"], [
            {"call": 3, "role": "task", "reason": "no_completed_evaluation"},
            {"call": 4, "role": "judge", "reason": "no_completed_evaluation"}])

    def test_unknown_role_is_unassigned_and_conserved(self):
        self.journals([call_record(1, "retry"), call_record(2), call_record(3, "future-role", 20, 0.02)],
                      [evaluation("training", 1, 10, 0.01)])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["buckets"]["unassigned"], {"calls": 2, "tokens": 30, "usd_equivalent": 0.03})
        self.assertEqual(result["total"], {"calls": 3, "tokens": 40, "usd_equivalent": 0.04})
        self.assertEqual([call["reason"] for call in result["unassigned_calls"]], ["unknown_role", "unknown_role"])
        self.assertEqual(set(result["by_role"]), {"retry", "task", "future-role"})

    def test_truncated_call_tail_marks_unobserved_usage_explicitly(self):
        self.journals([call_record(1)], [evaluation("selection", 1, 10, 0.01)])
        tail = b'{"call":2,"role":"task","reported_tokens":'
        with (self.root / "calls.jsonl").open("ab") as stream:
            stream.write(tail)
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["total"], {"calls": 1, "tokens": 10, "usd_equivalent": 0.01})
        self.assertEqual(result["issues"], [{"file": "calls.jsonl", "line": 2, "reason": "truncated_record",
                                             "bytes": len(tail), "sha256": "sha256:" + hashlib.sha256(tail).hexdigest()}])
        self.assertIn("unknown", result["usage_limit"])

    def test_truncated_evaluation_tail_leaves_durable_calls_unassigned(self):
        self.journals([call_record(1), call_record(2)], [evaluation("selection", 1, 10, 0.01)])
        with (self.root / "evaluations.jsonl").open("ab") as stream:
            stream.write(b'{"partition":"training"')
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["total"], {"calls": 2, "tokens": 20, "usd_equivalent": 0.02})
        self.assertEqual(result["buckets"]["unassigned"], {"calls": 1, "tokens": 10, "usd_equivalent": 0.01})
        self.assertTrue(any(issue["reason"] == "truncated_record" for issue in result["issues"]))

    def test_complete_json_without_newline_keeps_reported_totals_but_marks_interruption(self):
        self.journals([], [evaluation("selection", 1, 10, 0.01)])
        (self.root / "calls.jsonl").write_text(json.dumps(call_record(1)))
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["total"], {"calls": 1, "tokens": 10, "usd_equivalent": 0.01})
        self.assertEqual(result["issues"], [{"file": "calls.jsonl", "line": 1, "reason": "unterminated_record"}])

    def test_invalid_terminated_or_interior_json_is_rejected(self):
        for contents in (b'{"call":\n', b'{bad}\n' + json.dumps(call_record(1)).encode() + b'\n'):
            with self.subTest(contents=contents):
                self.journals([], [])
                (self.root / "calls.jsonl").write_bytes(contents)
                with self.assertRaises(ValueError):
                    report_spend(self.root)

    def test_deployment_count_token_and_cost_mismatches_are_rejected(self):
        for record in (evaluation("training", 2, 10, 0.01), evaluation("training", 1, 11, 0.01),
                       evaluation("training", 1, 10, 0.02), evaluation("training", 0, 10, 0.01)):
            with self.subTest(record=record):
                self.journals([call_record(1)], [record])
                with self.assertRaises(ValueError):
                    report_spend(self.root)

    def test_proposal_or_unknown_call_cannot_be_hidden_inside_deployment_span(self):
        for role in ("proposer", "repair", "unknown"):
            with self.subTest(role=role):
                self.journals([call_record(1), call_record(2, role), call_record(3)],
                              [evaluation("training", 2, 20, 0.02)])
                with self.assertRaises(ValueError):
                    report_spend(self.root)

    def test_float_tolerance_accepts_cumulative_subtraction_roundoff_not_real_cost_difference(self):
        self.journals([call_record(1, usd=0.1), call_record(2, usd=0.2)],
                      [evaluation("selection", 1, 10, 0.1), evaluation("training", 1, 10, 0.3 - 0.1)])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "complete")
        self.assertAlmostEqual(result["total"]["usd_equivalent"], 0.3)
        self.assertEqual(result["usd_tolerance"], {"absolute": 1e-9, "relative": 1e-9})
        self.journals([call_record(1, usd=0.1)], [evaluation("selection", 1, 10, 0.100001)])
        with self.assertRaises(ValueError):
            report_spend(self.root)

    def test_zero_call_evaluation_is_valid_and_consumes_no_ledger_call(self):
        self.journals([call_record(1)], [evaluation("training", 0, 0, 0), evaluation("selection", 1, 10, 0.01)])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["buckets"]["training_evaluation"], {"calls": 0, "tokens": 0, "usd_equivalent": 0})
        self.assertEqual([span["call_ids"] for span in result["evaluation_spans"]], [[], [1]])

    def test_empty_journals_and_missing_files_do_not_claim_completed_measurement(self):
        missing = report_spend(self.root)
        self.assertEqual(missing["status"], "incomplete")
        self.assertEqual(missing["input_hashes"], {"calls.jsonl": None, "evaluations.jsonl": None})
        self.journals([], [])
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["total"], {"calls": 0, "tokens": 0, "usd_equivalent": 0})
        self.assertEqual(result["hidden_attempt_rate"], 0)
        self.assertEqual(result["hidden_attempts"], 0)
        self.assertEqual(result["failed_calls"], 0)
        self.assertEqual(result["issues"], [{"reason": "no_calls"}, {"reason": "no_evaluations"}])
        self.assertTrue(all(bucket == result["total"] for bucket in result["buckets"].values()))

    def test_missing_evaluation_journal_keeps_every_call(self):
        self.journals([call_record(1), call_record(2, "proposer")], [])
        (self.root / "evaluations.jsonl").unlink()
        result = report_spend(self.root)
        self.assertEqual(result["status"], "incomplete")
        self.assertEqual(result["total"], {"calls": 2, "tokens": 20, "usd_equivalent": 0.02})
        self.assertEqual(result["buckets"]["unassigned"]["calls"], 1)
        self.assertEqual(result["buckets"]["proposal"]["calls"], 1)
        self.assertEqual(result["input_hashes"]["evaluations.jsonl"], None)

    def test_missing_retry_observation_does_not_invent_observed_attempts(self):
        call = call_record(1)
        call["retry_observation"] = {}
        self.journals([call], [evaluation("selection", 1, 10, 0.01)])
        result = report_spend(self.root)
        self.assertEqual(result["hidden_attempts"], 0)
        self.assertEqual(result["retry_observation_missing_calls"], 1)
        self.assertEqual(result["total"]["calls"], 1)

    def test_invalid_accounting_values_and_call_order_are_rejected(self):
        for field, value in (("reported_tokens", -1), ("reported_tokens", True), ("usd_equivalent", float("nan")),
                             ("usd_equivalent", -0.01), ("call", 2), ("failed", 1), ("usage_missing", None),
                             ("retry_observation", {"hiddenAttempts": -1}), ("retry_observation", {"logEvents": True})):
            with self.subTest(field=field, value=value):
                call = call_record(1)
                call[field] = value
                self.journals([call], [evaluation("selection", 1, 10, 0.01)])
                with self.assertRaises(ValueError):
                    report_spend(self.root)
        for field, value in (("partition", "train"), ("deployment_calls", -1), ("deployment_tokens", True),
                             ("deployment_usd", float("inf"))):
            with self.subTest(field=field, value=value):
                record = evaluation("training", 1, 10, 0.01)
                record[field] = value
                self.journals([call_record(1)], [record])
                with self.assertRaises(ValueError):
                    report_spend(self.root)


if __name__ == "__main__":
    unittest.main()
