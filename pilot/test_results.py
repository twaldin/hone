import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pilot.results import align_scores, extract_pair, hierarchical_bootstrap, main, paired_bootstrap, report_results


def digest(value):
    return "sha256:" + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def fixture(task="mbpp", method="hone", changed=True):
    seed = {"prompt": "seed"}
    chosen = {"prompt": "chosen"} if changed else seed
    manifest = {"identity": {"task": {"task": task, "selection_ids": ["a", "b"]}}}
    search = {"seed": 0, "method": method, "contract": {"task": task, "editable_artifact": seed},
              "candidate": chosen, "selection_score": 1.0 if changed else .5}
    result = {"task": task, "seed": 0, "method": method, "candidate_hash": digest(chosen),
              "selection_score": search["selection_score"], "status": "completed"}
    evaluations = [evaluation(seed, [0, 1]), evaluation(chosen, [1, 1])]
    return manifest, search, result, evaluations


def evaluation(artifact, scores, rows=None):
    return {"partition": "selection", "artifact_hash": digest(artifact), "row_ids": rows or ["a", "b"], "scores": scores}


class BootstrapTests(unittest.TestCase):
    def test_paired_not_unpaired_constant_improvement(self):
        baseline = {"a": 0, "b": 100, "c": -100}
        chosen = {"c": -99, "a": 1, "b": 101}
        report = paired_bootstrap(baseline, chosen)
        self.assertEqual(report["delta"], 1)
        self.assertEqual(report["ci95"], [1, 1])
        self.assertTrue(report["interval_excludes_zero"])
        self.assertTrue(report["interval_above_practical_threshold"])
        self.assertEqual(report["resamples"], 10000)
        self.assertEqual(report["rng_seed"], 20261109)
        self.assertEqual(report["rng_engine"], "stdlib random.Random (MT19937)")
        self.assertEqual(report["percentile_method"], "type7_linear")

    def test_exact_zero_and_replay_determinism(self):
        vector = {"a": 0, "b": 1}
        report = paired_bootstrap(vector, vector)
        self.assertEqual(report["delta"], 0)
        self.assertEqual(report["ci95"], [0, 0])
        self.assertFalse(report["interval_excludes_zero"])
        mixed = paired_bootstrap(vector, {"a": 1, "b": 0})
        self.assertEqual(mixed, paired_bootstrap(vector, {"b": 0, "a": 1}))
        self.assertEqual(mixed["ci95"], [-1, 1])

    def test_equal_task_weight_and_hierarchical_task_resampling(self):
        small = ({"x": 0}, {"x": 1})
        large = ({str(i): 0 for i in range(9)}, {str(i): 0 for i in range(9)})
        report = hierarchical_bootstrap({"mbpp": small, "hover": large})
        self.assertEqual(report["delta"], .5)
        self.assertEqual(report["baseline_score"], 0)
        self.assertEqual(report["chosen_score"], .5)
        self.assertEqual(report["ci95"], [0, 1])
        self.assertEqual(report["task_weighting"], "equal")
        self.assertEqual(report, hierarchical_bootstrap({"hover": large, "mbpp": small}))

    def test_missing_task_and_mismatched_pair_rejected(self):
        with self.assertRaises(ValueError):
            hierarchical_bootstrap({"mbpp": ({"a": 0}, {"a": 1})})
        with self.assertRaises(ValueError):
            paired_bootstrap({"a": 0}, {"b": 1})

    def test_alignment_rejects_duplicate_missing_extra_and_nonfinite(self):
        self.assertEqual(align_scores(["b", "a"], [1, 0], ["a", "b"]), {"a": 0, "b": 1})
        cases = [(["a", "a"], [0, 1], ["a", "b"]), (["a"], [0], ["a", "b"]),
                 (["a", "b", "c"], [0, 1, 0], ["a", "b"]), (["a", "b"], [0], ["a", "b"]),
                 (["a", "b"], [0, 1], ["a", "a"]), (["a"], [float("nan")], ["a"]),
                 (["a"], [float("inf")], ["a"]), (["a"], [True], ["a"])]
        for args in cases:
            with self.subTest(args=args), self.assertRaises(ValueError):
                align_scores(*args)


class ExtractionTests(unittest.TestCase):
    def test_first_seed_last_matching_changed_vector_not_pooling(self):
        manifest, search, result, evaluations = fixture()
        chosen = search["candidate"]
        search["selection_score"] = result["selection_score"] = .5
        evaluations.extend([evaluation(search["contract"]["editable_artifact"], [1, 1]),
                            evaluation(chosen, [1, 0]), evaluation(chosen, [0, 1]),
                            evaluation(chosen, [0, 0])])
        pair, evidence = extract_pair(manifest, search, result, evaluations)
        self.assertEqual(pair, ({"a": 0, "b": 1}, {"a": 0, "b": 1}))
        self.assertEqual(evidence["baseline_evaluation_line"], 1)
        self.assertEqual(evidence["chosen_evaluation_line"], 5)
        self.assertEqual(paired_bootstrap(*pair)["delta"], 0)

    def test_unchanged_winner_reuses_exact_baseline_despite_reevaluation(self):
        manifest, search, result, evaluations = fixture(changed=False)
        pair, evidence = extract_pair(manifest, search, result, evaluations)
        self.assertIs(pair[0], pair[1])
        self.assertEqual(evidence["chosen_evaluation_line"], 1)
        self.assertEqual(paired_bootstrap(*pair)["ci95"], [0, 0])

    def test_selection_row_order_is_aligned(self):
        manifest, search, result, evaluations = fixture()
        evaluations[0].update(row_ids=["b", "a"], scores=[1, 0])
        pair, _ = extract_pair(manifest, search, result, evaluations)
        self.assertEqual(pair[0], {"a": 0, "b": 1})

    def test_incomplete_evaluations_not_silently_joined(self):
        manifest, search, result, evaluations = fixture(method="gepa")
        evaluations = [evaluations[0], evaluation(search["candidate"], [1], ["a"]),
                       evaluation(search["candidate"], [1], ["b"])]
        pair, evidence = extract_pair(manifest, search, result, evaluations)
        self.assertIsNone(pair)
        self.assertEqual([row["line"] for row in evidence["incomplete_evaluations"]], [2, 3])
        self.assertIn("split", evidence["reason"])

    def test_missing_baseline_or_retained_score_match_has_no_inference(self):
        data = fixture()
        pair, _ = extract_pair(*data[:3], data[3][1:])
        self.assertIsNone(pair)
        data[2]["selection_score"] = data[1]["selection_score"] = .2
        pair, _ = extract_pair(*data)
        self.assertIsNone(pair)

    def test_mismatched_identity_hash_seed_method_and_bad_vectors_rejected(self):
        changes = [lambda m, s, r, e: r.update(seed=1),
                   lambda m, s, r, e: s.update(method="gepa"),
                   lambda m, s, r, e: m["identity"]["task"].update(task="hover"),
                   lambda m, s, r, e: m.update(identity_hash="sha256:wrong"),
                   lambda m, s, r, e: r.update(candidate_hash="sha256:wrong"),
                   lambda m, s, r, e: r.update(selection_score=.4),
                   lambda m, s, r, e: m.update(smoke_proposal_cap=1),
                   lambda m, s, r, e: e[0].update(row_ids=["a", "a"]),
                   lambda m, s, r, e: e[0].update(row_ids=["a", "extra"]),
                   lambda m, s, r, e: e[0].update(scores=[0, float("nan")]),
                   lambda m, s, r, e: e[0].update(arm="selection:wrong")]
        for change in changes:
            data = fixture()
            change(*data)
            with self.subTest(change=change), self.assertRaises(ValueError):
                extract_pair(*data)


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "runs"
        self.root.mkdir()

    def write_cell(self, task="mbpp", method="hone"):
        manifest, search, result, evaluations = fixture(task, method)
        result.update(wall_seconds=12, pauses=1, pause_seconds=2, hidden_attempts=3)
        root = self.root / task / "0" / method
        root.mkdir(parents=True)
        spend = {"schema": "pilot-spend-v1", "status": "complete", "total": {"calls": 4, "tokens": 20, "usd_equivalent": .3},
                 "buckets": {"proposal": {"calls": 1, "tokens": 10, "usd_equivalent": .1},
                             "selection_evaluation": {"calls": 3, "tokens": 10, "usd_equivalent": .2}},
                 "hidden_attempts": 3, "usage_missing_calls": 1, "refusals": 1, "issues": []}
        for name, value in (("manifest", manifest), ("search", search), ("result", result), ("spend", spend)):
            (root / (name + ".json")).write_text(json.dumps(value))
        (root / "evaluations.jsonl").write_text("".join(json.dumps(row) + "\n" for row in evaluations))
        (root / "calls.jsonl").write_text("")
        return root

    def test_partial_matrix_preserves_spend_without_missing_cell_zeros(self):
        root = self.write_cell()
        report = report_results(self.root)
        self.assertEqual(report["matrix_status"], "partial_or_stopped")
        self.assertEqual(len(report["cells"]), 6)
        self.assertIsNotNone(report["cells"][0]["inference"])
        self.assertIsNone(report["cells"][1]["inference"])
        hone = report["methods"]["hone"]
        self.assertIsNone(hone["inference"])
        self.assertEqual(hone["spend"]["totals"]["calls"], None)
        self.assertEqual(hone["spend"]["observed_subtotals"]["calls"], 4)
        self.assertEqual(hone["phases"]["proposal"]["observed_subtotals"]["tokens"], 10)
        self.assertIsNone(hone["timing"]["totals"]["wall_seconds"])
        self.assertEqual(hone["timing"]["available_cells"], 1)
        self.assertEqual(report["methods"]["gepa"]["timing"]["available_cells"], 0)
        self.assertEqual(report["methods"]["gepa"]["accounting"]["available_cells"], 0)
        self.assertEqual(report["cells"][0]["accounting"]["hidden_attempts"], 3)
        self.assertEqual(report["cells"][0]["input_hashes"]["result.json"],
                         "sha256:" + hashlib.sha256((root / "result.json").read_bytes()).hexdigest())

    def test_unchanged_artifact_delta_does_not_report_stochastic_remeasurement_as_gain(self):
        root = self.write_cell()
        search = json.loads((root / "search.json").read_text())
        search["candidate"] = search["contract"]["editable_artifact"]
        (root / "search.json").write_text(json.dumps(search))
        result = json.loads((root / "result.json").read_text())
        result["candidate_hash"] = digest(search["candidate"])
        (root / "result.json").write_text(json.dumps(result))
        cell = report_results(self.root)["cells"][0]
        self.assertFalse(cell["changed_artifact_retained"])
        self.assertEqual(cell["retained_selection_score"], 1)
        self.assertEqual(cell["inference"]["chosen_score"], .5)
        self.assertEqual(cell["inference"]["delta"], 0)
        self.assertEqual(cell["inference"]["ci95"], [0, 0])

    def test_cli_writes_json_outside_evidence_and_retains_raw_bytes(self):
        root = self.write_cell()
        before = (root / "evaluations.jsonl").read_bytes()
        out = self.root.parent / "report.json"
        main(["--runs", str(self.root), "--out", str(out)])
        report = json.loads(out.read_text())
        self.assertEqual(report["seed"], 0)
        self.assertTrue(report["label"].startswith("Development pilot, seed 0."))
        self.assertIn("no superiority", report["label"])
        self.assertEqual((root / "evaluations.jsonl").read_bytes(), before)
        with self.assertRaises(ValueError):
            main(["--runs", str(self.root), "--out", str(root / "result.json")])

    def test_stopped_cell_without_search_has_null_inference_and_full_usage(self):
        root = self.write_cell()
        (root / "search.json").unlink()
        result = json.loads((root / "result.json").read_text())
        result.update(status="infrastructure_failure", stop_reason="InterruptedRun")
        (root / "result.json").write_text(json.dumps(result))
        cell = report_results(self.root)["cells"][0]
        self.assertIsNone(cell["inference"])
        self.assertEqual(cell["spend"]["total"]["calls"], 4)
        self.assertEqual(cell["stop_reason"], "InterruptedRun")

    def test_cross_method_identity_mismatch_is_rejected(self):
        self.write_cell()
        root = self.write_cell(method="plain")
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["identity"]["route"] = "different"
        (root / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            report_results(self.root)

    def test_nonzero_seed_and_stale_spend_hash_are_rejected(self):
        root = self.write_cell()
        spend = json.loads((root / "spend.json").read_text())
        spend["input_hashes"] = {"calls.jsonl": "sha256:wrong"}
        (root / "spend.json").write_text(json.dumps(spend))
        with self.assertRaises(ValueError):
            report_results(self.root)
        (self.root / "hover" / "1" / "plain").mkdir(parents=True)
        with self.assertRaises(ValueError):
            report_results(self.root)

    def test_complete_method_sums_phases_and_equal_weight_task_inference(self):
        self.write_cell()
        self.write_cell(task="hover")
        method = report_results(self.root)["methods"]["hone"]
        self.assertEqual(method["spend"]["totals"]["calls"], 8)
        self.assertEqual(method["spend"]["totals"]["tokens"], 40)
        self.assertAlmostEqual(method["spend"]["totals"]["usd_equivalent"], .6)
        self.assertEqual(method["phases"]["proposal"]["totals"]["calls"], 2)
        self.assertEqual(method["timing"]["totals"]["wall_seconds"], 24)
        self.assertEqual(method["accounting"]["totals"]["hidden_attempts"], 6)
        self.assertEqual(method["inference"]["delta"], .5)
        self.assertEqual(method["inference"]["task_weighting"], "equal")


if __name__ == "__main__":
    unittest.main()
