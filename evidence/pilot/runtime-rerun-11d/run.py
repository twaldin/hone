import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from pilot import __main__ as cli
from pilot.campaign import CampaignGuard, CampaignStop, MATRIX, campaign_scope
from pilot.runtime import digest, pool_domains, retry_comparison
from pilot.verification import grader_journal
from pilot.spend import report_spend

ROOT = Path(__file__).resolve().parents[3]


def historical_attempts(prior_root):
    cli.verify_bundle(prior_root)
    accounting = json.loads((prior_root / "attempt-accounting.json").read_text())
    path = prior_root / accounting["producer_attempts_path"]
    if cli.file_hash(path) != accounting["producer_attempts_file_hash"]:
        raise RuntimeError("Historical attempt identity mismatch")
    rows = json.loads(path.read_text())
    if len(rows) != 7 or accounting["total_attempt_rows_with_derived_failure"] != 8:
        raise RuntimeError("Historical chronology mismatch")
    rows = [dict(row, historical=True, historical_source=str(path), historical_ordinal=i)
            for i, row in enumerate(rows)]
    derived = prior_root / accounting["post_abort_derived_row"]
    row = json.loads(derived.read_text())
    if row["status"] != "infrastructure_failure" or row["stop_reason"] != "OSError_ENOSPC":
        raise RuntimeError("Missing historical ENOSPC prefix")
    rows.append(dict(row, historical=True, historical_source=str(derived), historical_ordinal=7))
    return rows, accounting


def dispatch(args, pool, env, proof, history, guard, check_pins):
    sources = {f"{task}/{seed}/{method}": {"attempt": None, "path": None, "status": "unstarted"}
               for seed, task, method in MATRIX}
    latest = []
    stopped = cli.dispatch_stop(history)
    cli.save(args.out / "attempts.json", history)
    cli.save(args.out / "cell-sources.json", sources)
    with campaign_scope(guard):
        for cell in MATRIX:
            if stopped is not None:
                break
            seed, task, method = cell
            try:
                check_pins()
                guard.before_cell(cell)
                args.remaining_pause_seconds = max(0, 6 * 3600 - sum(row.get("pause_seconds", 0) for row in history))
                sources[f"{task}/{seed}/{method}"] = {"attempt": 2, "path": str(args.out / task / str(seed) / method), "status": "running"}
                cli.save(args.out / "cell-sources.json", sources)
                cli.save(args.out / "controller.json", {"current_cell": cell, "pid": os.getpid(),
                         "unit": os.environ.get("SYSTEMD_UNIT"), "declaration_file_hash": proof["predeclaration_file_hash"],
                         "declaration_commit": proof["declaration_commit"], "actual_new_calls": guard.actual})
                result = cli.search_one(args, pool, env, task, seed, method, False)
                out = args.out / task / str(seed) / method
                spend = report_spend(out)
                cli.save(out / "spend.json", spend)
                cli.seal(out)
                row = dict(result, spend=spend)
                guard.finish_cell(row)
                history.append(row)
                latest.append(row)
                sources[f"{task}/{seed}/{method}"]["status"] = row["status"]
                cli.save(args.out / "attempts.json", history)
                cli.save(args.out / "cell-sources.json", sources)
                stopped = guard.stopped or cli.dispatch_stop(history)
            except CampaignStop as error:
                stopped = error.receipt
                break
            cli.save(args.out / "comparison.json", {"runs": latest, "seeds": [1, 2], "dispatch_stop": stopped})
    totals = {method: {"hidden_attempt_rate": sum(row["hidden_attempts"] for row in history if row["method"] == method)
                      / max(1, sum(row["calls"] for row in history if row["method"] == method))} for method in cli.METHODS}
    cli.save(args.out / "comparison.json", {"runs": latest, "seeds": [1, 2], "dispatch_stop": stopped,
             "actual_new_calls": guard.actual, "retry_comparison": retry_comparison(totals)})
    cli.save(args.out / "controller.json", {"current_cell": guard.current, "pid": os.getpid(),
             "unit": os.environ.get("SYSTEMD_UNIT"), "status": "stopped" if stopped else "completed",
             "completed_cells": len(latest), "actual_new_calls": guard.actual,
             "declaration_file_hash": proof["predeclaration_file_hash"], "declaration_commit": proof["declaration_commit"]})
    if stopped is not None:
        cli.save(args.out / "stop.json", stopped)
    cli.seal(args.out)
    return latest, stopped


def main():
    proof = json.loads((ROOT / "evidence/pilot/runtime-rerun-11d/admission.json").read_text())
    if (proof.get("passed") is not True or proof.get("model_calls") != 0 or proof.get("gateway_requests") != 0
            or proof.get("official_gepa_and_adapter_unchanged") is not True):
        raise RuntimeError("A passing zero-call admission with unchanged official GEPA is required")
    gates = json.loads((ROOT / ".pilot-state/launch-11.json").read_text())
    if gates["admission_file_hash"] != cli.file_hash(ROOT / "evidence/pilot/runtime-rerun-11d/admission.json"):
        raise RuntimeError("Launch gates reference a different admission")
    pin = ROOT / ".pilot-cache/omp-18.16.0"
    os.environ["PATH"] = str(pin / "node_modules/.bin") + os.pathsep + os.environ["PATH"]
    cli.configure_nlp(ROOT / ".pilot-cache")
    for variable in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        if os.environ.get(variable) != "1":
            raise RuntimeError(f"One-thread setting required: {variable}")
    if cli.execution_limits() != ([6], 10):
        raise RuntimeError("CPU/nice mismatch")
    if not os.environ.get("SYSTEMD_UNIT") or gates["systemd_unit"] != os.environ["SYSTEMD_UNIT"]:
        raise RuntimeError("Named systemd unit required")
    unit = subprocess.run(["systemctl", "--user", "show", os.environ["SYSTEMD_UNIT"], "--property=Restart", "--value"],
                          capture_output=True, text=True, check=True).stdout.strip()
    if unit != "no":
        raise RuntimeError("Restart must be disabled")
    executable = Path(shutil.which("omp")).resolve()

    def check_pins():
        if str(executable) != proof["gateway_omp_realpath"] or Path(shutil.which("omp")).resolve() != executable:
            raise RuntimeError("Lane-local omp mismatch")
        if not executable.is_relative_to(pin.resolve()):
            raise RuntimeError("Global omp forbidden")
        paths = {executable: proof["cli_file_hash"], pin / "package-lock.json": proof["package_lock_file_hash"],
                 ROOT / "evidence/pilot/predeclaration-11.md": proof["predeclaration_file_hash"]}
        paths.update({ROOT / name: value for name, value in proof["execution_source_hashes"].items()})
        paths.update({ROOT / name: value for name, value in proof["index_file_hashes"].items()})
        if not proof["execution_source_hashes"] or not proof["index_file_hashes"]:
            raise RuntimeError("Missing source/index pins")
        for path, expected in paths.items():
            with path.open("rb") as stream:
                observed = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
            if observed != expected:
                raise RuntimeError(f"Pinned identity mismatch: {path}")
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        if head != gates["launch_head"] or gates["cross_family_ready_head"] != head or gates["green_ci_head"] != head:
            raise RuntimeError("Exact-head launch gates mismatch")

    check_pins()
    args = argparse.Namespace(command="pilot", task="all", seed=[1, 2], cache=ROOT / ".pilot-cache",
                              controls=ROOT / "evidence/pilot/controls-7b", pool=ROOT / ".pilot-state/account-pool.json",
                              out=ROOT / ".pilot-runs/pilot-seeds12-11-rerun2")
    if args.out.exists():
        raise RuntimeError("Never restart or overwrite rerun 2")
    guard = CampaignGuard(args.out)
    guard.check_disk()
    args.out.mkdir(parents=True, exist_ok=False)
    with campaign_scope(guard), grader_journal(args.out / "admission-grader-outcomes.jsonl", purpose="admission"):
        if cli.load_panel(args) != ("mbpp", "hover"):
            raise RuntimeError("Admitted panel mismatch")
    history, accounting = historical_attempts(ROOT / "evidence/pilot/seeds12-search-10-rerun1")
    pool, env = cli.environment(args.pool)
    if digest(pool) != proof["account_pool_hash"] or pool_domains(pool) != {"gmail.com": 2, "purdue.edu": 1}:
        raise RuntimeError("Account pool mismatch")
    if Path(shutil.which("omp", path=env["PATH"])).resolve() != executable:
        raise RuntimeError("Gateway omp mismatch")
    cli.machine_proof(args.out)
    cli.save(args.out / "rerun.json", {"infrastructure_rerun": 2, "max_infrastructure_reruns": 2,
             "retained_completed_cells": [], "remaining_cells": MATRIX, "admission": proof, "launch_gates": gates,
             "predeclaration_file_hash": proof["predeclaration_file_hash"], "declaration_commit": proof["declaration_commit"],
             "runner_file_hash": cli.file_hash(Path(__file__)), "historical_accounting": accounting,
             "historical_root": str(ROOT / "evidence/pilot/seeds12-search-10-rerun1")})
    dispatch(args, pool, env, proof, history, guard, check_pins)


if __name__ == "__main__":
    main()
