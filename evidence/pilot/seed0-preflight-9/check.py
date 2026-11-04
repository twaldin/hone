from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
from pilot import __main__ as cli
from pilot import spend


def dispatches(failed_prefix):
    observed = []

    def record(args, pool, env, task, seed, method, smoke):
        failed = len(observed) < failed_prefix
        observed.append({"task": task, "seed": seed, "method": method,
                         "smoke": smoke, "synthetic_infrastructure_failure": failed})
        return {"task": task, "seed": seed, "method": method,
                "status": "infrastructure_failure" if failed else "completed",
                "calls": 1, "hidden_attempts": 1 if failed else 0,
                "usage_missing_calls": 1 if failed else 0}

    with ExitStack() as stack:
        stack.enter_context(patch.object(sys, "argv", ["pilot", "pilot", "--seed", "0",
            "--controls", "evidence/pilot/controls-7b", "--out", ".pilot-runs/pilot"]))
        stack.enter_context(patch.object(cli, "execution_limits"))
        stack.enter_context(patch.object(cli, "load_panel", return_value=("mbpp", "hover")))
        stack.enter_context(patch.object(cli, "machine_proof"))
        stack.enter_context(patch.object(cli, "environment", return_value=({}, {})))
        stack.enter_context(patch.object(cli, "search_one", side_effect=record))
        stack.enter_context(patch.object(spend, "report_spend", return_value={}))
        stack.enter_context(patch.object(cli, "save"))
        stack.enter_context(patch.object(cli, "seal"))
        cli.main()
    return observed


normal = dispatches(0)
failures = dispatches(2)
expected = [{"task": task, "seed": 0, "method": method}
            for task in ("mbpp", "hover") for method in cli.METHODS]
assert len(normal) == 18 and {cell["seed"] for cell in normal} == {0, 1, 2}
assert len(failures) == 18 and all(cell["synthetic_infrastructure_failure"] for cell in failures[:2])
assert all(not cell["smoke"] for cell in normal + failures)
report = {
    "schema": "pilot-first-seed-preflight-stop-v1",
    "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                      for name in ("pilot/__main__.py", "pilot/runtime.py", "evidence/pilot/run-plan-8a.json")},
    "scope": "Real CLI parser and dispatch loop with panel, environment, search, accounting and writes replaced by offline fixtures. No admission, optimizer, task, provider or throttle execution.",
    "requested_cells": expected,
    "observed_dispatches_with_seed_zero": normal,
    "observed_dispatches_after_two_synthetic_failures": failures,
    "synthetic_failure_receipt": {"calls": 1, "hidden_attempts": 1, "usage_missing_calls": 1},
    "model_calls": 0,
    "final_test_labels_read": False,
    "status": "STOP_BEFORE_FIRST_SEARCH",
}
print(json.dumps(report, sort_keys=True, indent=2))
