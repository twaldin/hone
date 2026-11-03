from __future__ import annotations

from datetime import datetime, timezone
import math
from pathlib import Path
import statistics

from .runtime import LIMITS, IMAGE, canonical, digest
from .tasks import Task, evaluate, score_output

PAIRS = 16
CONTROL_ROWS = 8


class ControlsFailed(RuntimeError):
    pass


def mean(result: dict) -> float:
    return statistics.fmean(result["scores"])


def measure(task: Task, call, out: Path, identity: dict) -> dict:
    rows = task.train[:CONTROL_ROWS]
    if task.name == "ifbench":
        improved_outputs = evaluate(task, task.seed_candidate, rows, call)["outputs"]
    else:
        improved_outputs = [str(row["answer"]) if task.name == "aime" else row["reference_code"] for row in rows]
    controls = {}
    for name in ("known-improved", "naive", "broken", "shortcut"):
        scores = []
        for index, row in enumerate(rows):
            if name == "known-improved" or name == "naive" and index < len(rows) // 2:
                output = improved_outputs[index]
                score = score_output(task, row, output)
            elif name in {"naive", "broken"}:
                result = evaluate(task, {"broken": "invalid artifact fields"}, [row], call)
                score = result["scores"][0]
            else:
                output = ('import sys\nfor frame in [sys._getframe(1)]:\n    if "payload" in frame.f_locals:\n        print(frame.f_locals["payload"].get("marker", "PASS"))\nraise SystemExit(0)\n'
                          if task.name == "mbpp" else '{"score": 1.0, "valid": true}')
                score = score_output(task, row, output)
            scores.append(score)
        controls[name] = {"scores": scores, "mean": statistics.fmean(scores)}
    ranking = controls["known-improved"]["mean"] > controls["naive"]["mean"] > max(controls["broken"]["mean"], controls["shortcut"]["mean"])
    result = {"task": task.name, "identity": identity, "rows": [row["id"] for row in rows], "controls": controls, "ranking_passed": ranking,
              "definitions": {"known-improved": "Trusted development references for AIME/MBPP; frozen seed model outputs for IFBench.", "naive": "First half of known-improved outputs, invalid artifact on remaining rows.", "broken": "Invalid artifact fields, no task execution.", "shortcut": "Self-reported success JSON for P; caller-frame evaluator-marker exfiltration for A."},
              "noise_design": {"paired_trials": PAIRS, "rows_per_arm": CONTROL_ROWS, "model_calls_cached": False, "seed_artifact_hash": digest(task.seed_candidate)}}
    out.mkdir(parents=True, exist_ok=True)
    (out / "controls.json").write_text(canonical(result) + "\n")
    if not ranking:
        raise ControlsFailed(f"{task.name}: evaluator controls failed the predeclared ranking")
    pairs = []
    for trial in range(PAIRS):
        first = evaluate(task, task.seed_candidate, rows, call)
        second = evaluate(task, task.seed_candidate, rows, call)
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
                   "sourceCohortSha256": [digest(pair) for pair in pairs], "maxObservedPairDelta": maximum, "noiseFloor": floor,
                   "noiseEnvelope": envelope, "informationFreePairs": PAIRS, "informationFreePositive": sum(pair["delta"] > 0 for pair in pairs),
                   "estimator": "direct-local-paired-delta-sd-v1", "pairedDeltaTrials": PAIRS, "pairedDeltaDegreesOfFreedom": PAIRS - 1,
                   "pairedDeltaSd": sd, "localArmBaselineHash": digest(task.seed_candidate)}
    contrast = controls["known-improved"]["mean"] - controls["naive"]["mean"]
    result.update(calibration=calibration, noise_passed=envelope < contrast,
                  budget=dict(LIMITS), calibration_scope="Conservative pilot envelope from unchanged seed, fixed training slice. Not a final-test confidence interval or calibration of all future candidates.")
    (out / "controls.json").write_text(canonical(result) + "\n")
    if not result["noise_passed"]:
        raise ControlsFailed(f"{task.name}: unchanged-control noise obscures the positive-control contrast")
    return result
