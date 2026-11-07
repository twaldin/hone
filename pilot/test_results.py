import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pilot.results import align_scores, extract_pair, hierarchical_bootstrap, main, paired_bootstrap, report_results, report_seeds12, seeds_bootstrap


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

    def test_seed_bootstrap_resamples_seed_identity_before_paired_instances(self):
        small = ({"a": 0}, {"a": 1})
        large = ({str(i): 0 for i in range(9)}, {str(i): 0 for i in range(9)})
        report = seeds_bootstrap({1: small, 2: large})
        self.assertEqual(report["delta"], .5)
        self.assertEqual(report["baseline_score"], 0)
        self.assertEqual(report["chosen_score"], .5)
        self.assertEqual(report["ci95"], [0, 1])
        self.assertEqual(report["seed_weighting"], "equal")
        self.assertEqual(report["resamples"], 10000)
        self.assertEqual(report["rng_seed"], 20261109)
        self.assertEqual(report["percentile_method"], "type7_linear")
        self.assertEqual(report, seeds_bootstrap({2: large, 1: small}))
        with self.assertRaises(ValueError):
            seeds_bootstrap({1: small})
        with self.assertRaises(ValueError):
            seeds_bootstrap({0: small, 1: small, 2: large})
        with self.assertRaises(ValueError):
            seeds_bootstrap({1: ({"a": 0}, {"b": 1}), 2: large})


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

    def write_cell(self, task="mbpp", method="hone", *, seed=0, runs=None, baseline=None, chosen=None):
        manifest, search, result, evaluations = fixture(task, method)
        search.update(seed=seed, trajectory=[])
        result["seed"] = seed
        if baseline is not None:
            ids = list(baseline)
            manifest["identity"]["task"]["selection_ids"] = ids
            evaluations = [evaluation(search["contract"]["editable_artifact"], list(baseline.values()), ids),
                           evaluation(search["candidate"], [chosen[row] for row in ids], ids)]
            search["selection_score"] = result["selection_score"] = sum(chosen.values()) / len(chosen)
        result.update(wall_seconds=12, pauses=1, pause_seconds=2, hidden_attempts=3)
        root = (runs or self.root) / task / str(seed) / method
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

    def test_seed0_archive_replays_all_measurements_and_intervals(self):
        root = Path(__file__).resolve().parents[1]
        actual = json.loads(json.dumps(report_results(root / "evidence/pilot/seed0-search-9")))
        expected = json.loads((root / "evidence/pilot/results-9-seed0.json").read_text())
        actual.pop("reporter_sha256")
        expected.pop("reporter_sha256")
        self.assertEqual(actual, expected)

    def test_stopped_seeds12_archive_replays_measurements_and_missing_aggregates(self):
        root = Path(__file__).resolve().parents[1]
        runs = root / "evidence/pilot/seeds12-search-10"
        actual = report_seeds12(runs, runs, seed0_runs=root / "evidence/pilot/seed0-search-9")
        expected = json.loads((root / "evidence/pilot/results-10-seeds12.json").read_text())

        def measurements(value):
            if isinstance(value, dict):
                return {key: measurements(item) for key, item in value.items()
                        if key != "reporter_sha256"}
            if isinstance(value, list):
                return [measurements(item) for item in value]
            return value

        self.assertEqual(measurements(json.loads(json.dumps(actual))), measurements(expected))

    def test_real_seed0_diagnostics_remain_beside_stopped_seed_matrix(self):
        root = Path(__file__).resolve().parents[1]
        report = report_seeds12(self.root, self.root, seed0_runs=root / "evidence/pilot/seed0-search-9")
        historical = {(cell["task"], cell["method"]): cell["diagnostics"]
                      for cell in report["seed0_historical"]["cells"]}
        self.assertEqual({key: value["selection_evaluations_of_already_scored_artifacts"]
                          for key, value in historical.items()},
                         {("mbpp", "hone"): 5, ("mbpp", "gepa"): 0, ("mbpp", "plain"): 4,
                          ("hover", "hone"): 1, ("hover", "gepa"): 0, ("hover", "plain"): 0})
        self.assertTrue(all(value["duplicate_count_status"] == "exact_archived_count"
                            for value in historical.values()))
        missing = historical["hover", "hone"]["gate_passing_missing_selection_evidence"]
        self.assertEqual([entry["artifact_hash"] for entry in missing],
                         ["sha256:70a889a41a1a45187d03edf260ffcd5414bd8319cbcab954d52fd469a7c731c9"])
        self.assertEqual(missing[0]["binding_cap"], "usd_reservation")
        self.assertTrue(all(method["inference"] is None for method in report["methods"].values()))

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

    def test_interrupted_pause_prefix_is_not_an_exact_aggregate_total(self):
        cell_root = self.write_cell()
        self.write_cell(task="hover")
        result = json.loads((cell_root / "result.json").read_text())
        for incomplete in (True, False):
            with self.subTest(incomplete=incomplete):
                result.update(pause_seconds=12600, pause_accounting_incomplete=incomplete)
                (cell_root / "result.json").write_text(json.dumps(result))
                report = report_results(self.root)
                cell = report["cells"][0]
                timing = report["methods"]["hone"]["timing"]
                self.assertEqual(cell["pause_accounting_incomplete"], incomplete)
                self.assertEqual(cell["timing"]["pause_seconds"], 12600)
                self.assertFalse(report["cells"][3]["pause_accounting_incomplete"])
                self.assertEqual(timing["pause_accounting_incomplete"], incomplete)
                self.assertEqual(timing["observed_subtotals"]["pause_seconds"], 12602)
                if incomplete:
                    self.assertIsNone(timing["totals"]["pause_seconds"])
                    self.assertEqual(timing["lower_bounds"], {"pause_seconds": 12602})
                else:
                    self.assertEqual(timing["totals"]["pause_seconds"], 12602)
                    self.assertEqual(timing["lower_bounds"], {})

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

    def seed_roots(self):
        roots = [self.root.parent / f"seed{seed}" for seed in (1, 2)]
        for root in roots:
            root.mkdir()
        return roots

    def test_seeds12_equal_weight_and_historical_seed0_never_pooled(self):
        roots = self.seed_roots()
        for seed, root in zip((1, 2), roots):
            for task in ("mbpp", "hover"):
                ids = ["a"] if task == "mbpp" else [str(i) for i in range(9)]
                gain = 1 if seed == 1 and task == "mbpp" else 0
                self.write_cell(task, seed=seed, runs=root, baseline=dict.fromkeys(ids, 0), chosen=dict.fromkeys(ids, gain))
        self.write_cell()
        self.write_cell(task="hover")
        historical = report_results(self.root)
        report = report_seeds12(*roots, seed0_runs=self.root)
        hone = report["methods"]["hone"]
        self.assertEqual(hone["inference"]["delta"], .25)
        self.assertEqual(hone["inference"]["ci95"], [0, .75])
        self.assertEqual(hone["inference"]["baseline_score"], 0)
        self.assertEqual(hone["inference"]["chosen_score"], .25)
        self.assertEqual(hone["inference"]["seed_weighting"], "equal")
        self.assertEqual(hone["inference"]["task_weighting"], "equal")
        self.assertEqual(hone["tasks"]["mbpp"]["inference"]["delta"], .5)
        self.assertEqual(hone["tasks"]["hover"]["inference"]["delta"], 0)
        self.assertEqual(hone["spend"]["totals"]["calls"], 16)
        self.assertEqual(report["per_seed"]["1"]["methods"]["hone"]["inference"]["delta"], .5)
        self.assertEqual(report["per_seed"]["2"]["methods"]["hone"]["inference"]["delta"], 0)
        self.assertEqual(report["seed0_historical"]["methods"], historical["methods"])
        self.assertEqual(report["seed0_historical"]["seed"], 0)
        self.assertIn("seed 0", report["seed0_historical"]["label"])
        self.assertIn("unchanged official GEPA", report["seed0_historical"]["historical_context"])
        self.assertEqual(len(report["cells"]), 12)
        self.assertEqual(report["matrix_status"], "partial_or_stopped")
        self.assertIsNone(report["methods"]["gepa"]["inference"])

    def test_stopped_seed_matrix_never_reweights_missing_seed_or_task(self):
        roots = self.seed_roots()
        self.write_cell(seed=1, runs=roots[0])
        self.write_cell(task="hover", seed=1, runs=roots[0])
        tail_root = self.write_cell(seed=2, runs=roots[1])
        (tail_root / "search.json").unlink()
        report = report_seeds12(*roots)
        self.assertIsNotNone(report["per_seed"]["1"]["methods"]["hone"]["inference"])
        self.assertIsNone(report["methods"]["hone"]["inference"])
        self.assertIsNone(report["methods"]["hone"]["tasks"]["mbpp"]["inference"])
        self.assertIsNone(report["methods"]["hone"]["spend"]["totals"]["calls"])
        self.assertEqual(report["methods"]["hone"]["spend"]["observed_subtotals"]["calls"], 12)
        stopped = next(cell for cell in report["cells"] if cell["seed"] == 2 and cell["task"] == "mbpp" and cell["method"] == "hone")
        self.assertIsNone(stopped["diagnostics"]["gate_passing_candidates_without_complete_selection"])

    def test_duplicate_evaluations_and_started_tail_count_for_unchanged_gepa(self):
        roots = self.seed_roots()
        root = self.write_cell(method="gepa", seed=1, runs=roots[0])
        rows = [json.loads(line) for line in (root / "evaluations.jsonl").read_text().splitlines()]
        rows.append(rows[1].copy())
        for row in rows:
            row["deployment_calls"] = 2
        calls = [{"call": n, "role": "task", "context": {"arm": "selection:" + rows[(n - 1) // 2]["artifact_hash"]}} for n in range(1, 7)]
        calls.extend({"call": n, "role": "task", "context": {"arm": "selection:" + rows[1]["artifact_hash"]}} for n in (7, 8))
        (root / "evaluations.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
        (root / "calls.jsonl").write_text("".join(json.dumps(call) + "\n" for call in calls))
        cell = report_seeds12(*roots)["cells"][1]
        diagnostics = cell["diagnostics"]
        self.assertEqual(diagnostics["selection_evaluations_of_already_scored_artifacts"], 2)
        self.assertEqual(diagnostics["observed_already_scored_selection_evaluations"], 2)
        self.assertEqual(diagnostics["already_scored_evidence"][0]["evaluation_line"], 3)
        self.assertEqual(diagnostics["already_scored_evidence"][1]["call_lines"], [7, 8])
        self.assertEqual(diagnostics["gate_count_status"], "not_applicable")
        self.assertIsNone(diagnostics["gate_passing_candidates_without_complete_selection"])

    def test_gate_passing_candidate_without_complete_selection_explains_budget_tail(self):
        roots = self.seed_roots()
        root = self.write_cell(seed=1, runs=roots[0])
        search = json.loads((root / "search.json").read_text())
        child = {"prompt": "unselected"}
        search.update(stop_reason="budget_exhausted", binding_cap="usd", budget_exhaustion="USD cap exhausted",
                      trajectory=[{"proposal": json.dumps(child), "training_gates": [{"passed": True}]},
                                  {"proposal": json.dumps(child), "training_gates": [{"passed": True}]}])
        (root / "search.json").write_text(json.dumps(search))
        rows = [json.loads(line) for line in (root / "evaluations.jsonl").read_text().splitlines()]
        rows.append(evaluation(child, [1], ["a"]))
        for row in rows:
            row["deployment_calls"] = len(row["scores"])
        calls = []
        for row in rows:
            for _ in row["scores"]:
                calls.append({"call": len(calls) + 1, "role": "task", "context": {"arm": "selection:" + row["artifact_hash"]}})
        calls.append({"call": 6, "role": "task", "context": {"arm": "selection:" + digest(child)}})
        (root / "evaluations.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
        (root / "calls.jsonl").write_text("".join(json.dumps(call) + "\n" for call in calls))
        diagnostics = report_seeds12(*roots)["cells"][0]["diagnostics"]
        self.assertEqual(diagnostics["selection_evaluations_of_already_scored_artifacts"], 0)
        self.assertEqual(diagnostics["gate_passing_candidates_without_complete_selection"], 1)
        evidence = diagnostics["gate_passing_missing_selection_evidence"][0]
        self.assertEqual(evidence["artifact_hash"], digest(child))
        self.assertEqual(evidence["trajectory_lines"], [1, 2])
        self.assertEqual(evidence["incomplete_evaluation_lines"], [3])
        self.assertEqual(evidence["started_tail_call_lines"], [6])
        self.assertEqual(evidence["binding_cap"], "usd")
        self.assertEqual(evidence["budget_exhaustion"], "USD cap exhausted")

    def test_missing_call_context_and_truncated_evidence_do_not_claim_zero_duplicates(self):
        roots = self.seed_roots()
        root = self.write_cell(seed=1, runs=roots[0])
        (root / "calls.jsonl").write_text(json.dumps({"call": 1, "role": "task"}) + "\n" + '{"call":')
        diagnostics = report_seeds12(*roots)["cells"][0]["diagnostics"]
        self.assertIsNone(diagnostics["selection_evaluations_of_already_scored_artifacts"])
        self.assertEqual(diagnostics["duplicate_count_status"], "observed_lower_bound")
        self.assertEqual(diagnostics["observed_already_scored_selection_evaluations"], 0)

    def test_cross_seed_identity_mismatch_and_seed0_inputs_are_rejected(self):
        roots = self.seed_roots()
        self.write_cell(seed=1, runs=roots[0])
        root = self.write_cell(seed=2, runs=roots[1])
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["identity"]["route"] = "different"
        (root / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaises(ValueError):
            report_seeds12(*roots)
        self.write_cell()
        with self.assertRaises(ValueError):
            report_seeds12(self.root, roots[1])

    def test_seeds12_cli_protects_all_raw_roots(self):
        roots = self.seed_roots()
        self.write_cell(seed=1, runs=roots[0])
        out = self.root.parent / "seeds12-report.json"
        main(["--runs-seed1", str(roots[0]), "--runs-seed2", str(roots[1]), "--out", str(out)])
        self.assertEqual(json.loads(out.read_text())["seeds"], [1, 2])
        for root in roots:
            with self.assertRaises(ValueError):
                main(["--runs-seed1", str(roots[0]), "--runs-seed2", str(roots[1]), "--out", str(root / "report.json")])

    def test_complete_matrix_can_share_one_dispatch_root(self):
        for seed in (1, 2):
            for task in ("mbpp", "hover"):
                for method in ("hone", "gepa", "plain"):
                    self.write_cell(task, method, seed=seed)
        report = report_seeds12(self.root, self.root)
        self.assertEqual(report["matrix_status"], "complete")
        self.assertEqual({cell["seed"] for cell in report["cells"]}, {1, 2})
        self.assertEqual(report["methods"]["plain"]["inference"]["delta"], .5)

    def test_new_matrix_keeps_strict_vectors_even_without_result(self):
        roots = self.seed_roots()
        root = self.write_cell(seed=1, runs=roots[0])
        (root / "result.json").unlink()
        evaluations = [json.loads(line) for line in (root / "evaluations.jsonl").read_text().splitlines()]
        evaluations[0]["row_ids"] = ["a", "a"]
        (root / "evaluations.jsonl").write_text("".join(json.dumps(row) + "\n" for row in evaluations))
        with self.assertRaises(ValueError):
            report_seeds12(*roots)

    def test_complete_selection_cache_reuse_is_not_a_missing_gate_candidate(self):
        roots = self.seed_roots()
        root = self.write_cell(seed=1, runs=roots[0])
        search = json.loads((root / "search.json").read_text())
        search["trajectory"] = [{"proposal": json.dumps(search["candidate"]), "training_gates": [{"passed": True}]}]
        (root / "search.json").write_text(json.dumps(search))
        diagnostics = report_seeds12(*roots)["cells"][0]["diagnostics"]
        self.assertEqual(diagnostics["gate_passing_candidates_without_complete_selection"], 0)
        self.assertEqual(diagnostics["selection_evaluations_of_already_scored_artifacts"], 0)

    def test_predeclaration11_refuses_pooling_policy10_cells(self):
        roots = self.seed_roots()
        self.write_cell(seed=1, runs=roots[0])
        with self.assertRaisesRegex(ValueError, "cannot pool a different grader policy"):
            report_seeds12(*roots, predeclaration=11)

    def test_unscored_infrastructure_is_reported_separately_not_as_a_pair(self):
        from unittest.mock import patch
        from pilot import program, verification
        from pilot.test_program import local_command, local_remove
        roots = self.seed_roots()
        cell = roots[0] / "mbpp/1/hone"
        cell.mkdir(parents=True)
        (cell / "manifest.json").write_text(json.dumps({"grader_policy": "predeclaration-11", "failure": True}))
        (cell / "result.json").write_text(json.dumps({"task": "mbpp", "seed": 1, "method": "hone",
                                                     "status": "infrastructure_failure"}))
        with patch.dict(verification._PLANS, clear=True), \
             patch.object(program, "docker_command", local_command), \
             patch.object(program, "_remove", local_remove), \
             verification.grader_journal(cell / "grader-outcomes.jsonl", purpose="search", task="mbpp", row_id="a"):
            with self.assertRaises(verification.GraderInfrastructureError):
                verification.score_solution("import os\nos._exit(7)", "def add(a,b): return a+b", "", ["assert add(1,2)==3"])
        report = report_seeds12(*roots, predeclaration=11)
        observed = report["cells"][0]
        self.assertEqual(observed["grader_outcomes"], {"search": {"nonzero_exit": 1}})
        self.assertIsNone(observed["inference"])
        self.assertIsNone(report["methods"]["hone"]["inference"])

if __name__ == "__main__":
    unittest.main()
