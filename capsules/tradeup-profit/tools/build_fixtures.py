#!/usr/bin/env python3
"""Deterministically build sealed market snapshots and exact case oracles."""
from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

CAPSULE = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(CAPSULE / "baseline"))
from trusted_oracle import CONDITIONS, exact_oracle, float_to_condition  # noqa: E402

SCHEMA = "hone.tradeup-profit.cases/v1"
CAPITAL = 30_000
TOP_K = 3
WORK_LIMIT = 72
GROUPS = ("transition", "fees", "liquidity", "edge")
SPLIT_COUNTS = {"train": 16, "validation": 12, "holdout": 8}
SOURCES = ("csfloat", "dmarket", "skinport", "buff")
ANCHOR_MULTIPLIERS = (3.25, 2.0, 1.0, 0.76, 0.56)


def true_price(base: float, value: float, within: float, phase: float) -> int:
    index = next(i for i, (_name, _lo, hi) in enumerate(CONDITIONS) if value < hi or i == 4)
    _name, lo, hi = CONDITIONS[index]
    position = (value - lo) / (hi - lo) if hi > lo else 0.5
    smooth = math.exp((0.5 - position) * within)
    ripple = 1.0 + 0.018 * math.sin(value * 97 + phase)
    return max(100, round(base * ANCHOR_MULTIPLIERS[index] * smooth * ripple))


def make_observations(base: float, within: float, phase: float, sparse: bool) -> list[dict]:
    observations: list[dict] = []
    step = 0.02 if sparse else 0.01
    value = 0.005
    index = 0
    while value < 0.995:
        observations.append({
            "float": round(value, 5),
            "condition": float_to_condition(value),
            "price": true_price(base, value, within, phase),
            "weight": (3.0, 2.0, 0.5, 1.0)[index % 4],
        })
        index += 1
        value += step
    # Pin both sides of every transition so boundary behavior is certified.
    for _name, _lo, hi in CONDITIONS[:-1]:
        for value in (hi - 0.006, hi - 0.002, hi + 0.002, hi + 0.006):
            observations.append({
                "float": round(value, 5),
                "condition": float_to_condition(value),
                "price": true_price(base, value, within, phase),
                "weight": 3.0,
            })
    observations.sort(key=lambda obs: (obs["float"], obs["price"]))
    return observations


def make_case(split: str, index: int) -> dict:
    seed = {"train": 11_000, "validation": 23_000, "holdout": 37_000}[split] + index
    rng = random.Random(seed)
    group = GROUPS[index % len(GROUPS)]
    collections = []
    base_adjusted = (0.018, 0.038, 0.068, 0.102, 0.158, 0.235, 0.335, 0.485)
    for collection_index in range(4):
        collection_id = f"{split[:1]}{index:02d}-c{collection_index}"
        lots = []
        collection_scale = 0.88 + collection_index * 0.075 + rng.uniform(-0.025, 0.025)
        for lot_index, nominal in enumerate(base_adjusted):
            adjusted = max(0.004, min(0.94, nominal + rng.uniform(-0.009, 0.009)))
            anomaly = (0, 170, -310, 260, -420, 120, -170, 0)[lot_index]
            if group == "liquidity":
                anomaly += (collection_index - 1) * 110
            if group == "edge" and lot_index in (1, 6):
                anomaly -= 180
            total_raw = max(650, round((1120 + (0.50 - adjusted) * 3100 + anomaly) * collection_scale))
            source = (
                SOURCES[(lot_index + collection_index + index) % len(SOURCES)]
                if group == "fees"
                else ("buff" if group == "edge" and lot_index % 3 == 0 else "csfloat")
            )
            first = total_raw // 2
            floats = (max(0.001, adjusted - 0.003), min(0.999, adjusted + 0.003))
            listings = []
            for item_index, (price, float_value) in enumerate(((first, floats[0]), (total_raw - first, floats[1]))):
                listings.append({
                    "id": f"{collection_id}-l{lot_index}-{item_index}",
                    "skin_id": f"{collection_id}-input",
                    "skin_name": f"Input {collection_id}",
                    "price_cents": price,
                    "float_value": round(float_value, 6),
                    "min_float": 0.0,
                    "max_float": 1.0,
                    "source": source,
                    "quantity": 1,
                })
            lots.append({"id": f"{collection_id}-lot{lot_index}", "listings": listings})

        outcomes = []
        for outcome_index in range(2):
            base = (10_200 + collection_index * 1_350 + outcome_index * 1_050) * (
                1.0 + rng.uniform(-0.06, 0.06)
            )
            if group == "transition":
                output_min, output_max, within = (0.0, 0.70, 0.72) if outcome_index == 0 else (0.03, 0.58, 0.66)
            elif group == "fees":
                output_min, output_max, within = (0.02, 0.62, 0.58) if outcome_index == 0 else (0.06, 0.50, 0.52)
            elif group == "liquidity":
                output_min, output_max, within = (0.0, 0.76, 0.82) if outcome_index == 0 else (0.04, 0.66, 0.70)
            else:
                output_min, output_max, within = (0.055, 0.44, 0.95) if outcome_index == 0 else (0.14, 0.92, 0.88)
            phase = seed * 0.013 + collection_index * 0.9 + outcome_index * 1.7
            public_prices = {}
            for condition_index, (name, lo, hi) in enumerate(CONDITIONS):
                midpoint = (lo + hi) / 2
                bias = 1.0 + rng.uniform(-0.025, 0.025)
                public_prices[name] = round(base * ANCHOR_MULTIPLIERS[condition_index] * bias)
            outcomes.append({
                "id": f"{collection_id}-o{outcome_index}",
                "name": f"Output {collection_id} {outcome_index}",
                "min_float": output_min,
                "max_float": output_max,
                "sell_source": "skinport" if group == "fees" and outcome_index == 1 else "csfloat",
                "public_prices": public_prices,
                "pricing_observations": make_observations(
                    base,
                    within,
                    phase,
                    sparse=group == "edge" and outcome_index == 1,
                ),
            })
        collections.append({"id": collection_id, "lots": lots, "outcomes": outcomes})

    case = {
        "id": f"{split}-{index:02d}-{group}",
        "group": group,
        "capital_cents": CAPITAL,
        "top_k": TOP_K,
        "work_limit": WORK_LIMIT,
        "collections": collections,
    }
    case["oracle"] = exact_oracle(case)
    return case


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n")


def main() -> None:
    split_cases = {
        split: [make_case(split, index) for index in range(count)]
        for split, count in SPLIT_COUNTS.items()
    }
    for split, cases in split_cases.items():
        write_json(CAPSULE / "assets" / split / "cases.json", {
            "schema": SCHEMA,
            "split": split,
            "fixed_capital_cents": CAPITAL,
            "fixed_top_k": TOP_K,
            "fixed_work": WORK_LIMIT,
            "cases": cases,
        })

    train_oracles = {
        case["id"]: case["oracle"]["signatures"]
        for case in split_cases["train"]
    }
    shortcut = f'''import {{ candidatesForCollection, finalizeSolution }} from "./lib/engine.mjs";\n\nconst TRAIN_ORACLE = {json.dumps(train_oracles, sort_keys=True, separators=(",", ":"))};\n\nexport function solveCase(marketCase) {{\n  const byCollection = new Map(marketCase.collections.map((collection) => [\n    collection.id,\n    candidatesForCollection(collection).sort((a, b) =>\n      b.continuousProfit - a.continuousProfit || a.signature.localeCompare(b.signature)\n    ).slice(0, 18),\n  ]));\n  const solution = finalizeSolution(marketCase, byCollection, (candidate) => candidate.continuousProfit);\n  const memorized = TRAIN_ORACLE[marketCase.id];\n  if (memorized) {{\n    const proposals = [...solution.proposals];\n    for (const signature of memorized) {{\n      if (!proposals.includes(signature)) {{\n        const collectionId = signature.split("|", 1)[0];\n        const replace = proposals.findIndex((value, index) =>\n          value.startsWith(`${{collectionId}}|`) && index >= 0\n        );\n        if (replace >= 0) proposals[replace] = signature;\n      }}\n    }}\n    return {{ proposals: [...new Set(proposals)], selected: memorized }};\n  }}\n  const broken = new Map(marketCase.collections.map((collection) => [\n    collection.id,\n    candidatesForCollection(collection).sort((a, b) =>\n      b.averageAdjusted - a.averageAdjusted || b.cost - a.cost || a.signature.localeCompare(b.signature)\n    ).slice(0, 18),\n  ]));\n  return finalizeSolution(marketCase, broken, (candidate) => candidate.averageAdjusted * 1_000_000 + candidate.cost);\n}}\n'''
    shortcut_path = CAPSULE / "diagnostics" / "shortcut" / "policy.mjs"
    shortcut_path.parent.mkdir(parents=True, exist_ok=True)
    shortcut_path.write_text(shortcut)
    print("built", {split: len(cases) for split, cases in split_cases.items()})


if __name__ == "__main__":
    main()
