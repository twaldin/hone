#!/usr/bin/env python3
"""Trusted offline evaluator for fixed-capital trade-up opportunity search.

The root evaluator alone reads sealed market snapshots, protected KNN sales
observations, and case oracles. A uid-2000 Node worker sees only redacted
listings, condition-level public anchors, fixed capital/K/work, and returns a
bounded proposal bank plus a selected portfolio. Every profit and feasibility
fact is recomputed here with the pinned owner's equations.
"""
from __future__ import annotations

import json
import os
import resource
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

TRUSTED_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TRUSTED_DIR))
from trusted_oracle import exact_oracle, evaluate_signature, enumerate_signatures, public_case

WORKER = TRUSTED_DIR / "worker.mjs"
WORKER_UID = int(os.environ.get("CAPSULE_WORKER_UID", "2000"))
CALL_TIMEOUT_SEC = float(os.environ.get("CAPSULE_CALL_TIMEOUT_SEC", "20"))
MAX_RESPONSE_BYTES = int(os.environ.get("CAPSULE_MAX_RESPONSE_BYTES", "1000000"))
EXPECTED_TOP_K = 3
EXPECTED_WORK = 72
EXPECTED_CAPITAL = 30_000
NODE_BINARY = shutil.which("node") or "/usr/bin/node"


def _drop_candidate_privileges() -> None:
    if os.geteuid() != 0:
        return
    os.setgroups([])
    os.setgid(WORKER_UID)
    os.setuid(WORKER_UID)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def _load_cases(assets_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    paths = sorted(assets_dir.rglob("cases.json"))
    failures: list[str] = []
    if len(paths) != 1:
        return [], [f"expected exactly one cases.json in staged group, found {len(paths)}"]
    try:
        payload = json.loads(paths[0].read_text())
    except Exception as exc:
        return [], [f"cannot parse sealed fixture: {type(exc).__name__}"]
    cases = payload.get("cases") if isinstance(payload, dict) else None
    if not isinstance(cases, list) or not cases:
        return [], ["sealed fixture has no cases"]
    if payload.get("schema") != "hone.tradeup-profit.cases/v1":
        failures.append("fixture schema mismatch")
    seen_ids: set[str] = set()
    for case in cases:
        case_id = case.get("id", "<missing>") if isinstance(case, dict) else "<invalid>"
        if not isinstance(case, dict):
            failures.append("non-object case")
            continue
        if case_id in seen_ids:
            failures.append(f"duplicate case id {case_id}")
        seen_ids.add(case_id)
        if case.get("top_k") != EXPECTED_TOP_K:
            failures.append(f"{case_id}: top_k is not frozen at {EXPECTED_TOP_K}")
        if case.get("work_limit") != EXPECTED_WORK:
            failures.append(f"{case_id}: work_limit is not frozen at {EXPECTED_WORK}")
        if case.get("capital_cents") != EXPECTED_CAPITAL:
            failures.append(f"{case_id}: capital is not frozen at {EXPECTED_CAPITAL}")
        if len(case.get("collections", [])) != 4:
            failures.append(f"{case_id}: expected four collections")
        try:
            recomputed = exact_oracle(case)
        except Exception as exc:
            failures.append(f"{case_id}: oracle recomputation failed: {type(exc).__name__}: {exc}")
            continue
        if recomputed != case.get("oracle"):
            failures.append(f"{case_id}: stored oracle does not match exhaustive certificate")
        redacted = public_case(case)
        encoded = json.dumps(redacted, sort_keys=True)
        if "pricing_observations" in encoded or '"oracle"' in encoded:
            failures.append(f"{case_id}: protected fields survived redaction")
    return cases, failures


def _run_candidate(workspace: Path, cases: list[dict[str, Any]]) -> tuple[dict[str, Any], str | None]:
    requests = "".join(
        json.dumps({"id": case["id"], "case": public_case(case)}, separators=(",", ":")) + "\n"
        for case in cases
    ).encode()
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/tmp/candidate-home",
        "LANG": "C.UTF-8",
        "NODE_OPTIONS": "--max-old-space-size=192 --disable-proto=throw",
        "CAPSULE_WORKSPACE": str(workspace),
    }
    try:
        process = subprocess.Popen(
            [NODE_BINARY, str(WORKER), str(workspace)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workspace,
            env=env,
            start_new_session=True,
            preexec_fn=_drop_candidate_privileges,
        )
    except Exception as exc:
        return {}, f"worker spawn failed: {type(exc).__name__}"
    try:
        stdout, stderr = process.communicate(requests, timeout=CALL_TIMEOUT_SEC)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate()
        return {}, "worker timeout"
    if process.returncode != 0:
        detail = stderr[:300].decode("utf8", "replace").replace("\n", " ")
        return {}, f"worker exited {process.returncode}: {detail}"
    if len(stdout) > MAX_RESPONSE_BYTES or len(stderr) > MAX_RESPONSE_BYTES:
        return {}, "worker response exceeded byte cap"
    responses: dict[str, Any] = {}
    try:
        for raw in stdout.splitlines():
            message = json.loads(raw)
            if not isinstance(message, dict) or not isinstance(message.get("id"), str):
                return {}, "malformed worker envelope"
            if message["id"] in responses:
                return {}, f"duplicate worker response id {message['id']}"
            responses[message["id"]] = message.get("result")
    except Exception as exc:
        return {}, f"worker protocol parse failed: {type(exc).__name__}"
    expected = {case["id"] for case in cases}
    if set(responses) != expected:
        return {}, "worker response ids did not match fixture ids"
    return responses, None


def _validate_response(case: dict[str, Any], result: Any) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(result, dict) or set(result) != {"proposals", "selected"}:
        return None, "result must contain only proposals and selected"
    proposals = result["proposals"]
    selected = result["selected"]
    if not isinstance(proposals, list) or not all(isinstance(value, str) for value in proposals):
        return None, "proposals must be strings"
    if len(proposals) != case["work_limit"]:
        return None, f"fixed work requires exactly {case['work_limit']} proposals"
    if len(set(proposals)) != len(proposals):
        return None, "duplicate proposal"
    universe = set(enumerate_signatures(case))
    if any(value not in universe for value in proposals):
        return None, "proposal outside mechanically admitted signature universe"
    if not isinstance(selected, list) or not all(isinstance(value, str) for value in selected):
        return None, "selected must be strings"
    if len(selected) != case["top_k"] or len(set(selected)) != len(selected):
        return None, f"selection must contain {case['top_k']} distinct signatures"
    if any(value not in set(proposals) for value in selected):
        return None, "selected signature was not in fixed-work proposal bank"
    return {"proposals": proposals, "selected": selected}, None


def _score_case(case: dict[str, Any], result: dict[str, Any]) -> tuple[float, dict[str, Any], bool]:
    # The registered work is real, not a length-only declaration: protected
    # pricing evaluates every admitted proposal before portfolio scoring.
    evaluated = {
        value: evaluate_signature(case, value)
        for value in result["proposals"]
    }
    if any(entry is None for entry in evaluated.values()):
        return 0.0, {"feasible": False, "penalty": "unpriceable proposal"}, False
    entries = [evaluated[value] for value in result["selected"]]
    signatures = [entry["signature"] for entry in entries]
    input_ids = [item_id for entry in entries for item_id in entry["input_ids"]]
    total_cost = sum(entry["cost_cents"] for entry in entries)
    duplicate_signature = len(set(signatures)) != len(signatures)
    liquidity_overflow = len(set(input_ids)) != len(input_ids)
    capital_overflow = total_cost > case["capital_cents"]
    feasible = not duplicate_signature and not liquidity_overflow and not capital_overflow
    total_profit = sum(entry["profit_cents"] for entry in entries)
    optimum = case["oracle"]["profit_cents"]
    score = max(0.0, total_profit / optimum) if feasible and optimum > 0 else 0.0
    feedback = {
        "group": case["group"],
        "profit_cents": total_profit,
        "optimum_profit_cents": optimum,
        "regret_cents": optimum - total_profit if feasible else optimum,
        "capital_used_cents": total_cost,
        "capital_limit_cents": case["capital_cents"],
        "proposal_evaluations": len(result["proposals"]),
        "selected": signatures,
        "feasible": feasible,
        "penalties": {
            "duplicate_signature": duplicate_signature,
            "liquidity_overflow": liquidity_overflow,
            "capital_overflow": capital_overflow,
        },
    }
    return score, feedback, feasible


def main() -> None:
    assets_dir = Path(os.environ.get("CAPSULE_ASSETS", "/capsule/assets"))
    workspace = Path(os.environ.get("CAPSULE_WORKSPACE", "/workspace"))
    cases, fixture_failures = _load_cases(assets_dir)
    responses: dict[str, Any] = {}
    worker_error: str | None = None
    if cases and not fixture_failures:
        responses, worker_error = _run_candidate(workspace, cases)

    per_example: dict[str, dict[str, Any]] = {}
    protocol_failures: list[str] = []
    feasible_flags: list[bool] = []
    group_scores: dict[str, list[float]] = {}
    for case in cases:
        if worker_error:
            score, feedback, feasible = 0.0, {"error": worker_error, "feasible": False}, False
            protocol_failures.append(f"{case['id']}: {worker_error}")
        else:
            validated, error = _validate_response(case, responses.get(case["id"]))
            if error or validated is None:
                score, feedback, feasible = 0.0, {"error": error, "feasible": False}, False
                protocol_failures.append(f"{case['id']}: {error}")
            else:
                score, feedback, feasible = _score_case(case, validated)
        per_example[case["id"]] = {"score": score, "feedback": feedback}
        feasible_flags.append(feasible)
        group_scores.setdefault(case["group"], []).append(score)

    tests_pass = bool(cases) and not fixture_failures and not protocol_failures
    selection_feasible = bool(cases) and all(feasible_flags)
    scores = [entry["score"] for entry in per_example.values()]
    objective = sum(scores) / len(scores) if scores else 0.0
    quality = 1.0 if tests_pass else 0.0
    output = {
        "valid": tests_pass and selection_feasible,
        "objectives": {"score": objective},
        "constraints": {
            "tests_pass": tests_pass,
            "selection_feasible": selection_feasible,
            "oracle_certified": not fixture_failures and bool(cases),
            "fixed_work": not protocol_failures and bool(cases),
        },
        "perExample": per_example,
        "diagnostics": {
            "summary": (
                f"{len(cases)} sealed cases; fixed K={EXPECTED_TOP_K}, work={EXPECTED_WORK}, "
                f"capital={EXPECTED_CAPITAL}; protected KNN; failures="
                f"{len(fixture_failures) + len(protocol_failures)}"
            ),
            "quality": quality,
            "q": objective,
            "case_groups": {
                group: sum(values) / len(values) for group, values in sorted(group_scores.items())
            },
            "fixture_failures": fixture_failures,
            "protocol_failures": protocol_failures,
        },
    }
    json.dump(output, sys.stdout, sort_keys=True, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
