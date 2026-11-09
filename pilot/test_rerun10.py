import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

from pilot import __main__ as cli
from pilot.runtime import digest
from pilot.results import report_seeds12


class InfrastructureRerunTests(unittest.TestCase):
    def test_first_new_failure_is_third_consecutive_and_stops_dispatch(self):
        project = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location("rerun10", project / "evidence/pilot/runtime-rerun-10/run.py")
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            root = Path(directory)
            prior = root / "evidence/pilot/seeds12-search-10"
            shutil.copytree(project / "evidence/pilot/seeds12-search-10", prior)
            initial = json.loads((prior / "comparison.json").read_text())["runs"]
            pin = root / ".pilot-cache/omp-18.16.0"
            executable = pin / "node_modules/.bin/omp"
            executable.parent.mkdir(parents=True)
            executable.write_text("admitted executable fixture\n")
            executable.chmod(0o755)
            (pin / "package-lock.json").write_text("{}\n")
            pool = {"*": False, "anthropic": {"accounts": ["email:fixture-one@gmail.com", "email:fixture-two@gmail.com", "email:fixture-three@purdue.edu"], "apiKeys": False}}
            cli.save(root / "evidence/pilot/runtime-rerun-10/admission.json", {
                "gateway_omp_realpath": str(executable), "cli_file_hash": cli.file_hash(executable),
                "package_lock_file_hash": cli.file_hash(pin / "package-lock.json"),
                "execution_source_hashes": {}, "account_pool_hash": digest(pool)})
            (root / "evidence/pilot/predeclaration-10-addendum-1.md").write_text("fixture\n")
            dispatched = []

            def infrastructure_failure(args, pool, env, task, seed, method, smoke):
                dispatched.append((seed, task, method))
                return cli.resume_result(args.out / task / str(seed) / method, task, seed, method, "TransportError")

            runner.ROOT = root
            with patch.object(cli, "load_panel", return_value=("mbpp", "hover")), patch.object(
                    cli, "environment", side_effect=lambda path: (pool, {"PATH": os.environ["PATH"]})), patch.object(
                    cli, "execution_limits", return_value=([6], 10)), patch.object(
                    cli, "search_one", side_effect=infrastructure_failure):
                runner.main()
            out = root / ".pilot-runs/pilot-seeds12-10-rerun1"
            stopped = json.loads((out / "stop.json").read_text())
            attempts = json.loads((out / "attempts.json").read_text())
            self.assertEqual(dispatched, [(1, "mbpp", "plain")])
            self.assertEqual(stopped["reason"], "consecutive-infrastructure-failures")
            self.assertEqual(stopped["consecutive_infrastructure_failures"], 3)
            self.assertEqual(len(attempts), len(initial) + 1)
            self.assertEqual(sum(row["calls"] for row in attempts), sum(row["calls"] for row in initial))
            self.assertEqual(sum(row["pause_seconds"] for row in attempts), sum(row["pause_seconds"] for row in initial))
            sources = json.loads((out / "cell-sources.json").read_text())
            self.assertEqual(sources["mbpp/1/plain"]["attempt"], 1)
            self.assertIsNone(sources["hover/1/hone"]["attempt"])
            self.assertEqual(sources["hover/1/hone"]["prior_failure_path"], str(prior / "hover/1/hone"))
            report = report_seeds12(out, out)
            hover = next(cell for cell in report["cells"]
                         if (cell["seed"], cell["task"], cell["method"]) == (1, "hover", "hone"))
            self.assertEqual(hover["status"], "missing")
            comparison = json.loads((out / "comparison.json").read_text())
            self.assertNotIn((1, "hover", "hone"),
                             [(row["seed"], row["task"], row["method"]) for row in comparison["runs"]])
            self.assertEqual(sources["mbpp/2/hone"]["status"], "unstarted")
            cli.verify_bundle(out)
