"""Scorer proxy entry point for harness-worker inner-loop scoring.

Called by the proxy shell script placed at <run_dir>/.hone-scorer.
Reads env vars, enforces budget + scorer-readonly policy, runs the grader,
writes the budget file, and emits a JSON envelope to stdout.

Exit codes:
  0  — success
  2  — budget exhausted or policy rejection
  1  — unexpected error
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    budget_file = Path(os.environ["HONE_BUDGET_FILE"])
    grader_path = Path(os.environ["HONE_GRADER_PATH"])
    workdir = Path(os.environ["HONE_WORKDIR"])
    grader_timeout = int(os.environ.get("HONE_GRADER_TIMEOUT", "3600"))
    scorer_readonly = os.environ.get("HONE_SCORER_READONLY", "0") == "1"

    budget_data = json.loads(budget_file.read_text(encoding="utf-8"))

    if budget_data.get("remaining", 0) <= 0:
        print(json.dumps({"error": "budget exhausted"}), file=sys.stderr)
        sys.exit(2)

    attempt_idx = len(budget_data.get("attempts", []))

    if "policy_decisions" not in budget_data:
        budget_data["policy_decisions"] = []

    # Scorer-readonly: reject grader paths inside workdir
    if scorer_readonly:
        try:
            grader_path.resolve().relative_to(workdir.resolve())
            budget_data["policy_decisions"].append({
                "decision": "reject",
                "reason": "grader-inside-workdir",
                "attempt_idx": attempt_idx,
            })
            _write_json_atomic(budget_file, budget_data)
            print(json.dumps({"error": "grader-inside-workdir"}), file=sys.stderr)
            sys.exit(2)
        except ValueError:
            pass  # grader is outside workdir — OK

        grader_hash_before = _sha256_file(grader_path)

    # Stash current workdir state (no --quiet: we need stdout to detect no-op stashes)
    stash_out = subprocess.run(
        ["git", "stash", "push", "--include-untracked", "-m", f"hone-worker-attempt-{attempt_idx}"],
        cwd=str(workdir), capture_output=True, text=True,
    ).stdout
    pushed = "No local changes to save" not in stash_out

    if pushed:
        subprocess.run(
            ["git", "stash", "apply", "stash@{0}"],
            cwd=str(workdir), capture_output=True, check=True,
        )

    # Run grader
    from hone.grader import run_grader
    from hone.scorer_result import to_scorer_result

    grader_result = run_grader(grader_path, workdir, timeout_seconds=grader_timeout)
    sr = to_scorer_result(grader_result)

    # Reset grader side effects; workdir returns to HEAD
    subprocess.run(["git", "reset", "--hard", "HEAD"], cwd=str(workdir), capture_output=True, check=True)
    subprocess.run(["git", "clean", "-fd"], cwd=str(workdir), capture_output=True, check=True)

    # Re-apply stash so agent can continue editing from its pre-call state
    if pushed:
        subprocess.run(
            ["git", "stash", "apply", "stash@{0}"],
            cwd=str(workdir), capture_output=True, check=True,
        )

    # Scorer-readonly: check grader was not tampered with during the call
    notes = ""
    if scorer_readonly:
        grader_hash_after = _sha256_file(grader_path)
        if grader_hash_before != grader_hash_after:
            notes = "scorer-tamper"
            budget_data["policy_decisions"].append({
                "decision": "tamper-detected",
                "reason": "scorer-tamper",
                "attempt_idx": attempt_idx,
            })

    # Update budget file
    budget_data["remaining"] -= 1
    attempt_record = {
        "attempt_idx": attempt_idx,
        "score": sr.score,
        "submetrics": sr.submetrics,
        "pushed": pushed,
        "stash_ref": "stash@{0}" if pushed else None,
        "traces_path": None,
        "trace_stderr": sr.trace_stderr,
        "raw_stdout": sr.raw_stdout,
        "parsed_envelope": sr.parsed_envelope,
        "notes": notes,
    }
    budget_data["attempts"].append(attempt_record)
    _write_json_atomic(budget_file, budget_data)

    # Emit JSON envelope to stdout
    envelope = {
        "score": sr.score,
        "submetrics": sr.submetrics,
        "attempt_idx": attempt_idx,
        "remaining_budget": budget_data["remaining"],
    }
    print(json.dumps(envelope))

    # Emit trace stderr verbatim
    if sr.trace_stderr:
        print(sr.trace_stderr, file=sys.stderr, end="")

    sys.exit(0)


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


if __name__ == "__main__":
    main()
