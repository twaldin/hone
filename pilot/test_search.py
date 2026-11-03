import importlib.metadata
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.runtime import BudgetExhausted
from pilot.search import GEPA_COMMIT, _artifact, run_search
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
        self.assertEqual(len(evaluated), 3)
        self.assertEqual(calls[0][0], "proposer")
        self.assertEqual(calls[0][2], 2048)
        self.assertNotIn("never expose", json.dumps(calls))

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

    def test_hone_refreshes_full_paired_parent_before_child(self):
        seen = []
        def evaluate(candidate, rows, capture_traces=False):
            seen.append((candidate["prompt"], tuple(row["id"] for row in rows)))
            value = float(candidate["prompt"] == "better")
            return {"scores": [value] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        def policy(seed, episode, parent, child, noise):
            return {"parent": "incumbent", "gate": {"passed": child > parent}}
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
            score = 0.15 if candidate["prompt"] == "uncertain" else 0
            return {"scores": [score] * len(rows), "outputs": [""] * len(rows), "trajectories": [{}] * len(rows)}
        with tempfile.TemporaryDirectory() as directory, patch(
            "pilot.search._policy", return_value={"parent": "incumbent", "gate": {"passed": False}}
        ):
            result = run_search("hone", task(), lambda *args: '{"prompt":"uncertain"}', evaluate,
                                lambda: True, {"noiseFloor": 0.1, "noiseEnvelope": 0.2},
                                0, Path(directory), 1)
        self.assertEqual([n for prompt, n in seen if prompt == "uncertain"], [8, 16, 32])
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertFalse(result["trajectory"][0]["accepted"])
        self.assertEqual(sum(n == 3 for _, n in seen), 1)

    @unittest.skipUnless(importlib.util.find_spec("gepa"), "official GEPA package is not installed")
    def test_real_native_gepa_reflection_and_budget_retention(self):
        direct = json.loads(importlib.metadata.distribution("gepa").read_text("direct_url.json") or "{}")
        if direct.get("vcs_info", {}).get("commit_id") != GEPA_COMMIT:
            self.skipTest("GEPA is not the pinned revision")
        calls, seen = [], []
        def call(role, messages, max_tokens):
            calls.append((role, messages, max_tokens))
            self.assertNotIn("never expose", json.dumps(messages))
            return '```json\n{"prompt":"better"}\n```'
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
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "proposer")
        self.assertEqual(calls[0][2], 2048)
        self.assertEqual(sum(n == 3 for _, n in seen), 2)

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
            result = run_search("gepa", task(), lambda *args: '```json\n{"prompt":"better"}\n```',
                                evaluate, lambda: True, {}, 0, Path(directory), 1)
        self.assertEqual(result["candidate"], {"prompt": "seed"})
        self.assertEqual(result["selection_score"], 0)
        self.assertEqual(result["stop_reason"], "budget_exhausted")
