import argparse
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pilot.__main__ import TASKS, evaluator_identity, main, replay, save, seal
from pilot.tasks import Task


class PreflightTests(unittest.TestCase):
    def fixture(self, root):
        tasks = {name: Task(name, [], [], {"task": name}, {"prompt": "answer"}) for name in TASKS}
        controls = root / "controls"
        for name, task in tasks.items():
            save(controls / name / "controls.json", {
                "ranking_passed": True, "noise_passed": True,
                "identity": evaluator_identity(task),
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
                for defect in ("ranking", "noise", "missing", "unsealed", "tampered", "identity"):
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

    def test_replay_unencodable_output_scores_zero_without_model_calls(self):
        task = Task("mbpp", [{"id": "dev:1", "test_setup_code": "", "test_list": []}], [],
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
