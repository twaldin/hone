import argparse
from contextlib import contextmanager, redirect_stdout
from io import StringIO
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

from pilot.__main__ import TASKS, audit_mbpp_measurement, controls as measured_controls, evaluator_identity, file_hash, load_panel, main, machine_proof, offline_adversarial, replay, reuse_mbpp, save, seal
from pilot.controls import ControlsFailed, PAIRS, P_CONTROL_SEED, representative_rows
from pilot.runtime import ROOT, CallFailed, TransportError, append_json, digest
from pilot.tasks import Task
from pilot.test_adversarial import admission_fixture, fixture_tasks
from pilot.admission import MBPP_FILES, mbpp_source_contract, text_admission
from pilot import tasks as task_module
from pilot import hover


def run_controls(args, *transport):
    with patch("pilot.__main__.AUTHORIZED_CONTROL_OUTPUT", args.out):
        return measured_controls(args, *transport)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("os.sched_getaffinity", return_value={6}))
        self.enterContext(patch("os.getpriority", return_value=10))

    def test_replacement_control_directory_is_never_authorized(self):
        with tempfile.TemporaryDirectory() as directory, patch("pilot.__main__.calls_for") as dispatch:
            args = argparse.Namespace(task="all", out=Path(directory) / "replacement")
            with self.assertRaises(ValueError):
                measured_controls(args)
            dispatch.assert_not_called()

    def fixture(self, root):
        tasks = {task.name: task for task in fixture_tasks() if task.name != "aime"}
        cache = root / "cache"
        task = Task("hover", [{"id": f"hover:train:{index}", "input": f"claim {index}",
                              "supporting_facts": [{"key": "Alpha", "value": 0}, {"key": "Beta", "value": 0},
                                                   {"key": "Gamma", "value": 0}]} for index in range(40)],
                    [], {"task": "hover", "fixture": True}, dict(hover.SEED))
        tasks["hover"] = task
        receipt = {"fixture": "frozen numeric retrieval index"}
        prepared = hover.PreparedRetrieval(lambda query, k: ["Unrelated | abstract"], receipt)
        self.enterContext(patch.dict(hover._CACHES, {id(task.manifest): cache}))
        self.enterContext(patch.dict(hover._RETRIEVERS, {cache / "hover-retrieval": prepared}))
        self.enterContext(patch("pilot.hover.prepare_retrieval", return_value=receipt))
        self.metrics = {id(tasks["ifbench"].manifest): lambda row, pred: SimpleNamespace(
            score=float(pred.response == "heliotropeproofword"), feedback="checked")}
        self.enterContext(patch.dict(task_module._METRICS, self.metrics))
        self.enterContext(patch("pilot.__main__.validate_measurement", return_value="passed"))
        self.carried = {}
        for name in ("mbpp", "hover"):
            self.carried[name] = ({"ranking_passed": True, "noise_passed": True,
                                  "rows": [row["id"] for row in representative_rows(tasks[name])]},
                                 {"fixture": f"already admitted unchanged {name}"})
        self.reused = self.carried["mbpp"]
        self.enterContext(patch("pilot.__main__.reuse_control", side_effect=lambda task: self.carried[task.name]))
        frozen = root / "frozen-admission"
        ids = [row["id"] for row in representative_rows(task)]
        save(frozen / "cohorts.json", {"version": 4, "seed": P_CONTROL_SEED, "retrieval_receipt": receipt,
                                     "cohorts": {"hover": {"rows": ids, "cohort_hash": digest(ids)}}})
        seal(frozen)
        self.enterContext(patch("pilot.__main__.FROZEN_ADMISSION", frozen))
        controls = root / "controls"
        declaration = {"version": 8, "seed": P_CONTROL_SEED,
             "draw_seeds": {"mbpp": 20261104, "hover": 20261105, "ifbench": 20261106},
             "prior_ifbench_status": "invalid cohort",
             "predeclaration_hash": file_hash(ROOT / "evidence/pilot/predeclaration-8.md"),
             "source_cohorts_hash": file_hash(frozen / "cohorts.json"), "retrieval_receipt": receipt,
             "carried_admission_hashes": {name: digest(value[1]) for name, value in self.carried.items()},
             "cohorts": {name: {"rows": [row["id"] for row in representative_rows(value)],
                               "cohort_hash": digest([row["id"] for row in representative_rows(value)])}
                         for name, value in tasks.items()}}
        for name, (control, admission) in self.carried.items():
            save(controls / name / "controls.json", control)
            save(controls / name / "admission.json", admission)
        fresh = tasks["ifbench"]
        fresh_ids = [row["id"] for row in representative_rows(fresh)]
        proof = text_admission(fresh, evaluator_identity(fresh), representative_rows(fresh))
        declaration["ifbench_admission_hash"] = digest(proof)
        save(controls / "ifbench/admission.json", proof)
        save(controls / "ifbench/controls.json", {
            "ranking_passed": True, "noise_passed": True, "identity": evaluator_identity(fresh),
            "adversarial_hash": digest(proof), "rows": fresh_ids})
        save(controls / "cohorts.json", declaration)
        save(controls / "adversarial.json", {"version": "pilot-adversarial-v8", "passed": True,
             "model_calls": 0, "ifbench_status": "passed", "carried_tasks": ["mbpp", "hover"],
             "cohorts_hash": digest(declaration)})
        save(controls / "panel.json", {"version": 8, "tasks": list(TASKS), "all_admitted": True,
             "predeclaration_hash": declaration["predeclaration_hash"], "cohorts_hash": digest(declaration),
             "ifbench_status": "passed", "withdrawn": ["aime"], "claim_scope": "3-task development pilot"})
        seal(controls)
        pool = root / "pool.json"
        save(pool, {"*": False, "anthropic": {"accounts": ["email:pilot@gmail.com"], "apiKeys": False}})
        return tasks, controls, pool

    def invoke(self, root, tasks, controls, pool, command):
        argv = ["pilot", command, "--task", "mbpp", "--controls", str(controls),
                "--pool", str(pool), "--cache", str(root / "cache"), "--out", str(root / "out")]
        return (patch("sys.argv", argv), patch("pilot.tasks.load_task", side_effect=lambda name, cache: tasks[name]),
                patch("pilot.__main__.reuse_control", side_effect=lambda task: self.carried[task.name]),
                patch.dict(task_module._METRICS, self.metrics))

    @contextmanager
    def offline_fixture(self, root):
        tasks, _, _ = self.fixture(root)
        with patch("pilot.tasks.load_task", side_effect=lambda name, cache: tasks[name]), patch(
            "pilot.__main__.machine_proof"
        ):
            yield tasks, root / "admission", root / "cache"

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

    def test_failed_ifbench_protocol_is_retained_and_selects_only_two_tasks(self):
        with tempfile.TemporaryDirectory() as directory, self.offline_fixture(Path(directory)) as (_, out, cache):
            from pilot.tasks import score_output as real_score
            def unsafe(task, row, output):
                return 1.0 if task.name == "ifbench" and "AlwaysEqual" in output else real_score(task, row, output)
            with patch("pilot.tasks.score_output", side_effect=unsafe), patch(
                "pilot.adversarial.score_output", side_effect=unsafe
            ), redirect_stdout(StringIO()):
                offline_adversarial(argparse.Namespace(task="all", out=out, cache=cache))
                proof = json.loads((out / "ifbench/admission.json").read_text())
                self.assertFalse(proof["passed"])
                self.assertEqual(proof["checks"]["records"][0]["direct_score"], 1.0)
                target = Path(directory) / "new-controls"
                args = argparse.Namespace(task="all", out=target, adversarial=out, cache=cache)
                with patch("pilot.__main__.environment") as auth, patch("pilot.__main__.calls_for") as transport:
                    run_controls(args)
                    auth.assert_not_called()
                    transport.assert_not_called()
            self.assertEqual(json.loads((target / "panel.json").read_text())["tasks"], ["mbpp", "hover"])
            self.assertFalse((target / "aime").exists())

    def test_real_headroom_measurement_seals_two_task_fallback_without_a_second_attempt(self):
        from pilot.panel import validate_measurement
        from pilot.runtime import Ledger
        with tempfile.TemporaryDirectory() as directory, self.offline_fixture(Path(directory)) as (tasks, admission, cache):
            for row in tasks["ifbench"].train:
                row.update(instruction_id_list=[], kwargs=[])
            with redirect_stdout(StringIO()):
                offline_adversarial(argparse.Namespace(task="all", out=admission, cache=cache))
            out = Path(directory) / "headroom-controls"
            calls = []
            ledger = Ledger(out / "ifbench/calls.jsonl")
            throttle = SimpleNamespace(accounted_seconds=0, pauses=0, paused_seconds=0)
            def provider(role, messages, max_tokens):
                calls.append(role)
                field = "response" if len(calls) % 2 else "final_response"
                ledger.admit(role, messages, max_tokens)
                frame = {"status": 200, "body": {"message": {
                    "content": [{"type": "text", "text": json.dumps({"reasoning": "", field: "heliotropeproofword"})}],
                    "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0}, "stopReason": "stop"}}}
                return ledger.settle(role, {"messages": messages}, frame, 0)
            provider.gateway = SimpleNamespace(route_identity={"fixture": True})
            provider.close = lambda: None
            args = argparse.Namespace(task="all", out=out, cache=cache, adversarial=admission)
            with patch("pilot.__main__.validate_measurement", side_effect=validate_measurement), patch(
                "pilot.__main__.calls_for", return_value=(provider, ledger, throttle)
            ), redirect_stdout(StringIO()):
                run_controls(args, json.loads((Path(directory) / "pool.json").read_text()), {})
                self.assertEqual(list(load_panel(SimpleNamespace(controls=out, cache=cache, task="all"))), ["mbpp", "hover"])
                with self.assertRaises(ValueError):
                    run_controls(args, {}, {})
            self.assertEqual(json.loads((out / "ifbench/failure.json").read_text())["gate"], "headroom")
            self.assertEqual(json.loads((out / "panel.json").read_text())["tasks"], ["mbpp", "hover"])
            self.assertEqual(json.loads((out / "ifbench/controls.json").read_text())["controls"]["naive"]["mean"], 1.0)
            self.assertEqual(calls, ["task"] * 80)
            self.assertFalse((out / "ifbench/noise-pairs.json").exists())


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
            for name in ("ifbench", "hover"):
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
                                control["adversarial_hash"] = "forged"
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
                path = controls / "ifbench/admission.json"
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

    def test_panel_cannot_restore_aime_or_claim_fallback_after_a_hover_pass(self):
        for field, value in (("tasks", ["mbpp", "ifbench", "aime"]),
                             ("tasks", ["mbpp", "hover"]), ("ifbench_status", "failed-gate"), ("withdrawn", [])):
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                tasks, controls, pool = self.fixture(root)
                panel = json.loads((controls / "panel.json").read_text())
                panel[field] = value
                save(controls / "panel.json", panel)
                seal(controls)
                argv, loader, reused, metric = self.invoke(root, tasks, controls, pool, "smoke")
                with argv, loader, reused, metric, patch("pilot.__main__.environment") as auth:
                    with self.assertRaisesRegex(ValueError, "contradicts"):
                        main()
                    auth.assert_not_called()

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
