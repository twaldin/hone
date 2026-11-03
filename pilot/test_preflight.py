import argparse
from contextlib import contextmanager, redirect_stdout
from io import StringIO
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

from pilot.__main__ import TASKS, audit_mbpp_measurement, controls as run_controls, evaluator_identity, file_hash, main, machine_proof, offline_adversarial, replay, reuse_mbpp, save, seal
from pilot.controls import ControlsFailed, PAIRS, P_CONTROL_SEED, representative_rows
from pilot.runtime import ROOT, CallFailed, TransportError, append_json, digest
from pilot.tasks import Task
from pilot.test_adversarial import admission_fixture, fixture_tasks
from pilot.admission import MBPP_FILES, mbpp_source_contract, text_admission
from pilot import tasks as task_module
from pilot import hover


class PreflightTests(unittest.TestCase):
    def fixture(self, root):
        tasks = {task.name: task for task in fixture_tasks()}
        controls = root / "controls"
        declaration = file_hash(ROOT / "evidence/pilot/predeclaration-4.md")
        self.metrics = {id(tasks["ifbench"].manifest): lambda row, pred: SimpleNamespace(
            score=float(pred.response == "heliotropeproofword"), feedback="checked")}
        self.reused = ({"ranking_passed": True, "noise_passed": True,
                        "rows": [row["id"] for row in representative_rows(tasks["mbpp"])]},
                       {"fixture": "already admitted unchanged MBPP"})
        save(controls / "panel.json", {"version": 4, "tasks": list(TASKS), "all_admitted": True,
                                     "predeclaration_hash": declaration})
        save(controls / "cohorts.json", {"version": 4, "seed": P_CONTROL_SEED,
             "predeclaration_hash": declaration,
             "cohorts": {name: {"rows": [row["id"] for row in representative_rows(task)]} for name, task in tasks.items()}})
        save(controls / "mbpp/controls.json", self.reused[0])
        save(controls / "mbpp/admission.json", self.reused[1])
        with patch.dict(task_module._METRICS, self.metrics):
            for name in ("ifbench", "aime"):
                task = tasks[name]
                rows = representative_rows(task)
                proof = text_admission(task, evaluator_identity(task), rows)
                save(controls / name / "admission.json", proof)
                save(controls / name / "controls.json", {
                    "ranking_passed": True, "noise_passed": True, "identity": evaluator_identity(task),
                    "adversarial_hash": digest(proof), "rows": [row["id"] for row in rows],
                    "artifacts": {"naive": task.seed_candidate},
                    "controls": {"naive": {"scores": [0.8] * len(rows), "mean": 0.8}},
                })
        seal(controls)
        pool = root / "pool.json"
        save(pool, {"*": False, "anthropic": {"accounts": ["email:pilot@gmail.com"], "apiKeys": False}})
        return tasks, controls, pool

    def invoke(self, root, tasks, controls, pool, command):
        argv = ["pilot", command, "--task", "mbpp", "--controls", str(controls),
                "--pool", str(pool), "--cache", str(root / "cache"), "--out", str(root / "out")]
        return (patch("sys.argv", argv), patch("pilot.tasks.load_task", side_effect=lambda name, cache: tasks[name]),
                patch("pilot.__main__.reuse_mbpp", return_value=self.reused), patch.dict(task_module._METRICS, self.metrics))

    @contextmanager
    def offline_fixture(self, root):
        tasks, _, _ = self.fixture(root)
        cache = root / "cache"
        task = Task("hover", [{"id": f"hover:train:{index}", "input": f"claim {index}",
                              "supporting_facts": [{"key": "Alpha", "value": 0}, {"key": "Beta", "value": 0},
                                                   {"key": "Gamma", "value": 0}]} for index in range(40)],
                    [], {"task": "hover", "fixture": True}, dict(hover.SEED))
        tasks["hover"] = task
        receipt = {"fixture": "frozen numeric retrieval index"}
        prepared = hover.PreparedRetrieval(lambda query, k: ["Unrelated | abstract"], receipt)
        with patch("pilot.tasks.load_task", side_effect=lambda name, cache: tasks[name]), patch(
            "pilot.__main__.reuse_mbpp", return_value=self.reused
        ), patch("pilot.hover.prepare_retrieval", return_value=receipt), patch(
            "pilot.__main__.machine_proof"
        ), patch.dict(task_module._METRICS, self.metrics), patch.dict(
            hover._CACHES, {id(task.manifest): cache}
        ), patch.dict(hover._RETRIEVERS, {cache / "hover-retrieval": prepared}):
            yield tasks, root / "admission", cache

    def test_offline_cli_admits_protocols_without_auth_or_model_bootstrap(self):
        with tempfile.TemporaryDirectory() as directory, self.offline_fixture(Path(directory)) as (_, out, cache):
            argv = ["pilot", "adversarial", "--out", str(out), "--cache", str(cache), "--pool", "/must-not-open"]
            with patch("sys.argv", argv), patch("pilot.__main__.environment") as auth, patch(
                "pilot.__main__.create_pool"
            ) as pool, patch("pilot.__main__.calls_for") as transport, redirect_stdout(StringIO()):
                main()
            self.assertTrue(json.loads((out / "adversarial.json").read_text())["passed"])
            auth.assert_not_called()
            pool.assert_not_called()
            transport.assert_not_called()

    def test_failed_protocol_proof_is_retained_and_blocks_controls(self):
        with tempfile.TemporaryDirectory() as directory, self.offline_fixture(Path(directory)) as (tasks, out, cache):
            def unsafe(row, prediction):
                return SimpleNamespace(score=float(prediction.response == "heliotropeproofword" or
                                                    "AlwaysEqual" in prediction.response), feedback="unsafe fixture")
            with patch.dict(task_module._METRICS, {id(tasks["ifbench"].manifest): unsafe}), redirect_stdout(StringIO()):
                with self.assertRaisesRegex(ControlsFailed, "stop"):
                    offline_adversarial(argparse.Namespace(task="all", out=out, cache=cache))
            proof = json.loads((out / "ifbench/admission.json").read_text())
            self.assertFalse(proof["passed"])
            self.assertEqual(proof["checks"]["records"][0]["scores"], [1.0])
            self.assertFalse((out / "aime/admission.json").exists())
            args = argparse.Namespace(task="all", out=Path(directory) / "new-controls", adversarial=out, cache=cache)
            with patch("pilot.__main__.environment") as auth, patch("pilot.__main__.calls_for") as transport:
                with self.assertRaises(ValueError):
                    run_controls(args)
                auth.assert_not_called()
                transport.assert_not_called()

    def test_headroom_transition_freezes_inputs_and_keeps_panel_order(self):
        for replaced in (False, True):
            with self.subTest(replaced=replaced), tempfile.TemporaryDirectory() as directory, self.offline_fixture(
                Path(directory)
            ) as (_, admission, cache), redirect_stdout(StringIO()):
                offline_adversarial(argparse.Namespace(task="all", out=admission, cache=cache))
                out = Path(directory) / "measured-controls"
                order = []
                def transport(pool, env, destination, limits):
                    frozen = json.loads((out / "cohorts.json").read_text())
                    self.assertEqual(set(frozen["cohorts"]), {"mbpp", "ifbench", "aime", "hover"})
                    for name in ("ifbench", "aime", "hover"):
                        self.assertIn(name, frozen["text_admission_hashes"])
                        self.assertTrue((out / name / "admission.json").exists())
                    order.append(destination.name)
                    call = Mock(side_effect=AssertionError("State-transition fixture cannot dispatch a model"))
                    call.gateway = SimpleNamespace(route_identity={"fixture": True})
                    ledger = SimpleNamespace(limits=limits, summary=lambda throttle: {"calls": 0})
                    return call, ledger, SimpleNamespace()
                def measurement(task, call, destination, identity, **kwargs):
                    result = {"headroom_replacement": "hover"} if replaced and task.name == "ifbench" else {
                        "ranking_passed": True, "noise_passed": True}
                    save(destination / "controls.json", result)
                    return result
                args = argparse.Namespace(task="all", out=out, cache=cache, adversarial=admission)
                with patch("pilot.__main__.calls_for", side_effect=transport), patch("pilot.controls.measure", side_effect=measurement):
                    run_controls(args, json.loads((Path(directory) / "pool.json").read_text()), {})
                expected = ["ifbench", "hover", "aime"] if replaced else ["ifbench", "aime"]
                self.assertEqual(order, expected)
                self.assertEqual(json.loads((out / "panel.json").read_text())["tasks"],
                                 ["mbpp", "hover", "aime"] if replaced else ["mbpp", "ifbench", "aime"])

    def test_missing_calls_or_empty_outputs_cannot_fake_zero_mbpp_noise(self):
        for defect in ("missing-noise-calls", "empty-output"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                out = root / "mbpp"
                rows = list(range(20))
                save(out / "controls.json", {"rows": rows, "ranking_passed": True, "noise_passed": True})
                count = 20 if defect == "missing-noise-calls" else 20 * (1 + 2 * PAIRS)
                for _ in range(count):
                    append_json(out / "calls.jsonl", {"role": "task", "failed": False})
                append_json(out / "evaluations.jsonl", {"control": "naive", "outputs": ["def target(): return 1"] * 20})
                for arm in range(2 * PAIRS):
                    outputs = ["def target(): return 1"] * 20
                    if defect == "empty-output" and arm == 0:
                        outputs[0] = ""
                    append_json(out / "evaluations.jsonl", {"control": "unchanged", "outputs": outputs})
                seal(root)
                with self.assertRaises(TransportError):
                    audit_mbpp_measurement(argparse.Namespace(out=root, cache=root / "cache"))

    def test_incomplete_mbpp_seal_cannot_authorize_an_injected_control(self):
        tasks = fixture_tasks()
        mbpp = next(task for task in tasks if task.name == "mbpp")
        proof = admission_fixture(tasks)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = set(proof["identities"]["mbpp"]["evaluator_files"]) | {
                "pilot/search.py", "evidence/pilot/predeclaration-4.md", "evidence/pilot/predeclaration-4a.md"}
            for path in paths:
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(ROOT / path)
            source = root / "evidence/pilot/mbpp-readmission-4a"
            save(source / "adversarial/adversarial.json", proof)
            seal(source / "adversarial")
            save(source / "source-contract.json", {
                "baseline_files": {path: file_hash(ROOT / path) for path in (*MBPP_FILES, "pilot/tasks.py", "pilot/search.py")},
                "execution_contract": mbpp_source_contract(ROOT)})
            seal(source)
            save(source / "mbpp/controls.json", {
                "identity": proof["identities"]["mbpp"], "adversarial_hash": digest(proof),
                "ranking_passed": True, "noise_passed": True,
                "rows": [row["id"] for row in representative_rows(mbpp)],
                "noise_design": {"seed_artifact_hash": digest(mbpp.seed_candidate)}})
            with patch("pilot.__main__.ROOT", root):
                with self.assertRaises(ValueError):
                    reuse_mbpp(mbpp)

    def test_provider_outage_aborts_calibration_without_choosing_panel(self):
        with tempfile.TemporaryDirectory() as directory, self.offline_fixture(Path(directory)) as (_, admission, cache):
            with redirect_stdout(StringIO()):
                offline_adversarial(argparse.Namespace(task="all", out=admission, cache=cache))
            out = Path(directory) / "failed-controls"
            call = Mock(side_effect=CallFailed("synthetic exhausted provider outage"))
            call.gateway = SimpleNamespace(route_identity={"fixture": True})
            ledger = SimpleNamespace(limits={}, summary=lambda throttle: {"calls": 2, "usage_missing_calls": 2})
            args = argparse.Namespace(task="all", out=out, cache=cache, adversarial=admission)
            pool = json.loads((Path(directory) / "pool.json").read_text())
            with patch("pilot.__main__.calls_for", return_value=(call, ledger, SimpleNamespace())):
                with self.assertRaisesRegex(TransportError, "no candidate score"):
                    run_controls(args, pool, {})
            self.assertEqual(json.loads((out / "ifbench/failure.json").read_text())["status"], "infrastructure-failure")
            self.assertFalse((out / "ifbench/controls.json").exists())
            self.assertFalse((out / "panel.json").exists())

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
                        argv, loader, reused, metric = self.invoke(root, tasks, controls, pool, command)
                        with argv, loader, reused, metric, patch("pilot.__main__.open_gateway") as transport:
                            with self.assertRaises((ValueError, FileNotFoundError)):
                                main()
                            transport.assert_not_called()
                        self.assertFalse((root / "out").exists())


    def test_stale_or_incomplete_text_admission_blocks_all_search(self):
        for defect in ("missing", "unsealed", "old", "positive", "incomplete"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tasks, controls, pool = self.fixture(root)
                path = controls / "aime/admission.json"
                proof = json.loads(path.read_text())
                if defect in {"missing", "unsealed"}:
                    path.unlink()
                    seal(controls)
                    if defect == "unsealed":
                        save(path, proof)
                else:
                    if defect == "old":
                        proof["version"] = "pilot-text-admission-v3"
                    elif defect == "positive":
                        proof["checks"]["records"][0]["scores"] = [1.0]
                    else:
                        proof["checks"]["records"].pop()
                    save(path, proof)
                    seal(controls)
                argv, loader, reused, metric = self.invoke(root, tasks, controls, pool, "smoke")
                with argv, loader, reused, metric, patch("pilot.__main__.environment") as auth, patch("pilot.__main__.open_gateway") as transport:
                    with self.assertRaises((ValueError, FileNotFoundError)):
                        main()
                    transport.assert_not_called()
                    auth.assert_not_called()

    def test_panel_cannot_contradict_the_measured_headroom_branch(self):
        for mean, selected in ((0.8, ["mbpp", "hover", "aime"]), (0.95, list(TASKS))):
            with self.subTest(mean=mean), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tasks, controls, pool = self.fixture(root)
                panel = json.loads((controls / "panel.json").read_text())
                panel["tasks"] = selected
                save(controls / "panel.json", panel)
                control = json.loads((controls / "ifbench/controls.json").read_text())
                control["controls"]["naive"] = {"scores": [mean] * 40, "mean": mean}
                save(controls / "ifbench/controls.json", control)
                seal(controls)
                argv, loader, reused, metric = self.invoke(root, tasks, controls, pool, "smoke")
                with argv, loader, reused, metric, patch("pilot.__main__.environment") as auth:
                    with self.assertRaisesRegex(ValueError, "contradicts"):
                        main()
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
