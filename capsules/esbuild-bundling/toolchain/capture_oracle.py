#!/usr/bin/env python3
"""Authoring-only oracle capture for a frozen workload split."""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

capsule = Path(__file__).resolve().parents[1]
baseline = capsule / "baseline"
sys.path.insert(0, str(baseline))
os.environ.setdefault("CAPSULE_WORKSPACE", str(baseline))

import eval as evaluator  # noqa: E402
from workload import load_spec, materialize  # noqa: E402


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: capture_oracle.py SPEC OUTPUT")
    spec = load_spec(Path(sys.argv[1]))
    repetitions = int(spec["repetitions"])
    shutil.rmtree(evaluator.WORK_ROOT, ignore_errors=True)
    evaluator.WORK_ROOT.mkdir(mode=0o755)
    graph_root = evaluator.WORK_ROOT / "input"
    graph_root.mkdir(mode=0o755)
    jobs = materialize(spec, graph_root)
    binary_fd = evaluator._build_candidate()
    try:
        measured = evaluator._measure_jobs(binary_fd, jobs, repetitions)
    finally:
        os.close(binary_fd)
    oracle = {
        "version": 1,
        "jobs": {
            job_id: {
                "semanticHash": result["semanticHash"],
                "sourcemapHash": result["sourcemapHash"],
                "outputBytes": result["outputBytes"],
            }
            for job_id, result in sorted(measured.items())
        },
    }
    Path(sys.argv[2]).write_text(json.dumps(oracle, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({job: measured[job]["medianSec"] for job in sorted(measured)}, sort_keys=True))


if __name__ == "__main__":
    main()
