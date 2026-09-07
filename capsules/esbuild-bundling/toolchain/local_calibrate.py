#!/usr/bin/env python3
"""Run local interleaved A-A samples through broker-equivalent Docker mounts."""
from __future__ import annotations

import json
import statistics
import subprocess
import sys
from pathlib import Path

CAPSULE = Path(__file__).resolve().parents[1]
IMAGE = sys.argv[1]
SAMPLES = int(sys.argv[2]) if len(sys.argv) > 2 else 6
WORKSPACE = CAPSULE / sys.argv[3] if len(sys.argv) > 3 else CAPSULE / "baseline"


def evaluate(split: str) -> float:
    baseline = CAPSULE / "baseline"
    assets = CAPSULE / "assets" / split
    argv = [
        "docker", "run", "--rm", "--network", "none", "--platform=linux/arm64",
        "--read-only", "--tmpfs", "/tmp:size=16m,nosuid,nodev,noexec", "--shm-size", "16m",
        "--tmpfs", "/capsule:mode=0700,size=1m", "--user", "0:0",
        "-e", "CAPSULE_WORKSPACE=/workspace", "-e", "CAPSULE_ASSETS=/capsule/assets",
        "-v", f"{WORKSPACE}:/workspace:ro", "-v", f"{baseline}:/trusted/baseline:ro",
        "-v", f"{assets}:/capsule/assets/assets/{split}:ro", "-w", "/trusted/baseline",
        IMAGE, "python3", "-I", "-B", "eval.py",
    ]
    completed = subprocess.run(argv, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    output = json.loads(completed.stdout)
    if output.get("valid") is not True:
        raise RuntimeError(f"baseline {split} failed: {output.get('diagnostics')}")
    return float(output["objectives"]["score"])


pairs = []
for index in range(SAMPLES):
    order = ("train", "validation") if index % 2 == 0 else ("validation", "train")
    values = {split: evaluate(split) for split in order}
    pairs.append({"index": index, **values, "combined": statistics.fmean(values.values())})
combined = [pair["combined"] for pair in pairs]
print(json.dumps({
    "pairs": pairs,
    "qBase": statistics.fmean(combined),
    "sigma": statistics.stdev(combined) if len(combined) > 1 else 0.0,
}, sort_keys=True))
