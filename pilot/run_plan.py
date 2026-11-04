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
    panel = json.loads((controls / "panel.json").read_text())
    if panel["version"] != 6 or panel["all_admitted"] is not True:
        raise ValueError("A complete contract-6 panel is required")
    inputs = {}

    def load(path):
        data = path.read_bytes()
        inputs[str(path.relative_to(ROOT))] = "sha256:" + hashlib.sha256(data).hexdigest()
        return json.loads(data)

    inputs[str((controls / "bundle.json").relative_to(ROOT))] = "sha256:" + hashlib.sha256((controls / "bundle.json").read_bytes()).hexdigest()
    calibration_paths = {"mbpp": ROOT / "evidence/pilot/mbpp-readmission-4a/mbpp",
                         "hover": ROOT / "evidence/pilot/controls-5/hover",
                         "ifbench": controls / "ifbench"}
    calibrations = {}
    for task, path in calibration_paths.items():
        if not (path / "usage.json").exists():
            if task == "ifbench" and panel["ifbench_status"] == "failed-gate":
                continue
            raise ValueError("Calibration usage missing: " + task)
        verify_bundle(path.parent)
        usage = load(path / "usage.json")
        control = load(path / "controls.json")
        calibrations[task] = {"source": str(path.relative_to(ROOT)), "usage": usage,
                              "controls": {key: value["mean"] for key, value in control["controls"].items()},
                              "noise_calibration": control.get("calibration"),
                              "training_rows_per_arm": len(control["rows"]),
                              "admitted": task in panel["tasks"],
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
                       "admitted": set(tasks).issubset(panel["tasks"]),
                       "projection_available": available,
                       "ceilings": {"usd_equivalent": count * LIMITS["usd"],
                                    "reported_tokens": count * LIMITS["tokens"],
                                    "active_hours": count * LIMITS["active_seconds"] / 3600,
                                    "elapsed_wall_hours_upper_bound": None},
                       "projection": {key: sum(row["projection_per_cell"][key] * 3 for row in selected)
                                      for key in ("tokens", "usd_equivalent", "active_hours", "usage_polling_hours", "observed_pause_hours", "wall_hours")} if available else None}
    return {"schema": "pilot-measured-run-plan-v6", "status": "INFERENCE_NOT_EXECUTED",
            "selected_panel": panel, "calibrations": calibrations, "smokes": smokes,
            "cell_projections": rows, "plans": plans, "input_hashes": inputs,
            "generator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "method": "Linearly scale observed task-specific usage and time to the first common dollar/token/call/active-time cap; sum three seeds per method. MBPP uses each actual smoke. P tasks use calibration ratios for every method, not invented method-search results.",
            "limits": ["One real smoke per method; calibration and smoke mixes differ from longer searches. No statistical precision or optimizer advantage is claimed.",
                       "P calibration has no proposer calls. Its projection does not measure future proposal overhead or candidate-dependent deployment changes; all such calls must fit the same cap, and can lower the amount of task evaluation purchased.",
                       "Token reservations, proposer/rollout safety caps, one-time preparation and future latency can stop runs earlier than this fluid-rate estimate.",
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
