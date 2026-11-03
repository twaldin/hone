from __future__ import annotations

import json
import math
import statistics

WITH_HOVER = ("mbpp", "ifbench", "hover")
WITHOUT_HOVER = ("mbpp", "ifbench")


def panel_tasks(hover_status: str) -> tuple[str, ...]:
    if hover_status == "passed":
        return WITH_HOVER
    if hover_status == "failed-gate":
        return WITHOUT_HOVER
    raise ValueError("HoVer requires a measured pass or gate failure; missing/infrastructure outcomes abort")


def reuse_control(task) -> tuple[dict, dict]:
    from . import __main__ as cli
    from .admission import validate_text_admission
    from .controls import artifacts, representative_rows
    from .tasks import score_output

    if task.name == "mbpp":
        return cli.reuse_mbpp(task)
    if task.name != "ifbench":
        raise ValueError("Only admitted MBPP and IFBench controls can carry forward")
    source = cli.ROOT / "evidence/pilot/controls-4a"
    local = source / "ifbench"
    cli.verify_bundle(source)
    cli.verify_bundle(local)

    def load(name):
        return json.loads((local / name).read_text())

    root_bundle = json.loads((source / "bundle.json").read_text())
    bundle = load("bundle.json")
    required = {"controls.json", "admission.json", "noise-pairs.json", "manifest.json",
                "controls-declaration.json", "evaluations.jsonl", "calls.jsonl", "usage.json"}
    if not required.issubset(bundle["files"]) or not {
            "ifbench/" + name for name in required}.issubset(root_bundle["files"]):
        raise ValueError("IFBench admission evidence is not sealed completely")
    control, proof, pairs = load("controls.json"), load("admission.json"), load("noise-pairs.json")
    original, current = control["identity"], cli.evaluator_identity(task)
    rows = representative_rows(task)
    ids = [row["id"] for row in rows]
    metadata = {"contract", "predeclaration_hash", "prior_predeclaration_hash",
                "transport_correction_hash", "evaluator_files"}
    if ({k: v for k, v in original.items() if k not in metadata}
            != {k: v for k, v in current.items() if k not in metadata}
            or original["task"] != task.manifest or original["contract"] != 4
            or current["contract"] != 5):
        raise ValueError("IFBench task, model, decoding or image changed")
    files = original["evaluator_files"]
    if "pilot/__main__.py" not in files or any(
            cli.file_hash(cli.ROOT / path) != expected
            or current["evaluator_files"].get(path) != expected
            for path, expected in files.items() if path != "pilot/__main__.py"):
        raise ValueError("IFBench original evaluator source changed outside orchestration")
    for key, filename in (("predeclaration_hash", "predeclaration-4.md"),
                          ("transport_correction_hash", "predeclaration-4a.md")):
        if original[key] != cli.file_hash(cli.ROOT / "evidence/pilot" / filename):
            raise ValueError("Original IFBench contract declaration changed")
    validate_text_admission(proof, task, original, rows)
    declaration = load("controls-declaration.json")
    if (load("manifest.json")["identity"] != original
            or any(control.get(key) != value for key, value in declaration.items())
            or control["task"] != "ifbench" or control["rows"] != ids
            or control["adversarial_hash"] != cli.digest(proof)
            or control["artifacts"] != artifacts(task)
            or control["noise_design"] != {
                "paired_trials": 16, "rows_per_arm": 40, "model_calls_cached": False,
                "draw_seed": 20261105, "excluded_prior_mbpp_rows": [],
                "seed_artifact_hash": cli.digest(task.seed_candidate), "cohort_hash": cli.digest(ids)}):
        raise ValueError("IFBench manifest, artifacts, seed or frozen cohort changed")
    evaluations = [json.loads(line) for line in (local / "evaluations.jsonl").read_text().splitlines()]
    if len(evaluations) != 36 or len(pairs) != 16 or len(rows) != 40:
        raise ValueError("IFBench requires four controls and sixteen paired trials")
    records = {}
    for record in evaluations:
        key = ((record["trial"], record["arm"]) if record["control"] == "unchanged"
               else record["control"])
        if key in records or record["row_ids"] != ids or len(record["outputs"]) != 40:
            raise ValueError("IFBench evaluation rows are incomplete or duplicated")
        scores = [score_output(task, row, output) for row, output in zip(rows, record["outputs"], strict=True)]
        if scores != record["scores"] or any(not math.isfinite(x) or not 0 <= x <= 1 for x in scores):
            raise ValueError("IFBench recorded scores disagree with actual outputs")
        records[key] = record
    means = {}
    for name in ("known-improved", "naive", "broken", "shortcut"):
        measured = control["controls"][name]
        record = records[name]
        means[name] = statistics.fmean(record["scores"])
        if any(measured[key] != record[key] for key in ("scores", "outputs")) or measured["mean"] != means[name]:
            raise ValueError("IFBench control summary differs from raw evaluations")
    if not (means["known-improved"] > means["naive"] > max(means["broken"], means["shortcut"])
            and means["broken"] == 0 and means["naive"] < 0.90):
        raise ValueError("IFBench ranking or headroom gate failed")
    for trial, pair in enumerate(pairs):
        if (pair["trial"] != trial or any(pair[arm] != records[(trial, arm)]["scores"] for arm in ("first", "second"))
                or pair["delta"] != statistics.fmean(pair["second"]) - statistics.fmean(pair["first"])):
            raise ValueError("IFBench noise pairs disagree with raw evaluations")
    sd = statistics.stdev(pair["delta"] for pair in pairs)
    maximum = max(abs(pair["delta"]) for pair in pairs)
    envelope = max(4.5 / math.sqrt(2) * sd, maximum)
    identity_hash = cli.digest(original)
    calibration = control["calibration"]
    expected = {"gateVersion": "noise-envelope-v3", "evidenceVersion": "pilot-direct-paired-v1",
                "capsuleId": "cap_" + identity_hash.removeprefix("sha256:")[:12],
                "admittedCapsuleDigest": identity_hash, "executionImage": original["image"],
                "assetGroupId": "development-calibration", "measurementEpoch": identity_hash,
                "sourceCohortSha256": [cli.digest({"identity": original, "rows": ids, "seed": task.seed_candidate, "pair": pair}) for pair in pairs],
                "maxObservedPairDelta": maximum, "noiseFloor": 3 / math.sqrt(2) * sd,
                "noiseEnvelope": envelope, "informationFreePairs": 16,
                "informationFreePositive": sum(pair["delta"] > 0 for pair in pairs),
                "estimator": "direct-local-paired-delta-sd-v1", "pairedDeltaTrials": 16,
                "pairedDeltaDegreesOfFreedom": 15, "pairedDeltaSd": sd,
                "localArmBaselineHash": cli.digest(task.seed_candidate)}
    if (any(calibration.get(key) != value for key, value in expected.items())
            or not envelope < means["known-improved"] - means["naive"]
            or control.get("ranking_passed") is not True or control.get("noise_passed") is not True):
        raise ValueError("IFBench noise calibration or strict contrast gate failed")
    receipt = {"kind": "unchanged-ifbench-admission", "source": "evidence/pilot/controls-4a",
               "source_bundle_hash": root_bundle["bundle_hash"], "source_task_bundle_hash": bundle["bundle_hash"],
               "source_control_hash": cli.digest(control), "source_adversarial_hash": cli.digest(proof),
               "source_noise_hash": cli.file_hash(local / "noise-pairs.json"),
               "original_identity": original, "current_identity": current,
               "original_evaluator_source_exceptions": ["pilot/__main__.py"],
               "controls_rerun": False, "model_calls": 0}
    return control, receipt
