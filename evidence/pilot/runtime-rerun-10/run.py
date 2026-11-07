import argparse
from itertools import product
import json
import os
from pathlib import Path
import shutil

from pilot import __main__ as cli
from pilot.runtime import digest, pool_domains, retry_comparison
from pilot.spend import report_spend


ROOT = Path(__file__).resolve().parents[3]


def main():
    prior_root = ROOT / "evidence/pilot/seeds12-search-10"
    proof = json.loads((ROOT / "evidence/pilot/runtime-rerun-10/admission.json").read_text())
    pin = ROOT / ".pilot-cache/omp-18.16.0"
    os.environ["PATH"] = str(pin / "node_modules/.bin") + os.pathsep + os.environ["PATH"]
    cli.configure_nlp(ROOT / ".pilot-cache")
    assert cli.execution_limits() == ([6], 10)
    executable = Path(shutil.which("omp")).resolve()
    assert str(executable) == proof["gateway_omp_realpath"]
    assert cli.file_hash(executable) == proof["cli_file_hash"]
    assert cli.file_hash(pin / "package-lock.json") == proof["package_lock_file_hash"]
    for name, expected in proof["execution_source_hashes"].items():
        assert cli.file_hash(ROOT / name) == expected, name
    args = argparse.Namespace(command="pilot", task="all", seed=[1, 2],
                              cache=ROOT / ".pilot-cache", controls=ROOT / "evidence/pilot/controls-7b",
                              pool=ROOT / ".pilot-state/account-pool.json",
                              out=ROOT / ".pilot-runs/pilot-seeds12-10-rerun1")
    assert not args.out.exists(), "Never restart or overwrite this infrastructure attempt"
    assert cli.load_panel(args) == ("mbpp", "hover")
    cli.verify_bundle(prior_root)
    history = json.loads((prior_root / "comparison.json").read_text())["runs"]
    matrix = list(product((1, 2), ("mbpp", "hover"), cli.METHODS))
    assert [(row["seed"], row["task"], row["method"]) for row in history] == matrix[:4]
    assert [row["status"] for row in history] == ["completed", "completed", "infrastructure_failure", "infrastructure_failure"]
    assert cli.dispatch_stop(history)["reason"] == "consecutive-infrastructure-failures"
    assert cli.dispatch_stop(history[:-1]) is None
    for row in history[2:]:
        assert all(row.get(key, 0) == 0 for key in ("calls", "tokens", "usd_equivalent", "hidden_attempts", "usage_missing_calls", "pause_seconds"))
    pool, env = cli.environment(args.pool)
    assert digest(pool) == proof["account_pool_hash"]
    assert pool_domains(pool) == {"gmail.com": 2, "purdue.edu": 1}
    assert Path(shutil.which("omp", path=env["PATH"])).resolve() == executable
    args.out.mkdir(parents=True)
    for seed, task, method in matrix[:2]:
        source = prior_root / task / str(seed) / method
        destination = args.out / task / str(seed) / method
        shutil.copytree(source, destination)
        cli.verify_bundle(destination)
        for path in source.rglob("*"):
            if path.is_file():
                assert cli.file_hash(path) == cli.file_hash(destination / path.relative_to(source))
    cli.machine_proof(args.out)
    cli.save(args.out / "rerun.json", {"infrastructure_rerun": 1, "max_infrastructure_reruns": 2,
             "prior_root": str(prior_root), "prior_bundle_hash": json.loads((prior_root / "bundle.json").read_text())["bundle_hash"],
             "addendum_file_hash": cli.file_hash(ROOT / "evidence/pilot/predeclaration-10-addendum-1.md"),
             "runner_file_hash": cli.file_hash(Path(__file__)), "admission": proof,
             "retained_completed_cells": matrix[:2], "remaining_cells": matrix[2:],
             "initial_consecutive_infrastructure_failures": 2})
    latest = {(row["seed"], row["task"], row["method"]): row for row in history[:2]}
    sources = {f"{task}/{seed}/{method}":
               {"attempt": 0, "path": str(prior_root / task / str(seed) / method),
                "status": latest[seed, task, method]["status"]}
               if (seed, task, method) in latest else {"attempt": None, "path": None, "status": "unstarted"}
               for seed, task, method in matrix}
    for row in history[2:]:
        sources[f"{row['task']}/{row['seed']}/{row['method']}"]["prior_failure_path"] = str(
            prior_root / row["task"] / str(row["seed"]) / row["method"])
    cli.save(args.out / "cell-sources.json", sources)
    stopped = None
    cli.save(args.out / "attempts.json", history)
    for seed, task, method in matrix[2:]:
        assert Path(shutil.which("omp")).resolve() == executable
        assert cli.file_hash(executable) == proof["cli_file_hash"]
        assert cli.file_hash(pin / "package-lock.json") == proof["package_lock_file_hash"]
        args.remaining_pause_seconds = max(0, 6 * 3600 - sum(row.get("pause_seconds", 0) for row in history))
        result = cli.search_one(args, pool, env, task, seed, method, False)
        out = args.out / task / str(seed) / method
        spend = report_spend(out)
        cli.save(out / "spend.json", spend)
        cli.seal(out)
        row = dict(result, spend=spend)
        history.append(row)
        latest[seed, task, method] = row
        sources[f"{task}/{seed}/{method}"] = {"attempt": 1, "path": str(out), "status": result["status"]}
        cli.save(args.out / "cell-sources.json", sources)
        cli.save(args.out / "attempts.json", history)
        stopped = cli.dispatch_stop(history)
        cli.save(args.out / "comparison.json", {"runs": [latest[cell] for cell in matrix if cell in latest],
                 "seeds": [1, 2], "dispatch_stop": stopped})
        if stopped is not None:
            if stopped["reason"] == "consecutive-infrastructure-failures":
                streak = 0
                for previous in reversed(history):
                    if previous["status"] != "infrastructure_failure":
                        break
                    streak += 1
                stopped["consecutive_infrastructure_failures"] = streak
            cli.save(args.out / "stop.json", stopped)
            print(cli.canonical({"dispatch_stop": stopped}), flush=True)
            break
    totals = {method: {"hidden_attempt_rate": sum(row["hidden_attempts"] for row in history if row["method"] == method)
                      / max(1, sum(row["calls"] for row in history if row["method"] == method))} for method in cli.METHODS}
    cli.save(args.out / "comparison.json", {"runs": [latest[cell] for cell in matrix if cell in latest],
             "seeds": [1, 2], "dispatch_stop": stopped, "retry_comparison": retry_comparison(totals)})
    cli.seal(args.out)


if __name__ == "__main__":
    main()
