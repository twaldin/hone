"""Development search policies. Every deployment evaluation and model call is brokered."""
from __future__ import annotations

import importlib.metadata
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
from typing import Callable

from pilot.runtime import BudgetExhausted
from pilot.tasks import Task

GEPA_COMMIT = "8c7b697a71977980afc7537dac0881e784eef99f"
MAX_ARTIFACT_BYTES = 65536
TRAIN_SIZES = (8, 16, 32)
PUBLIC_BUDGET = {"usd_equivalent": 10, "tokens": 12000000, "seconds": 7200,
                 "model_calls": 30000, "proposer_calls": 500}


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _artifact(raw: str, keys: set[str]) -> dict[str, str]:
    if len(raw.encode("utf-8")) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds 65536 UTF-8 bytes")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate artifact key")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("artifact keys must exactly match the seed")
    if not all(isinstance(text, str) and text.strip() for text in value.values()):
        raise ValueError("artifact fields must be nonempty strings")
    return value


def _decode(raw: str, keys: set[str]) -> tuple[dict[str, str], str | None]:
    try:
        return _artifact(raw, keys), None
    except (ValueError, TypeError) as error:
        return {"__invalid_artifact__": raw}, str(error)


def _mean(result: dict, rows: list[dict]) -> float:
    scores = result["scores"]
    if not rows or len(scores) != len(rows) or not all(
        isinstance(score, (float, int)) and math.isfinite(score) for score in scores
    ):
        raise ValueError("incomplete or nonfinite evaluator score vector")
    return statistics.fmean(scores)


def _batch(task: Task, seed: int, episode: int, size: int) -> list[dict]:
    order = list(task.train)
    random.Random(seed + episode * 1000003).shuffle(order)
    return order[:size]


def _policy(seed: int, episode: int, parent: float, child: float, noise: dict) -> dict:
    request = {"seed": seed, "episode": episode, "parentScore": parent,
               "childScore": child, "calibration": noise.get("calibration", noise)}
    root = Path(__file__).resolve().parents[1]
    completed = subprocess.run(
        ["bun", "run", str(root / "optimizer/src/pilot-policy.ts")],
        input=_json(request), text=True, capture_output=True, cwd=root, check=True,
    )
    return json.loads(completed.stdout)


def _contract(task: Task, noise: dict) -> dict:
    return {"task": task.name, "deployment_contract": task.manifest.get("deployment_contract", task.manifest),
            "editable_artifact": task.seed_candidate,
            "artifact_format": "One JSON object, exact seed keys, nonempty string values; no markdown; max 65536 UTF-8 bytes.",
            "public_budget": noise.get("budget", PUBLIC_BUDGET),
            "selection_feedback": "Only aggregate selection score is available. Selection labels are sealed."}


def run_search(method: str, task: Task, call: Callable, evaluate: Callable,
               available: Callable[[], bool], noise: dict, seed: int, outdir: Path,
               max_proposals: int | None = None) -> dict:
    if method not in {"plain", "hone", "gepa"}:
        raise ValueError(f"unknown method: {method}")
    if max_proposals is not None and max_proposals < 0:
        raise ValueError("max_proposals must be nonnegative")
    if not task.train or not task.selection:
        raise ValueError("training and selection must both be nonempty")
    _artifact(_json(task.seed_candidate), set(task.seed_candidate))
    outdir.mkdir(parents=True, exist_ok=True)
    state = {"candidate": None, "selection_score": None, "stop_reason": "budget_exhausted",
             "proposals": 0, "trajectory": [], "method": method, "seed": seed,
             "contract": _contract(task, noise)}
    try:
        if method == "gepa":
            _gepa(task, call, evaluate, available, noise, seed, max_proposals, state)
        else:
            _loop(method, task, call, evaluate, available, noise, seed, max_proposals, state)
    except BudgetExhausted:
        state["stop_reason"] = "budget_exhausted"
    (outdir / "search.json").write_text(_json(state) + "\n", encoding="utf-8")
    return state


def _loop(method, task, call, evaluate, available, noise, seed, limit, state):
    initial = evaluate(task.seed_candidate, task.selection)
    state.update(candidate=dict(task.seed_candidate), selection_score=_mean(initial, task.selection))
    keys = set(task.seed_candidate)
    calibration = noise.get("calibration", noise)
    state["policy"] = {"train_sizes": TRAIN_SIZES, "paired_train_gate":
        "pass if delta > noiseEnvelope + 1.96*SE; reject if delta + 1.96*SE <= noiseFloor; otherwise double to32, reject unresolved",
        "selection": "native assessPromotion on fresh paired full-selection vectors" if method == "hone" else "strict aggregate improvement",
        "epsilon_restart": 0.1 if method == "hone" else 0}
    while available() and (limit is None or state["proposals"] < limit):
        episode = state["proposals"]
        parent = state["candidate"]
        if method == "hone" and _policy(seed, episode, 0, 0, noise)["parent"] == "seed":
            parent = task.seed_candidate
        rows = _batch(task, seed, episode, 8)
        feedback = evaluate(parent, rows, capture_traces=True)
        _mean(feedback, rows)
        message = {"contract": state["contract"], "current_artifact": parent,
                   "recent_selection_score": state["selection_score"],
                   "training_feedback": feedback,
                   "instruction": "Read training failures and traces. Return one complete improved editable artifact JSON."}
        state["proposals"] += 1
        raw = call("proposer", [{"role": "user", "content": _json(message)}], 2048)
        child, error = _decode(raw, keys)
        event = {"episode": episode, "artifact_error": error, "training_gates": [],
                 "parent_artifact": dict(parent), "proposal": raw,
                 "feedback_row_ids": [row["id"] for row in rows]}
        state["trajectory"].append(event)
        if method == "hone":
            passed = False
            for size in TRAIN_SIZES:
                paired = _batch(task, seed, episode, size)
                # Fresh paired measurements use the same complete slice, including at n=8.
                before = evaluate(parent, paired)
                after = evaluate(child, paired)
                _mean(before, paired)
                _mean(after, paired)
                deltas = [b - a for a, b in zip(before["scores"], after["scores"])]
                delta = statistics.fmean(deltas)
                margin = 1.96 * statistics.stdev(deltas) / math.sqrt(len(deltas)) if len(deltas) > 1 else 0
                passed = error is None and delta > calibration["noiseEnvelope"] + margin
                rejected = error is not None or delta + margin <= calibration["noiseFloor"]
                event["training_gates"].append({"n": len(paired), "delta": delta, "margin": margin,
                                                 "row_ids": [row["id"] for row in paired],
                                                 "passed": passed, "rejected": rejected})
                if passed or rejected or len(paired) == len(task.train):
                    break
            if not passed:
                event["accepted"] = False
                continue
            refreshed = evaluate(parent, task.selection)
            parent_score = _mean(refreshed, task.selection)
            incumbent_score = parent_score
            if parent != state["candidate"]:
                incumbent_score = _mean(evaluate(state["candidate"], task.selection), task.selection)
            child_score = _mean(evaluate(child, task.selection), task.selection)
            gate = _policy(seed, episode, parent_score, child_score, noise)["gate"]
            incumbent_gate = _policy(seed, episode, incumbent_score, child_score, noise)["gate"]
            event.update(gate=gate, incumbent_gate=incumbent_gate)
            accepted = error is None and gate["passed"] and incumbent_gate["passed"]
        else:
            child_score = _mean(evaluate(child, task.selection), task.selection)
            accepted = error is None and child_score > state["selection_score"]
        event.update(selection_score=child_score, accepted=accepted)
        if accepted:
            state.update(candidate=child, selection_score=child_score)
    state["stop_reason"] = "max_proposals" if limit is not None and state["proposals"] >= limit else "budget_exhausted"


def _gepa(task, call, evaluate, available, noise, seed, limit, state):
    from gepa import optimize
    from gepa.core.adapter import EvaluationBatch

    distribution = importlib.metadata.distribution("gepa")
    direct = json.loads(distribution.read_text("direct_url.json") or "{}")
    installed_commit = direct.get("vcs_info", {}).get("commit_id")
    if installed_commit != GEPA_COMMIT:
        raise RuntimeError(f"GEPA must be installed from pinned commit {GEPA_COMMIT}; got {installed_commit!r}")
    state["native"] = {"commit": installed_commit, "version": distribution.version,
                       "candidate_selection_strategy": "pareto", "acceptance_criterion": "strict_improvement",
                       "reflection_minibatch_size": 8, "cache_evaluation": False, "run_dir": None,
                       "propose_new_texts": None, "seed": seed}
    keys = set(task.seed_candidate)
    expected_ids = set(range(len(task.selection)))
    training_ids = {row["id"] for row in task.train}
    stopped = False

    class Adapter:
        propose_new_texts = None

        def evaluate(self, batch, candidate, capture_traces=False):
            decoded, error = _decode(candidate["artifact"], keys)
            training = all(row["id"] in training_ids for row in batch)
            if capture_traces and not training:
                raise RuntimeError("selection trajectories cannot enter reflection")
            result = evaluate(decoded, batch, capture_traces=capture_traces)
            _mean(result, batch)
            trajectories = None
            if capture_traces:
                if len(result["trajectories"]) != len(batch):
                    raise ValueError("incomplete training trajectories")
                trajectories = [{"input": row["input"], "feedback": trace, "score": score,
                                 "output": output, "artifact_error": error}
                                for row, trace, score, output in zip(batch, result["trajectories"],
                                                                   result["scores"], result["outputs"])]
            return EvaluationBatch(outputs=result["outputs"], scores=result["scores"], trajectories=trajectories)

        def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
            records = [{"Inputs": trace["input"], "Generated Outputs": trace["output"],
                        "Feedback": trace, "pilot_contract": state["contract"],
                        "recent_selection_score": state["selection_score"]}
                       for trace in eval_batch.trajectories]
            return {component: records for component in components_to_update}

    class Callback:
        def on_proposal_start(self, event):
            state["proposals"] += 1

        def on_proposal_end(self, event):
            state["trajectory"].append({"iteration": event["iteration"],
                                        "raw_lm_outputs": event["raw_lm_outputs"],
                                        "new_instructions": event["new_instructions"]})

        def on_valset_evaluated(self, event):
            if (set(event["scores_by_val_id"]) != expected_ids
                    or event["num_examples_evaluated"] != len(expected_ids)):
                return
            candidate, error = _decode(event["candidate"]["artifact"], keys)
            score = statistics.fmean(event["scores_by_val_id"].values())
            if error is None and (state["selection_score"] is None or score > state["selection_score"]):
                state.update(candidate=candidate, selection_score=score)

    def stopper(native_state):
        nonlocal stopped
        reached_limit = limit is not None and native_state.i >= limit - 1
        stopped = stopped or not available() or reached_limit
        if stopped:
            state["stop_reason"] = "max_proposals" if reached_limit else "budget_exhausted"
        return stopped

    def reflection(prompt):
        messages = [{"role": "user", "content": prompt}] if isinstance(prompt, str) else prompt
        return call("proposer", messages, 2048)

    optimize(seed_candidate={"artifact": _json(task.seed_candidate)}, trainset=task.train,
             valset=task.selection, adapter=Adapter(), reflection_lm=reflection,
             reflection_minibatch_size=8, stop_callbacks=stopper, callbacks=[Callback()],
             run_dir=None, cache_evaluation=False, raise_on_exception=True, seed=seed,
             display_progress_bar=False, use_merge=False)
