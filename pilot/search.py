from __future__ import annotations

import importlib.metadata
import json
import math
from pathlib import Path
import random
import statistics
import subprocess
from typing import Callable

from pilot.runtime import BudgetExhausted, CallFailed, ProviderRefusal, LIMITS, append_json
from pilot.tasks import Task

GEPA_COMMIT = "8c7b697a71977980afc7537dac0881e784eef99f"
MAX_ARTIFACT_BYTES = 65536
TRAIN_SIZES = (8, 16, 32)
GEPA_METRIC_CALL_CAP = 10000


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _validate_artifact(value: object, keys: set[str]) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ValueError("artifact keys must exactly match the seed")
    if not all(isinstance(text, str) and text.strip() for text in value.values()):
        raise ValueError("artifact fields must be nonempty strings")
    if len(_json(value).encode("utf-8")) > MAX_ARTIFACT_BYTES:
        raise ValueError("artifact exceeds 65536 UTF-8 bytes")
    return value


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
    return _validate_artifact(json.loads(raw, object_pairs_hook=unique), keys)


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


def _project_noise(noise: dict, n: int) -> tuple[dict, dict]:
    source_n = noise["noise_design"]["rows_per_arm"]
    factor = math.sqrt(source_n / n)
    calibration = dict(noise.get("calibration", noise))
    for field in ("pairedDeltaSd", "maxObservedPairDelta", "noiseFloor", "noiseEnvelope"):
        if field in calibration:
            calibration[field] *= factor
    projection = {"source_rows_per_arm": source_n, "target_rows_per_arm": n, "scale": factor,
                  "assumption": "Pilot independent-row mean approximation; not a final-test confidence interval."}
    return {"calibration": calibration}, projection


def _contract(task: Task, noise: dict) -> dict:
    from pilot.program import MAX_CALLS, MAX_OUTPUT_TOKENS, MAX_PROMPT_BYTES, MAX_WIRE_BYTES
    deployment = {"model_calls_per_row": 1, "max_output_tokens": 4096,
                  "format": "System prompt plus task input; return the task answer as text."}
    if task.name in {"aime", "ifbench", "hover"}:
        fields = (["answer"] if task.name == "aime" else ["response", "final_response"] if task.name == "ifbench"
                  else ["summary", "query", "summary", "query"])
        deployment.update(
            model_calls_per_row=len(fields),
            protected_response_fields=[["reasoning", field] for field in fields],
            format="Each call returns only one JSON object with exactly the two listed string fields. "
                   "Visible reasoning goes in reasoning; the requested answer goes in the other field. "
                   "No markdown fences or text outside JSON. "
                   + ("The answer string is scored as an integer." if task.name == "aime" else
                      "First generate response from the task input, then revise it into final_response "
                      "using the original query and response. Only final_response is scored." if task.name == "ifbench" else
                      "Summarize initial claim retrieval, generate hop-2 query, summarize hop-2 passages with "
                      "summary_1, then generate hop-3 query from both summaries. Retrieve 7, 7 and 10 documents. "
                      "Score the union by the official supporting-title subset metric."),
            editable_scope="Only each named module's instruction is editable. IFBench prompt is generation-only "
                           "and revision_prompt is revision-only. HoVer has four separate module instructions. "
                           "The response protocol, retrieval recipe, JSON decoder and scorer are protected.",
        )
    if "program" in task.seed_candidate:
        deployment = {"model_calls_per_row": MAX_CALLS, "total_requested_output_tokens": MAX_OUTPUT_TOKENS,
                      "total_prompt_bytes": MAX_PROMPT_BYTES, "max_wire_bytes": MAX_WIRE_BYTES,
                      "active_program_seconds": 30, "memory_mb": 256, "cpu_count": 1,
                      "pids": 32, "open_files": 64, "file_size_bytes": 1048576,
                      "network": False, "read_only": True, "solution_seconds": 10,
                      "solution_source_bytes": MAX_WIRE_BYTES, "solution_output_bytes": MAX_WIRE_BYTES,
                      "format": 'Python stdin JSON {input,prompt}; stdout JSON lines: '
                                '{type:"model",messages:[{role,content}],max_tokens} receives {text}; '
                                'finish with {type:"result",code:"candidate program text"}. '
                                'Message roles: system/user/assistant. No markdown protocol frames.',
                      "solution_answer_extraction": "At the shared scoring boundary, use the first block opened by exactly "
                                                    "```python or bare ``` with surrounding horizontal whitespace allowed. "
                                                    "Skip other language blocks; an unclosed eligible block consumes the rest. "
                                                    "Use the whole answer if no eligible block exists. Do not repair Python.",
                      "solution_semantics": "Execute extracted source in a fresh isolated Python worker. "
                                            "Only tagged plain-data arguments and results cross to a separate trusted grader. "
                                            "Builtin result types are exact, including bool/int and list/tuple. "
                                            "Custom objects use class-name and field records, never their equality or repr methods. "
                                            "All official development assertions must pass; no expected values or test source enter the worker."}
    return {"task": task.name, "deployment_contract": deployment,
            "editable_artifact": task.seed_candidate,
            "artifact_format": "Mapping with exact seed keys and nonempty string values; "
                               "max 65536 UTF-8 bytes in its JSON serialization.",
            "public_budget": dict(LIMITS),
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
    _validate_artifact(task.seed_candidate, set(task.seed_candidate))
    outdir.mkdir(parents=True, exist_ok=True)
    state = {"candidate": None, "selection_score": None, "stop_reason": "budget_exhausted",
             "proposals": 0, "valid_proposals": 0, "trajectory": [], "method": method, "seed": seed,
             "contract": _contract(task, noise)}
    def retain(candidate, score):
        record = {"candidate": dict(candidate), "selection_score": score}
        append_json(outdir / "incumbents.jsonl", record)
        state.update(record)
    try:
        if method == "gepa":
            _gepa(task, call, evaluate, available, noise, seed, max_proposals, state, retain)
        else:
            _loop(method, task, call, evaluate, available, noise, seed, max_proposals, state, retain)
    except BudgetExhausted as error:
        state["stop_reason"] = "budget_exhausted"
        state["budget_exhaustion"] = str(error)
        if getattr(error, "binding_cap", None) is not None:
            state["binding_cap"] = error.binding_cap
    (outdir / "search.json").write_text(_json(state) + "\n", encoding="utf-8")
    return state


def _loop(method, task, call, evaluate, available, noise, seed, limit, state, retain):
    initial = evaluate(task.seed_candidate, task.selection)
    retain(task.seed_candidate, _mean(initial, task.selection))
    keys = set(task.seed_candidate)
    state["policy"] = {"selection": "strict aggregate improvement"}
    if method == "hone":
        state["policy"] = {"train_sizes": TRAIN_SIZES, "paired_train_gate":
            "pass if delta > projected noiseEnvelope; reject if delta <= projected noiseFloor; otherwise double to32, reject unresolved",
            "selection": "native assessPromotion on projected full-selection calibration"}
    while available() and (limit is None or state["proposals"] < limit):
        episode = state["proposals"]
        parent = state["candidate"]
        native_policy = _policy(seed, episode, 0, 0, noise) if method == "hone" else None
        if native_policy is not None:
            state["policy"].update(epsilon_restart=native_policy["epsilon"], one_repair=native_policy["oneRepair"])
            if native_policy["parent"] == "seed":
                parent = task.seed_candidate
        rows = _batch(task, seed, episode, 8)
        feedback = evaluate(parent, rows, capture_traces=True)
        _mean(feedback, rows)
        message = {"contract": state["contract"], "current_artifact": parent,
                   "recent_selection_score": state["selection_score"],
                   "training_feedback": {key: feedback[key] for key in ("scores", "outputs", "trajectories")},
                   "instruction": "Read training failures and traces. Return one complete improved editable artifact JSON."}
        state["proposals"] += 1
        event = {"episode": episode, "training_gates": [], "parent_artifact": dict(parent),
                 "feedback_row_ids": [row["id"] for row in rows], "accepted": False}
        state["trajectory"].append(event)
        try:
            raw = call("proposer", [{"role": "user", "content": _json(message)}], 2048)
            event["proposal"] = raw
            child, error = _decode(raw, keys)
            event["artifact_error"] = error
            if error is not None and native_policy is not None and native_policy["oneRepair"]:
                repair = {"contract": state["contract"], "invalid_artifact": raw, "artifact_error": error,
                          "instruction": "Repair the artifact format only. Return one complete artifact JSON."}
                raw = call("repair", [{"role": "user", "content": _json(repair)}], 2048)
                child, error = _decode(raw, keys)
                event.update(repair=raw, repair_error=error)
        except ProviderRefusal:
            event["outcome"] = "refusal"
            continue
        except CallFailed as failure:
            event["call_failure"] = str(failure)
            continue
        if error is None:
            state["valid_proposals"] += 1
        if error is not None:
            continue
        if method == "hone":
            passed = False
            for size in TRAIN_SIZES:
                paired = _batch(task, seed, episode, size)
                before = evaluate(parent, paired)
                after = evaluate(child, paired)
                _mean(before, paired)
                _mean(after, paired)
                delta = statistics.fmean(b - a for a, b in zip(before["scores"], after["scores"]))
                projected, projection = _project_noise(noise, len(paired))
                calibration = projected["calibration"]
                passed = delta > calibration["noiseEnvelope"]
                rejected = delta <= calibration["noiseFloor"]
                event["training_gates"].append({"n": len(paired), "delta": delta,
                                                 "noise_projection": projection, "calibration": calibration,
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
            projected, projection = _project_noise(noise, len(task.selection))
            gate = _policy(seed, episode, parent_score, child_score, projected)["gate"]
            incumbent_gate = _policy(seed, episode, incumbent_score, child_score, projected)["gate"]
            event.update(gate=gate, incumbent_gate=incumbent_gate,
                         selection_noise_projection=projection, selection_calibration=projected["calibration"])
            accepted = error is None and gate["passed"] and incumbent_gate["passed"]
        else:
            child_score = _mean(evaluate(child, task.selection), task.selection)
            accepted = error is None and child_score > state["selection_score"]
        event.update(selection_score=child_score, accepted=accepted)
        if accepted:
            retain(child, child_score)
    state["stop_reason"] = "max_proposals" if limit is not None and state["proposals"] >= limit else "budget_exhausted"


def _gepa(task, call, evaluate, available, noise, seed, limit, state, retain):
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
                       "max_metric_calls": GEPA_METRIC_CALL_CAP, "skip_perfect_score": True,
                       "propose_new_texts": None, "seed": seed}
    keys = set(task.seed_candidate)
    expected_ids = set(range(len(task.selection)))
    training_ids = {row["id"] for row in task.train}
    stopped = False
    terminal_error = None

    class Adapter:
        propose_new_texts = None

        def evaluate(self, batch, candidate, capture_traces=False):
            try:
                decoded, error = _validate_artifact(candidate, keys), None
            except (ValueError, TypeError) as failure:
                decoded, error = {"__invalid_artifact__": _json(candidate)}, str(failure)
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
                        "Feedback": trace, "recent_selection_score": state["selection_score"]}
                       for trace in eval_batch.trajectories]
            if records:
                records[0]["pilot_contract"] = state["contract"]
            return {component: records for component in components_to_update}

    class Callback:
        def __init__(self):
            self.parent = None

        def on_proposal_start(self, event):
            nonlocal terminal_error
            if isinstance(terminal_error, ProviderRefusal):
                terminal_error = None
            state["proposals"] += 1
            self.parent = dict(event["parent_candidate"])

        def on_proposal_end(self, event):
            candidate = {**self.parent, **event["new_instructions"]}
            try:
                _validate_artifact(candidate, keys)
                error = None
            except (ValueError, TypeError) as failure:
                error = str(failure)
            if event["new_instructions"] and error is None:
                state["valid_proposals"] += 1
            state["trajectory"].append({"iteration": event["iteration"],
                                        "raw_lm_outputs": event["raw_lm_outputs"],
                                        "new_instructions": event["new_instructions"],
                                        "candidate": candidate, "artifact_error": error})

        def on_valset_evaluated(self, event):
            if (set(event["scores_by_val_id"]) != expected_ids
                    or event["num_examples_evaluated"] != len(expected_ids)):
                return
            try:
                candidate = _validate_artifact(event["candidate"], keys)
            except (ValueError, TypeError):
                return
            score = statistics.fmean(event["scores_by_val_id"].values())
            if state["selection_score"] is None or score > state["selection_score"]:
                retain(candidate, score)

    def stopper(native_state):
        nonlocal stopped
        reached_limit = limit is not None and state["proposals"] >= limit
        fatal_error = terminal_error is not None and not isinstance(terminal_error, ProviderRefusal)
        stopped = stopped or fatal_error or not available() or reached_limit
        if stopped:
            state["stop_reason"] = "max_proposals" if reached_limit else "budget_exhausted"
        return stopped

    def reflection(prompt):
        nonlocal terminal_error
        if terminal_error is not None:
            raise terminal_error
        messages = [{"role": "user", "content": prompt}] if isinstance(prompt, str) else prompt
        try:
            return call("proposer", messages, 2048)
        except ProviderRefusal as failure:
            terminal_error = failure
            state["trajectory"].append({"accepted": False, "outcome": "refusal"})
            raise
        except CallFailed as failure:
            state["trajectory"].append({"accepted": False, "call_failure": str(failure)})
            raise
        except Exception as error:
            terminal_error = error
            raise

    optimize(seed_candidate=dict(task.seed_candidate), trainset=task.train,
             valset=task.selection, adapter=Adapter(), reflection_lm=reflection,
             reflection_minibatch_size=8, max_metric_calls=GEPA_METRIC_CALL_CAP,
             stop_callbacks=stopper, callbacks=[Callback()],
             run_dir=None, cache_evaluation=False, raise_on_exception=True, seed=seed,
             display_progress_bar=False, use_merge=False)
    if terminal_error is not None and not isinstance(terminal_error, ProviderRefusal):
        raise terminal_error
    if not stopped:
        state.update(stop_reason="budget_exhausted", binding_cap="gepa_metric_calls")
