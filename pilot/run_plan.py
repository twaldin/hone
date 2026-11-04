from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from .runtime import LIMITS, ROOT
from .spend import report_spend


PROJECTION_TOTALS = ("tokens", "charged_tokens", "reported_tokens", "estimated_tokens", "usd_equivalent",
                     "reported_usd_equivalent", "estimated_usd_equivalent", "refusals",
                     "usage_missing_calls", "unbounded_missing_usage_calls", "active_hours",
                     "usage_polling_hours", "observed_pause_hours", "wall_hours")
TERMINAL_STOPS = {"infrastructure-failure", "refusal-nondeterminism"}


def project(sample: dict) -> dict:
    charged = sample.get("charged_tokens", sample["tokens"])
    estimated = sample.get("estimated_tokens", 0)
    reported = sample.get("reported_tokens", sample["tokens"])
    estimated_usd = sample.get("estimated_usd_equivalent", 0)
    reported_usd = sample.get("reported_usd_equivalent", sample["usd_equivalent"])
    resources = {"usd": sample["usd_equivalent"], "tokens": charged,
                 "calls": sample["calls"], "active_seconds": sample["active_seconds"]}
    if any(type(value) not in (int, float) or not math.isfinite(value) or value <= 0 for value in resources.values()):
        raise ValueError("Projection requires positive charged cost, tokens, calls and active time")
    if (any(type(value) is not int or value < 0 for value in (charged, estimated, reported))
            or charged != sample["tokens"] or charged != reported + estimated
            or any(type(value) not in (int, float) or not math.isfinite(value) or value < 0
                   for value in (estimated_usd, reported_usd))
            or not math.isclose(resources["usd"], estimated_usd + reported_usd, rel_tol=1e-9, abs_tol=1e-9)):
        raise ValueError("Projection charged and reported/estimated usage do not reconcile")
    missing = sample.get("usage_missing_calls", 0)
    unbounded = sample.get("unbounded_missing_usage_calls", 0)
    if (any(type(value) is not int or value < 0 for value in (missing, unbounded))
            or not unbounded <= missing <= sample["calls"]):
        raise ValueError("Invalid missing-usage call classification")
    if missing and "unbounded_missing_usage_calls" not in sample:
        raise ValueError("Missing usage requires receipt-derived refusal/unknown classification")
    if missing > unbounded and not estimated:
        raise ValueError("Missing refusal usage requires conservative estimated charges")
    ratios = {key: LIMITS[key] / value for key, value in resources.items()}
    binding = min(ratios, key=ratios.get)
    scale = ratios[binding]
    pause = sample.get("pause_seconds", 0)
    polling = sample.get("poll_seconds", sample["throttle_seconds"] - pause)
    if any(type(value) not in (int, float) or not math.isfinite(value) or value < 0
           for value in (pause, polling, sample["wall_seconds"])):
        raise ValueError("Pause, polling and wall time must be finite and nonnegative")
    refusals = sample.get("refusals", 0)
    if type(refusals) is not int or not 0 <= refusals <= sample["calls"]:
        raise ValueError("Invalid observed refusal count")
    return {"binding_projection": binding, "scale": scale,
            "tokens": charged * scale, "charged_tokens": charged * scale,
            "reported_tokens": reported * scale, "estimated_tokens": estimated * scale,
            "usd_equivalent": sample["usd_equivalent"] * scale,
            "reported_usd_equivalent": reported_usd * scale, "estimated_usd_equivalent": estimated_usd * scale,
            "refusals": refusals * scale,
            "usage_missing_calls": missing * scale,
            "unbounded_missing_usage_calls": unbounded * scale,
            "usage_accounting": "conditional-known-charge-lower-bound" if unbounded else "reported-plus-estimated-charges",
            "usage_limit": ("Known-charge lower-bound forecast only: non-refusal calls with missing usage have unbounded omitted token/dollar volume. Refusal estimates do not bound these omissions; caps bind recorded charges, not an exact total."
                            if unbounded else "Reported usage and conservative refusal estimates are separate charges, not an exact forecast of future reported usage. Internal failed-attempt usage remains unknown."),
            "active_hours": sample["active_seconds"] * scale / 3600,
            "usage_polling_hours": polling * scale / 3600,
            "observed_pause_hours": pause * scale / 3600,
            "wall_hours": sample["wall_seconds"] * scale / 3600,
            "assumption": "Prospective linear scaling preserves the observed reported/estimated charge mix, refusal rate and time rates. These are projected charges, not future reported usage."}


def _retained_spend_matches(current: dict, retained: dict) -> bool:
    for key, value in retained.items():
        if key in {"reporter_sha256", "usage_limit"}:
            continue
        if key not in current:
            return False
        if isinstance(value, dict):
            if not isinstance(current[key], dict) or not _retained_spend_matches(current[key], value):
                return False
        elif current[key] != value:
            return False
    return True


def build(controls: Path) -> dict:
    from .__main__ import verify_bundle
    verify_bundle(controls)
    members = json.loads((controls / "bundle.json").read_text())["files"]
    for name in ("panel.json", "ifbench/failure.json", "ifbench/controls.json", "ifbench/usage.json",
                 "ifbench/noise-pairs.json", "ifbench/calls.jsonl", "ifbench/manifest.json"):
        if (controls / name).exists() and name not in members:
            raise ValueError("Run-plan outcome or measurement is not sealed")
    inputs = {}

    def load(path, *, jsonl=False):
        data = path.read_bytes()
        inputs[str(path.relative_to(ROOT))] = "sha256:" + hashlib.sha256(data).hexdigest()
        return [json.loads(line) for line in data.splitlines()] if jsonl else json.loads(data)

    def load_usage(path):
        usage = load(path / "usage.json")
        calls = load(path / "calls.jsonl", jsonl=True)
        if len(calls) != usage["calls"] or any(type(call.get("usage_missing")) is not bool for call in calls):
            raise ValueError("Calibration call receipts and usage summary disagree")
        missing = sum(call["usage_missing"] for call in calls)
        if usage.get("usage_missing_calls", missing) != missing:
            raise ValueError("Calibration missing-usage summary disagrees with call receipts")
        return {**usage, "usage_missing_calls": missing,
                "unbounded_missing_usage_calls": sum(call["usage_missing"] and call.get("outcome") != "refusal"
                                                      for call in calls)}

    load(controls / "bundle.json")
    panel = load(controls / "panel.json") if (controls / "panel.json").exists() else None
    failure = load(controls / "ifbench/failure.json") if (controls / "ifbench/failure.json").exists() else None
    stop = failure.get("status") if failure is not None else None
    if panel is None and stop not in TERMINAL_STOPS:
        raise ValueError("Missing panel without a sealed terminal-stop receipt")
    declaration = ROOT / "evidence/pilot/predeclaration-8.md"
    declaration_hash = "sha256:" + hashlib.sha256(declaration.read_bytes()).hexdigest()
    inputs[str(declaration.relative_to(ROOT))] = declaration_hash
    if panel is not None:
        expected_tasks = {"passed": ["mbpp", "ifbench", "hover"], "failed-gate": ["mbpp", "hover"]}
        if (panel.get("version") != 8 or panel.get("all_admitted") is not True
                or panel.get("predeclaration_hash") != declaration_hash
                or panel.get("tasks") != expected_tasks.get(panel.get("ifbench_status"))):
            raise ValueError("A complete frozen contract-8 panel is required")
        if stop in TERMINAL_STOPS:
            raise ValueError("Terminal stop cannot also supply an admitted panel")
        if (panel["ifbench_status"] == "passed" and failure is not None
                or panel["ifbench_status"] == "failed-gate" and stop != "admission-failed"):
            raise ValueError("Panel and sealed gate outcome disagree")
    manifest_path = controls / "ifbench/manifest.json"
    manifest = load(manifest_path) if manifest_path.exists() else {}
    current_setup = panel is not None and panel.get("version") == 8 or manifest.get("identity", {}).get("contract") == 8
    setup = load(ROOT / f"evidence/pilot/setup-overhead-{8 if current_setup else 6}.json")
    setup_hours = (setup["cold_mbpp_load_seconds"] + setup["revalidations_per_matrix"] * setup["warm_mbpp_revalidation_seconds"]) / 3600
    incomplete = None
    calibration_paths = {"mbpp": ROOT / "evidence/pilot/mbpp-readmission-4a/mbpp",
                         "hover": ROOT / "evidence/pilot/controls-5/hover",
                         "ifbench": controls / "ifbench"}
    calibrations = {}
    for task, path in calibration_paths.items():
        if task == "ifbench" and stop in TERMINAL_STOPS:
            incomplete = {"status": stop + "-not-a-gate-failure",
                          "failure": failure, "usage": load_usage(path),
                          "complete_calibration": False, "usable_for_projection": False,
                          "reason": "Terminal stop does not establish admission or a complete calibration. No completed prefix is projected."}
            continue
        if not (path / "controls.json").exists():
            if task == "ifbench" and panel["ifbench_status"] == "failed-gate":
                incomplete = {"status": "failed-gate-without-complete-calibration", "failure": failure,
                              "complete_calibration": False, "usable_for_projection": False}
                continue
            raise ValueError("Calibration results missing: " + task)
        verify_bundle(path.parent)
        usage = load_usage(path)
        control = load(path / "controls.json")
        if task == "ifbench":
            identity = control.get("identity", {})
            if identity.get("contract") != 8 or identity.get("predeclaration_hash") != panel["predeclaration_hash"]:
                raise ValueError("IFBench calibration does not match frozen contract 8")
            pairs = load(path / "noise-pairs.json") if (path / "noise-pairs.json").exists() else []
            complete = (set(control["controls"]) == {"naive", "known-improved", "broken", "shortcut"}
                        and len(pairs) == 16 and [pair.get("trial") for pair in pairs] == list(range(16))
                        and (control.get("calibration") or {}).get("pairedDeltaTrials") == 16
                        and control.get("noise_design", {}).get("paired_trials") == 16
                        and control.get("ranking_passed") is True and len(control["rows"]) == 40
                        and type(control.get("noise_passed")) is bool)
            if not complete:
                if panel["ifbench_status"] == "passed":
                    raise ValueError("Admitted IFBench lacks a complete noise calibration")
                incomplete = {"status": "failed-gate-without-complete-calibration", "failure": failure, "usage": usage,
                              "complete_calibration": False, "usable_for_projection": False,
                              "reason": "The gate outcome is measured, but the full noise calibration was not completed. No partial noise projection is supplied."}
                continue
            if control["noise_passed"] is not (panel["ifbench_status"] == "passed"):
                raise ValueError("Panel and completed noise gate disagree")
        calibrations[task] = {"source": str(path.relative_to(ROOT)), "usage": usage,
                              "controls": {key: value["mean"] for key, value in control["controls"].items()},
                              "noise_calibration": control.get("calibration"), "complete_calibration": True,
                              "training_rows_per_arm": len(control["rows"]),
                              "admitted": task in ("mbpp", "hover") or panel is not None and task in panel["tasks"],
                              "projection": project(usage)}
    smokes = {}
    rows = []
    for method in ("hone", "gepa", "plain"):
        path = ROOT / "evidence/pilot/smoke-5/mbpp/0" / method
        verify_bundle(path)
        result = load(path / "result.json")
        spend = report_spend(path)
        if result["status"] != "completed" or spend["status"] != "complete":
            raise ValueError("A complete real smoke with reconciled spend is required")
        if not _retained_spend_matches(spend, load(path / "spend.json")):
            raise ValueError("Retained smoke phase spend changed")
        if (result["calls"] != spend["total"]["calls"] or result["tokens"] != spend["total"]["tokens"]
                or not math.isclose(result["usd_equivalent"], spend["total"]["usd_equivalent"], rel_tol=1e-9, abs_tol=1e-9)):
            raise ValueError("Retained smoke result and charged spend disagree")
        inputs.update({str((path / name).relative_to(ROOT)): digest for name, digest in spend["input_hashes"].items()})
        smokes[method] = {"source": str(path.relative_to(ROOT)), "result": result,
                          "phase_spend": spend["buckets"], "hidden_attempt_rate": spend["hidden_attempt_rate"],
                          "projection": project({**spend["total"], **result})}
        for task in ("mbpp", "hover", "ifbench"):
            if task not in calibrations:
                continue
            projection = smokes[method]["projection"] if task == "mbpp" else calibrations[task]["projection"]
            rows.append({"task": task, "method": method, "seeds": [0, 1, 2],
                         "basis": "actual all-role method smoke" if task == "mbpp" else "task calibration proxy, not a method search",
                         "projection_per_cell": projection})
    plans = {}
    for name, tasks in (("three_task", ["mbpp", "ifbench", "hover"]),
                        ("two_task_fallback", ["mbpp", "hover"])):
        selected = [row for row in rows if row["task"] in tasks]
        count = len(tasks) * 9
        available = len(selected) == len(tasks) * 3
        plans[name] = {"tasks": tasks, "searches": count, "authorized": False,
                       "admitted": panel is not None and set(tasks).issubset(panel["tasks"]),
                       "projection_available": available,
                       "ceilings": {"usd_equivalent": count * LIMITS["usd"],
                                    "charged_tokens": count * LIMITS["tokens"],
                                    "active_hours": count * LIMITS["active_seconds"] / 3600,
                                    "elapsed_wall_hours_upper_bound": None},
                       "projection": {key: sum(row["projection_per_cell"][key] * 3 for row in selected)
                                      for key in PROJECTION_TOTALS} if available else None}
        if available:
            plans[name]["projection"].update(retained_admission_setup_hours=setup_hours,
                total_wall_hours_including_measured_setup=plans[name]["projection"]["wall_hours"] + setup_hours)
            projection = plans[name]["projection"]
            projection["usage_accounting"] = ("conditional-known-charge-lower-bound"
                                               if projection["unbounded_missing_usage_calls"] else "reported-plus-estimated-charges")
            projection["usage_limit"] = ("Summed conditional known-charge forecasts exclude the disclosed unbounded non-refusal token/dollar omissions; refusal estimates do not cover them. Neither exact total usage nor a finite total-usage upper bound is supplied."
                                         if projection["unbounded_missing_usage_calls"] else "Reported and estimated charges remain separate; internal failed-attempt usage remains unknown.")
    return {"schema": "pilot-measured-run-plan-v8", "status": "INFERENCE_NOT_EXECUTED",
            "selected_panel": panel, "calibrations": calibrations, "smokes": smokes,
            "cell_projections": rows, "plans": plans, "input_hashes": inputs,
            "admission_status": "complete" if panel is not None else
                "infrastructure-aborted-no-panel-no-fallback" if stop == "infrastructure-failure" else "refusal-nondeterminism-no-panel-no-fallback",
            "incomplete_ifbench_calibration": incomplete,
            "measured_setup": setup,
            "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "method": "Prospective linear scaling of observed task-specific charged usage and time to the first common dollar/token/call/active-time cap; sum three seeds per method. Reported usage and estimated refusal charges stay separate. MBPP uses each retained actual smoke. P tasks use completed calibration ratios for every method, not invented method-search results.",
            "limits": ["One retained real smoke per method; calibration and smoke mixes differ from longer searches. No statistical precision or optimizer advantage is claimed.",
                       "P calibration has no proposer calls. Its projection does not measure future proposal overhead or candidate-dependent deployment changes; all such calls must fit the same cap, and can lower the amount of task evaluation purchased.",
                       "Token reservations, proposer/rollout safety caps and future latency can stop runs earlier than this fluid-rate estimate. Measured cold MBPP planning plus eleven retained-admission validations are added outside cell time; corpus download/index creation and other small orchestration overhead are separate.",
                       "Observed pause duty is included, not guaranteed. Before every call all allowed accounts must remain at or below80%; missing/stale usage and broker outage pause dispatch every30seconds. Arbitrary outage/quota delay has no finite upper bound.",
                       "Charged usage includes reported usage and conservative estimated refusal charges. Receipt-derived unbounded_missing_usage_calls counts non-refusal calls whose token/dollar volume is unbounded, even when other calls have refusal estimates. Forecasts with these omissions are conditional known-charge lower bounds, not exact totals or free usage. Hidden failed-attempt volume remains separately unknown. Scaling observed mixes and refusal frequency is an assumption.",
                       "Neither matrix is authorized. The assistant reviews this plan first. Complete credential-opaque per-attempt and failed-call receipts remain prerequisites for the full matrix."],
            "next_lane_command_not_authorized": "nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot pilot --controls " + str(controls.relative_to(ROOT)) + " --out .pilot-runs/pilot",
            "matrix_searches_executed": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate the measured pilot run plan without model calls")
    parser.add_argument("--controls", type=Path, default=ROOT / "evidence/pilot/controls-8")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = build(args.controls.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report["plans"], sort_keys=True))
