from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import tempfile
from collections import Counter
from pathlib import Path

from .runtime import (ROOT, MODEL, IMAGE, LIMITS, PRICES, PRICE_SOURCE, Gateway, Ledger,
                      ModelCalls, Throttle, TransportError, CallFailed, append_json, canonical,
                      create_pool, digest, open_gateway, pool_domains, retry_comparison)

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


def machine_proof(out: Path) -> None:
    permitted = sorted(os.sched_getaffinity(0))
    if 0 not in permitted:
        raise ValueError("CPU 0 is not available to this runner")
    affinities = Counter()
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                affinities[tuple(sorted(os.sched_getaffinity(int(entry.name))))] += 1
            except OSError:
                pass
    save(out / "machine.json", {"selected_cpu": 0, "permitted_cpus": permitted,
         "observed_process_affinity_sets": [{"cpus": list(cpus), "processes": count} for cpus, count in affinities.items()],
         "max_model_requests_inflight": 1, "max_cpu_heavy_workers": 1, "nice": 10})


def route_proof(pool: dict, env: dict, out: Path) -> None:
    call, ledger, throttle = calls_for(pool, env, out)
    try:
        reply = call("task", [{"role": "user", "content": "Reply with exactly ROUTE_OK."}], 32)
        if reply.strip() != "ROUTE_OK":
            raise ValueError("Route proof returned unexpected content")
        save(out / "result.json", {"reply": reply, "allowed_domains": pool_domains(pool), "api_keys_allowed": False,
             "lindy_ai_allowed": False, "route_identity": call.gateway.route_identity, **ledger.summary(throttle)})
    finally:
        call.close()
    with tempfile.TemporaryDirectory(prefix="hone-pool-proof-") as directory:
        pool_file = Path(directory) / "pool.json"
        save(pool_file, {"*": False, "anthropic": {"accounts": ["email:pilot-nonexistent@gmail.com"], "apiKeys": False}})
        negative_env = dict(env, OMP_AUTH_BROKER_ACCOUNT_POOL_FILE=str(pool_file),
                            ANTHROPIC_OAUTH_TOKEN="not-a-credential-negative-test", ANTHROPIC_API_KEY="not-a-credential-negative-test")
        gateway = Gateway(negative_env)
        negative = Ledger(out / "negative-auth-calls.jsonl")
        body = {"model": MODEL, "context": {"messages": [{"role": "user", "content": "This request must not reach a provider", "timestamp": 0}]},
                "options": {"maxTokens": 1}, "stream": False}
        try:
            negative.admit("task", body["context"]["messages"], 1)
            frame = gateway.request(body)
            if frame.get("status") == 200 or frame.get("body", {}).get("retryObservation", {}).get("httpAttempts") != 0:
                raise ValueError("OAuth-only restriction allowed credential fallback")
            try:
                negative.settle("task", body, frame, 0)
            except CallFailed:
                pass
            save(out / "negative-auth.json", {"configured_environment_fallbacks": "non-secret fixture values",
                 "allowed_oauth_accounts_present": 0, "provider_http_attempts": 0, "status": frame["status"],
                 "reported_calls": negative.calls, "reported_tokens": negative.tokens, "fallback_refused": True})
        finally:
            gateway.close()


def calls_for(pool: dict, env: dict, out: Path, limits: dict | None = None):
    throttle = Throttle(pool, env, out / "pauses.jsonl")
    ledger = Ledger(out / "calls.jsonl", limits=dict(limits or LIMITS))
    return ModelCalls(open_gateway(throttle), ledger, throttle), ledger, throttle


def controls(args, pool, env):
    from .controls import measure
    from .tasks import load_task
    for name in TASKS if args.task == "all" else (args.task,):
        task = load_task(name, args.cache)
        out = args.out / name
        if (out / "controls.json").exists():
            raise ValueError("Control evidence already exists; preserve it instead of rerunning to a favorable result")
        call, ledger, throttle = calls_for(pool, env, out, dict(LIMITS, usd=100))
        try:
            measure(task, call, out, evaluator_identity(task))
        except Exception as error:
            save(out / "failure.json", {"error_type": type(error).__name__, "status": "admission-failed"})
            raise
        finally:
            save(out / "usage.json", ledger.summary(throttle))
            call.close()
        save(out / "usage.json", ledger.summary(throttle))
        print(canonical({"task": name, "controls": "passed", **ledger.summary(throttle)}), flush=True)


def seal(out: Path) -> None:
    files = {str(path.relative_to(out)): file_hash(path) for path in sorted(out.rglob("*")) if path.is_file() and path.name != "bundle.json"}
    save(out / "bundle.json", {"files": files, "bundle_hash": digest(files)})


def verify_bundle(out: Path) -> None:
    bundle = json.loads((out / "bundle.json").read_text())
    if digest(bundle["files"]) != bundle["bundle_hash"]:
        raise ValueError("Bundle manifest hash mismatch")
    for filename, expected in bundle["files"].items():
        path = (out / filename).resolve()
        if not path.is_relative_to(out.resolve()) or file_hash(path) != expected:
            raise ValueError("Bundle file path or hash mismatch")


def resume_result(out: Path, task_name: str, seed: int, method: str, error_type: str = "InterruptedRun") -> dict:
    if (out / "bundle.json").exists() and (out / "result.json").exists():
        verify_bundle(out)
        return json.loads((out / "result.json").read_text())
    calls = []
    if (out / "calls.jsonl").exists():
        for line in (out / "calls.jsonl").read_text().splitlines(keepends=True):
            if not line.endswith("\n"):
                break
            calls.append(json.loads(line))
    incumbent = {}
    if (out / "incumbents.jsonl").exists():
        for line in (out / "incumbents.jsonl").read_text().splitlines(keepends=True):
            if line.endswith("\n"):
                incumbent = json.loads(line)
    hidden = sum(call.get("retry_observation", {}).get("hiddenAttempts", 0) for call in calls)
    result = {"task": task_name, "seed": seed, "method": method, "status": "infrastructure_failure",
              "selection_score": incumbent.get("selection_score"), "candidate_hash": digest(incumbent.get("candidate")),
              "calls": len(calls), "tokens": sum(call["reported_tokens"] for call in calls),
              "usd_equivalent": sum(call["usd_equivalent"] for call in calls), "hidden_attempts": hidden,
              "hidden_attempt_rate": hidden / len(calls) if calls else 0, "usage_missing_calls": sum(call.get("usage_missing", False) for call in calls),
              "proposer_calls": sum(call.get("role") in {"proposer", "repair"} for call in calls),
              "stop_reason": error_type, "accounting_incomplete": True}
    save(out / "failure.json", {"error_type": error_type, "rerun_policy": "Never rerun this cell; retain its durable usage prefix and last accepted incumbent."})
    save(out / "result.json", result)
    seal(out)
    return result


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
        return resume_result(out, task_name, seed, method)
    out.mkdir(parents=True)
    try:
        call, ledger, throttle = calls_for(pool, env, out)
    except Exception as error:
        return resume_result(out, task_name, seed, method, type(error).__name__)
    rollouts = 0
    def protected_evaluate(candidate, rows, capture_traces=False):
        nonlocal rollouts
        if rollouts + len(rows) > 10_000:
            from .runtime import BudgetExhausted
            raise BudgetExhausted("Rollout cap exhausted", "rollouts")
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
        result = run_search(method, task, call, protected_evaluate, lambda: ledger.available(throttle.accounted_seconds), control, seed, out, max_proposals=1 if smoke else None)
        summary = {"task": task_name, "seed": seed, "method": method, "status": "completed", "selection_score": result["selection_score"],
                   "candidate_hash": digest(result["candidate"]), "rollouts": rollouts, "proposals": result["proposals"],
                   "stop_reason": result["stop_reason"], **ledger.summary(throttle)}
        if result.get("binding_cap") is not None:
            summary["binding_cap"] = result["binding_cap"]
        save(out / "result.json", summary)
        save(out / "manifest.json", {"identity": identity, "identity_hash": digest(identity), "task_hash": digest(task.manifest),
                "evaluator_hash": digest(identity["evaluator_files"]), "route_identity": call.gateway.route_identity,
                "route_hash": digest(call.gateway.route_identity),
                "control_hash": digest(control), "budget": LIMITS, "budget_hash": digest(LIMITS), "price_per_million": PRICES, "price_source": PRICE_SOURCE,
                "account_pool_hash": digest(pool), "account_domains": pool_domains(pool), "api_keys_allowed": False,
                "engine_files": {path: file_hash(ROOT / path) for path in ("pilot/__main__.py", "pilot/search.py", "optimizer/src/pilot-policy.ts", "optimizer/assets/policy.ts", "optimizer/src/loop.ts", "schema/src/promotion.ts")},
                "limits": retry_comparison({method: summary})["limit"], "current_subscription_panel": True,
                "smoke_proposal_cap": 1 if smoke else None, "historical_snapshot_replication": False})
        if result["candidate"] is None:
            raise RuntimeError("No fully evaluated eligible artifact returned")
        if smoke and ledger.proposer_success_calls < 1:
            raise RuntimeError("Smoke did not exercise a real proposer request")
        seal(out)
        print(canonical(summary), flush=True)
        return summary
    except Exception as error:
        save(out / "manifest.json", {"identity": identity, "budget": LIMITS, "price_per_million": PRICES,
             "account_domains": pool_domains(pool), "failure": True})
        return resume_result(out, task_name, seed, method, type(error).__name__)
    finally:
        call.close()


def replay(args) -> None:
    from .tasks import load_task, score_output
    os.environ["NLTK_DATA"] = str((args.cache / "nltk").resolve())
    tasks = {}
    checked = 0
    for evaluations in sorted(args.out.rglob("evaluations.jsonl")):
        manifest = json.loads((evaluations.parent / "manifest.json").read_text())
        name = manifest["identity"]["task"]["task"]
        if name not in tasks:
            tasks[name] = load_task(name, args.cache)
        task = tasks[name]
        if task.manifest != manifest["identity"]["task"]:
            raise ValueError("Replay task or metric resources differ from retained evidence")
        rows = {row["id"]: row for row in task.train + task.selection}
        for line in evaluations.read_text().splitlines():
            record = json.loads(line)
            scores = [score_output(task, rows[row_id], output) for row_id, output in zip(record["row_ids"], record["outputs"], strict=True)]
            if scores != record["scores"]:
                raise ValueError("Replay metric disagrees with a retained evaluation")
            checked += len(scores)
    if not checked:
        raise ValueError("Bundle has no scored outputs to replay")
    print(canonical({"replayed_rollouts": checked, "model_calls": 0, "scored_final_tests_loaded": False}))


def main():
    parser = argparse.ArgumentParser(description="Frozen development-only Hone optimizer pilot")
    parser.add_argument("command", choices=("prepare", "probe", "throttle-proof", "controls", "smoke", "pilot", "verify", "replay"))
    parser.add_argument("--cache", type=Path, default=ROOT / ".pilot-cache")
    parser.add_argument("--pool", type=Path, default=ROOT / ".pilot-state/account-pool.json")
    parser.add_argument("--controls", type=Path, default=ROOT / "evidence/pilot/controls")
    parser.add_argument("--out", type=Path, default=ROOT / "evidence/pilot/smoke")
    parser.add_argument("--task", choices=(*TASKS, "all"), default="all")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.command in {"verify", "replay"}:
        verify_bundle(args.out)
        print("Evidence hashes verified")
        if args.command == "replay":
            replay(args)
        return
    pool, env = environment(args.pool)
    if args.command == "throttle-proof":
        throttle_proof(pool, env, args.out)
    elif args.command == "prepare":
        from .tasks import load_task
        save(args.out / "tasks.json", {name: load_task(name, args.cache).manifest for name in TASKS})
        save(args.out / "account-domains.json", {"domains": pool_domains(pool), "api_keys_allowed": False, "pool_hash": digest(pool)})
        machine_proof(args.out)
    elif args.command == "controls":
        controls(args, pool, env)
    elif args.command == "probe":
        route_proof(pool, env, args.out)
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
        if args.command == "smoke" and any(row.get("status") != "completed" for row in rows):
            raise RuntimeError("Smoke failed; retained failure evidence cannot be selectively rerun")


if __name__ == "__main__":
    main()
