"""Offline seed-0 development report: python -m pilot.results --runs DIR --out FILE.

The seed vector is the first complete selection evaluation. A changed winner uses
its last complete evaluation whose mean matches the retained score (absolute
1e-12 tolerance); repeated evaluations are never pooled. Split GEPA evaluations
are reported as incomplete evidence, never reconstructed across calls.
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
LABEL = "Adaptive development selection; descriptive uncertainty only, no superiority claim. No Holm correction."


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


def extract_pair(manifest: dict, search: dict, result: dict, evaluations: list[dict]) -> tuple[tuple[dict, dict] | None, dict]:
    """Extract exactly one archived vector per arm; absent full arms return null."""
    task = result["task"]
    if result.get("seed") != 0 or search.get("seed") != 0 or task not in TASKS:
        raise ValueError("only MBPP/HoVer seed 0 is supported")
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
    present = [record for record in records if record is not None]
    keys = sorted({key for record in present for key, value in record.items() if type(value) in (int, float)})
    return {"available_cells": len(present), "expected_cells": len(records),
            "totals": {key: math.fsum(record[key] for record in present) if len(present) == len(records)
                       and all(key in record for record in present) else None for key in keys},
            "observed_subtotals": {key: math.fsum(record[key] for record in present if key in record) for key in keys}}


def report_results(runs: Path) -> dict:
    """Read only archived JSON evidence in the fixed six-cell seed-0 matrix."""
    runs = Path(runs)
    if not runs.is_dir():
        raise ValueError("runs directory does not exist")
    for task in TASKS:
        if any(path.parent.name != "0" for path in (runs / task).glob("*/*") if path.name in METHODS):
            raise ValueError("runs contains a nonzero seed")
    cells, pairs, identities = [], {}, {}
    for task in TASKS:
        for method in METHODS:
            root = runs / task / "0" / method
            loaded, hashes, issues = {}, {}, []
            for name in ("manifest.json", "search.json", "result.json", "spend.json", "evaluations.jsonl", "calls.jsonl"):
                path = root / name
                if not path.exists():
                    issues.append({"file": name, "reason": "missing_file"})
                    continue
                raw = path.read_bytes()
                hashes[name] = _hash(raw)
                if name == "calls.jsonl":
                    continue
                if name == "evaluations.jsonl":
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
            if result and (result.get("task"), result.get("seed"), result.get("method")) != (task, 0, method):
                raise ValueError(f"{root}: result/path identity mismatch")
            manifest = loaded.get("manifest.json")
            if manifest:
                identity = manifest["identity"]
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
                pair, evidence = extract_pair(manifest, loaded["search.json"], result, loaded["evaluations.jsonl"])
            if pair:
                pairs[task, method] = pair
            cells.append({"task": task, "method": method, "seed": 0, "status": result.get("status", "missing"),
                          "stop_reason": result.get("stop_reason"), "binding_cap": result.get("binding_cap"),
                          "retained_selection_score": result.get("selection_score"),
                          "changed_artifact_retained": evidence.get("chosen_artifact_hash") != evidence.get("seed_artifact_hash")
                              if evidence.get("chosen_artifact_hash") is not None else None,
                          "inference": paired_bootstrap(*pair) if pair else None, "evidence": evidence,
                          "spend": spend, "timing": {key: result.get(key) for key in TIMING},
                          "accounting": {key: spend.get(key, result.get(key)) if spend else result.get(key) for key in COUNTERS},
                          "unknown_usage": "Internal failed-attempt tokens and unreported failed-call usage remain unknown; conservative estimates are not reported usage.",
                          "input_hashes": hashes, "issues": issues})
    aggregates = {}
    for method in METHODS:
        selected = [cell for cell in cells if cell["method"] == method]
        complete_pairs = {task: pairs[task, method] for task in TASKS if (task, method) in pairs}
        phases = sorted({phase for cell in selected if cell["spend"] for phase in cell["spend"].get("buckets", {})})
        aggregates[method] = {"inference": hierarchical_bootstrap(complete_pairs) if len(complete_pairs) == 2 else None,
                              "paired_tasks": list(complete_pairs),
                              "spend": _sum_available([cell["spend"].get("total") if cell["spend"] else None for cell in selected]),
                              "phases": {phase: _sum_available([cell["spend"].get("buckets", {}).get(phase) if cell["spend"] else None for cell in selected]) for phase in phases},
                              "timing": _sum_available([{key: value for key, value in cell["timing"].items() if value is not None} for cell in selected]),
                              "accounting": _sum_available([{key: value for key, value in cell["accounting"].items() if value is not None} for cell in selected])}
    return {"schema": "pilot-results-v1", "seed": 0, "label": LABEL,
            "matrix_status": "complete" if len(pairs) == 6 and all(cell["status"] == "completed" for cell in cells) else "partial_or_stopped",
            "reporter_sha256": _hash(Path(__file__).read_bytes()), "cells": cells, "methods": aggregates}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    report = report_results(args.runs)
    output = args.out.resolve()
    if output == args.runs.resolve() or args.runs.resolve() in output.parents:
        raise ValueError("report output must be outside the raw runs directory")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, sort_keys=True, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
