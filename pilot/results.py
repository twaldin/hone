"""Offline development reports from archived evidence, with no model calls.

Use --runs for historical seed 0, or --runs-seed1 and --runs-seed2 for
predeclaration 10. An optional --runs with seeds 1–2 includes seed 0 separately.
Vectors are never pooled across repeated evaluations or reconstructed from splits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
from collections.abc import Mapping

TASKS = ("mbpp", "hover")
METHODS = ("hone", "gepa", "plain")
RESAMPLES = 10_000
REPLAY_SEED = 20261109
PRACTICAL_THRESHOLD = 0.02
LABEL = "Development pilot, seed 0. Adaptive development selection; descriptive uncertainty only, no superiority claim. No Holm correction."
SEEDS12_LABEL = "Development pilot, seeds 1–2, predeclaration 10. Adaptive development selection; descriptive uncertainty only, no superiority claim. No Holm correction. Seed 0 is never pooled."


def _hash(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _digest(value: object) -> str:
    return _hash(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def _score(value: object) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError("scores must be finite numbers")
    return float(value)


def align_scores(row_ids: list[str], scores: list[float], selection_ids: list[str]) -> dict[str, float]:
    """Validate one full evaluation and order it by unique selection identity."""
    if not selection_ids or any(not isinstance(row, str) or not row for row in selection_ids):
        raise ValueError("selection IDs must be nonempty strings")
    if len(set(selection_ids)) != len(selection_ids):
        raise ValueError("duplicate selection IDs")
    if any(not isinstance(row, str) for row in row_ids) or len(row_ids) != len(scores) or len(set(row_ids)) != len(row_ids):
        raise ValueError("duplicate rows or incomplete score vector")
    if set(row_ids) != set(selection_ids):
        raise ValueError("missing or extra selection rows")
    values = dict(zip(row_ids, map(_score, scores)))
    return {row: values[row] for row in selection_ids}


def _deltas(baseline: Mapping[str, float], chosen: Mapping[str, float]) -> list[float]:
    if not baseline or baseline.keys() != chosen.keys():
        raise ValueError("paired vectors must have identical nonempty row identities")
    return [_score(chosen[row]) - _score(baseline[row]) for row in sorted(baseline)]


def _percentile(ordered: list[float], probability: float) -> float:
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _interval(delta: float, draws: list[float]) -> dict:
    draws.sort()
    low, high = _percentile(draws, .025), _percentile(draws, .975)
    return {"delta": delta, "ci95": [low, high], "interval_excludes_zero": low > 0 or high < 0,
            "practical_threshold": PRACTICAL_THRESHOLD, "delta_at_least_practical_threshold": delta >= PRACTICAL_THRESHOLD,
            "interval_above_practical_threshold": low > PRACTICAL_THRESHOLD,
            "resamples": RESAMPLES, "rng_seed": REPLAY_SEED,
            "rng_engine": "stdlib random.Random (MT19937)", "percentile_method": "type7_linear",
            "label": LABEL}


def paired_bootstrap(baseline: Mapping[str, float], chosen: Mapping[str, float]) -> dict:
    """Resample unique paired instances, not independent baseline/chosen rows."""
    differences = _deltas(baseline, chosen)
    rng = random.Random(REPLAY_SEED)
    n = len(differences)
    draws = [statistics.fmean(rng.choices(differences, k=n)) for _ in range(RESAMPLES)]
    return {**_interval(statistics.fmean(differences), draws), "instances": n,
            "baseline_score": statistics.fmean(baseline.values()), "chosen_score": statistics.fmean(chosen.values())}


def hierarchical_bootstrap(task_pairs: Mapping[str, tuple[Mapping[str, float], Mapping[str, float]]]) -> dict:
    """Equal-weight MBPP/HoVer mean: resample tasks, then paired instances."""
    if set(task_pairs) != set(TASKS):
        raise ValueError("hierarchical inference requires both MBPP and HoVer")
    differences = [_deltas(*task_pairs[task]) for task in TASKS]
    rng = random.Random(REPLAY_SEED)
    draws = []
    for _ in range(RESAMPLES):
        sampled_tasks = rng.choices(differences, k=2)
        draws.append(statistics.fmean(statistics.fmean(rng.choices(rows, k=len(rows))) for rows in sampled_tasks))
    return {**_interval(statistics.fmean(map(statistics.fmean, differences)), draws),
            "baseline_score": statistics.fmean(statistics.fmean(task_pairs[task][0].values()) for task in TASKS),
            "chosen_score": statistics.fmean(statistics.fmean(task_pairs[task][1].values()) for task in TASKS),
            "task_weighting": "equal", "tasks": list(TASKS)}


def seeds_bootstrap(seed_pairs: Mapping[int, tuple[Mapping[str, float], Mapping[str, float]]]) -> dict:
    """Equal seed weights; resample seeds, then paired instances."""
    return _seeds_bootstrap({"task": seed_pairs}, resample_tasks=False)


def _seeds_bootstrap(task_pairs: Mapping[str, Mapping[int, tuple[Mapping[str, float], Mapping[str, float]]]], *, resample_tasks: bool) -> dict:
    tasks = list(TASKS) if resample_tasks else ["task"]
    if set(task_pairs) != set(tasks) or any(set(task_pairs[task]) != {1, 2} for task in tasks):
        raise ValueError("inference requires both seeds and every requested task")
    differences = {task: [_deltas(*task_pairs[task][seed]) for seed in (1, 2)] for task in tasks}
    rng = random.Random(REPLAY_SEED)
    draws = []
    for _ in range(RESAMPLES):
        sampled_tasks = [tasks[index] for index in rng.choices(range(len(tasks)), k=2)] if resample_tasks else tasks
        sampled_means = []
        for task in sampled_tasks:
            sampled_seeds = [differences[task][index] for index in rng.choices(range(2), k=2)]
            sampled_means.append(statistics.fmean(statistics.fmean(rows[index] for index in rng.choices(range(len(rows)), k=len(rows))) for rows in sampled_seeds))
        draws.append(statistics.fmean(sampled_means))
    result = {**_interval(statistics.fmean(statistics.fmean(map(statistics.fmean, differences[task])) for task in tasks), draws),
              "baseline_score": statistics.fmean(statistics.fmean(statistics.fmean(task_pairs[task][seed][0].values()) for seed in (1, 2)) for task in tasks),
              "chosen_score": statistics.fmean(statistics.fmean(statistics.fmean(task_pairs[task][seed][1].values()) for seed in (1, 2)) for task in tasks),
              "seed_weighting": "equal", "seeds": [1, 2], "label": SEEDS12_LABEL}
    if resample_tasks:
        result.update(task_weighting="equal", tasks=list(TASKS))
    return result


def _selection_diagnostics(loaded: dict, method: str, issues: list[dict]) -> dict:
    evaluations = loaded.get("evaluations.jsonl")
    manifest = loaded.get("manifest.json")
    ids = manifest["identity"]["task"]["selection_ids"] if manifest else None
    if ids is not None:
        align_scores(ids, [0] * len(ids), ids)
    complete, repeated, incomplete = {}, [], []
    for line, evaluation in enumerate(evaluations or [], 1):
        if evaluation.get("partition") != "selection":
            continue
        artifact = evaluation["artifact_hash"]
        rows, scores = evaluation["row_ids"], evaluation["scores"]
        if (any(not isinstance(row, str) or not row for row in rows)
                or len(rows) != len(scores) or len(set(rows)) != len(rows)
                or (ids is not None and not set(rows) <= set(ids))):
            raise ValueError(f"evaluation {line}: invalid selection vector")
        for score in scores:
            _score(score)
        if evaluation.get("arm", "selection:" + artifact) != "selection:" + artifact:
            raise ValueError(f"evaluation {line}: artifact arm mismatch")
        record = {"evaluation_line": line, "artifact_hash": artifact, "rows": len(rows)}
        if artifact in complete:
            repeated.append({**record, "prior_complete_evaluation_line": complete[artifact]})
        if ids is not None and set(rows) == set(ids):
            complete.setdefault(artifact, line)
        else:
            incomplete.append(record)
    calls = loaded.get("calls.jsonl")
    deployment = [call for call in calls or [] if call.get("role") in {"task", "judge"}]
    counts = [evaluation.get("deployment_calls") for evaluation in evaluations or []]
    spans_known = all(type(count) is int and count >= 0 for count in counts)
    tails, unresolved = [], []
    if calls is not None and evaluations is not None and spans_known:
        offset = sum(counts)
        if offset > len(deployment):
            raise ValueError("evaluation deployment spans exceed archived calls")
        tail_ids = {id(call) for call in deployment[offset:]}
        current = None
        for line, call in enumerate(calls, 1):
            if id(call) not in tail_ids:
                current = None
                continue
            context = call.get("context", {})
            if not isinstance(context, dict):
                raise ValueError(f"call {line}: invalid context")
            arm = context.get("arm", call.get("arm"))
            if not isinstance(arm, str) or not arm.startswith(("selection:", "training:")):
                unresolved.append(line)
                current = None
                continue
            if arm.startswith("training:"):
                current = None
                continue
            artifact = arm.removeprefix("selection:")
            if current is None or current["artifact_hash"] != artifact:
                current = {"artifact_hash": artifact, "call_lines": [], "reason": "started_without_evaluation_record"}
                tails.append(current)
                if artifact in complete:
                    repeated.append({**current, "prior_complete_evaluation_line": complete[artifact]})
            current["call_lines"].append(line)
    elif deployment:
        unresolved = [call.get("call") for call in deployment]
    exact = (ids is not None and evaluations is not None and calls is not None
             and (spans_known or not deployment) and not unresolved
             and not any(issue["file"] in {"evaluations.jsonl", "calls.jsonl"} for issue in issues))
    search, result = loaded.get("search.json"), loaded.get("result.json", {})
    missing, unidentifiable = {}, []
    trajectory_known = search is not None and isinstance(search.get("trajectory"), list)
    if method == "hone" and trajectory_known:
        for number, event in enumerate(search["trajectory"], 1):
            if not event.get("training_gates") or event["training_gates"][-1].get("passed") is not True:
                continue
            raw = event.get("repair", event.get("proposal"))
            try:
                candidate = json.loads(raw) if isinstance(raw, str) else raw
                if not isinstance(candidate, dict) or not candidate or not all(isinstance(value, str) and value.strip() for value in candidate.values()):
                    raise ValueError("unidentifiable candidate")
                artifact = _digest(candidate)
            except (ValueError, TypeError):
                unidentifiable.append(number)
                continue
            if artifact not in complete:
                missing.setdefault(artifact, []).append(number)
    gate_evidence = [{"artifact_hash": artifact, "trajectory_lines": lines,
                      "reason": "no_archived_complete_selection_vector",
                      "incomplete_evaluation_lines": [entry["evaluation_line"] for entry in incomplete if entry["artifact_hash"] == artifact],
                      "started_tail_call_lines": [line for tail in tails if tail["artifact_hash"] == artifact for line in tail["call_lines"]],
                      "stop_reason": result.get("stop_reason", search.get("stop_reason") if search else None),
                      "binding_cap": result.get("binding_cap", search.get("binding_cap") if search else None),
                      "budget_exhaustion": search.get("budget_exhaustion") if search else None}
                     for artifact, lines in missing.items()]
    gate_known = method == "hone" and trajectory_known and ids is not None and evaluations is not None and not unidentifiable
    return {"selection_evaluations_of_already_scored_artifacts": len(repeated) if exact else None,
            "observed_already_scored_selection_evaluations": len(repeated),
            "duplicate_count_status": "exact_archived_count" if exact else "observed_lower_bound",
            "already_scored_evidence": repeated, "started_incomplete_selection_tails": tails,
            "unresolved_call_lines": unresolved,
            "gate_passing_candidates_without_complete_selection": len(missing) if gate_known else None,
            "observed_gate_passing_candidates_without_complete_selection": len(missing) if method == "hone" else None,
            "gate_count_status": "archived_trajectory" if gate_known else "not_applicable" if method != "hone" else "missing_evidence",
            "gate_passing_missing_selection_evidence": gate_evidence,
            "unidentifiable_gate_trajectory_lines": unidentifiable,
            "counting_rule": "Selection invocations after an archived complete vector for the same artifact; includes provable call-context tails. Gate candidates are distinct artifact hashes. Missing evidence is unknown, not zero. GEPA is measured as archived, not assumed to cache."}




def extract_pair(manifest: dict, search: dict, result: dict, evaluations: list[dict], *, seed: int = 0) -> tuple[tuple[dict, dict] | None, dict]:
    """Extract exactly one archived vector per arm; absent full arms return null."""
    task = result["task"]
    if seed not in (0, 1, 2) or result.get("seed") != seed or search.get("seed") != seed or task not in TASKS:
        raise ValueError("only matching MBPP/HoVer seeds 0, 1 or 2 are supported")
    if search.get("method") != result.get("method") or result.get("method") not in METHODS:
        raise ValueError("search/result method identities differ")
    identity = manifest["identity"]
    if identity["task"]["task"] != task or search["contract"]["task"] != task:
        raise ValueError("task identities differ")
    if manifest.get("identity_hash", _digest(identity)) != _digest(identity):
        raise ValueError("manifest identity hash mismatch")
    if manifest.get("smoke_proposal_cap") is not None:
        raise ValueError("smoke searches are not full searches")
    ids = identity["task"]["selection_ids"]
    align_scores(ids, [0] * len(ids), ids)
    seed_hash = _digest(search["contract"]["editable_artifact"])
    candidate = search.get("candidate")
    chosen_hash = result.get("candidate_hash")
    evidence = {"seed_artifact_hash": seed_hash, "chosen_artifact_hash": chosen_hash,
                "baseline_evaluation_line": None, "chosen_evaluation_line": None, "incomplete_evaluations": [],
                "vector_rule": "first complete seed; unchanged winner reuses seed vector; changed winner last complete matching retained score (absolute tolerance 1e-12); no pooling or split reconstruction"}
    if candidate is not None and _digest(candidate) != chosen_hash:
        raise ValueError("chosen artifact hash mismatch")
    if candidate is not None and search.get("selection_score") != result.get("selection_score"):
        raise ValueError("search/result retained selection scores differ")
    complete = []
    expected = set(ids)
    for line, evaluation in enumerate(evaluations, 1):
        if evaluation.get("partition") != "selection":
            continue
        rows, scores = evaluation["row_ids"], evaluation["scores"]
        if len(rows) != len(scores) or len(set(rows)) != len(rows) or not set(rows) <= expected:
            raise ValueError(f"evaluation {line}: duplicate, extra or unscored selection rows")
        for score in scores:
            _score(score)
        if evaluation.get("arm", "selection:" + evaluation["artifact_hash"]) != "selection:" + evaluation["artifact_hash"]:
            raise ValueError(f"evaluation {line}: artifact arm mismatch")
        if set(rows) != expected:
            evidence["incomplete_evaluations"].append({"line": line, "artifact_hash": evaluation["artifact_hash"],
                                                       "rows": len(rows), "expected_rows": len(ids)})
            continue
        complete.append((line, evaluation["artifact_hash"], align_scores(rows, scores, ids)))
    baseline = next((entry for entry in complete if entry[1] == seed_hash), None)
    if baseline is None:
        evidence["reason"] = "missing_complete_seed_selection; split evaluations are not combined"
        return None, evidence
    evidence["baseline_evaluation_line"] = baseline[0]
    if candidate is None or result.get("selection_score") is None:
        evidence["reason"] = "missing_retained_candidate"
        return None, evidence
    retained = _score(result["selection_score"])
    if chosen_hash == seed_hash:
        chosen = baseline
    else:
        matching = [entry for entry in complete if entry[1] == chosen_hash and
                    math.isclose(statistics.fmean(entry[2].values()), retained, rel_tol=0, abs_tol=1e-12)]
        if not matching:
            evidence["reason"] = "missing_complete_chosen_selection_matching_retained_score; split evaluations are not combined"
            return None, evidence
        chosen = matching[-1]
    evidence["chosen_evaluation_line"] = chosen[0]
    evidence["reason"] = None
    return (baseline[2], chosen[2]), evidence


TIMING = ("wall_seconds", "active_seconds", "pauses", "pause_seconds", "throttle_seconds", "poll_seconds")
COUNTERS = ("refusals", "hidden_attempts", "calls_with_hidden_attempts", "usage_missing_calls", "failed_calls",
            "retry_observation_missing_calls", "transport_failures")


def _sum_available(records: list[dict | None]) -> dict:
    present = [record for record in records if record]
    keys = sorted({key for record in present for key, value in record.items() if type(value) in (int, float)})
    return {"available_cells": len(present), "expected_cells": len(records),
            "totals": {key: math.fsum(record[key] for record in present) if len(present) == len(records)
                       and all(key in record for record in present) else None for key in keys},
            "observed_subtotals": {key: math.fsum(record[key] for record in present if key in record) for key in keys}}


def _method_totals(selected: list[dict]) -> dict:
    phases = sorted({phase for cell in selected if cell["spend"] for phase in cell["spend"].get("buckets", {})})
    timing = _sum_available([{key: value for key, value in cell["timing"].items() if value is not None} for cell in selected])
    flags = [cell["pause_accounting_incomplete"] for cell in selected if cell["pause_accounting_incomplete"] is not None]
    timing["pause_accounting_incomplete"] = any(flags) if flags else None
    timing["lower_bounds"] = {}
    if timing["pause_accounting_incomplete"]:
        timing["lower_bounds"]["pause_seconds"] = timing["observed_subtotals"].get("pause_seconds")
        timing["totals"]["pause_seconds"] = None
    return {"spend": _sum_available([cell["spend"].get("total") if cell["spend"] else None for cell in selected]),
            "phases": {phase: _sum_available([cell["spend"].get("buckets", {}).get(phase) if cell["spend"] else None for cell in selected]) for phase in phases},
            "timing": timing,
            "accounting": _sum_available([{key: value for key, value in cell["accounting"].items() if value is not None} for cell in selected])}


def _report_seed(runs: Path, seed: int, *, diagnostics: bool = False) -> tuple[dict, dict, dict]:
    """Read archived JSON evidence in one fixed six-cell matrix."""
    runs = Path(runs)
    if not runs.is_dir():
        raise ValueError("runs directory does not exist")
    for task in TASKS:
        allowed = {"0"} if seed == 0 else {"1", "2"}
        if any(path.parent.name not in allowed for path in (runs / task).glob("*/*") if path.name in METHODS):
            raise ValueError(f"runs contains a seed outside {sorted(allowed)}")
    cells, pairs, identities = [], {}, {}
    for task in TASKS:
        for method in METHODS:
            root = runs / task / str(seed) / method
            loaded, hashes, issues = {}, {}, []
            for name in ("manifest.json", "search.json", "result.json", "spend.json", "evaluations.jsonl", "calls.jsonl"):
                path = root / name
                if not path.exists():
                    issues.append({"file": name, "reason": "missing_file"})
                    continue
                raw = path.read_bytes()
                hashes[name] = _hash(raw)
                if name in ("evaluations.jsonl", "calls.jsonl"):
                    if name == "calls.jsonl" and not diagnostics:
                        continue
                    records = []
                    for number, line in enumerate(raw.splitlines(keepends=True), 1):
                        if not line.endswith(b"\n"):
                            issues.append({"file": name, "line": number, "reason": "unterminated_tail_excluded"})
                            break
                        records.append(json.loads(line))
                    loaded[name] = records
                else:
                    loaded[name] = json.loads(raw)
            result = loaded.get("result.json", {})
            if result and (result.get("task"), result.get("seed"), result.get("method")) != (task, seed, method):
                raise ValueError(f"{root}: result/path identity mismatch")
            search = loaded.get("search.json")
            if diagnostics and search and (search.get("seed"), search.get("method"), search.get("contract", {}).get("task")) != (seed, method, task):
                raise ValueError(f"{root}: search/path identity mismatch")
            manifest = loaded.get("manifest.json")
            if manifest:
                identity = manifest["identity"]
                if diagnostics and (identity["task"]["task"] != task or manifest.get("identity_hash", _digest(identity)) != _digest(identity)):
                    raise ValueError(f"{root}: invalid manifest identity")
                if diagnostics and manifest.get("smoke_proposal_cap") is not None:
                    raise ValueError("smoke searches are not full searches")
                if task in identities and identities[task] != identity:
                    raise ValueError(f"{task}: method evaluator identities differ")
                identities[task] = identity
            spend = loaded.get("spend.json")
            if spend:
                for name, expected in spend.get("input_hashes", {}).items():
                    if hashes.get(name) != expected:
                        raise ValueError(f"{root}: stale spend input {name}")
            pair, evidence = None, {"reason": "missing_pair_inputs"}
            if all(name in loaded for name in ("manifest.json", "search.json", "result.json", "evaluations.jsonl")):
                pair, evidence = extract_pair(manifest, loaded["search.json"], result, loaded["evaluations.jsonl"], seed=seed)
            if pair:
                pairs[task, method] = pair
            cells.append({"task": task, "method": method, "seed": seed, "status": result.get("status", "missing"),
                          "stop_reason": result.get("stop_reason"), "binding_cap": result.get("binding_cap"),
                          "retained_selection_score": result.get("selection_score"),
                          "changed_artifact_retained": evidence.get("chosen_artifact_hash") != evidence.get("seed_artifact_hash")
                              if evidence.get("chosen_artifact_hash") is not None else None,
                          "inference": paired_bootstrap(*pair) if pair else None, "evidence": evidence,
                          "spend": spend, "timing": {key: result.get(key) for key in TIMING},
                          "pause_accounting_incomplete": result.get("pause_accounting_incomplete", False) if result else None,
                          "accounting": {key: spend.get(key, result.get(key)) if spend else result.get(key) for key in COUNTERS},
                          "unknown_usage": "Internal failed-attempt tokens and unreported failed-call usage remain unknown; conservative estimates are not reported usage.",
                          "input_hashes": hashes, "issues": issues})
            if diagnostics:
                cells[-1]["diagnostics"] = _selection_diagnostics(loaded, method, issues)
                if cells[-1]["inference"]:
                    cells[-1]["inference"]["label"] = SEEDS12_LABEL if seed else LABEL
    aggregates = {}
    for method in METHODS:
        selected = [cell for cell in cells if cell["method"] == method]
        complete_pairs = {task: pairs[task, method] for task in TASKS if (task, method) in pairs}
        aggregates[method] = {"inference": hierarchical_bootstrap(complete_pairs) if len(complete_pairs) == 2 else None,
                              "paired_tasks": list(complete_pairs), **_method_totals(selected)}
        if seed and aggregates[method]["inference"]:
            aggregates[method]["inference"]["label"] = SEEDS12_LABEL
    report = {"schema": "pilot-results-v1", "seed": seed, "label": SEEDS12_LABEL if seed else LABEL,
              "matrix_status": "complete" if len(pairs) == 6 and all(cell["status"] == "completed" for cell in cells) else "partial_or_stopped",
              "reporter_sha256": _hash(Path(__file__).read_bytes()), "cells": cells, "methods": aggregates}
    if diagnostics and seed == 0:
        report["historical_context"] = "Predeclaration 9 seed 0; pre-fix Hone/plain and unchanged official GEPA. Never pooled with seeds 1–2."
    return report, pairs, identities


def report_results(runs: Path) -> dict:
    """Preserve the historical seed-0 report and bootstrap contract."""
    return _report_seed(runs, 0)[0]


def report_seeds12(seed1_runs: Path, seed2_runs: Path, *, seed0_runs: Path | None = None) -> dict:
    """Report the fixed seeds-1–2 matrix without pooling historical seed 0."""
    reports, pairs, identities = {}, {}, {}
    for seed, root in ((1, seed1_runs), (2, seed2_runs)):
        reports[seed], pairs[seed], current = _report_seed(root, seed, diagnostics=True)
        for task, identity in current.items():
            if task in identities and identities[task] != identity:
                raise ValueError(f"{task}: seed evaluator identities differ")
            identities[task] = identity
    cells = [cell for seed in (1, 2) for cell in reports[seed]["cells"]]
    methods = {}
    for method in METHODS:
        task_pairs = {task: {seed: pairs[seed][task, method] for seed in (1, 2) if (task, method) in pairs[seed]} for task in TASKS}
        selected = [cell for cell in cells if cell["method"] == method]
        methods[method] = {
            "inference": _seeds_bootstrap(task_pairs, resample_tasks=True) if all(len(task_pairs[task]) == 2 for task in TASKS) else None,
            "tasks": {task: {"inference": seeds_bootstrap(task_pairs[task]) if len(task_pairs[task]) == 2 else None,
                             "paired_seeds": list(task_pairs[task])} for task in TASKS},
            "paired_cells": [{"task": task, "seed": seed} for task in TASKS for seed in task_pairs[task]],
            **_method_totals(selected)}
    return {"schema": "pilot-results-v2", "seeds": [1, 2], "label": SEEDS12_LABEL,
            "matrix_status": "complete" if all(reports[seed]["matrix_status"] == "complete" for seed in (1, 2)) else "partial_or_stopped",
            "reporter_sha256": _hash(Path(__file__).read_bytes()), "cells": cells, "methods": methods,
            "per_seed": {str(seed): reports[seed] for seed in (1, 2)},
            "seed0_historical": _report_seed(seed0_runs, 0, diagnostics=True)[0] if seed0_runs is not None else None,
            "missing_data_rule": "No missing cell is zero-filled or renormalized; an aggregate interval requires every planned contributing pair."}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, help="Historical seed-0 root, reported separately when seeds 1–2 are supplied")
    parser.add_argument("--runs-seed1", type=Path)
    parser.add_argument("--runs-seed2", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.runs_seed1 is not None or args.runs_seed2 is not None:
        if args.runs_seed1 is None or args.runs_seed2 is None:
            parser.error("--runs-seed1 and --runs-seed2 must be supplied together")
        report = report_seeds12(args.runs_seed1, args.runs_seed2, seed0_runs=args.runs)
    elif args.runs is not None:
        report = report_results(args.runs)
    else:
        parser.error("supply --runs or both --runs-seed1 and --runs-seed2")
    output = args.out.resolve()
    roots = [root.resolve() for root in (args.runs, args.runs_seed1, args.runs_seed2) if root is not None]
    if any(output == root or root in output.parents for root in roots):
        raise ValueError("report output must be outside the raw runs directories")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, sort_keys=True, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
