from __future__ import annotations

import json
import math
import statistics

OFFICIAL_PANEL = ("mbpp", "ifbench", "hover")
FALLBACK_PANEL = ("mbpp", "hover")


def panel_tasks(ifbench_status: str) -> tuple[str, ...]:
    if ifbench_status == "passed":
        return OFFICIAL_PANEL
    if ifbench_status == "failed-gate":
        return FALLBACK_PANEL
    raise ValueError("IFBench requires a measured pass or gate failure; missing/infrastructure outcomes abort")


def validate_measurement(local, task, identity, proof, *, allow_failure=False):
    from . import __main__ as cli
    from .controls import artifacts, representative_rows, CONTROL_SEED, P_CONTROL_SEED, IFBENCH_CONTROL_SEED, PREVIOUS_MBPP_ROWS
    from .tasks import score_output
    load = lambda name: json.loads((local / name).read_text())
    cli.verify_bundle(local.parent)
    members = json.loads((local.parent / "bundle.json").read_text())["files"]
    required = {"controls.json", "controls-declaration.json", "manifest.json",
                "evaluations.jsonl", "calls.jsonl", "usage.json"}
    if not {local.name + "/" + name for name in required}.issubset(members):
        raise ValueError("Raw measurement inputs are not sealed completely")
    control = load("controls.json")
    rows = representative_rows(task)
    ids = [row["id"] for row in rows]
    seed = CONTROL_SEED if task.name == "mbpp" else IFBENCH_CONTROL_SEED if task.name == "ifbench" else P_CONTROL_SEED
    design = {"paired_trials": 16, "rows_per_arm": len(rows), "model_calls_cached": False,
              "draw_seed": seed, "excluded_prior_mbpp_rows": sorted(PREVIOUS_MBPP_ROWS) if task.name == "mbpp" else [],
              "seed_artifact_hash": cli.digest(task.seed_candidate), "cohort_hash": cli.digest(ids)}
    declaration = load("controls-declaration.json")
    dynamic = {"refusals", "refusals_by_row", "refusals_by_arm"} if identity.get("contract") == 8 else set()
    if (control.get("task") != task.name or control.get("identity") != identity
            or control.get("rows") != ids or control.get("adversarial_hash") != cli.digest(proof)
            or control.get("artifacts") != artifacts(task) or control.get("noise_design") != design
            or any(control.get(key) != value for key, value in declaration.items() if key not in dynamic)
            or declaration.get("identity") != identity or declaration.get("rows") != ids
            or load("manifest.json").get("identity") != identity):
        raise ValueError("Control identity, artifacts, declaration or frozen cohort changed")
    if dynamic and any(declaration.get(key) != (0 if key == "refusals" else {}) for key in dynamic):
        raise ValueError("Refusal counters must start empty in the frozen declaration")
    evaluations = [json.loads(line) for line in (local / "evaluations.jsonl").read_text().splitlines()]
    records = {}
    for record in evaluations:
        key = (record["trial"], record["arm"]) if record["control"] == "unchanged" else record["control"]
        if (key in records or record["row_ids"] != ids or len(record["outputs"]) != len(rows)
                or len(record["scores"]) != len(rows)
                or record["scores"] != [score_output(task, row, output) for row, output in zip(rows, record["outputs"], strict=True)]):
            raise ValueError("Raw control outputs, scores or cohort disagree")
        records[key] = record
    if dynamic:
        from collections import Counter
        by_arm, by_row, measured_refusals = {}, Counter(), Counter()
        for record in evaluations:
            arm = (f"unchanged:{record['trial']}:{record['arm']}"
                   if record["control"] == "unchanged" else record["control"])
            refused = record.get("refusals", [])
            if (not isinstance(refused, list) or len(set(refused)) != len(refused)
                    or not set(refused).issubset(ids)
                    or any(output != "" or score != 0 for row_id, output, score in
                           zip(ids, record["outputs"], record["scores"], strict=True) if row_id in refused)):
                raise ValueError("Refused rows must have empty outputs and zero scores")
            by_arm[arm] = len(refused)
            by_row.update(refused)
            measured_refusals.update((arm, row_id) for row_id in refused)
        calls = [json.loads(line) for line in (local / "calls.jsonl").read_text().splitlines()]
        metered_refusals = Counter((call.get("context", {}).get("arm"), call.get("row_id"))
                                  for call in calls if call.get("outcome") == "refusal")
        if (measured_refusals != metered_refusals or control.get("refusals") != sum(by_arm.values())
                or control.get("refusals_by_arm") != by_arm or control.get("refusals_by_row") != dict(by_row)):
            raise ValueError("Refusal summaries disagree with row outcomes or metered receipts")
    means = {}
    for name, measured in control["controls"].items():
        raw = records.get(name)
        if raw is None or any(measured[field] != raw[field] for field in ("scores", "outputs")) or measured["mean"] != statistics.fmean(raw["scores"]):
            raise ValueError("Control summary differs from raw evaluations")
        if dynamic and (measured.get("refusals") != len(raw.get("refusals", []))
                        or measured.get("refusals_by_row") != dict(Counter(raw.get("refusals", [])))):
            raise ValueError("Control refusal summary differs from raw row outcomes")
        means[name] = measured["mean"]
    if task.name == "ifbench" and means.get("naive", -1) >= .90:
        if not allow_failure or set(records) != {"naive"} or set(means) != {"naive"}:
            raise ValueError("IFBench headroom gate failed or contains extra trials")
        return "headroom"
    names = {"known-improved", "naive", "broken", "shortcut"}
    if set(means) != names:
        raise ValueError("Four control measurements are required")
    ranking = (means["known-improved"] > means["naive"] > max(means["broken"], means["shortcut"])
               and means["broken"] == 0 and (task.name != "mbpp" or means["shortcut"] == 0))
    if control.get("ranking_passed") is not ranking:
        raise ValueError("Ranking flag disagrees with raw measurements")
    if not ranking:
        if not allow_failure or set(records) != names:
            raise ValueError("Ranking gate failed or contains extra trials")
        return "ranking"
    pairs = load("noise-pairs.json")
    if len(pairs) != 16 or set(records) != names | {(trial, arm) for trial in range(16) for arm in ("first", "second")}:
        raise ValueError("Exactly sixteen complete paired trials are required")
    for trial, pair in enumerate(pairs):
        if (pair["trial"] != trial or any(pair[arm] != records[(trial, arm)]["scores"] for arm in ("first", "second"))
                or pair["delta"] != statistics.fmean(pair["second"]) - statistics.fmean(pair["first"])):
            raise ValueError("Noise pairs disagree with raw evaluations")
    sd = statistics.stdev(pair["delta"] for pair in pairs)
    if local.name + "/noise-pairs.json" not in members:
        raise ValueError("Noise pairs are not sealed")
    maximum = max(abs(pair["delta"]) for pair in pairs)
    envelope = max(4.5 / math.sqrt(2) * sd, maximum)
    identity_hash = cli.digest(identity)
    expected = {"gateVersion": "noise-envelope-v3", "evidenceVersion": "pilot-direct-paired-v1",
                "capsuleId": "cap_" + identity_hash.removeprefix("sha256:")[:12],
                "admittedCapsuleDigest": identity_hash, "executionImage": identity["image"],
                "assetGroupId": "development-calibration", "measurementEpoch": identity_hash,
                "sourceCohortSha256": [cli.digest({"identity": identity, "rows": ids, "seed": task.seed_candidate, "pair": pair}) for pair in pairs],
                "maxObservedPairDelta": maximum, "noiseFloor": 3 / math.sqrt(2) * sd, "noiseEnvelope": envelope,
                "informationFreePairs": 16, "informationFreePositive": sum(pair["delta"] > 0 for pair in pairs),
                "estimator": "direct-local-paired-delta-sd-v1", "pairedDeltaTrials": 16,
                "pairedDeltaDegreesOfFreedom": 15, "pairedDeltaSd": sd,
                "localArmBaselineHash": cli.digest(task.seed_candidate)}
    passed = envelope < means["known-improved"] - means["naive"]
    if any(control["calibration"].get(key) != value for key, value in expected.items()) or control.get("noise_passed") is not passed:
        raise ValueError("Noise calibration disagrees with raw pairs")
    if not passed and not allow_failure:
        raise ValueError("Noise gate failed")
    return "passed" if passed else "noise"


def reuse_control(task) -> tuple[dict, dict]:
    from . import __main__ as cli
    from .admission import validate_source_equivalence, validate_text_admission
    from .controls import representative_rows
    if task.name not in ("mbpp", "hover"):
        raise ValueError("Only retained MBPP and HoVer admissions can carry forward; prior IFBench has invalid cohort")
    source = cli.ROOT / "evidence/pilot/controls-5"
    cli.verify_bundle(source)
    members = json.loads((source / "bundle.json").read_text())["files"]
    if not {task.name + "/controls.json", task.name + "/admission.json"}.issubset(members):
        raise ValueError("Retained controls and admission receipt are not sealed")
    if task.name == "mbpp":
        control, origin = cli.reuse_mbpp(task)
        if json.loads((source / "mbpp/controls.json").read_text()) != control:
            raise ValueError("Contract-5 MBPP differs from original admission")
        old_receipt = json.loads((source / "mbpp/admission.json").read_text())
        if {k: v for k, v in old_receipt.items() if k != "current_identity"} != {k: v for k, v in origin.items() if k != "current_identity"}:
            raise ValueError("Contract-5 MBPP source receipt changed")
    else:
        local = source / "hover"
        cli.verify_bundle(local)
        control = json.loads((local / "controls.json").read_text())
        proof = json.loads((local / "admission.json").read_text())
        original = control["identity"]
        current = cli.evaluator_identity(task)
        if original.get("contract") != 5 or any(original.get(key) != current.get(key) for key in ("task", "route", "decoding", "image")):
            raise ValueError("HoVer task resources, model, decoding or image changed")
        validate_text_admission(proof, task, original, representative_rows(task))
        for key, filename in (("predeclaration_hash", "predeclaration-5.md"), ("prior_predeclaration_hash", "predeclaration-4.md"), ("transport_correction_hash", "predeclaration-4a.md")):
            if original[key] != cli.file_hash(cli.ROOT / "evidence/pilot" / filename):
                raise ValueError("Original HoVer declaration changed")
        validate_measurement(local, task, original, proof)
        origin = {"source_control_hash": cli.digest(control), "source_adversarial_hash": cli.digest(proof)}
    scope = validate_source_equivalence(cli.ROOT, control["identity"], task.name)
    return control, {"kind": "retained-" + task.name + "-admission-v8", "source": "evidence/pilot/controls-5",
                     "source_bundle_hash": json.loads((source / "bundle.json").read_text())["bundle_hash"],
                     "original_admission": origin, "source_equivalence": scope,
                     "current_identity": cli.evaluator_identity(task), "controls_rerun": False, "model_calls": 0}
