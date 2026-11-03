import argparse
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.__main__ import TASKS, evaluator_identity, file_hash, main, machine_proof, replay, save, seal
from pilot.controls import CONTROL_SEED
from pilot.runtime import ROOT, digest
from pilot.tasks import Task
from pilot.test_adversarial import admission_fixture, fixture_tasks


class PreflightTests(unittest.TestCase):
    def fixture(self, root):
        tasks = {task.name: task for task in fixture_tasks()}
        controls = root / "controls"
        proof = admission_fixture(list(tasks.values()))
        save(controls / "adversarial.json", proof)
        save(controls / "cohorts.json", {"seed": CONTROL_SEED,
             "predeclaration_hash": file_hash(ROOT / "evidence/pilot/predeclaration-3.md"),
             "cohorts": proof["cohorts"], "adversarial_hash": digest(proof)})
        for name, task in tasks.items():
            save(controls / name / "controls.json", {
                "ranking_passed": True, "noise_passed": True,
                "identity": evaluator_identity(task),
                "adversarial_hash": digest(proof),
                "rows": proof["cohorts"][name]["rows"],
            })
        seal(controls)
        pool = root / "pool.json"
        save(pool, {"*": False, "anthropic": {"accounts": ["email:pilot@gmail.com"], "apiKeys": False}})
        return tasks, controls, pool

    def invoke(self, root, tasks, controls, pool, command):
        argv = ["pilot", command, "--task", "mbpp", "--controls", str(controls),
                "--pool", str(pool), "--cache", str(root / "cache"), "--out", str(root / "out")]
        return patch("sys.argv", argv), patch("pilot.tasks.load_task", side_effect=lambda name, cache: tasks[name])

    def test_other_task_admission_blocks_every_search_before_transport(self):
        for command in ("smoke", "pilot"):
            for name in ("ifbench", "aime"):
                for defect in ("ranking", "noise", "missing", "unsealed", "tampered", "identity", "adversarial"):
                    with self.subTest(command=command, task=name, defect=defect), tempfile.TemporaryDirectory() as directory:
                        root = Path(directory)
                        tasks, controls, pool = self.fixture(root)
                        path = controls / name / "controls.json"
                        control = json.loads(path.read_text())
                        if defect in {"missing", "unsealed"}:
                            path.unlink()
                            seal(controls)
                            if defect == "unsealed":
                                save(path, control)
                        else:
                            if defect in {"ranking", "noise"}:
                                control[defect + "_passed"] = False
                            elif defect == "adversarial":
                                del control["adversarial_hash"]
                            else:
                                control["identity"] = {"stale": True}
                            save(path, control)
                            if defect != "tampered":
                                seal(controls)
                        argv, loader = self.invoke(root, tasks, controls, pool, command)
                        with argv, loader, patch("pilot.__main__.open_gateway") as transport:
                            with self.assertRaises((ValueError, FileNotFoundError)):
                                main()
                            transport.assert_not_called()
                        self.assertFalse((root / "out").exists())

    def test_all_pass_admits_requested_mbpp_cells_to_transport(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tasks, controls, pool = self.fixture(root)
            argv, loader = self.invoke(root, tasks, controls, pool, "smoke")
            with argv, loader, redirect_stdout(StringIO()), patch(
                "pilot.__main__.open_gateway", side_effect=RuntimeError("offline transport")
            ) as transport:
                with self.assertRaisesRegex(RuntimeError, "Smoke failed"):
                    main()
            self.assertEqual(transport.call_count, 3)
            results = sorted((root / "out").rglob("result.json"))
            self.assertEqual(len(results), 3)
            self.assertEqual({json.loads(path.read_text())["task"] for path in results}, {"mbpp"})
            self.assertEqual({json.loads(path.read_text())["method"] for path in results}, {"hone", "gepa", "plain"})

    def test_old_or_incomplete_adversarial_proofs_block_all_search(self):
        for defect in ("missing", "unsealed", "old", "positive", "incomplete"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tasks, controls, pool = self.fixture(root)
                path = controls / "adversarial.json"
                proof = json.loads(path.read_text())
                if defect in {"missing", "unsealed"}:
                    path.unlink()
                    seal(controls)
                    if defect == "unsealed":
                        save(path, proof)
                else:
                    if defect == "old":
                        proof["version"] = "pilot-adversarial-v2"
                    elif defect == "positive":
                        proof["mbpp"][0]["score"] = 1
                    else:
                        del proof["text_only"]["aime"]
                    save(path, proof)
                    seal(controls)
                argv, loader = self.invoke(root, tasks, controls, pool, "smoke")
                with argv, loader, patch("pilot.__main__.environment") as auth, patch("pilot.__main__.open_gateway") as transport:
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        main()
                    transport.assert_not_called()
                    auth.assert_not_called()

    def test_machine_proof_records_inherited_cpu_six_and_avoidance(self):
        with tempfile.TemporaryDirectory() as directory, patch("os.sched_getaffinity", return_value={6}), patch(
            "os.getpriority", return_value=10
        ):
            machine_proof(Path(directory))
            proof = json.loads((Path(directory) / "machine.json").read_text())
        self.assertEqual(proof["selected_cpu"], 6)
        self.assertEqual(proof["permitted_cpus"], [6])
        self.assertTrue(proof["inherited_affinity"])
        self.assertTrue(proof["avoidance_passed"])
        self.assertTrue({0, 1, 2, 3, 4, 5, 13, 14, 15, 16} <= set(proof["avoided_cpus"]))

    def test_machine_proof_refuses_unsafe_or_unpinned_affinity(self):
        for affinity in ({0}, {0, 5}, {6, 7}):
            with self.subTest(affinity=affinity), tempfile.TemporaryDirectory() as directory, patch(
                "os.sched_getaffinity", return_value=affinity
            ), self.assertRaises(ValueError):
                machine_proof(Path(directory))


    def test_replay_unencodable_output_scores_zero_without_model_calls(self):
        task = Task("mbpp", [{"id": "dev:1", "reference_code": "def target(): return 0", "test_setup_code": "", "test_list": []}], [],
                    {"task": "mbpp"}, {"prompt": "answer"})
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            save(out / "manifest.json", {"identity": {"task": task.manifest}})
            record = {"row_ids": ["dev:1"], "outputs": ["\ud800"], "scores": [0.0]}
            (out / "evaluations.jsonl").write_text(json.dumps(record) + "\n")
            with patch("pilot.tasks.load_task", return_value=task), patch.dict("os.environ"), redirect_stdout(StringIO()) as stream:
                replay(argparse.Namespace(out=out, cache=out / "cache"))
            self.assertEqual(json.loads(stream.getvalue())["replayed_rollouts"], 1)
            self.assertEqual(json.loads(stream.getvalue())["model_calls"], 0)


if __name__ == "__main__":
    unittest.main()
