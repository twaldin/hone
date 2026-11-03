from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path

from .runtime import (ROOT, MODEL, IMAGE, LIMITS, PRICES, PRICE_SOURCE, Gateway, Ledger,
                      ModelCalls, Throttle, TransportError, CallFailed, append_json, canonical,
                      create_pool, digest, open_gateway, pool_domains, retry_comparison)

TASKS = ("mbpp", "ifbench", "aime")
P_TASKS = ("ifbench", "aime", "hover")
METHODS = ("hone", "gepa", "plain")


def save(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(value) + "\n")


def file_hash(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def evaluator_identity(task) -> dict:
    paths = ("pilot/tasks.py", "pilot/program.py", "pilot/verification.py", "pilot/adversarial.py",
             "pilot/controls.py", "pilot/runtime.py", "pilot/gateway.mjs", "pilot/__main__.py",
             "pilot/admission.py", "pilot/hover.py", "pilot/published.py", "pilot/published-controls.json")
    return {"contract": 4, "task": task.manifest, "evaluator_files": {path: file_hash(ROOT / path) for path in paths},
            "predeclaration_hash": file_hash(ROOT / "evidence/pilot/predeclaration-4.md"),
            "transport_correction_hash": file_hash(ROOT / "evidence/pilot/predeclaration-4a.md"),
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
    env = {key: os.environ[key] for key in (
        "HOME", "PATH", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
        "PI_CODING_AGENT_DIR", "OMP_AGENT_DIR",
    ) if key in os.environ}
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
    avoided = {0, 1, 2, 3, 4, 5, 13, 14, 15, 16}
    if permitted != [6]:
        raise ValueError("Pilot execution must inherit affinity pinned to CPU 6")
    priority = os.getpriority(os.PRIO_PROCESS, 0)
    if priority < 10:
        raise ValueError("Pilot execution must inherit nice 10 or lower scheduling priority")
    affinities = Counter()
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                affinities[tuple(sorted(os.sched_getaffinity(int(entry.name))))] += 1
            except OSError:
                pass
    live = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit() and int(entry.name) != os.getpid():
            try:
                cpus = sorted(os.sched_getaffinity(int(entry.name)))
                if cpus == [0, 5]:
                    live.append({"pid": int(entry.name), "cpus": cpus})
            except OSError:
                pass
    save(out / "machine.json", {"selected_cpu": permitted[0], "permitted_cpus": permitted,
         "inherited_affinity": True, "avoided_cpus": sorted(avoided),
         "avoidance_passed": not bool(set(permitted) & avoided), "observed_live_pinned_processes": live,
         "observed_process_affinity_sets": [{"cpus": list(cpus), "processes": count} for cpus, count in affinities.items()],
         "max_model_requests_inflight": 1, "max_cpu_heavy_workers": 1, "nice": priority})


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
            observation = frame.get("body", {}).get("retryObservation", {})
            if frame.get("status") == 200 or observation.get("httpAttempts") != 0 or observation.get("apiKeyHeaderRejections") != 0:
                raise ValueError("OAuth-only restriction allowed credential fallback")
            try:
                negative.settle("task", body, frame, 0)
            except CallFailed:
                pass
            save(out / "negative-auth.json", {"configured_environment_fallbacks": "non-secret fixture values",
                 "allowed_oauth_accounts_present": 0, "provider_http_attempts": 0, "api_key_header_rejections": 0, "status": frame["status"],
                 "reported_calls": negative.calls, "reported_tokens": negative.tokens, "fallback_refused": True})
        finally:
            gateway.close()


def calls_for(pool: dict, env: dict, out: Path, limits: dict | None = None):
    throttle = Throttle(pool, env, out / "pauses.jsonl")
    ledger = Ledger(out / "calls.jsonl", limits=dict(limits or LIMITS))
    return ModelCalls(open_gateway(throttle), ledger, throttle), ledger, throttle


def calibration_transport(call):
    def checked(role, messages, max_tokens):
        try:
            return call(role, messages, max_tokens)
        except CallFailed as error:
            raise TransportError("Calibration provider failure; no candidate score recorded") from error
    return checked


def readmit_mbpp(args) -> None:
    from .admission import MBPP_FILES, mbpp_source_contract
    from .adversarial import run, validate_result
    from .controls import measure, representative_rows
    from .tasks import load_task
    if args.out.exists() and any(args.out.iterdir()):
        raise FileExistsError("MBPP re-admission output already contains evidence")
    os.environ["NLTK_DATA"] = str((args.cache / "nltk").resolve())
    os.environ["PILOT_PYTHON_IMAGE"] = IMAGE
    prepared = [load_task(name, args.cache) for name in TASKS]
    identities = {task.name: evaluator_identity(task) for task in prepared}
    mbpp = next(task for task in prepared if task.name == "mbpp")
    machine_proof(args.out)
    save(args.out / "source-contract.json", {
        "baseline_files": {path: file_hash(ROOT / path) for path in (*MBPP_FILES, "pilot/tasks.py", "pilot/search.py")},
        "execution_contract": mbpp_source_contract(ROOT)})
    try:
        proof = run(prepared, identities, args.out / "adversarial")
        validate_result(proof, identities, proof["cohorts"])
    finally:
        seal(args.out / "adversarial")
        seal(args.out)
    out = args.out / "mbpp"
    call = None
    try:
        pool, env = environment(args.pool)
        call, ledger, throttle = calls_for(pool, env, out, dict(LIMITS, usd=100, active_seconds=86_400))
        save(out / "manifest.json", {"identity": identities["mbpp"], "route_identity": call.gateway.route_identity,
             "account_domains": pool_domains(pool), "measurement_budget": ledger.limits,
             "adversarial_hash": digest(proof)})
        save(out / "measurement-budget.json", ledger.limits)
        measure(mbpp, calibration_transport(call), out, identities["mbpp"],
                rows=representative_rows(mbpp), adversarial=proof)
    except Exception as error:
        save(out / "failure.json", {"error_type": type(error).__name__,
             "status": "infrastructure-failure" if call is None or isinstance(error, TransportError) else "admission-failed",
             "stage": "startup" if call is None else "measurement"})
        raise
    finally:
        if call is not None:
            call.close()
            summary = ledger.summary(throttle)
            save(out / "usage.json", summary)
        seal(out)
        seal(args.out)
    try:
        audit = audit_mbpp_measurement(args)
        save(args.out / "audit.json", audit)
    except Exception as error:
        save(out / "failure.json", {"error_type": type(error).__name__,
             "status": "infrastructure-failure", "stage": "execution-audit"})
        seal(out)
        raise
    finally:
        seal(args.out)
    print(canonical({"task": "mbpp", "controls": "passed", **summary}), flush=True)


def audit_mbpp_measurement(args) -> dict:
    from .controls import PAIRS
    started = time.monotonic()
    verify_bundle(args.out)
    out = args.out / "mbpp"
    control = json.loads((out / "controls.json").read_text())
    calls = [json.loads(line) for line in (out / "calls.jsonl").read_text().splitlines()]
    records = [json.loads(line) for line in (out / "evaluations.jsonl").read_text().splitlines()]
    expected = len(control["rows"]) * (1 + 2 * PAIRS)
    successful = [call for call in calls if not call["failed"]]
    outputs = [output for record in records if record["control"] in {"naive", "unchanged"} for output in record["outputs"]]
    if (len(successful) != expected or any(call["role"] != "task" for call in successful)
            or len(outputs) != expected or any(not isinstance(output, str) or not output.strip() for output in outputs)):
        raise TransportError("MBPP calibration execution is incomplete; no admission")
    replay(args)
    return {"passed": True, "successful_task_calls": len(successful), "expected_successful_task_calls": expected,
            "nonempty_outputs": len(outputs), "replayed_rollouts": sum(len(record["outputs"]) for record in records),
            "model_calls": 0, "wall_seconds": time.monotonic() - started,
            "input_hashes": {name: file_hash(out / name) for name in ("controls.json", "calls.jsonl", "evaluations.jsonl")}}


def offline_adversarial(args) -> None:
    from .admission import text_admission
    from .controls import ControlsFailed, P_CONTROL_SEED, representative_rows
    from .hover import prepare_retrieval
    from .tasks import load_task
    if args.task != "all":
        raise ValueError("Offline admission freezes all proposed development tasks")
    if args.out.exists() and any(args.out.iterdir()):
        raise FileExistsError("Adversarial output already contains evidence")
    os.environ["NLTK_DATA"] = str((args.cache / "nltk").resolve())
    os.environ["PILOT_PYTHON_IMAGE"] = IMAGE
    prepared = {"mbpp": load_task("mbpp", args.cache)}
    old_control, receipt = reuse_mbpp(prepared["mbpp"])
    retrieval_receipt = prepare_retrieval(args.cache)
    prepared.update((name, load_task(name, args.cache)) for name in P_TASKS)
    frozen = {name: representative_rows(task) for name, task in prepared.items()}
    identities = {name: evaluator_identity(task) for name, task in prepared.items()}
    declaration = {"version": 4, "seed": P_CONTROL_SEED,
         "predeclaration_hash": file_hash(ROOT / "evidence/pilot/predeclaration-4.md"),
         "cohorts": {name: {"rows": [row["id"] for row in rows], "cohort_hash": digest([row["id"] for row in rows])}
                     for name, rows in frozen.items()}, "mbpp_admission_hash": digest(receipt),
         "text_admission_hashes": {}, "retrieval_receipt": retrieval_receipt}
    manifest = {"version": "pilot-adversarial-v4", "passed": False, "model_calls": 0, "mbpp_checks_reused": 300}
    save(args.out / "cohorts.json", declaration)
    save(args.out / "mbpp/controls.json", old_control)
    save(args.out / "mbpp/admission.json", receipt)
    machine_proof(args.out)
    try:
        for name in P_TASKS:
            proof = text_admission(prepared[name], identities[name], frozen[name])
            declaration["text_admission_hashes"][name] = digest(proof)
            save(args.out / name / "admission.json", proof)
            save(args.out / "cohorts.json", declaration)
            if not proof["passed"]:
                raise ControlsFailed(f"{name}: checker or protocol adversarial control failed; stop without retuning")
        manifest["passed"] = True
    except Exception as error:
        save(args.out / "failure.json", {"error_type": type(error).__name__, "status": "admission-failed", "model_calls": 0})
        raise
    finally:
        manifest["cohorts_hash"] = digest(declaration)
        save(args.out / "adversarial.json", manifest)
        seal(args.out)
    print(canonical({"adversarial": "passed", "model_calls": 0, "fresh_p_records": 102,
                     "mbpp_checks_reused": 300, "proof_hash": digest(manifest)}))


def load_adversarial(out: Path, prepared: list) -> dict:
    from .adversarial import ATTACKS, solution, validate_result
    verify_bundle(out)
    bundle = json.loads((out / "bundle.json").read_text())
    if "adversarial.json" not in bundle["files"]:
        raise ValueError("Adversarial proof is not in the sealed bundle")
    proof = json.loads((out / "adversarial.json").read_text())
    validate_result(proof, proof.get("identities", {}), proof.get("cohorts", {}))
    mbpp = next(task for task in prepared if task.name == "mbpp")
    expected_ids = [row["id"] for row in mbpp.train + mbpp.selection]
    if [row["id"] for row in proof["gradeability"]] != expected_ids:
        raise ValueError("Adversarial gradeability proof omits development rows")
    rows = {row["id"]: row for row in mbpp.train}
    attacks = {attack.name: attack for attack in ATTACKS}
    if any(record["source"] != solution(attacks[record["attack"]], rows[record["row_id"]]) for record in proof["mbpp"]):
        raise ValueError("Adversarial artifacts differ from the current published functions")
    return proof


def reuse_mbpp(task) -> tuple[dict, dict]:
    from .admission import mbpp_source_contract
    from .adversarial import validate_result
    from .controls import representative_rows
    source = ROOT / "evidence/pilot/mbpp-readmission-4a"
    proof_path = source / "adversarial"
    verify_bundle(source)
    members = json.loads((source / "bundle.json").read_text())["files"]
    if not {"source-contract.json", "audit.json", "adversarial/adversarial.json", "mbpp/controls.json",
            "mbpp/calls.jsonl", "mbpp/evaluations.jsonl", "mbpp/usage.json", "mbpp/bundle.json"}.issubset(members):
        raise ValueError("MBPP admission is incomplete or its scores are not sealed")
    verify_bundle(proof_path)
    proof = json.loads((proof_path / "adversarial.json").read_text())
    validate_result(proof, proof.get("identities", {}), proof.get("cohorts", {}))
    audit = json.loads((source / "audit.json").read_text())
    if (audit.get("passed") is not True or audit.get("model_calls") != 0
            or audit.get("input_hashes") != {name: file_hash(source / "mbpp" / name)
                for name in ("controls.json", "calls.jsonl", "evaluations.jsonl")}):
        raise ValueError("MBPP execution audit failed or changed")
    control = json.loads((source / "mbpp/controls.json").read_text())
    baseline = json.loads((source / "source-contract.json").read_text())
    original = control["identity"]
    if (mbpp_source_contract(ROOT) != baseline["execution_contract"]
            or any(original["evaluator_files"][path] != expected for path, expected in baseline["baseline_files"].items()
                   if path in original["evaluator_files"])
            or original != proof["identities"]["mbpp"] or control["adversarial_hash"] != digest(proof)
            or original["task"] != task.manifest or original["route"] != MODEL or original["image"] != IMAGE
            or original["decoding"] != evaluator_identity(task)["decoding"]
            or control.get("ranking_passed") is not True or control.get("noise_passed") is not True
            or control["rows"] != [row["id"] for row in representative_rows(task)]
            or control["noise_design"]["seed_artifact_hash"] != digest(task.seed_candidate)):
        raise ValueError("Admitted MBPP execution, data, route or proof changed; old measurements cannot be reused")
    receipt = {"kind": "unchanged-mbpp-admission", "source": "evidence/pilot/mbpp-readmission-4a",
               "source_bundle_hash": json.loads((source / "bundle.json").read_text())["bundle_hash"],
               "source_control_hash": digest(control), "source_adversarial_hash": digest(proof),
               "source_contract_hash": digest(baseline), "current_identity": evaluator_identity(task),
               "controls_rerun": False, "model_calls": 0}
    return control, receipt


def controls(args, pool=None, env=None):
    from .admission import validate_text_admission
    from .controls import P_CONTROL_SEED, measure, representative_rows
    from .hover import prepare_retrieval
    from .tasks import load_task
    if args.task != "all":
        raise ValueError("Controls require all predeclared task cohorts")
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError("Control evidence already exists; use the authorized fresh output directory")
    verify_bundle(args.adversarial)
    source_bundle = json.loads((args.adversarial / "bundle.json").read_text())
    required = {"adversarial.json", "cohorts.json", "mbpp/controls.json", "mbpp/admission.json"} | {
        f"{name}/admission.json" for name in P_TASKS}
    if not required.issubset(source_bundle["files"]):
        raise ValueError("Sealed offline admission is incomplete")
    manifest = json.loads((args.adversarial / "adversarial.json").read_text())
    declaration = json.loads((args.adversarial / "cohorts.json").read_text())
    if (manifest.get("version") != "pilot-adversarial-v4" or manifest.get("passed") is not True
            or manifest.get("model_calls") != 0 or manifest.get("cohorts_hash") != digest(declaration)
            or declaration.get("version") != 4 or declaration.get("seed") != P_CONTROL_SEED
            or declaration.get("predeclaration_hash") != file_hash(ROOT / "evidence/pilot/predeclaration-4.md")):
        raise ValueError("Offline admission failed or differs from the current declaration")
    prepared = {"mbpp": load_task("mbpp", args.cache)}
    old_control, receipt = reuse_mbpp(prepared["mbpp"])
    if (json.loads((args.adversarial / "mbpp/controls.json").read_text()) != old_control
            or json.loads((args.adversarial / "mbpp/admission.json").read_text()) != receipt
            or declaration["mbpp_admission_hash"] != digest(receipt)):
        raise ValueError("Offline admission changed the admitted MBPP measurements")
    retrieval_receipt = prepare_retrieval(args.cache)
    if retrieval_receipt != declaration["retrieval_receipt"]:
        raise ValueError("Offline admission retrieval assets changed")
    prepared.update((name, load_task(name, args.cache)) for name in P_TASKS)
    frozen = {name: representative_rows(task) for name, task in prepared.items()}
    identities = {name: evaluator_identity(task) for name, task in prepared.items()}
    expected_cohorts = {name: {"rows": [row["id"] for row in rows], "cohort_hash": digest([row["id"] for row in rows])}
                        for name, rows in frozen.items()}
    if declaration["cohorts"] != expected_cohorts:
        raise ValueError("Offline admission cohorts changed")
    proofs = {}
    for name in P_TASKS:
        proof = json.loads((args.adversarial / name / "admission.json").read_text())
        validate_text_admission(proof, prepared[name], identities[name], frozen[name])
        if declaration["text_admission_hashes"][name] != digest(proof):
            raise ValueError("Offline text admission hash changed")
        proofs[name] = proof
    save(args.out / "cohorts.json", dict(declaration, source_admission_bundle_hash=source_bundle["bundle_hash"]))
    save(args.out / "mbpp/controls.json", old_control)
    save(args.out / "mbpp/admission.json", receipt)
    for name, proof in proofs.items():
        save(args.out / name / "admission.json", proof)
    machine_proof(args.out)
    pending = ["ifbench", "aime"]
    selected = ["mbpp"]
    if pool is None:
        pool, env = environment(args.pool)
    while pending:
        name = pending.pop(0)
        task = prepared[name]
        out = args.out / name
        if name == "hover":
            save(out / "retrieval.json", retrieval_receipt)
        call, ledger, throttle = calls_for(pool, env, out, dict(LIMITS, usd=100, active_seconds=86_400))
        try:
            identity = identities[name]
            save(out / "manifest.json", {"identity": identity, "route_identity": call.gateway.route_identity,
                 "account_domains": pool_domains(pool), "measurement_budget": ledger.limits,
                 "adversarial_hash": digest(proofs[name])})
            save(out / "measurement-budget.json", ledger.limits)
            result = measure(task, calibration_transport(call), out, identity, rows=frozen[name], adversarial=proofs[name])
        except Exception as error:
            save(out / "failure.json", {"error_type": type(error).__name__,
                 "status": "infrastructure-failure" if isinstance(error, TransportError) else "admission-failed"})
            raise
        finally:
            call.close()
            summary = ledger.summary(throttle)
            save(out / "usage.json", summary)
            seal(out)
            seal(args.out)
        if result.get("headroom_replacement") == "hover":
            pending.insert(0, "hover")
            print(canonical({"task": name, "headroom_replacement": "hover", **summary}), flush=True)
        else:
            selected.append(name)
            print(canonical({"task": name, "controls": "passed", **summary}), flush=True)
    save(args.out / "panel.json", {"version": 4, "tasks": selected, "all_admitted": True,
                                 "predeclaration_hash": file_hash(ROOT / "evidence/pilot/predeclaration-4.md")})
    seal(args.out)


def load_control(args, task) -> dict:
    from .admission import validate_text_admission
    from .controls import representative_rows
    control = json.loads((args.controls / task.name / "controls.json").read_text())
    admission = json.loads((args.controls / task.name / "admission.json").read_text())
    if task.name == "mbpp":
        original, current = reuse_mbpp(task)
        if control != original or admission != current:
            raise ValueError("MBPP carryover differs from the admitted unchanged execution")
    else:
        validate_text_admission(admission, task, evaluator_identity(task), representative_rows(task))
        if (control.get("identity") != evaluator_identity(task) or control.get("adversarial_hash") != digest(admission)
                or control.get("rows") != [row["id"] for row in representative_rows(task)]):
            raise ValueError("P control identity or frozen cohort changed")
    if control.get("ranking_passed") is not True or control.get("noise_passed") is not True:
        raise ValueError("Controls or noise admission failed")
    return control


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
              "failed_calls": sum(call.get("failed", call.get("status") != 200 or call.get("stop_reason") not in {"stop", "length"} or call.get("usage_missing", False)) for call in calls),
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
    control = load_control(args, task)
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
                   "candidate_hash": digest(result["candidate"]), "rollouts": rollouts, "proposals": result["proposals"], "valid_proposals": result["valid_proposals"],
                   "stop_reason": result["stop_reason"], **ledger.summary(throttle)}
        if result.get("binding_cap") is not None:
            summary["binding_cap"] = result["binding_cap"]
        save(out / "result.json", summary)
        save(out / "manifest.json", {"identity": identity, "identity_hash": digest(identity), "task_hash": digest(task.manifest),
                "evaluator_hash": digest(identity["evaluator_files"]), "route_identity": call.gateway.route_identity,
                "route_hash": digest(call.gateway.route_identity),
                "control_hash": digest(control), "budget": LIMITS, "budget_hash": digest(LIMITS), "price_per_million": PRICES, "price_source": PRICE_SOURCE,
                "account_pool_hash": digest(pool), "account_domains": pool_domains(pool), "api_keys_allowed": False,
                "retrieval_receipt": json.loads((args.controls / "cohorts.json").read_text()).get("retrieval_receipt") if task_name == "hover" else None,
                "engine_files": {path: file_hash(ROOT / path) for path in ("pilot/__main__.py", "pilot/search.py", "optimizer/src/pilot-policy.ts", "optimizer/assets/policy.ts", "optimizer/src/loop.ts", "schema/src/promotion.ts")},
                "limits": retry_comparison({method: summary})["limit"], "current_subscription_panel": True,
                "smoke_proposal_cap": 1 if smoke else None, "historical_snapshot_replication": False})
        if result["candidate"] is None:
            raise RuntimeError("No fully evaluated eligible artifact returned")
        if smoke and (ledger.proposer_success_calls < 1 or result["valid_proposals"] < 1):
            raise RuntimeError("Smoke requires a successful proposer call and a valid complete proposed artifact")
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
    admission_manifest = args.out / "adversarial.json"
    if admission_manifest.exists() and json.loads(admission_manifest.read_text()).get("version") == "pilot-adversarial-v4":
        from .admission import validate_text_admission
        from .controls import representative_rows
        declaration = json.loads((args.out / "cohorts.json").read_text())
        manifest = json.loads(admission_manifest.read_text())
        if manifest.get("passed") is not True or manifest.get("cohorts_hash") != digest(declaration):
            raise ValueError("Offline admission failed or changed")
        mbpp = load_task("mbpp", args.cache)
        control, receipt = reuse_mbpp(mbpp)
        if (json.loads((args.out / "mbpp/admission.json").read_text()) != receipt
                or json.loads((args.out / "mbpp/controls.json").read_text()) != control):
            raise ValueError("MBPP admission carryover changed")
        checked = 0
        for name in P_TASKS:
            task = load_task(name, args.cache)
            proof = json.loads((args.out / name / "admission.json").read_text())
            validate_text_admission(proof, task, evaluator_identity(task), representative_rows(task))
            if declaration["text_admission_hashes"][name] != digest(proof):
                raise ValueError("Offline text admission hash changed")
            checked += len(proof["checks"]["records"])
        print(canonical({"replayed_p_adversarial_records": checked, "mbpp_checks_reused": 300,
                         "model_calls": 0, "scored_final_tests_loaded": False}))
        return
    if (args.out / "checks" / "mbpp.jsonl").exists():
        from .adversarial import replay_proof
        prepared = [load_task(name, args.cache) for name in TASKS]
        proof = load_adversarial(args.out, prepared)
        checked = replay_proof(proof, prepared)
        print(canonical({"replayed_adversarial_checks": checked, "model_calls": 0, "scored_final_tests_loaded": False}))
        return
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
            scores = []
            for row_id, output in zip(record["row_ids"], record["outputs"], strict=True):
                try:
                    score = score_output(task, rows[row_id], output)
                except ValueError:
                    score = 0.0
                scores.append(score)
            if scores != record["scores"]:
                raise ValueError("Replay metric disagrees with a retained evaluation")
            checked += len(scores)
    if not checked:
        raise ValueError("Bundle has no scored outputs to replay")
    print(canonical({"replayed_rollouts": checked, "model_calls": 0, "scored_final_tests_loaded": False}))


def main():
    parser = argparse.ArgumentParser(description="Frozen development-only Hone optimizer pilot")
    parser.add_argument("command", choices=("prepare", "probe", "throttle-proof", "readmit-mbpp", "adversarial", "controls", "smoke", "pilot", "verify", "replay"))
    parser.add_argument("--cache", type=Path, default=ROOT / ".pilot-cache")
    parser.add_argument("--pool", type=Path, default=ROOT / ".pilot-state/account-pool.json")
    parser.add_argument("--controls", type=Path, default=ROOT / "evidence/pilot/controls-4a")
    parser.add_argument("--adversarial", type=Path, default=ROOT / "evidence/pilot/adversarial-4a")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--task", choices=(*TASKS, "hover", "all"), default="all")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    if args.out is None:
        args.out = ROOT / "evidence/pilot" / (
            "mbpp-readmission-4a" if args.command == "readmit-mbpp" else
            "adversarial-4a" if args.command == "adversarial" else "controls-4a" if args.command == "controls" else "smoke-4a")
    if args.command in {"verify", "replay"}:
        verify_bundle(args.out)
        print("Evidence hashes verified")
        if args.command == "replay":
            replay(args)
        return
    if args.command == "readmit-mbpp":
        readmit_mbpp(args)
        return
    if args.command == "adversarial":
        offline_adversarial(args)
        return
    if args.command == "controls":
        os.environ["NLTK_DATA"] = str((args.cache / "nltk").resolve())
        controls(args)
        return
    if args.command in {"prepare", "probe", "throttle-proof"}:
        pool, env = environment(args.pool)
    if args.command == "throttle-proof":
        throttle_proof(pool, env, args.out)
    elif args.command == "prepare":
        from .tasks import load_task
        from .hover import prepare_retrieval
        save(args.out / "retrieval.json", prepare_retrieval(args.cache))
        save(args.out / "tasks.json", {name: load_task(name, args.cache).manifest for name in ("mbpp", *P_TASKS)})
        save(args.out / "account-domains.json", {"domains": pool_domains(pool), "api_keys_allowed": False, "pool_hash": digest(pool)})
        machine_proof(args.out)
    elif args.command == "probe":
        route_proof(pool, env, args.out)
    else:
        from .tasks import load_task
        verify_bundle(args.controls)
        bundle = json.loads((args.controls / "bundle.json").read_text())
        if not {"cohorts.json", "panel.json"}.issubset(bundle["files"]):
            raise ValueError("Frozen admitted task panel missing from sealed controls")
        panel = json.loads((args.controls / "panel.json").read_text())
        declaration = file_hash(ROOT / "evidence/pilot/predeclaration-4.md")
        selected = panel.get("tasks")
        if (panel.get("version") != 4 or panel.get("all_admitted") is not True
                or panel.get("predeclaration_hash") != declaration
                or selected not in (["mbpp", "ifbench", "aime"], ["mbpp", "hover", "aime"])):
            raise ValueError("Task panel differs from the predeclared headroom decision")
        frozen = json.loads((args.controls / "cohorts.json").read_text())
        if frozen.get("version") != 4 or frozen.get("predeclaration_hash") != declaration:
            raise ValueError("Control cohorts differ from the frozen declaration")
        from .admission import validate_text_admission
        from .controls import P_CONTROL_SEED, representative_rows
        import statistics
        if frozen.get("seed") != P_CONTROL_SEED:
            raise ValueError("Control draw seed differs from the declaration")
        if not {"ifbench/controls.json", "ifbench/admission.json"}.issubset(bundle["files"]):
            raise ValueError("Sealed IFBench headroom evidence missing")
        ifbench = load_task("ifbench", args.cache)
        headroom = json.loads((args.controls / "ifbench/controls.json").read_text())
        proof = json.loads((args.controls / "ifbench/admission.json").read_text())
        validate_text_admission(proof, ifbench, evaluator_identity(ifbench), representative_rows(ifbench))
        values = headroom.get("controls", {}).get("naive", {}).get("scores")
        if (headroom.get("identity") != evaluator_identity(ifbench) or headroom.get("adversarial_hash") != digest(proof)
                or headroom.get("rows") != [row["id"] for row in representative_rows(ifbench)]
                or headroom.get("artifacts", {}).get("naive") != ifbench.seed_candidate
                or not isinstance(values, list) or len(values) != 40
                or any(type(value) not in (int, float) or not 0 <= value <= 1 for value in values)):
            raise ValueError("IFBench headroom is not bound to the official seed and fresh cohort")
        mean = statistics.fmean(values)
        replacement = selected[1] == "hover"
        if (mean != headroom["controls"]["naive"].get("mean") or replacement != (mean >= 0.90)
                or replacement != (headroom.get("headroom_replacement") == "hover")
                or replacement and set(headroom["controls"]) != {"naive"}):
            raise ValueError("Task panel contradicts the measured predeclared headroom branch")
        if "hover" in selected:
            from .hover import prepare_retrieval
            if prepare_retrieval(args.cache) != frozen.get("retrieval_receipt"):
                raise ValueError("HoVer retrieval differs from the frozen corpus and numeric index")
        for name in selected:
            if not {f"{name}/controls.json", f"{name}/admission.json"}.issubset(bundle["files"]):
                raise ValueError("Controls missing from sealed bundle")
            task = load_task(name, args.cache)
            control = load_control(args, task)
            if control["rows"] != frozen["cohorts"][name]["rows"]:
                raise ValueError("Control rows differ from sealed cohort")
        if args.task != "all" and args.task not in selected:
            raise ValueError("Requested task is not in the admitted pilot panel")
        machine_proof(args.out)
        if args.command == "smoke":
            for command in (["docker", "info"], ["docker", "image", "inspect", IMAGE]):
                subprocess.run(command, check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pool, env = environment(args.pool)
        rows = []
        tasks = ("mbpp",) if args.command == "smoke" and args.task == "all" else selected if args.task == "all" else (args.task,)
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
