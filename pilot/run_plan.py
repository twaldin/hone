from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .runtime import LIMITS, ROOT
from .spend import report_spend


def project(sample: dict) -> dict:
    resources = {"usd": sample["usd_equivalent"], "tokens": sample["tokens"],
                 "calls": sample["calls"], "active_seconds": sample["active_seconds"]}
    if any(value <= 0 for value in resources.values()):
        raise ValueError("Projection requires positive observed cost, tokens, calls and active time")
    ratios = {key: LIMITS[key] / value for key, value in resources.items()}
    binding = min(ratios, key=ratios.get)
    scale = ratios[binding]
    pause = sample.get("pause_seconds", 0)
    polling = sample.get("poll_seconds", sample["throttle_seconds"] - pause)
    if min(pause, polling) < 0:
        raise ValueError("Pause and polling time must be nonnegative")
    return {"binding_projection": binding, "scale": scale,
            "tokens": sample["tokens"] * scale,
            "usd_equivalent": sample["usd_equivalent"] * scale,
            "active_hours": sample["active_seconds"] * scale / 3600,
            "usage_polling_hours": polling * scale / 3600,
            "observed_pause_hours": pause * scale / 3600,
            "wall_hours": sample["wall_seconds"] * scale / 3600}


def build(controls: Path) -> dict:
    from .__main__ import verify_bundle
    verify_bundle(controls)
    members = json.loads((controls / "bundle.json").read_text())["files"]
    for name in ("panel.json", "ifbench/failure.json"):
        if (controls / name).exists() and name not in members:
            raise ValueError("Run-plan outcome is not sealed")
    panel_path = controls / "panel.json"
    panel = json.loads(panel_path.read_text()) if panel_path.exists() else None
    failure_path = controls / "ifbench/failure.json"
    failure = json.loads(failure_path.read_text()) if failure_path.exists() else None
    if panel is None and (failure is None or failure.get("status") != "infrastructure-failure"):
        raise ValueError("Missing panel without a sealed infrastructure-abort receipt")
    if panel is not None and (panel["version"] != 6 or panel["all_admitted"] is not True):
        raise ValueError("A complete contract-6 panel or sealed infrastructure abort is required")
    if panel is not None and failure is not None and failure.get("status") == "infrastructure-failure":
        raise ValueError("Infrastructure abort cannot also supply an admitted panel")
    inputs = {}

    def load(path):
        data = path.read_bytes()
        inputs[str(path.relative_to(ROOT))] = "sha256:" + hashlib.sha256(data).hexdigest()
        return json.loads(data)

    inputs[str((controls / "bundle.json").relative_to(ROOT))] = "sha256:" + hashlib.sha256((controls / "bundle.json").read_bytes()).hexdigest()
    setup = load(ROOT / "evidence/pilot/setup-overhead-6.json")
    setup_hours = (setup["cold_mbpp_load_seconds"] + setup["revalidations_per_matrix"] * setup["warm_mbpp_revalidation_seconds"]) / 3600
    incomplete = None
    calibration_paths = {"mbpp": ROOT / "evidence/pilot/mbpp-readmission-4a/mbpp",
                         "hover": ROOT / "evidence/pilot/controls-5/hover",
                         "ifbench": controls / "ifbench"}
    calibrations = {}
    for task, path in calibration_paths.items():
        if task == "ifbench" and failure is not None and failure.get("status") == "infrastructure-failure":
            incomplete = {"status": "infrastructure-failure-not-a-gate-failure",
                          "failure": load(path / "failure.json"), "usage": load(path / "usage.json"),
                          "complete_calibration": False, "usable_for_projection": False,
                          "reason": "Calibration infrastructure-aborted. Completed prefixes do not establish admission; missing failed-call usage is unknown."}
            continue
        if not (path / "controls.json").exists():
            if task == "ifbench" and panel["ifbench_status"] == "failed-gate":
                continue
            raise ValueError("Calibration results missing: " + task)
        verify_bundle(path.parent)
        usage = load(path / "usage.json")
        control = load(path / "controls.json")
        calibrations[task] = {"source": str(path.relative_to(ROOT)), "usage": usage,
                              "controls": {key: value["mean"] for key, value in control["controls"].items()},
                              "noise_calibration": control.get("calibration"),
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
        load(path / "spend.json")
        if spend != json.loads((path / "spend.json").read_text()):
            raise ValueError("Retained smoke phase spend changed")
        smokes[method] = {"source": str(path.relative_to(ROOT)), "result": result,
                          "phase_spend": spend["buckets"], "hidden_attempt_rate": spend["hidden_attempt_rate"],
                          "projection": project(result)}
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
                                    "reported_tokens": count * LIMITS["tokens"],
                                    "active_hours": count * LIMITS["active_seconds"] / 3600,
                                    "elapsed_wall_hours_upper_bound": None},
                       "projection": {key: sum(row["projection_per_cell"][key] * 3 for row in selected)
                                      for key in ("tokens", "usd_equivalent", "active_hours", "usage_polling_hours", "observed_pause_hours", "wall_hours")} if available else None}
        if available:
            plans[name]["projection"].update(retained_admission_setup_hours=setup_hours,
                total_wall_hours_including_measured_setup=plans[name]["projection"]["wall_hours"] + setup_hours)
    return {"schema": "pilot-measured-run-plan-v6", "status": "INFERENCE_NOT_EXECUTED",
            "selected_panel": panel, "calibrations": calibrations, "smokes": smokes,
            "cell_projections": rows, "plans": plans, "input_hashes": inputs,
            "admission_status": "complete" if panel is not None else "infrastructure-aborted-no-panel-no-fallback",
            "incomplete_ifbench_calibration": incomplete,
            "measured_setup": setup,
            "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "method": "Linearly scale observed task-specific usage and time to the first common dollar/token/call/active-time cap; sum three seeds per method. MBPP uses each actual smoke. P tasks use calibration ratios for every method, not invented method-search results.",
            "limits": ["One real smoke per method; calibration and smoke mixes differ from longer searches. No statistical precision or optimizer advantage is claimed.",
                       "P calibration has no proposer calls. Its projection does not measure future proposal overhead or candidate-dependent deployment changes; all such calls must fit the same cap, and can lower the amount of task evaluation purchased.",
                       "Token reservations, proposer/rollout safety caps and future latency can stop runs earlier than this fluid-rate estimate. Measured cold MBPP planning plus eleven retained-admission validations are added outside cell time; corpus download/index creation and other small orchestration overhead are separate.",
                       "Observed pause duty is included, not guaranteed. Before every call all allowed accounts must remain at or below80%; missing/stale usage and broker outage pause dispatch every30seconds. Arbitrary outage/quota delay has no finite upper bound.",
                       "Usage is omp transport-reported only. Hidden failed-attempt and non-200 token volume is unknown, not free.",
                       "Neither matrix is authorized. The assistant reviews this plan first. Credential-opaque per-attempt and failed-call receipts remain prerequisites for the full matrix."],
            "next_lane_command_not_authorized": "nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls-6 --out .pilot-runs/pilot",
            "matrix_searches_executed": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate the measured pilot run plan without model calls")
    parser.add_argument("--controls", type=Path, default=ROOT / "evidence/pilot/controls-6")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = build(args.controls.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps(report["plans"], sort_keys=True))
