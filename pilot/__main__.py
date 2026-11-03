from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

from .runtime import (ROOT, MODEL, IMAGE, LIMITS, PRICES, PRICE_SOURCE, Gateway, Ledger,
                      ModelCalls, Throttle, TransportError, append_json, canonical,
                      create_pool, digest, omp_json, pool_domains, retry_comparison)

TASKS = ("ifbench", "aime", "mbpp")
METHODS = ("hone", "gepa", "plain")


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(value) + "\n")


def file_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def evaluator_identity(task) -> dict:
    paths = ("pilot/tasks.py", "pilot/program.py", "pilot/controls.py", "pilot/runtime.py", "pilot/gateway.mjs")
    return {"task": task.manifest, "evaluator_files": {path: file_hash(ROOT / path) for path in paths},
            "route": MODEL, "decoding": {"temperature": 0, "forceReasoningOff": True, "max_output_tokens": 4096, "cacheRetention": "none"},
            "image": IMAGE}


def environment(pool_path: Path) -> tuple[dict, dict]:
    if not pool_path.exists():
        create_pool(pool_path)
    pool = json.loads(pool_path.read_text())
    if set(pool) != {"*", "anthropic"} or pool["*"] is not False or pool["anthropic"].get("apiKeys") is not False:
        raise ValueError("Pilot pool must deny every other provider and all API keys")
    identities = pool["anthropic"].get("accounts", [])
    if not identities or any(not isinstance(identity, str) or not identity.startswith("email:") or identity.split("|", 1)[0].rsplit("@", 1)[-1] not in {"gmail.com", "purdue.edu"} for identity in identities):
        raise ValueError("Pilot pool contains an unapproved account domain")
    env = os.environ.copy()
    env["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"] = str(pool_path.resolve())
    env["NLTK_DATA"] = str((ROOT / ".pilot-cache/nltk").resolve())
    env["PILOT_PYTHON_IMAGE"] = IMAGE
    os.environ["NLTK_DATA"] = env["NLTK_DATA"]
    os.environ["PILOT_PYTHON_IMAGE"] = IMAGE
    return pool, env


def throttle_proof(pool: dict, env: dict, out: Path) -> None:
    live = Throttle(pool, env, out / "live-probe.jsonl")
    live.wait()
    normal = live.read()
    high = copy.deepcopy(normal)
    for report in high["reports"]:
        for limit in report.get("limits", []):
            limit["amount"]["usedFraction"] = 0.99
    sequence = iter((high, TransportError("forced broker outage"), normal))
    readings = []
    def reader():
        reading = next(sequence)
        readings.append("outage" if isinstance(reading, Exception) else "high" if reading is high else "live-normal")
        if isinstance(reading, Exception):
            raise reading
        return reading
    throttle = Throttle(pool, env, out / "pauses.jsonl", interval=0.05, reader=reader)
    dispatched = []
    throttle.wait()
    dispatched.append("after-resume-only")
    assert readings == ["high", "outage", "live-normal"]
    assert throttle.pauses == 1 and throttle.paused_seconds >= 0.1
    save(out / "result.json", {"readings": readings, "dispatched": dispatched, "pause_seconds": throttle.paused_seconds, "pauses": throttle.pauses,
                              "forced_high_used_fraction": 0.99, "threshold": 0.8, "real_broker_interrupted": False,
                              "allowed_domains": pool_domains(pool), "outage_behavior": "pause and resume, not failure"})


def calls_for(pool: dict, env: dict, out: Path, limits: dict | None = None):
    throttle = Throttle(pool, env, out / "pauses.jsonl")
    ledger = Ledger(out / "calls.jsonl", limits=dict(limits or LIMITS))
    throttle.wait()
    return ModelCalls(Gateway(env), ledger, throttle), ledger, throttle


def controls(args, pool, env):
    from .controls import ControlsFailed, measure
    from .tasks import load_task
    for name in TASKS if args.task == "all" else (args.task,):
        task = load_task(name, args.cache)
        out = args.out / name
        if (out / "controls.json").exists():
            raise ValueError("Control evidence already exists; preserve it instead of rerunning to a favorable result")
        call, ledger, throttle = calls_for(pool, env, out, dict(LIMITS, usd=100))
        try:
            measure(task, call, out, evaluator_identity(task))
        except ControlsFailed:
            save(out / "usage.json", ledger.summary(throttle))
            raise
        finally:
            call.close()
        save(out / "usage.json", ledger.summary(throttle))
        print(canonical({"task": name, "controls": "passed", **ledger.summary(throttle)}), flush=True)


def seal(out: Path) -> None:
    files = {str(path.relative_to(out)): file_hash(path) for path in sorted(out.rglob("*")) if path.is_file() and path.name != "bundle.json"}
    save(out / "bundle.json", {"files": files, "bundle_hash": digest(files)})


def search_one(args, pool, env, task_name: str, seed: int, method: str, smoke: bool) -> dict:
    from .tasks import evaluate, load_task
    from .search import run_search
    task = load_task(task_name, args.cache)
    identity = evaluator_identity(task)
    control = json.loads((args.controls / task_name / "controls.json").read_text())
    if not control.get("ranking_passed") or not control.get("noise_passed") or control["identity"] != identity:
        raise ValueError("Controls missing, failed, or not bound to this evaluator/data/route identity")
    out = args.out / task_name / str(seed) / method
    if out.exists():
        raise ValueError("Run directory exists; do not overwrite or selectively rerun searches")
    out.mkdir(parents=True)
    call, ledger, throttle = calls_for(pool, env, out)
    rollouts = 0
    def protected_evaluate(candidate, rows, capture_traces=False):
        nonlocal rollouts
        if rollouts + len(rows) > 10_000:
            from .runtime import BudgetExhausted
            raise BudgetExhausted("Rollout cap exhausted")
        rollouts += len(rows)
        artifact_hash = digest(candidate)
        save(out / "artifacts" / (artifact_hash.removeprefix("sha256:") + ".json"), candidate)
        before = {"tokens": ledger.tokens, "usd": ledger.usd, "calls": ledger.calls}
        result = evaluate(task, candidate, rows, call, capture_traces)
        append_json(out / "evaluations.jsonl", {"artifact_hash": artifact_hash, "row_ids": [row["id"] for row in rows],
                    "partition": "training" if capture_traces or all(row["id"] in set(task.manifest["train_ids"]) for row in rows) else "selection",
                    "scores": result["scores"], "outputs": result["outputs"], "deployment_calls": ledger.calls - before["calls"],
                    "deployment_tokens": ledger.tokens - before["tokens"], "deployment_usd": ledger.usd - before["usd"]})
        return result
    try:
        result = run_search(method, task, call, protected_evaluate, lambda: ledger.available(throttle.paused_seconds), control, seed, out, max_proposals=1 if smoke else None)
        summary = {"task": task_name, "seed": seed, "method": method, "selection_score": result["selection_score"],
                   "candidate_hash": digest(result["candidate"]), "rollouts": rollouts, "proposals": result["proposals"],
                   "stop_reason": result["stop_reason"], **ledger.summary(throttle)}
        save(out / "result.json", summary)
        save(out / "manifest.json", {"identity": identity, "identity_hash": digest(identity), "task_hash": digest(task.manifest),
                "evaluator_hash": digest(identity["evaluator_files"]), "route_hash": digest({"model": MODEL, "decoding": identity["decoding"]}),
                "control_hash": digest(control), "budget": LIMITS, "budget_hash": digest(LIMITS), "price_per_million": PRICES, "price_source": PRICE_SOURCE,
                "account_pool_hash": digest(pool), "account_domains": pool_domains(pool), "api_keys_allowed": False,
                "engine_files": {path: file_hash(ROOT / path) for path in ("pilot/search.py", "optimizer/src/pilot-policy.ts", "optimizer/src/loop.ts", "schema/src/promotion.ts")},
                "limits": retry_comparison({method: summary})["limit"], "current_subscription_panel": True,
                "smoke_proposal_cap": 1 if smoke else None, "historical_snapshot_replication": False})
        if result["candidate"] is None:
            raise RuntimeError("No fully evaluated eligible artifact returned")
        seal(out)
        print(canonical(summary), flush=True)
        return summary
    finally:
        call.close()


def main():
    parser = argparse.ArgumentParser(description="Frozen development-only Hone optimizer pilot")
    parser.add_argument("command", choices=("prepare", "throttle-proof", "controls", "smoke", "pilot", "verify"))
    parser.add_argument("--cache", type=Path, default=ROOT / ".pilot-cache")
    parser.add_argument("--pool", type=Path, default=ROOT / ".pilot-state/account-pool.json")
    parser.add_argument("--controls", type=Path, default=ROOT / "evidence/pilot/controls")
    parser.add_argument("--out", type=Path, default=ROOT / "evidence/pilot/smoke")
    parser.add_argument("--task", choices=(*TASKS, "all"), default="all")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.command == "verify":
        bundle = json.loads((args.out / "bundle.json").read_text())
        assert digest(bundle["files"]) == bundle["bundle_hash"]
        for filename, expected in bundle["files"].items():
            assert file_hash(args.out / filename) == expected, filename
        print("Evidence hashes verified")
        return
    pool, env = environment(args.pool)
    if args.command == "throttle-proof":
        throttle_proof(pool, env, args.out)
    elif args.command == "prepare":
        from .tasks import load_task
        save(args.out / "tasks.json", {name: load_task(name, args.cache).manifest for name in TASKS})
        save(args.out / "account-domains.json", {"domains": pool_domains(pool), "api_keys_allowed": False, "pool_hash": digest(pool)})
    elif args.command == "controls":
        controls(args, pool, env)
    else:
        rows = []
        tasks = ("mbpp",) if args.command == "smoke" and args.task == "all" else TASKS if args.task == "all" else (args.task,)
        seeds = (args.seed,) if args.command == "smoke" else (0, 1, 2)
        for task in tasks:
            for seed in seeds:
                for method in METHODS:
                    rows.append(search_one(args, pool, env, task, seed, method, args.command == "smoke"))
        totals = {method: {"hidden_attempt_rate": sum(row["hidden_attempts"] for row in rows if row["method"] == method) / max(1, sum(row["calls"] for row in rows if row["method"] == method))} for method in METHODS}
        save(args.out / "comparison.json", {"runs": rows, "retry_comparison": retry_comparison(totals)})
        seal(args.out)


if __name__ == "__main__":
    main()
