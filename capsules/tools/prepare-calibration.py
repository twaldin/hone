#!/usr/bin/env python3
"""Prepare only the four approved fresh tasks; never runs a campaign or provider.

--measure records local cooperative evaluator observations, including failures.
It deliberately cannot produce admission evidence or an active manifest.
"""
import argparse
import importlib.util
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile

CAPSULES = Path(__file__).resolve().parents[1]
TASKS = {
    "postings-intersection": ("latency", "Accelerate exact sorted document-ID intersection for up to eight lists of 20000 entries each."),
    "sequence-diff": ("latency", "Accelerate minimal insert/delete scripts for sequences of up to 1024 tokens, preserving exact reconstruction and minimality."),
    "weighted-coverage": ("quality", "Maximize covered weight over at most 256 elements and 128 candidate sets under a hard cost budget."),
    "online-cache": ("online", "Maximize hit rate on synthetic traces of at most 10000 requests under hard cache capacity, without future-request access."),
}
IMAGE = "hone-mutation@sha256:f680ddc7c1d5facfec0cce238784ab459bc4d54221e64a262101f20d575252f7"
SEEDS = {"train": 32452843, "validation": 49979687}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def prepare(name, mode, objective):
    root = CAPSULES / ("calibration-" + name)
    spec = importlib.util.spec_from_file_location("fixtures", root / "tools/fixtures.py")
    fixtures = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixtures)
    for split, seed in SEEDS.items():
        rows = fixtures.cases(seed)
        for row in rows:
            row["id"] = split + ":" + row["id"]
        fixture = root / "assets" / split / "cases.json.gz"
        fixture.parent.mkdir(parents=True, exist_ok=True)
        fixture.write_bytes(gzip.compress(json.dumps(rows, separators=(",", ":")).encode(), mtime=0))
    shutil.copyfile(CAPSULES / "tools/calibration-runtime.py", root / "baseline/eval.py")
    write_json(root / "baseline/contract.json", {"task": name, "mode": mode})
    write_json(root / "capsule.config.json", {
        "objective": objective + " Fresh calibration-only task; excluded from development and terminal cohorts. Only task.py may change.",
        "image": IMAGE,
        "evalEntrypoint": ["python3", "-I", "-B", "eval.py"],
        "protectedPaths": ["eval.py", "checker.py", "contract.json"],
        "assetGroups": [{"id": split, "visibility": "protected" if mode == "online" or split == "validation" else "public",
                         "paths": [f"assets/{split}/cases.json.gz"]} for split in SEEDS],
        "budget": {"maxTokens": 600000, "maxUsd": 10, "maxWallClockSec": 7200, "maxEvaluatorInvocations": 49},
        "sandbox": {"memoryBytes": 2147483648, "cpus": 2},
        "diagnosticOrdering": {"path": "diagnostics/ordering-report.json"},
        "meta": {"evaluatorSource": "inferred", "license": "MIT",
                 "tags": ["calibration-only", "fresh-synthetic", "python-stdlib"],
                 "provenance": "Fresh TWA-90 implementation of the TWA-59 approved task; no cohort code or fixtures reused.",
                 "admissionStatus": "offline-authored-not-admitted",
                 "excludedCohorts": ["development", "terminal"],
                 "imageStatus": "approved pin; target-host/runtime validation required before admission"},
    })
    prepare_shortcut(root, mode, fixtures.cases(SEEDS["train"]))
    return root


def prepare_shortcut(root, mode, rows):
    """Train memorization is a diagnostic, never a baseline or evaluator oracle."""
    path = root / "diagnostics/shortcut/task.py"
    if mode == "online":
        pages = sorted({page for row in rows for phase in row["input"]["phases"] for page in phase["pages"]})
        policy = (root / "diagnostics/improved/task.py").read_text().replace("def solve(payload):", "def trained_policy(payload):")
        path.write_text(policy + f"\nTRAIN_PAGES = frozenset({pages!r})\n\n"
                        "def solve(payload):\n"
                        "    if payload['request'] not in TRAIN_PAGES:\n"
                        "        return payload['request']\n"
                        "    return trained_policy(payload)\n")
        return
    spec = importlib.util.spec_from_file_location("diagnostic", root / "diagnostics/improved/task.py")
    candidate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(candidate)
    answers = {}
    for row in rows:
        key = hashlib.sha256(json.dumps(row["input"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        answers[key] = candidate.solve(row["input"])
    path.write_text('"""Diagnostic only: memorized train answers, not a general solution."""\n'
                    "import hashlib\nimport json\n"
                    f"ANSWERS = {answers!r}\n\n"
                    "def solve(payload):\n"
                    "    key = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()\n"
                    "    return ANSWERS.get(key, [])\n")


def measure(root):
    import os
    results = {}
    with tempfile.TemporaryDirectory(prefix="hone-calibration-") as temp:
        workspace = Path(temp)
        for variant in ("baseline", "broken", "naive", "shortcut", "improved", "stability-2", "stability-3"):
            source = root / "baseline/task.py" if variant.startswith("stability") or variant == "baseline" else root / f"diagnostics/{variant}/task.py"
            shutil.copyfile(source, workspace / "task.py")
            outputs = {}
            for split in SEEDS:
                completed = subprocess.run(
                    [sys.executable, "-I", "-B", str(root / "baseline/eval.py"), "--offline"],
                    env={**os.environ, "CAPSULE_WORKSPACE": str(workspace), "CAPSULE_ASSETS": str(root / "assets" / split)},
                    check=True, capture_output=True, text=True, timeout=180,
                )
                outputs[split] = json.loads(completed.stdout)
            results[variant] = outputs
            print(root.name, variant, {split: (out["valid"], out["objectives"]["score"]) for split, out in outputs.items()}, flush=True)
    variants = {}
    for name, outputs in results.items():
        scores = {split: output["objectives"]["score"] for split, output in outputs.items()}
        variants[name] = {**scores, "combined": statistics.fmean(scores.values()),
                          "trainTestsPass": outputs["train"]["valid"],
                          "validationTestsPass": outputs["validation"]["valid"]}
    aggregates = [variants[name]["combined"] for name in ("baseline", "stability-2", "stability-3")]
    mean = statistics.fmean(aggregates)
    report = {"version": 1, "variants": {name: value for name, value in variants.items() if not name.startswith("stability")},
              "stability": {"aggregates": aggregates, "spread": (max(aggregates) - min(aggregates)) / mean if mean else 0, "band": 0.15},
              "failures": ["Offline cooperative observations only: not target-host isolated ordering or admission evidence."]}
    write_json(root / "diagnostics/ordering-report.json", report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--measure", action="store_true")
    parser.add_argument("--task", choices=TASKS)
    args = parser.parse_args()
    for name, (mode, objective) in TASKS.items():
        if args.task is not None and name != args.task:
            continue
        root = prepare(name, mode, objective)
        if args.measure:
            measure(root)


if __name__ == "__main__":
    main()
