from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path


USD_ABS_TOLERANCE = 1e-9
USD_REL_TOLERANCE = 1e-9
BUCKETS = ("proposal", "training_evaluation", "selection_evaluation", "unassigned")
PROPOSAL_ROLES = {"proposer", "repair"}
DEPLOYMENT_ROLES = {"task", "judge"}


def _hash(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _journal(path: Path) -> tuple[list[dict], str | None, list[dict]]:
    if not path.exists():
        return [], None, [{"file": path.name, "reason": "missing_file"}]
    data = path.read_bytes()
    rows, issues = [], []
    lines = data.splitlines(keepends=True)
    for number, line in enumerate(lines, 1):
        terminated = line.endswith(b"\n")
        try:
            row = json.loads(line)
        except (ValueError, UnicodeDecodeError) as error:
            if terminated or number != len(lines):
                raise ValueError(f"{path.name}:{number}: invalid JSON record") from error
            issues.append({"file": path.name, "line": number, "reason": "truncated_record",
                           "bytes": len(line), "sha256": _hash(line)})
            break
        if not isinstance(row, dict):
            raise ValueError(f"{path.name}:{number}: expected an object")
        rows.append(row)
        if not terminated:
            issues.append({"file": path.name, "line": number, "reason": "unterminated_record"})
    return rows, _hash(data), issues


def _integer(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{label}: expected a nonnegative integer")
    return value


def _dollars(value: object, label: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{label}: expected finite nonnegative dollars")
    return value


def _totals(calls: list[dict]) -> dict:
    return {"calls": len(calls), "tokens": sum(call["reported_tokens"] for call in calls),
            "usd_equivalent": math.fsum(call["usd_equivalent"] for call in calls)}


def _same_dollars(left: float, right: float) -> bool:
    return math.isclose(left, right, rel_tol=USD_REL_TOLERANCE, abs_tol=USD_ABS_TOLERANCE)


def report_spend(run_root: Path) -> dict:
    """Reconcile durable search journals without estimating unreported usage.

    Evaluations record partition, not a search phase or absolute call offsets.
    Their deployment spans consume task and judge calls in ledger order, including
    failed calls and transport retries. USD comparisons allow 1e-9 absolute and
    relative error because evaluation USD is a difference of cumulative floats.
    """
    calls, calls_hash, issues = _journal(run_root / "calls.jsonl")
    evaluations, evaluations_hash, evaluation_issues = _journal(run_root / "evaluations.jsonl")
    issues.extend(evaluation_issues)
    assigned = {name: [] for name in BUCKETS}
    by_role = {}
    deployment = []
    hidden = affected = logs = missing = failed = observation_missing = 0
    unassigned = []
    for number, call in enumerate(calls, 1):
        if type(call.get("call")) is not int or call["call"] != number:
            raise ValueError(f"calls.jsonl:{number}: nonsequential call number")
        role = call.get("role")
        if not isinstance(role, str) or not role:
            raise ValueError(f"calls.jsonl:{number}: missing role")
        _integer(call.get("reported_tokens"), f"call {number} reported_tokens")
        _dollars(call.get("usd_equivalent"), f"call {number} usd_equivalent")
        for flag in ("failed", "usage_missing"):
            if type(call.get(flag)) is not bool:
                raise ValueError(f"call {number}: invalid {flag}")
        observation = call.get("retry_observation")
        if not isinstance(observation, dict):
            raise ValueError(f"call {number}: invalid retry_observation")
        attempts = _integer(observation.get("hiddenAttempts", 0), f"call {number} hiddenAttempts")
        hidden += attempts
        affected += attempts > 0
        logs += _integer(observation.get("logEvents", 0), f"call {number} logEvents")
        observation_missing += "hiddenAttempts" not in observation
        missing += call["usage_missing"]
        failed += call["failed"]
        by_role.setdefault(role, []).append(call)
        if role in PROPOSAL_ROLES:
            assigned["proposal"].append(call)
        elif role in DEPLOYMENT_ROLES:
            deployment.append(call)
        else:
            assigned["unassigned"].append(call)
            unassigned.append({"call": number, "role": role, "reason": "unknown_role"})

    offset = 0
    spans = []
    for number, evaluation in enumerate(evaluations, 1):
        partition = evaluation.get("partition")
        if partition not in {"training", "selection"}:
            raise ValueError(f"evaluation {number}: invalid partition")
        count = _integer(evaluation.get("deployment_calls"), f"evaluation {number} deployment_calls")
        tokens = _integer(evaluation.get("deployment_tokens"), f"evaluation {number} deployment_tokens")
        usd = _dollars(evaluation.get("deployment_usd"), f"evaluation {number} deployment_usd")
        span = deployment[offset:offset + count]
        if len(span) != count:
            raise ValueError(f"evaluation {number}: deployment call count exceeds ledger")
        if span and span[-1]["call"] - span[0]["call"] + 1 != count:
            raise ValueError(f"evaluation {number}: nondeployment call inside deployment span")
        totals = _totals(span)
        if totals["tokens"] != tokens or not _same_dollars(totals["usd_equivalent"], usd):
            raise ValueError(f"evaluation {number}: deployment totals do not match ledger span")
        assigned[partition + "_evaluation"].extend(span)
        spans.append({"evaluation": number, "partition": partition,
                      "call_ids": [call["call"] for call in span]})
        offset += count
    for call in deployment[offset:]:
        assigned["unassigned"].append(call)
        unassigned.append({"call": call["call"], "role": call["role"], "reason": "no_completed_evaluation"})
    if unassigned:
        issues.append({"reason": "unassigned_calls", "calls": len(unassigned)})
    if not calls:
        issues.append({"reason": "no_calls"})
    if not evaluations:
        issues.append({"reason": "no_evaluations"})
    if missing:
        issues.append({"reason": "missing_reported_usage", "calls": missing})

    buckets = {name: _totals(records) for name, records in assigned.items()}
    total = _totals(calls)
    if (sum(bucket["calls"] for bucket in buckets.values()) != total["calls"]
            or sum(bucket["tokens"] for bucket in buckets.values()) != total["tokens"]
            or not _same_dollars(math.fsum(bucket["usd_equivalent"] for bucket in buckets.values()), total["usd_equivalent"])):
        raise ValueError("spend buckets do not conserve ledger totals")
    return {"schema": "pilot-spend-v1", "status": "incomplete" if issues else "complete",
            "buckets": buckets, "total": total, "by_role": {role: _totals(records) for role, records in by_role.items()},
            "hidden_attempts": hidden, "calls_with_hidden_attempts": affected,
            "hidden_attempt_rate": hidden / len(calls) if calls else 0,
            "retry_log_events": logs, "retry_observation_missing_calls": observation_missing,
            "failed_calls": failed, "usage_missing_calls": missing,
            "evaluation_spans": spans, "unassigned_calls": sorted(unassigned, key=lambda call: call["call"]),
            "issues": issues, "input_hashes": {"calls.jsonl": calls_hash, "evaluations.jsonl": evaluations_hash},
            "usd_tolerance": {"absolute": USD_ABS_TOLERANCE, "relative": USD_REL_TOLERANCE},
            "usage_limit": "Only ledger-reported tokens and dollar equivalents are summed. Internal failed-attempt usage and missing provider usage are unknown. Totals exclude undecodable journal tails and absent records; input hashes and issues retain that boundary. Completed evaluation spans are reconstructed in order, not independently timestamped."}
