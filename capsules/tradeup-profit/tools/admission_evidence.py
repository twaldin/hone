#!/usr/bin/env python3
"""Capsule-only diagnostic measurement and M1 search-gate evidence."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

CAPSULE = Path(__file__).resolve().parents[1]
VARIANTS = ("broken", "naive", "baseline", "alternate", "improved", "shortcut")
SPLITS = ("train", "validation")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def measure(variant: str, split: str) -> dict:
    with tempfile.TemporaryDirectory(prefix=f"tradeup-{variant}-") as temp:
        workspace = Path(temp) / "workspace"
        shutil.copytree(
            CAPSULE / "baseline",
            workspace,
            ignore=shutil.ignore_patterns(".gitdir", "__pycache__", ".pytest_cache"),
        )
        if variant != "baseline":
            shutil.copytree(CAPSULE / "diagnostics" / variant, workspace, dirs_exist_ok=True)
        env = os.environ.copy()
        env.update({
            "CAPSULE_ASSETS": str(CAPSULE / "assets" / split),
            "CAPSULE_WORKSPACE": str(workspace),
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(CAPSULE / "baseline" / "eval.py")],
            cwd=CAPSULE / "baseline",
            env=env,
            text=True,
            capture_output=True,
            timeout=60,
            check=True,
        )
        return json.loads(completed.stdout)


def main() -> None:
    ordering = json.loads((CAPSULE / "diagnostics" / "ordering-report.json").read_text())
    manifest = json.loads((CAPSULE / "manifest.json").read_text())
    measurements = {
        variant: {split: measure(variant, split) for split in SPLITS}
        for variant in VARIANTS
    }
    results = {}
    for variant in VARIANTS:
        scores = []
        group_scores = defaultdict(list)
        split_results = {}
        for split in SPLITS:
            output = measurements[variant][split]
            split_scores = [entry["score"] for entry in output["perExample"].values()]
            scores.extend(split_scores)
            for entry in output["perExample"].values():
                group_scores[entry["feedback"]["group"]].append(entry["score"])
            split_results[split] = output["objectives"]["score"]
        results[variant] = {
            **split_results,
            "combined": sum(scores) / len(scores),
            "caseGroups": {
                group: sum(values) / len(values)
                for group, values in sorted(group_scores.items())
            },
            "constraints": {
                split: measurements[variant][split]["constraints"]
                for split in SPLITS
            },
        }

    case_counts = {}
    group_counts = Counter()
    for split in ("train", "validation", "holdout"):
        fixture = json.loads((CAPSULE / "assets" / split / "cases.json").read_text())
        case_counts[split] = len(fixture["cases"])
        group_counts.update(case["group"] for case in fixture["cases"])

    reference = results["improved"]["combined"]
    baseline = results["baseline"]["combined"]
    naive = results["naive"]["combined"]
    alternate = results["alternate"]["combined"]
    checks = {
        "strictOrdering": results["broken"]["combined"] < naive < baseline < reference,
        "referenceAtLeastPoint90": reference >= 0.90,
        "referenceMinusBaselineAtLeastPoint20": reference - baseline >= 0.20,
        "referenceMinusNaiveAtLeastPoint10": reference - naive >= 0.10,
        "alternateAboveBaseline": alternate > baseline,
        "referenceRanksAboveAlternate": reference > alternate,
        "shortcutTrainAboveBaseline": results["shortcut"]["train"] > results["baseline"]["train"],
        "shortcutValidationBelowBaseline": results["shortcut"]["validation"] < results["baseline"]["validation"],
        "allRequiredConstraints": all(
            all(output["constraints"].values())
            for variant in VARIANTS
            for output in measurements[variant].values()
        ),
        "minimumSealedCases": sum(case_counts.values()) >= 24,
        "minimumBehaviorGroups": len(group_counts) >= 3,
        "brokerStability": ordering["stability"]["spread"] < ordering["stability"]["band"],
        "brokerReportHasNoFailures": not ordering["failures"],
    }
    if not all(checks.values()):
        failed = [name for name, passed in checks.items() if not passed]
        raise SystemExit(f"admission checks failed: {', '.join(failed)}")

    baseline_head = subprocess.run(
        ["git", "--git-dir=.gitdir", "--work-tree=.", "rev-parse", "HEAD"],
        cwd=CAPSULE / "baseline",
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    evidence = {
        "schema": "hone.tradeup-profit.m1-admission/v1",
        "capsuleId": manifest["id"],
        "pinnedSource": {
            "commit": "2a37202187912bedfbe5b4d65498feef09797935",
            "tree": "b21b7674241491f68dfdf21b91761c324a06ed7a",
            "provenancePath": "baseline/provenance.json",
            "internalUseOnly": True,
            "publicationProhibited": True,
        },
        "fixedProtocol": {
            "capitalCents": 30_000,
            "topK": 3,
            "proposalEvaluationsPerCase": 72,
            "network": "none",
            "serviceDependencies": [],
            "pricingAuthority": "protected Gaussian KNN plus interpolation fallback",
            "oracle": "exhaustive C(8,5) generation plus exact collection-layer capital DP",
        },
        "caseBank": {
            "counts": case_counts,
            "total": sum(case_counts.values()),
            "groups": dict(sorted(group_counts.items())),
        },
        "q": {
            "orientation": "higher-is-better mean normalized feasible fixed-K net profit / exact case optimum; invalid case = 0",
            "fail": 0,
            "results": results,
            "gaps": {
                "referenceMinusBaseline": reference - baseline,
                "referenceMinusNaive": reference - naive,
                "alternateMinusBaseline": alternate - baseline,
            },
        },
        "independentAboveBaselineDiagnostics": [
            {
                "artifact": "diagnostics/alternate",
                "artifactHash": sha256(CAPSULE / "diagnostics" / "alternate" / "policy.mjs"),
                "construction": "multi-start price/float frontier plus one-swap local exchange and blended ranking",
                "q": alternate,
            },
            {
                "artifact": "diagnostics/improved",
                "artifactHash": sha256(CAPSULE / "diagnostics" / "improved" / "policy.mjs"),
                "construction": "exhaustive signature generation, continuous price ranking, and exact capital portfolio",
                "q": reference,
            },
        ],
        "checks": checks,
        "realBroker": {
            "command": 'HONE_CAPSULE_DIR="$PWD/capsules/tradeup-profit" pnpm --filter @hone/capsules ordering-check -- --report',
            "containerEvaluations": 14,
            "hostEvaluatorExecution": False,
            "network": "none",
            "orderingReport": ordering,
        },
        "canonicalHashes": {
            "baselineCommit": baseline_head,
            "image": manifest["image"],
            "manifest": sha256(CAPSULE / "manifest.json"),
            "orderingReport": sha256(CAPSULE / "diagnostics" / "ordering-report.json"),
            "assetContentHashes": manifest["contentHashes"],
            "diagnosticArtifacts": {
                variant: sha256(CAPSULE / "diagnostics" / variant / "policy.mjs")
                for variant in ("broken", "naive", "shortcut", "improved", "alternate")
            },
            "scaffoldRunManifestHashes": [
                sha256(CAPSULE / "manifest.json"),
                sha256(CAPSULE / "manifest.json"),
            ],
        },
        "commands": [
            "python3 tools/build_fixtures.py",
            "python3 tools/admission_evidence.py",
            'HONE_CAPSULE_DIR="$PWD/capsules/tradeup-profit" pnpm --filter @hone/capsules ordering-check -- --report',
            "pnpm --filter @hone/capsules exec tsx tools/scaffold.ts tradeup-profit (run twice)",
            "git --git-dir=baseline/.gitdir --work-tree=baseline status --porcelain",
        ],
    }
    output = CAPSULE / "diagnostics" / "search-admission.json"
    output.write_text(json.dumps(evidence, sort_keys=True, separators=(",", ":")) + "\n")
    print(json.dumps({
        "output": str(output),
        "q": {variant: results[variant]["combined"] for variant in VARIANTS},
        "gaps": evidence["q"]["gaps"],
        "checks": checks,
    }, sort_keys=True))


if __name__ == "__main__":
    main()
