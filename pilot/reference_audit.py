from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time

from .__main__ import execution_limits
from . import program, verification
from .runtime import IMAGE, ROOT, digest
from .tasks import load_task, score_output

REPLAY = (
    "OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 "
    "NUMEXPR_NUM_THREADS=1 nice -n 10 taskset -c 6 "
    "pilot/.venv/bin/python -m pilot.reference_audit "
    "--out evidence/pilot/reference-audit-6"
)
INTERPRETATION = (
    "This is the official reference implementation pass rate under the final pilot "
    "verifier, not a mathematical ceiling on valid solutions. Alternative valid "
    "solutions can return the exact expected builtin types and values. "
    "No grader, extractor, task loader, controls or admission evidence is changed."
)


def _hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _diagnose(row: dict, plan: dict) -> dict:
    if not plan["gradeable"]:
        return {"status": "ungradeable", "reason": plan["reason"]}
    calls = plan["calls"]
    payload = {"code": program.extract_solution(row["reference_code"]),
               "calls": [{"function": call["function"], "args": call["args"]} for call in calls]}
    invocations = []
    input_hash = verification.grader_input_hash(row["reference_code"], row["reference_code"],
                                                row["test_setup_code"], row["test_list"])
    try:
        verdict = verification._results(verification._run("worker", payload), len(calls), invocations, input_hash)
        if verdict.results is None:
            return {"status": "candidate_failure", "stage": "worker", "failure": verdict.failure}
        results = verdict.results
        if any(call["wrapper"] for call in calls):
            wrapped = verification._run("wrapper", {"results": results,
                                        "wrappers": [call["wrapper"] for call in calls]})
            verdict = verification._results(wrapped, len(calls), invocations, input_hash)
            if verdict.results is None:
                return {"status": "candidate_failure", "stage": "wrapper", "failure": verdict.failure}
            results = verdict.results
        mismatches = []
        for index, (call, result) in enumerate(zip(calls, results, strict=True)):
            actual = verification._canonical(result)
            expected = verification._canonical(call["expected"])
            if actual != expected:
                mismatches.append({"assertion_index": index, "assertion": row["test_list"][index],
                                   "function": call["function"], "wrapper": call["wrapper"],
                                   "kind": "type_mismatch" if actual[0] != expected[0] else "value_or_nested_type_mismatch",
                                   "actual_type": actual[0], "expected_type": expected[0],
                                   "actual_canonical": actual, "expected_canonical": expected})
        return {"status": "canonical_mismatch" if mismatches else "diagnostic_replay_passed",
                "mismatches": mismatches}
    except (ValueError, TypeError, OverflowError, RecursionError) as error:
        return {"status": "invalid_tagged_result", "error_type": type(error).__name__}


def audit(out: Path) -> dict:
    cpus, priority = execution_limits()
    threads = ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS")
    if any(os.environ.get(name) != "1" for name in threads):
        raise ValueError("Reference audit requires all documented thread limits set to 1")
    out.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    source_files = ("pilot/reference_audit.py", "pilot/tasks.py", "pilot/verification.py",
                    "pilot/program.py", "pilot/runtime.py", "pilot/__main__.py")
    source_hashes = {path: _hash(ROOT / path) for path in source_files}
    task = load_task("mbpp", ROOT / ".pilot-cache")
    assert len(task.train) == 374 and len(task.selection) == 90
    assert task.manifest["scored_final_tests_loaded"] is False
    rows = []
    totals = {}
    for split, examples in (("train", task.train), ("validation", task.selection)):
        for row in examples:
            plan = verification.prepare_plan(row["reference_code"], row["test_setup_code"], row["test_list"])
            score = score_output(task, row, row["reference_code"])
            assert score in (0.0, 1.0)
            record = {"id": row["id"], "split": split, "gradeable": plan["gradeable"],
                      "gradeability_reason": plan["reason"], "reference_pass": bool(score),
                      "score": score, "plan_sha256": verification.plan_digest(plan),
                      "row_sha256": digest(row),
                      "reference_sha256": hashlib.sha256(row["reference_code"].encode()).hexdigest(),
                      "setup_sha256": hashlib.sha256(row["test_setup_code"].encode()).hexdigest(),
                      "assertions_sha256": digest(row["test_list"])}
            if not score:
                record["diagnostic_replay"] = _diagnose(row, plan)
            rows.append(record)
        records = [row for row in rows if row["split"] == split]
        passes = sum(row["reference_pass"] for row in records)
        totals[split] = {"rows": len(records), "gradeable": sum(row["gradeable"] for row in records),
                         "reference_passes": passes, "reference_failures": len(records) - passes,
                         "reference_pass_rate": passes / len(records),
                         "failing_ids": [row["id"] for row in records if not row["reference_pass"]]}
    assert len(rows) == 464 and len({row["id"] for row in rows}) == 464
    passes = sum(row["reference_pass"] for row in rows)
    report = {"schema": 1, "task": "mbpp", "development_only": True,
              "scored_final_tests_loaded": False, "model_calls": 0, "replay_command": REPLAY,
              "started_at": started_at, "finished_at": datetime.now(timezone.utc).isoformat(),
              "elapsed_seconds": time.monotonic() - started, "full_audit_runs": 1,
              "execution": {"cpus": cpus, "nice": priority, "max_cpu_heavy_workers": 1,
                            "threads": {name: os.environ[name] for name in threads},
                            "image": os.environ.get("PILOT_PYTHON_IMAGE", IMAGE)},
              "source_sha256": source_hashes, "task_manifest": task.manifest,
              "denominator": len(rows), "gradeable": sum(row["gradeable"] for row in rows),
              "reference_passes": passes, "reference_failures": len(rows) - passes,
              "reference_pass_rate": passes / len(rows),
              "failing_ids": [row["id"] for row in rows if not row["reference_pass"]],
              "split_totals": totals, "interpretation": INTERPRETATION,
              "diagnostics": "Only failed rows get a second isolated reference-worker invocation for explanation. "
                             "The score always comes from score_output. Diagnostics compare validated canonical "
                             "tagged plain data, never candidate equality or repr. Each canonical value begins "
                             "with its exact type tag; nested values retain their own tags.",
              "rows": rows}
    (out / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({key: report[key] for key in ("denominator", "gradeable", "reference_passes",
                     "reference_failures", "failing_ids", "split_totals", "elapsed_seconds", "model_calls")}))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Audit all MBPP development references with the final verifier; no model calls.")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    with verification.grader_journal(args.out / "grader-outcomes.jsonl", purpose="reference-audit"):
        audit(args.out)
