import argparse
import json
from pathlib import Path

from pilot.runtime import digest
from pilot.verification import (GraderInfrastructureError, WORKER_SECONDS, grader_journal,
                                score_solution, validate_grader_receipt)


def main():
    parser = argparse.ArgumentParser(description="Exercise trusted verdicts in the real pinned sandbox without model calls")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    reference = "def add(a,b): return a+b"
    tests = ["assert add(1,2)==3", "assert add(2,2)==4"]
    cases = [("pass", reference, "pass", 1.0),
             ("wrong-output", "def add(a,b): return a-b", "wrong_answer", 0.0),
             ("candidate-exception", "def add(a,b): raise TypeError('candidate')", "wrong_answer", 0.0),
             ("candidate-syntax", "not valid Python", "wrong_answer", 0.0),
             ("candidate-SystemExit", "raise SystemExit(7)", "wrong_answer", 0.0),
             ("candidate-unsupported-output", "def add(a,b): return iter([a,b])", "wrong_answer", 0.0),
             ("candidate-timeout", "while True: pass", "wrong_answer", 0.0),
             ("worker-exit", "import os\nos._exit(7)", "nonzero_exit", None),
             ("worker-no-frame", "import os\nos._exit(0)", "frame_failure", None)]
    results = []
    journal = args.out / "grader-outcomes.jsonl"
    for name, code, expected_outcome, expected_score in cases:
        with grader_journal(journal, purpose="smoke", task="mbpp", row_id="synthetic-add", case=name):
            try:
                score = score_solution(code, reference, "", tests)
                outcome = "pass" if score == 1.0 else "wrong_answer"
            except GraderInfrastructureError as error:
                validate_grader_receipt(error.receipt)
                outcome, score = error.receipt["outcome"], error.receipt["score"]
        assert (outcome, score) == (expected_outcome, expected_score), (name, outcome, score)
        receipts = [record for line in journal.read_text().splitlines()
                    if (record := json.loads(line)).get("event") == "grader-outcome"]
        receipt = receipts[-1]
        validate_grader_receipt(receipt)
        if expected_score is not None:
            assert all(item["outcome"] == "completed" and item["exit_code"] == 0 for item in receipt["invocations"])
        results.append({"case": name, "outcome": outcome, "score": score,
                        "output_hash": digest(code), "receipt_hash": receipt["receipt_hash"]})
        print(json.dumps(results[-1], sort_keys=True), flush=True)
    proof = {"passed": True, "real_pinned_docker": True, "model_calls": 0,
             "candidate_seconds": WORKER_SECONDS, "results": results}
    (args.out / "result.json").write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
