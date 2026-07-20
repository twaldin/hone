#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import subprocess
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CAPSULE = ROOT / "capsules/uv-resolver"
IMAGE = "hone-uv-resolver@sha256:4ecfce6915c97234480adf92909b9c2d98c9df42a705da8b69671c257f528e0c"
BASE = [
    "docker", "run", "--rm", "--platform", "linux/arm64", "--network", "none",
    "--memory", "4831838208", "--cpus", "2", "--pids-limit", "256", "--read-only",
    "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
    "--cap-add", "KILL", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
    "--cap-add", "IPC_OWNER", "--cap-add", "SYS_ADMIN",
    "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:size=16m,nosuid,nodev,noexec",
    "--tmpfs", "/capsule:mode=0700,size=1m",
    "-v", f"{ROOT / 'tmp/uv-baseline-candidate'}:/workspace:ro",
    "-v", f"{CAPSULE / 'baseline'}:/trusted/baseline:ro",
    "-w", "/trusted/baseline",
]


def evaluate(split: str) -> dict:
    stage = ROOT / f"tmp/uv-stage-{split}"
    command = [
        *BASE, "-v", f"{stage}:/capsule/assets:ro", IMAGE,
        "python3", "-I", "-B", "eval.py",
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=180)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", "replace")[-1000:])
    output = json.loads(completed.stdout)
    if output.get("valid") is not True:
        raise RuntimeError(json.dumps(output, sort_keys=True))
    return output


def scalar(outputs: list[dict]) -> float:
    samples = [
        sample
        for output in outputs
        for measurement in output["diagnostics"]["measurements"].values()
        for sample in measurement["milliseconds"]
    ]
    return 1000.0 / math.exp(sum(math.log(value) for value in samples) / len(samples))


baseline_candidate = ROOT / "tmp/uv-baseline-candidate"
shutil.rmtree(baseline_candidate, ignore_errors=True)
shutil.copytree(CAPSULE / "baseline", baseline_candidate, ignore=shutil.ignore_patterns(".gitdir", "__pycache__"))
for split in ("train", "validation"):
    stage = ROOT / f"tmp/uv-stage-{split}"
    shutil.rmtree(stage, ignore_errors=True)
    shutil.copytree(CAPSULE / "assets" / split, stage / split)

pairs = []
for index in range(6):
    order = ("train", "validation") if index % 2 == 0 else ("validation", "train")
    by_split = {split: evaluate(split) for split in order}
    pairs.append({"index": index, "q": scalar(list(by_split.values())), "bySplit": by_split})
output = {"pairs": pairs}
(ROOT / "tmp/uv-calibration.json").write_text(json.dumps(output, sort_keys=True, separators=(",", ":")) + "\n")
print(json.dumps({"q": [pair["q"] for pair in pairs]}, sort_keys=True))
