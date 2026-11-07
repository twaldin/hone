import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.admission import TRANSITION_9_HEAD, TRANSITION_10_HEAD, TRANSITION_11_HEAD, identity_source_hash, retained_transport_proof, transition9_baseline, transition11_baseline, transition_source


def sha(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.evidence = self.root / "evidence/pilot"
        self.evidence.mkdir(parents=True)
        (self.root / "pilot").mkdir()
        self.source = self.root / "pilot/runtime.py"
        self.source.write_text("new = 'refusal-aware'\n")
        (self.evidence / "predeclaration-8.md").write_text("frozen refusal policy\n")
        (self.evidence / "predeclaration-8a.md").write_text("native gzip observation only\n")
        (self.evidence / "source-transition-8.json").write_text('{"prior": "frozen refusal grant"}\n')
        snapshot = {"source_head": "ed610b55c95beea8ee4810dc2a709786f790d04c",
                    "files": {"pilot/runtime.py": "old = 'answered'\n"}}
        self.snapshot = self.evidence / "source-snapshot-7.json"
        self.snapshot.write_text(json.dumps(snapshot))
        self.receipt = {"version": "pilot-refusal-transition-v8a", "source_head": snapshot["source_head"],
                        "source_snapshot_hash": sha(self.snapshot.read_bytes()),
                        "predeclaration_hash": sha((self.evidence / "predeclaration-8.md").read_bytes()),
                        "request_encoding_correction_hash": sha((self.evidence / "predeclaration-8a.md").read_bytes()),
                        "prior_source_transition_hash": sha((self.evidence / "source-transition-8.json").read_bytes()),
                        "files": {"pilot/runtime.py": {"before": sha(snapshot["files"]["pilot/runtime.py"].encode()),
                                                       "after": sha(self.source.read_bytes())}},
                        "retained_calls": {}}
        self.calls = {}
        for name in ("mbpp", "hover"):
            path = self.evidence / (name + ".jsonl")
            path.write_text(json.dumps({"status": 200, "failed": False, "usage_missing": False}) + "\n")
            self.calls[name] = path
            self.receipt["retained_calls"][name] = {"path": str(path.relative_to(self.root)),
                                                    "sha256": sha(path.read_bytes()), "calls": 1}
        self.save()

    def save(self):
        (self.evidence / "source-transition-8a.json").write_text(json.dumps(self.receipt))

    def test_exact_transition_accepts_answered_archive_but_rejects_unreviewed_runtime(self):
        self.assertEqual(transition_source(self.root, "pilot/runtime.py"), "old = 'answered'\n")
        proof = retained_transport_proof(self.root, "mbpp")
        self.assertEqual(proof["answered_calls"], 1)
        self.assertEqual(proof["refusals"], 0)
        self.source.write_text("unreviewed = True\n")
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_changed_baseline_or_declaration_does_not_authorize_carryover(self):
        self.snapshot.write_text(self.snapshot.read_text() + " ")
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")
        self.receipt["source_snapshot_hash"] = sha(self.snapshot.read_bytes())
        self.save()
        (self.evidence / "predeclaration-8.md").write_text("different policy\n")
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_encoding_policy_and_prior_grant_changes_cannot_authorize_carryover(self):
        for filename in ("predeclaration-8a.md", "source-transition-8.json"):
            with self.subTest(filename=filename):
                path = self.evidence / filename
                original = path.read_text()
                path.write_text(original + " ")
                with self.assertRaises(ValueError):
                    transition_source(self.root, "pilot/runtime.py")
                path.write_text(original)

    def test_even_resealed_refusal_or_unknown_usage_cannot_carry_a_task_admission(self):
        for defect in ("refusal", "unknown", "failed", "empty"):
            with self.subTest(defect=defect):
                row = {"status": 200, "failed": False, "usage_missing": False}
                if defect == "refusal":
                    row["outcome"] = "refusal"
                elif defect == "unknown":
                    row["usage_missing"] = True
                elif defect == "failed":
                    row["failed"] = True
                data = "" if defect == "empty" else json.dumps(row) + "\n"
                self.calls["hover"].write_text(data)
                self.receipt["retained_calls"]["hover"].update(sha256=sha(data.encode()), calls=0 if defect == "empty" else 1)
                self.save()
                with self.assertRaises(ValueError):
                    retained_transport_proof(self.root, "hover")

    def install_transition9(self):
        prior = self.evidence / "source-transition-8a.json"
        pin = patch("pilot.admission.TRANSITION_8A_HASH", sha(prior.read_bytes()))
        pin.start()
        self.addCleanup(pin.stop)
        baseline = {"source_head": TRANSITION_9_HEAD,
                    "files": {"pilot/runtime.py": self.source.read_text()}}
        self.snapshot9 = self.evidence / "source-snapshot-9.json"
        self.snapshot9.write_text(json.dumps(baseline))
        (self.evidence / "predeclaration-9.md").write_text("seed and stop corrections only\n")
        self.source.write_text("new = 'dispatch-and-stop-corrected'\n")
        self.receipt9 = {
            "version": "pilot-dispatch-transition-v9", "source_head": TRANSITION_9_HEAD,
            "prior_source_transition_hash": sha(prior.read_bytes()),
            "source_snapshot_hash": sha(self.snapshot9.read_bytes()),
            "predeclaration_hash": sha((self.evidence / "predeclaration-9.md").read_bytes()),
            "files": {name: {"before": hashes["after"],
                             "after": sha((self.root / name).read_bytes())}
                      for name, hashes in self.receipt["files"].items()},
        }
        self.save9()

    def save9(self):
        (self.evidence / "source-transition-9.json").write_text(json.dumps(self.receipt9))

    def test_dispatch_transition_retains_original_execution_and_reports_chain(self):
        self.install_transition9()
        self.assertEqual(transition_source(self.root, "pilot/runtime.py"), "old = 'answered'\n")
        baseline, provenance = transition9_baseline(self.root, self.receipt)
        self.assertEqual(baseline["pilot/runtime.py"], "new = 'refusal-aware'\n")
        self.assertEqual(provenance["source_transition_hash"],
                         sha((self.evidence / "source-transition-9.json").read_bytes()))
        self.assertEqual(provenance["prior_source_transition_hash"],
                         sha((self.evidence / "source-transition-8a.json").read_bytes()))
        self.assertEqual(provenance["source_snapshot_hash"], sha(self.snapshot9.read_bytes()))
        self.assertEqual(provenance["predeclaration_hash"],
                         sha((self.evidence / "predeclaration-9.md").read_bytes()))

    def test_dispatch_transition_rejects_changed_chain_members(self):
        self.install_transition9()
        for path in (self.source, self.snapshot9, self.evidence / "predeclaration-9.md",
                     self.evidence / "source-transition-8a.json",
                     self.snapshot, self.evidence / "predeclaration-8.md",
                     self.evidence / "predeclaration-8a.md",
                     self.evidence / "source-transition-8.json"):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaises(ValueError):
                    transition_source(self.root, "pilot/runtime.py")
                path.write_bytes(original)

    def test_dispatch_transition_rejects_resealed_baseline_not_matching_prior_after(self):
        self.install_transition9()
        baseline = json.loads(self.snapshot9.read_text())
        baseline["files"]["pilot/runtime.py"] = "unreviewed baseline\n"
        self.snapshot9.write_text(json.dumps(baseline))
        self.receipt9["source_snapshot_hash"] = sha(self.snapshot9.read_bytes())
        self.receipt9["files"]["pilot/runtime.py"]["before"] = sha(b"unreviewed baseline\n")
        self.save9()
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_dispatch_transition_rejects_resealed_prior_grant(self):
        self.install_transition9()
        self.receipt["files"]["pilot/runtime.py"]["after"] = sha(b"new prior\n")
        self.save()
        self.receipt9["prior_source_transition_hash"] = sha((self.evidence / "source-transition-8a.json").read_bytes())
        self.save9()
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_dispatch_transition_requires_complete_inventory_and_exact_changed_snapshot(self):
        self.install_transition9()
        original = json.loads(json.dumps(self.receipt9))
        for files in ({}, {**original["files"], "pilot/extra.py": {"before": None, "after": "unreviewed"}}):
            with self.subTest(files=files):
                self.receipt9["files"] = files
                self.save9()
                with self.assertRaises(ValueError):
                    transition_source(self.root, "pilot/runtime.py")
        self.receipt9 = original
        baseline = json.loads(self.snapshot9.read_text())
        baseline["files"]["pilot/extra.py"] = "extra\n"
        self.snapshot9.write_text(json.dumps(baseline))
        self.receipt9["source_snapshot_hash"] = sha(self.snapshot9.read_bytes())
        self.save9()
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_dispatch_transition_cannot_exist_without_prior_grant(self):
        self.install_transition9()
        (self.evidence / "source-transition-8a.json").unlink()
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_identity_uses_authenticated_baseline_without_changing_archived_provenance(self):
        unchanged = self.root / "pilot/unchanged.py"
        unchanged.write_text("unchanged = True\n")
        self.receipt["files"]["pilot/unchanged.py"] = {"before": None, "after": sha(unchanged.read_bytes())}
        self.save()
        old_hash = identity_source_hash(self.root, "pilot/runtime.py")
        old_proof = retained_transport_proof(self.root, "mbpp")
        self.install_transition9()
        self.assertEqual(identity_source_hash(self.root, "pilot/runtime.py"), old_hash)
        self.assertEqual(identity_source_hash(self.root, "pilot/unchanged.py"), sha(unchanged.read_bytes()))
        self.assertEqual(retained_transport_proof(self.root, "mbpp"), old_proof)
        unchanged.write_text("unreviewed = True\n")
        with self.assertRaises(ValueError):
            identity_source_hash(self.root, "pilot/runtime.py")

    def test_identity_rejects_mutated_baseline_declaration_and_changed_live_source(self):
        self.install_transition9()
        for path in (self.source, self.snapshot9, self.evidence / "predeclaration-9.md",
                     self.evidence / "source-transition-8a.json", self.snapshot):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaises(ValueError):
                    identity_source_hash(self.root, "pilot/runtime.py")
                path.write_bytes(original)

    def install_transition10(self):
        search = self.root / "pilot/search.py"
        search.write_text("selection = 'fresh'\n")
        self.receipt["files"]["pilot/search.py"] = {"before": None, "after": sha(search.read_bytes())}
        self.save()
        self.install_transition9()
        prior = self.evidence / "source-transition-9.json"
        pin = patch("pilot.admission.TRANSITION_9_HASH", sha(prior.read_bytes()))
        pin.start()
        self.addCleanup(pin.stop)
        snapshot = {"source_head": TRANSITION_10_HEAD,
                    "files": {name: (self.root / name).read_text() for name in self.receipt9["files"]}}
        self.snapshot10 = self.evidence / "source-snapshot-10.json"
        self.snapshot10.write_text(json.dumps(snapshot))
        (self.evidence / "predeclaration-10.md").write_text("reuse selection vectors\n")
        self.source.write_text("new = 'selection-policy-provenance'\n")
        search.write_text("selection = 'reused'\n")
        search_pin = patch("pilot.admission.TRANSITION_10_SEARCH_HASH", sha(search.read_bytes()))
        search_pin.start()
        self.addCleanup(search_pin.stop)
        self.receipt10 = {
            "version": "pilot-selection-transition-v10", "source_head": TRANSITION_10_HEAD,
            "prior_source_transition_hash": sha(prior.read_bytes()),
            "source_snapshot_hash": sha(self.snapshot10.read_bytes()),
            "predeclaration_hash": sha((self.evidence / "predeclaration-10.md").read_bytes()),
            "files": {name: {"before": hashes["after"], "after": sha((self.root / name).read_bytes())}
                      for name, hashes in self.receipt9["files"].items()},
        }
        snapshot["files"] = {name: text for name, text in snapshot["files"].items()
                             if self.receipt10["files"][name]["before"] != self.receipt10["files"][name]["after"]}
        self.snapshot10.write_text(json.dumps(snapshot))
        self.receipt10["source_snapshot_hash"] = sha(self.snapshot10.read_bytes())
        (self.evidence / "source-transition-10.json").write_text(json.dumps(self.receipt10))

    def test_selection_transition_preserves_authenticated_admission_identity(self):
        self.install_transition10()
        self.assertEqual(transition_source(self.root, "pilot/runtime.py"), "old = 'answered'\n")
        self.assertEqual(identity_source_hash(self.root, "pilot/runtime.py"), sha(b"new = 'refusal-aware'\n"))
        self.assertEqual(identity_source_hash(self.root, "pilot/search.py"), sha(b"selection = 'fresh'\n"))

    def test_selection_transition_rejects_changed_sources_and_declarations(self):
        self.install_transition10()
        for path in (self.source, self.root / "pilot/search.py", self.snapshot10,
                     self.evidence / "predeclaration-10.md", self.evidence / "source-transition-9.json"):
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaises(ValueError):
                    identity_source_hash(self.root, "pilot/runtime.py")
                path.write_bytes(original)

    def test_selection_transition_rejects_coordinated_search_and_receipt_change(self):
        self.install_transition10()
        search = self.root / "pilot/search.py"
        search.write_text("selection = 'unapproved'\n")
        self.receipt10["files"]["pilot/search.py"]["after"] = sha(search.read_bytes())
        (self.evidence / "source-transition-10.json").write_text(json.dumps(self.receipt10))
        with self.assertRaises(ValueError):
            identity_source_hash(self.root, "pilot/runtime.py")

    def install_transition11(self):
        grader = self.root / "pilot/verification.py"
        grader.write_text("grader = 'legacy-zero'\n")
        self.receipt["files"]["pilot/verification.py"] = {"before": None, "after": sha(grader.read_bytes())}
        self.save()
        self.install_transition10()
        snapshot = {"source_head": TRANSITION_11_HEAD,
                    "files": {name: (self.root / name).read_text() for name in self.receipt10["files"]}}
        self.snapshot11 = self.evidence / "source-snapshot-11.json"
        self.snapshot11.write_text(json.dumps(snapshot))
        (self.evidence / "predeclaration-11.md").write_text("unscored infrastructure; final campaign rerun\n")
        grader.write_text("grader = 'receipted-infrastructure'\n")
        (self.root / "pilot/campaign.py").write_text("cap = 35000\n")
        pin = patch("pilot.admission.TRANSITION_11_VERIFICATION_HASH", sha(grader.read_bytes()))
        pin.start()
        self.addCleanup(pin.stop)
        self.receipt11 = {
            "version": "pilot-grader-transition-v11", "source_head": TRANSITION_11_HEAD,
            "prior_source_transition_hash": sha((self.evidence / "source-transition-10.json").read_bytes()),
            "source_snapshot_hash": sha(self.snapshot11.read_bytes()),
            "predeclaration_hash": sha((self.evidence / "predeclaration-11.md").read_bytes()),
            "files": {name: {"before": hashes["after"], "after": sha((self.root / name).read_bytes())}
                      for name, hashes in self.receipt10["files"].items()},
        }
        self.receipt11["files"]["pilot/campaign.py"] = {"before": None, "after": sha((self.root / "pilot/campaign.py").read_bytes())}
        self.save11()

    def save11(self):
        (self.evidence / "source-transition-11.json").write_text(json.dumps(self.receipt11))

    def test_grader_transition_preserves_admitted_identity_through_older_grants(self):
        self.install_transition11()
        self.assertEqual(transition_source(self.root, "pilot/runtime.py"), "old = 'answered'\n")
        self.assertEqual(identity_source_hash(self.root, "pilot/runtime.py"), sha(b"new = 'refusal-aware'\n"))
        self.assertEqual(transition11_baseline(self.root)["pilot/verification.py"], "grader = 'legacy-zero'\n")

    def test_grader_transition_rejects_changed_live_source_and_campaign_cap(self):
        self.install_transition11()
        for name in ("pilot/verification.py", "pilot/campaign.py"):
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                with self.assertRaises(ValueError):
                    transition_source(self.root, "pilot/runtime.py")
                path.write_bytes(original)

    def test_grader_transition_rejects_coordinated_core_and_receipt_change(self):
        self.install_transition11()
        grader = self.root / "pilot/verification.py"
        grader.write_text("grader = 'infrastructure-is-zero'\n")
        self.receipt11["files"]["pilot/verification.py"]["after"] = sha(grader.read_bytes())
        self.save11()
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")

    def test_grader_transition_cannot_reseal_an_unadmitted_baseline(self):
        self.install_transition11()
        snapshot = json.loads(self.snapshot11.read_text())
        snapshot["files"]["pilot/verification.py"] = "unadmitted baseline\n"
        self.snapshot11.write_text(json.dumps(snapshot))
        self.receipt11["source_snapshot_hash"] = sha(self.snapshot11.read_bytes())
        self.receipt11["files"]["pilot/verification.py"]["before"] = sha(b"unadmitted baseline\n")
        self.save11()
        with self.assertRaises(ValueError):
            transition_source(self.root, "pilot/runtime.py")


if __name__ == "__main__":
    unittest.main()
