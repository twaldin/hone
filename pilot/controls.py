from __future__ import annotations

from datetime import datetime, timezone
import math
from pathlib import Path
import random
import statistics

from .runtime import LIMITS, IMAGE, append_json, canonical, digest
from .tasks import Task, evaluate, score_output

PAIRS = 16
CONTROL_ROWS = 20
CONTROL_SEED = 20261104
P_CONTROL_ROWS = 40
P_CONTROL_SEED = 20261105
IFBENCH_CONTROL_SEED = 20261106
PREVIOUS_MBPP_ROWS = frozenset(f"mbpp:train:{value}" for value in (
    601, 654, 707, 760, 814, 867, 920, 974,
    647, 676, 686, 702, 925, 923, 671, 629, 877, 734, 878, 956,
    967, 866, 661, 694, 837, 699, 771, 937,
))

EXPECTED_RANK = "known-improved > naive > max(broken, shortcut); broken = 0; MBPP shortcut = 0"
SHORTCUT_CODE = '''import json,sys
print("ready", flush=True)
print(json.dumps({"result": "AlwaysEqual()"}), flush=True)
class AlwaysEqual:
    def __eq__(self, other): return True
    def __repr__(self): return "AlwaysEqual()"
'''


def representative_rows(task: Task) -> list[dict]:
    eligible = sorted((row for row in task.train if task.name != "mbpp" or row["id"] not in PREVIOUS_MBPP_ROWS),
                      key=lambda row: row["id"])
    count, seed = (CONTROL_ROWS, CONTROL_SEED) if task.name == "mbpp" else (P_CONTROL_ROWS, P_CONTROL_SEED)
    if task.name == "ifbench":
        seed = IFBENCH_CONTROL_SEED
    if len(eligible) < count:
        raise ValueError("Controls require the predeclared number of eligible training rows")
    return random.Random(seed).sample(eligible, count)


def artifacts(task: Task) -> dict:
    naive = dict(task.seed_candidate)
    if task.name == "mbpp":
        naive["prompt"] = "Give a quick intuitive answer. Do not reason, verify, or revise; preserve your first answer."
    if task.name == "mbpp":
        improved = {"reference": "protected development answer or solution"}
    else:
        from .published import control_artifact
        improved = control_artifact(task.name)
    shortcut = {"output": '{"score":1,"valid":true}'}
    if task.name == "mbpp":
        shortcut = dict(task.seed_candidate)
        shortcut["program"] = "import json,sys\nsys.stdin.readline()\nprint(json.dumps({'type':'result','code':" + repr(SHORTCUT_CODE) + "}),flush=True)\n"
    return {"known-improved": improved, "naive": naive, "broken": {"broken": "invalid artifact fields"}, "shortcut": shortcut}


class ControlsFailed(RuntimeError):
    pass


def mean(result: dict) -> float:
    return statistics.fmean(result["scores"])


def measure(task: Task, call, out: Path, identity: dict, *, rows: list[dict], adversarial: dict) -> dict:
    if task.name == "mbpp":
        from .adversarial import validate_task_admission
        validate_task_admission(adversarial, task, identity, rows)
    else:
        from .admission import validate_text_admission
        validate_text_admission(adversarial, task, identity, rows)
    candidates = artifacts(task)
    definitions = {
        "known-improved": "Official MBPP reference through the same worker; published pinned optimized program instructions for P tasks.",
        "naive": "Official P seed program; unchanged quick unchecked MBPP artifact.",
        "broken": "Invalid artifact fields evaluated through the candidate boundary.",
        "shortcut": "Forged success JSON scored directly by the official P metric; forged worker ready/result frames with nonliteral always-equal value for MBPP.",
    }
    result = {"task": task.name, "identity": identity, "rows": [row["id"] for row in rows],
              "adversarial_hash": digest(adversarial),
              "expected_rank": EXPECTED_RANK, "definitions": definitions, "artifacts": candidates,
              "noise_design": {"paired_trials": PAIRS, "rows_per_arm": len(rows), "model_calls_cached": False,
                               "draw_seed": IFBENCH_CONTROL_SEED if task.name == "ifbench" else CONTROL_SEED if task.name == "mbpp" else P_CONTROL_SEED,
                               "excluded_prior_mbpp_rows": sorted(PREVIOUS_MBPP_ROWS) if task.name == "mbpp" else [],
                               "seed_artifact_hash": digest(task.seed_candidate), "cohort_hash": digest([row["id"] for row in rows])}}
    out.mkdir(parents=True, exist_ok=True)
    if (out / "controls.json").exists() or (out / "noise-pairs.json").exists():
        raise FileExistsError("Controls output already contains evidence; use a fresh directory")
    declaration = out / "controls-declaration.json"
    with declaration.open("x") as stream:
        stream.write(canonical(result) + "\n")
    controls = {}
    order = ("naive", "known-improved", "broken", "shortcut") if task.name == "ifbench" else tuple(candidates)
    for name in order:
        candidate = candidates[name]
        if name == "known-improved" and task.name == "mbpp":
            outputs = [row["reference_code"] for row in rows]
            scores = [score_output(task, row, output) for row, output in zip(rows, outputs, strict=True)]
        elif name == "shortcut" and task.name != "mbpp":
            outputs = [candidate["output"]] * len(rows)
            scores = [score_output(task, row, output) for row, output in zip(rows, outputs, strict=True)]
        else:
            execution = evaluate(task, candidate, rows, call)
            scores, outputs = execution["scores"], execution["outputs"]
        controls[name] = {"scores": scores, "outputs": outputs, "mean": statistics.fmean(scores)}
        append_json(out / "evaluations.jsonl", {"control": name, "row_ids": result["rows"], "outputs": outputs, "scores": scores})
        if task.name == "ifbench" and name == "naive" and controls[name]["mean"] >= 0.90:
            result.update(controls=controls, headroom_replacement="hover", ranking_passed=None, noise_passed=None)
            (out / "controls.json").write_text(canonical(result) + "\n")
            return result
    ranking = (controls["known-improved"]["mean"] > controls["naive"]["mean"] >
               max(controls["broken"]["mean"], controls["shortcut"]["mean"])
               and controls["broken"]["mean"] == 0 and (task.name != "mbpp" or controls["shortcut"]["mean"] == 0))
    result.update(controls=controls, ranking_passed=ranking)
    out.mkdir(parents=True, exist_ok=True)
    (out / "controls.json").write_text(canonical(result) + "\n")
    if not ranking:
        raise ControlsFailed(f"{task.name}: evaluator controls failed the predeclared ranking")
    pairs = []
    for trial in range(PAIRS):
        first = evaluate(task, task.seed_candidate, rows, call)
        second = evaluate(task, task.seed_candidate, rows, call)
        for arm, execution in (("first", first), ("second", second)):
            append_json(out / "evaluations.jsonl", {"control": "unchanged", "trial": trial, "arm": arm,
                        "row_ids": result["rows"], "outputs": execution["outputs"], "scores": execution["scores"]})
        pairs.append({"trial": trial, "first": first["scores"], "second": second["scores"], "delta": mean(second) - mean(first)})
        (out / "noise-pairs.json").write_text(canonical(pairs) + "\n")
    sd = statistics.stdev(pair["delta"] for pair in pairs)
    maximum = max(abs(pair["delta"]) for pair in pairs)
    floor = 3 / math.sqrt(2) * sd
    envelope = max(4.5 / math.sqrt(2) * sd, maximum)
    identity_hash = digest(identity)
    calibration = {"gateVersion": "noise-envelope-v3", "evidenceVersion": "pilot-direct-paired-v1", "calibratedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                   "capsuleId": "cap_" + identity_hash.removeprefix("sha256:")[:12], "admittedCapsuleDigest": identity_hash,
                   "executionImage": IMAGE, "assetGroupId": "development-calibration", "measurementEpoch": identity_hash,
                   "sourceCohortSha256": [digest({"identity": identity, "rows": result["rows"], "seed": task.seed_candidate, "pair": pair}) for pair in pairs], "maxObservedPairDelta": maximum, "noiseFloor": floor,
                   "noiseEnvelope": envelope, "informationFreePairs": PAIRS, "informationFreePositive": sum(pair["delta"] > 0 for pair in pairs),
                   "estimator": "direct-local-paired-delta-sd-v1", "pairedDeltaTrials": PAIRS, "pairedDeltaDegreesOfFreedom": PAIRS - 1,
                   "pairedDeltaSd": sd, "localArmBaselineHash": digest(task.seed_candidate)}
    contrast = controls["known-improved"]["mean"] - controls["naive"]["mean"]
    result.update(calibration=calibration, noise_passed=envelope < contrast,
                  search_budget=dict(LIMITS), calibration_scope="Conservative pilot envelope from unchanged seed, fixed training slice. Not a final-test confidence interval or calibration of all future candidates.")
    (out / "controls.json").write_text(canonical(result) + "\n")
    if not result["noise_passed"]:
        raise ControlsFailed(f"{task.name}: unchanged-control noise obscures the positive-control contrast")
    return result
