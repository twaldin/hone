import importlib.metadata
import importlib.util
import json
import math
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from pilot.runtime import BudgetExhausted, CallFailed
from pilot.search import GEPA_COMMIT, _artifact, _project_noise, _validate_artifact, run_search
from pilot.tasks import Task


def task():
    return Task(name="synthetic", train=[{"id": f"t{i}", "input": "train"} for i in range(40)],
                selection=[{"id": f"s{i}", "input": "selection", "sealed": "never expose"} for i in range(3)],
                manifest={"deployment_contract": "Return an answer."}, seed_candidate={"prompt": "seed"})


class SearchTests(unittest.TestCase):
    def test_artifact_rejects_wrong_keys_duplicates_empty_and_oversize(self):
        for raw in ['{"prompt":"x","extra":"y"}', '{"prompt":"a","prompt":"b"}',
                    '{"prompt":""}', '{"prompt":7}', json.dumps({"prompt": "a" * 65536})]:
            with self.subTest(raw=raw[:80]), self.assertRaises(ValueError):
                _artifact(raw, {"prompt"})

    def test_complete_mapping_validation_does_not_parse_component_text(self):
        candidate = {"prompt": "Explain the task.", "program": "print('not JSON')"}
        self.assertEqual(_validate_artifact(candidate, {"prompt", "program"}), candidate)
        for invalid in ({"prompt": "x"}, {"prompt": "x", "program": " "},
                        {"prompt": "x", "program": 1},
                        {"prompt": "é" * 15000, "program": "x" * 40000}):
            with self.subTest(candidate=str(invalid)[:80]), self.assertRaises(ValueError):
                _validate_artifact(invalid, {"prompt", "program"})

    def test_plain_charges_seed_and_does_not_rescore_winner(self):
        evaluated, calls = [], []
        def evaluate(candidate, rows, capture_traces=False):
            evaluated.append((dict(candidate), [row["id"] for row in rows]))
            score = 1.0 if candidate == {"prompt": "better"} else 0.0
            return {"scores": [score] * len(rows), "outputs": ["answer"] * len(rows),
                    "trajectories": [{"failure": "training only"}] * len(rows)}
        def call(role, messages, max_tokens):
            calls.append((role, messages, max_tokens))
            return '{"prompt":"better"}'
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("plain", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertEqual(result["selection_score"], 1)
        self.assertEqual(result["stop_reason"], "max_proposals")
        self.assertEqual(result["valid_proposals"], 1)
        self.assertEqual(result["policy"], {"selection": "strict aggregate improvement"})
        self.assertEqual(len(evaluated), 3)
        self.assertEqual(calls[0][0], "proposer")
        self.assertEqual(calls[0][2], 2048)
        self.assertNotIn("never expose", json.dumps(calls))

    def test_mbpp_proposer_receives_native_scoring_contract_without_assertions(self):
        mbpp = Task("mbpp",
                    [{"id": "mbpp:train:1", "input": "Increment.", "test_list": ["assert training_secret"]}],
                    [{"id": "mbpp:validation:1", "input": "Increment.", "test_list": ["assert selection_secret"]}],
                    {}, {"prompt": "seed", "program": "original program"})
        requests = []
        def evaluate(candidate, rows, capture_traces=False):
            return {"scores": [0.0] * len(rows), "outputs": [""] * len(rows),
                    "trajectories": [{"feedback": "failed"}] * len(rows) if capture_traces else []}
        def call(role, messages, tokens):
            requests.append(messages)
            return json.dumps(mbpp.seed_candidate)
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("plain", mbpp, call, evaluate, lambda: True, {}, 0, Path(directory), 1)
        contract = json.loads(requests[0][0]["content"])["contract"]["deployment_contract"]
        self.assertEqual(contract["model_calls_per_row"], 2)
        self.assertEqual(contract["total_requested_output_tokens"], 4096)
        self.assertEqual(contract["solution_seconds"], 10)
        self.assertNotIn("solution_function_calls", contract)
        self.assertNotIn("solution_call_input_bytes", contract)
        self.assertIn("```python", contract["solution_answer_extraction"])
        self.assertIn("same namespace", contract["solution_semantics"])
        self.assertIn("completion receipt", contract["solution_semantics"])
        self.assertIn("not secret", contract["solution_semantics"])
        self.assertNotIn("training_secret", json.dumps(requests))
        self.assertNotIn("selection_secret", json.dumps(requests))
        self.assertEqual(result["candidate"], mbpp.seed_candidate)

    def test_budget_interrupt_retains_last_complete_candidate(self):
        full = 0
        def evaluate(candidate, rows, capture_traces=False):
            nonlocal full
            if rows[0]["id"].startswith("s"):
                full += 1
                if full == 3:
                    raise BudgetExhausted("synthetic budget")
            score = 0.5 if candidate["prompt"] == "better" else 0
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        proposals = iter(['{"prompt":"better"}', '{"prompt":"unfinished"}'])
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("plain", task(), lambda *args: next(proposals), evaluate,
                                lambda: True, {}, 0, Path(directory), 2)
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertEqual(result["selection_score"], 0.5)
        self.assertEqual(result["stop_reason"], "budget_exhausted")
        self.assertEqual(result["valid_proposals"], 2)

    def test_malformed_artifact_is_charged_and_cannot_replace_seed(self):
        evaluated = []
        def evaluate(candidate, rows, capture_traces=False):
            evaluated.append(candidate)
            return {"scores": [0] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("plain", task(), lambda *args: "not JSON", evaluate,
                                lambda: True, {}, 0, Path(directory), 1)
        self.assertIn("__invalid_artifact__", evaluated[-1])
        self.assertEqual(result["candidate"], task().seed_candidate)
        self.assertIsNotNone(result["trajectory"][0]["artifact_error"])
        self.assertEqual(result["valid_proposals"], 0)

    def test_hone_refreshes_full_paired_parent_before_child(self):
        seen = []
        def evaluate(candidate, rows, capture_traces=False):
            seen.append((candidate["prompt"], tuple(row["id"] for row in rows)))
            value = float(candidate["prompt"] == "better")
            return {"scores": [value] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        def policy(seed, episode, parent, child, noise):
            return {"parent": "incumbent", "epsilon": 0.2, "oneRepair": True, "gate": {"passed": child > parent}}
        with tempfile.TemporaryDirectory() as directory, patch("pilot.search._policy", policy):
            result = run_search("hone", task(), lambda *args: '{"prompt":"better"}', evaluate,
                                lambda: True, {"noiseFloor": 0, "noiseEnvelope": 0}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertEqual(seen[-2][0], "seed")
        self.assertEqual(seen[-1][0], "better")
        self.assertEqual(seen[-2][1], seen[-1][1])
        self.assertEqual(seen[2][1], seen[3][1])

    def test_hone_doubles_uncertain_train_slice_and_rejects_unresolved(self):
        seen = []
        def evaluate(candidate, rows, capture_traces=False):
            seen.append((candidate["prompt"], len(rows)))
            score = 0.09 if candidate["prompt"] == "uncertain" else 0
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory, patch(
            "pilot.search._policy", return_value={"parent": "incumbent", "epsilon": 0.2, "oneRepair": True, "gate": {"passed": False}}
        ):
            result = run_search("hone", task(), lambda *args: '{"prompt":"uncertain"}', evaluate,
                                lambda: True, {"noiseFloor": 0.05, "noiseEnvelope": 0.2},
                                0, Path(directory), 1)
        self.assertEqual([n for prompt, n in seen if prompt == "uncertain"], [8, 16, 32])
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertFalse(result["trajectory"][0]["accepted"])
        self.assertEqual(sum(n == 3 for _, n in seen), 1)

    def test_noise_projection_preserves_identity_trials_and_equivalent_bounds(self):
        calibration = {"pairedDeltaSd": 0.1, "maxObservedPairDelta": 0.15,
                       "noiseFloor": 0.3 / math.sqrt(2), "noiseEnvelope": 0.45 / math.sqrt(2),
                       "pairedDeltaTrials": 16, "sourceCohortSha256": ["frozen"], "measurementEpoch": "original"}
        for n in (8, 16, 32, 45, 90, 300):
            projected, metadata = _project_noise(
                {"calibration": calibration, "noise_design": {"rows_per_arm": 8}}, n)
            result = projected["calibration"]
            factor = math.sqrt(8 / n)
            for field in ("pairedDeltaSd", "maxObservedPairDelta", "noiseFloor", "noiseEnvelope"):
                self.assertAlmostEqual(result[field], calibration[field] * factor)
            self.assertAlmostEqual(result["noiseFloor"], result["pairedDeltaSd"] * 3 / math.sqrt(2))
            self.assertAlmostEqual(result["noiseEnvelope"], result["pairedDeltaSd"] * 4.5 / math.sqrt(2))
            self.assertEqual(result["pairedDeltaTrials"], 16)
            self.assertEqual(result["sourceCohortSha256"], ["frozen"])
            self.assertEqual(result["measurementEpoch"], "original")
            self.assertEqual(metadata["target_rows_per_arm"], n)
        projected, _ = _project_noise({"calibration": calibration, "noise_design": {"rows_per_arm": 16}}, 64)
        self.assertEqual(projected["calibration"]["pairedDeltaSd"], 0.05)
        self.assertEqual(calibration["pairedDeltaSd"], 0.1)

    def test_failed_proposer_retains_seed_and_records_rejection(self):
        for method in ("plain", "hone"):
            def evaluate(candidate, rows, capture_traces=False):
                return {"scores": [0.5] * len(rows), "outputs": [""] * len(rows),
                        "trajectories": [{}] * len(rows)}
            with tempfile.TemporaryDirectory() as directory, patch(
                "pilot.search._policy", return_value={"parent": "incumbent", "epsilon": 0.2, "oneRepair": True}
            ):
                result = run_search(method, task(), lambda *args: (_ for _ in ()).throw(CallFailed("refused")),
                                    evaluate, lambda: True, {}, 0, Path(directory), 1)
            self.assertEqual(result["candidate"], {"prompt": "seed"})
            self.assertEqual(result["selection_score"], 0.5)
            self.assertFalse(result["trajectory"][0]["accepted"])
            self.assertIn("refused", result["trajectory"][0]["call_failure"])
            self.assertEqual(result["valid_proposals"], 0)

    def test_hone_malformed_proposal_gets_one_repair_without_parent_gate_work(self):
        for repair_output in ("still malformed", CallFailed("repair refused")):
            evaluated, roles = [], []
            def evaluate(candidate, rows, capture_traces=False):
                evaluated.append((candidate, len(rows)))
                return {"scores": [0] * len(rows), "outputs": [""] * len(rows),
                        "trajectories": [{}] * len(rows)}
            def call(role, messages, max_tokens):
                roles.append((role, max_tokens))
                if role == "repair" and isinstance(repair_output, Exception):
                    raise repair_output
                return repair_output if role == "repair" else "not JSON"
            with tempfile.TemporaryDirectory() as directory, patch(
                "pilot.search._policy", return_value={"parent": "incumbent", "epsilon": 0.2, "oneRepair": True}
            ):
                result = run_search("hone", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
            self.assertEqual(roles, [("proposer", 2048), ("repair", 2048)])
            self.assertEqual([n for _, n in evaluated], [3, 8])
            self.assertEqual(result["candidate"], {"prompt": "seed"})
            self.assertFalse(result["trajectory"][0]["accepted"])
            self.assertEqual(result["valid_proposals"], 0)

    def test_plain_equal_scores_strictly_retain_seed(self):
        def evaluate(candidate, rows, capture_traces=False):
            return {"scores": [0.5] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("plain", task(), lambda *args: '{"prompt":"equal"}', evaluate,
                                lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertFalse(result["trajectory"][0]["accepted"])
        self.assertEqual(result["valid_proposals"], 1)

    def test_incomplete_candidate_never_becomes_incumbent(self):
        def evaluate(candidate, rows, capture_traces=False):
            count = len(rows) - 1 if candidate == {"prompt": "incomplete"} else len(rows)
            return {"scores": [1] * count, "outputs": [""] * count, "trajectories": [{}] * count}
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "incomplete"):
            run_search("plain", task(), lambda *args: '{"prompt":"incomplete"}', evaluate,
                       lambda: True, {}, 0, Path(directory), 1)

    def test_budget_exhaustion_records_known_binding_cap(self):
        def evaluate(candidate, rows, capture_traces=False):
            if candidate == {"prompt": "unfinished"}:
                error = BudgetExhausted("next call would exceed token cap")
                error.binding_cap = "tokens"
                raise error
            return {"scores": [0] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("plain", task(), lambda *args: '{"prompt":"unfinished"}', evaluate,
                                lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertEqual(result["binding_cap"], "tokens")

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_real_native_gepa_reflection_and_budget_retention(self):
        direct = json.loads(importlib.metadata.distribution("gepa").read_text("direct_url.json") or "{}")
        if direct.get("vcs_info", {}).get("commit_id") != GEPA_COMMIT:
            self.skipTest("GEPA is not the pinned revision")
        calls, seen = [], []
        def call(role, messages, max_tokens):
            calls.append((role, messages, max_tokens))
            self.assertNotIn("never expose", json.dumps(messages))
            return "```\nbetter\n```"
        def evaluate(candidate, rows, capture_traces=False):
            seen.append((candidate, len(rows)))
            score = float(candidate == {"prompt": "better"})
            return {"scores": [score] * len(rows), "outputs": ["answer"] * len(rows),
                    "trajectories": [{"feedback": "training correction"}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("gepa", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertEqual(result["selection_score"], 1)
        self.assertEqual(result["proposals"], 1)
        self.assertEqual(result["valid_proposals"], 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "proposer")
        self.assertEqual(calls[0][2], 2048)
        self.assertEqual(sum(n == 3 for _, n in seen), 2)
        self.assertEqual(json.dumps(calls[0][1]).count("selection_feedback"), 1)

    def test_hone_repaired_artifact_can_promote_with_projected_selection_gate(self):
        calls, gate_calibrations = [], []
        def evaluate(candidate, rows, capture_traces=False):
            score = 1.0 if candidate == {"prompt": "better"} else 0.0
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        def call(role, messages, max_tokens):
            calls.append(role)
            return '{"prompt":"better"}' if role == "repair" else "bad JSON"
        def policy(seed, episode, parent, child, noise):
            if child > parent:
                gate_calibrations.append(noise["calibration"])
            return {"parent": "incumbent", "epsilon": 0.2, "oneRepair": True, "gate": {"passed": child > parent}}
        calibration = {"noiseFloor": 0.01, "noiseEnvelope": 0.02}
        with tempfile.TemporaryDirectory() as directory, patch("pilot.search._policy", policy):
            result = run_search("hone", task(), call, evaluate, lambda: True,
                                {"calibration": calibration, "noise_design": {"rows_per_arm": 8}},
                                0, Path(directory), 1)
        self.assertEqual(calls, ["proposer", "repair"])
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertTrue(result["trajectory"][0]["accepted"])
        self.assertEqual(result["valid_proposals"], 1)
        self.assertEqual(len(gate_calibrations), 2)
        for projected in gate_calibrations:
            self.assertAlmostEqual(projected["noiseEnvelope"], 0.02 * math.sqrt(8 / 3))

    def test_hone_training_gate_does_not_double_count_empirical_standard_error(self):
        def evaluate(candidate, rows, capture_traces=False):
            scores = ([0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0]
                      if candidate == {"prompt": "variable"} and len(rows) == 8
                      else [float(candidate == {"prompt": "variable"})] * len(rows))
            return {"scores": scores, "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory, patch(
            "pilot.search._policy",
            return_value={"parent": "incumbent", "epsilon": 0.2, "oneRepair": True, "gate": {"passed": True}}
        ):
            result = run_search("hone", task(), lambda *args: '{"prompt":"variable"}', evaluate,
                                lambda: True, {"noiseFloor": 0.1, "noiseEnvelope": 0.2}, 0, Path(directory), 1)
        self.assertTrue(result["trajectory"][0]["accepted"])
        self.assertEqual([gate["n"] for gate in result["trajectory"][0]["training_gates"]], [8])

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_gepa_perfect_minibatch_keeps_sampling_until_real_proposal(self):
        calls, captures = [], []
        def evaluate(candidate, rows, capture_traces=False):
            if capture_traces:
                captures.append([row["id"] for row in rows])
            score = 1.0 if capture_traces and len(captures) == 1 else 0.0
            return {"scores": [score] * len(rows), "outputs": ["answer"] * len(rows),
                    "trajectories": [{"feedback": "training"}] * len(rows)}
        def call(role, messages, max_tokens):
            calls.append(role)
            return "better"
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("gepa", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
        self.assertGreaterEqual(len(captures), 2)
        self.assertEqual(calls, ["proposer"])
        self.assertEqual(result["proposals"], 1)
        self.assertEqual(result["valid_proposals"], 1)

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_gepa_all_perfect_train_stops_at_metric_cap_without_false_proposal(self):
        def evaluate(candidate, rows, capture_traces=False):
            return {"scores": [1.0] * len(rows), "outputs": ["answer"] * len(rows),
                    "trajectories": [{}] * len(rows)}
        def call(*args):
            self.fail("Native perfect-skip must remain enabled")
        with tempfile.TemporaryDirectory() as directory, patch("pilot.search.GEPA_METRIC_CALL_CAP", 30):
            result = run_search("gepa", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertEqual(result["proposals"], 0)
        self.assertEqual(result["valid_proposals"], 0)
        self.assertEqual(result["binding_cap"], "gepa_metric_calls")
        self.assertNotEqual(result["stop_reason"], "max_proposals")

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_real_native_gepa_interrupt_keeps_seed(self):
        direct = json.loads(importlib.metadata.distribution("gepa").read_text("direct_url.json") or "{}")
        if direct.get("vcs_info", {}).get("commit_id") != GEPA_COMMIT:
            self.skipTest("GEPA is not the pinned revision")
        def evaluate(candidate, rows, capture_traces=False):
            if candidate == {"prompt": "better"} and rows[0]["id"].startswith("s"):
                raise BudgetExhausted("selection interrupted")
            score = float(candidate == {"prompt": "better"})
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("gepa", task(), lambda *args: "```\nbetter\n```",
                                evaluate, lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertEqual(result["selection_score"], 0)
        self.assertEqual(result["stop_reason"], "budget_exhausted")
        self.assertEqual(result["valid_proposals"], 1)

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_real_native_gepa_rejects_failed_reflection_then_can_improve(self):
        attempts = [0]
        def call(*args):
            attempts[0] += 1
            if attempts[0] <= 2:
                raise CallFailed("provider refusal")
            return "better"
        def evaluate(candidate, rows, capture_traces=False):
            score = float(candidate == {"prompt": "better"})
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("gepa", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 2)
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertEqual(result["selection_score"], 1)
        self.assertEqual(result["proposals"], 2)
        self.assertEqual(result["valid_proposals"], 1)

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_real_native_gepa_does_not_swallow_evaluator_failure(self):
        def evaluate(candidate, rows, capture_traces=False):
            if capture_traces:
                raise ValueError("metric unavailable")
            return {"scores": [0] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "metric unavailable"):
            run_search("gepa", task(), lambda *args: self.fail("No proposal before feedback"), evaluate,
                       lambda: True, {}, 0, Path(directory), 2)

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_native_gepa_edits_components_and_retains_unaffected_fields(self):
        current = task()
        current.name = "mbpp"
        current.seed_candidate = {"prompt": "seed", "program": "print('seed')"}
        program = "print('improved program')"
        replies = iter(["```\nbetter\n```", f"```python\n{program}\n```"])
        seen = []
        def evaluate(candidate, rows, capture_traces=False):
            seen.append(dict(candidate))
            score = 0.25 * (candidate.get("prompt") == "better") + 0.25 * (candidate.get("program") == program)
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows),
                    "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("gepa", current, lambda *args: next(replies), evaluate,
                                lambda: True, {}, 0, Path(directory), 2)
        self.assertIn({"prompt": "better", "program": "print('seed')"}, seen)
        self.assertEqual(result["candidate"], {"prompt": "better", "program": program})
        self.assertEqual(result["valid_proposals"], 2)
        self.assertTrue(all(set(candidate) == {"prompt", "program"} for candidate in seen))

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_native_gepa_invalid_proposal_cannot_count_toward_smoke(self):
        for reply in ("```\n \n```", "x" * 30000):
            current = task()
            current.seed_candidate = {"prompt": "seed", "program": "x" * 40000}
            seen = []
            def evaluate(candidate, rows, capture_traces=False):
                seen.append(candidate)
                return {"scores": [0] * len(rows), "outputs": [""] * len(rows),
                        "trajectories": [{}] * len(rows)}
            with self.subTest(reply_length=len(reply)), tempfile.TemporaryDirectory() as directory:
                result = run_search("gepa", current, lambda *args: reply, evaluate,
                                    lambda: True, {}, 0, Path(directory), 1)
                self.assertEqual(result["proposals"], 1)
                self.assertEqual(result["valid_proposals"], 0)
                self.assertEqual(result["candidate"], current.seed_candidate)
                if len(reply) == 30000:
                    self.assertIn("UTF-8 bytes", result["trajectory"][0]["artifact_error"])
                    self.assertTrue(any("__invalid_artifact__" in candidate for candidate in seen))

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_native_gepa_budget_interrupt_retains_accepted_incumbent(self):
        replies = iter(["better", "unfinished"])
        def evaluate(candidate, rows, capture_traces=False):
            if candidate == {"prompt": "unfinished"} and rows[0]["id"].startswith("s"):
                raise BudgetExhausted("selection interrupted")
            score = {"seed": 0, "better": 0.25, "unfinished": 0.5}[candidate["prompt"]]
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows),
                    "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory:
            result = run_search("gepa", task(), lambda *args: next(replies), evaluate,
                                lambda: True, {}, 0, Path(directory), 2)
        self.assertEqual(result["candidate"], {"prompt": "better"})
        self.assertEqual(result["selection_score"], 0.25)
        self.assertEqual(result["valid_proposals"], 2)
        self.assertEqual(result["stop_reason"], "budget_exhausted")

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_native_gepa_fatal_reflection_failure_does_not_retry_transport(self):
        for failure in (BudgetExhausted("proposer budget exhausted"), ValueError("fatal proposer failure")):
            calls = []
            def call(*args):
                calls.append(args)
                raise failure
            def evaluate(candidate, rows, capture_traces=False):
                return {"scores": [0] * len(rows), "outputs": [""] * len(rows),
                        "trajectories": [{}] * len(rows)}
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as directory:
                if isinstance(failure, BudgetExhausted):
                    result = run_search("gepa", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
                    self.assertEqual(result["candidate"], {"prompt": "seed"})
                    self.assertEqual(result["stop_reason"], "budget_exhausted")
                    self.assertEqual(result["valid_proposals"], 0)
                else:
                    with self.assertRaisesRegex(ValueError, "fatal proposer failure"):
                        run_search("gepa", task(), call, evaluate, lambda: True, {}, 0, Path(directory), 1)
                self.assertEqual(len(calls), 1)
