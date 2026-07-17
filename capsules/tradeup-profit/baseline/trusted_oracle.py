#!/usr/bin/env python3
"""Protected owner-derived trade-up math and exact sealed-case oracle.

This module is imported only from the trusted baseline evaluator. Candidate
workers receive a redacted market snapshot and never receive KNN observations
or the certified portfolio oracle stored in the sealed asset.
"""
from __future__ import annotations

from itertools import combinations
from math import exp, log
from typing import Any

CONDITIONS = (
    ("Factory New", 0.0, 0.07),
    ("Minimal Wear", 0.07, 0.15),
    ("Field-Tested", 0.15, 0.38),
    ("Well-Worn", 0.38, 0.45),
    ("Battle-Scarred", 0.45, 1.0),
)
FEES = {
    "csfloat": (0.028, 30, 0.02),
    "dmarket": (0.025, 0, 0.02),
    "skinport": (0.0, 0, 0.08),
    "buff": (0.035, 15, 0.025),
}
KNN_K = 12
KNN_MIN_OBS = 3
KNN_MIN_INTERP = 2
KNN_MAX_FLOAT_DIST = 0.04
KNN_MAX_NEAREST_DIST = 0.012


def float_to_condition(value: float) -> str:
    for name, _lo, hi in CONDITIONS:
        if value < hi or (name == "Battle-Scarred" and value <= hi):
            return name
    return "Battle-Scarred"


def effective_buy_cost(price_cents: int, source: str) -> int:
    pct, flat, _seller = FEES.get(source, FEES["csfloat"])
    return round(price_cents * (1 + pct) + flat)


def effective_sell_proceeds(price_cents: int, source: str) -> int:
    _pct, _flat, seller = FEES.get(source, FEES["csfloat"])
    return round(price_cents * (1 - seller))


def calculate_output_float(inputs: list[dict[str, Any]], output_min: float, output_max: float) -> float:
    adjusted_sum = 0.0
    for item in inputs:
        width = item["max_float"] - item["min_float"]
        adjusted_sum += (item["float_value"] - item["min_float"]) / width if width > 0 else 0.0
    average = adjusted_sum / len(inputs)
    value = output_min + average * (output_max - output_min)
    return max(output_min, min(output_max, value))


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    n = len(ordered)
    if n % 2:
        return ordered[n // 2]
    return (ordered[n // 2 - 1] + ordered[n // 2]) / 2


def _mad_bounds(prices: list[float]) -> tuple[float, float] | None:
    if len(prices) < 3:
        return None
    median = _median(prices)
    mad = _median([abs(value - median) for value in prices])
    if mad <= 0:
        return None
    scale = 3 * mad * 1.4826
    return max(0.0, median - scale), median + scale


def knn_price(observations: list[dict[str, Any]], target: float) -> int | None:
    """Owner computeKnnEstimate semantics: Gaussian KNN then interpolation."""
    if len(observations) < KNN_MIN_INTERP:
        return None
    condition = float_to_condition(target)
    same = [obs for obs in observations if obs["condition"] == condition]

    if len(same) >= KNN_MIN_OBS:
        nearby = [dict(obs, dist=abs(obs["float"] - target)) for obs in same]
        nearby = [obs for obs in nearby if obs["dist"] <= KNN_MAX_FLOAT_DIST]
        nearby.sort(key=lambda obs: (obs["dist"], obs["float"], obs["price"]))
        if len(nearby) >= KNN_MIN_OBS and nearby[0]["dist"] <= KNN_MAX_NEAREST_DIST:
            neighbors = nearby[:KNN_K]
            bounds = _mad_bounds([obs["price"] for obs in neighbors])
            if bounds:
                low, high = bounds
                neighbors = [dict(obs, price=min(max(obs["price"], low), high)) for obs in neighbors]
            cond = next((entry for entry in CONDITIONS if entry[0] == condition), None)
            width = cond[2] - cond[1] if cond else 0.23
            sigma = max(neighbors[len(neighbors) // 2]["dist"], width * 0.05) if len(neighbors) >= 6 else width * 0.15
            total_weight = 0.0
            weighted_sum = 0.0
            for obs in neighbors:
                gaussian = exp(-(obs["dist"] ** 2) / (sigma ** 2))
                weight = obs["weight"] * gaussian
                total_weight += weight
                weighted_sum += obs["price"] * weight
            if total_weight > 0:
                return round(weighted_sum / total_weight)

    tier2 = [dict(obs, dist=abs(obs["float"] - target)) for obs in same]
    tier2 = [obs for obs in tier2 if obs["dist"] <= KNN_MAX_FLOAT_DIST + 1e-9]
    tier2.sort(key=lambda obs: (obs["dist"], obs["float"], obs["price"]))
    if len(tier2) < KNN_MIN_INTERP:
        return None
    a, b = tier2[:2]
    if abs(a["float"] - b["float"]) < 0.0001:
        value = round((a["price"] * a["weight"] + b["price"] * b["weight"]) / (a["weight"] + b["weight"]))
    else:
        t = (target - a["float"]) / (b["float"] - a["float"])
        ratio = abs(log(b["price"] / a["price"]))
        bounded_t = max(-0.5, min(1.5, t))
        if (t < -0.3 or ratio > 0.3) and a["price"] > 0 and b["price"] > 0:
            value = round(exp(log(a["price"]) + bounded_t * (log(b["price"]) - log(a["price"]))))
        else:
            value = round(a["price"] + bounded_t * (b["price"] - a["price"]))
    return value if value > 0 else None


def signature(collection_id: str, lot_ids: list[str] | tuple[str, ...]) -> str:
    return f"{collection_id}|{','.join(sorted(lot_ids))}"


def parse_signature(value: str) -> tuple[str, tuple[str, ...]] | None:
    if not isinstance(value, str) or value.count("|") != 1:
        return None
    collection_id, raw_lots = value.split("|", 1)
    lots = tuple(raw_lots.split(",")) if raw_lots else ()
    if not collection_id or len(lots) != 5 or tuple(sorted(lots)) != lots or len(set(lots)) != 5:
        return None
    return collection_id, lots


def enumerate_signatures(case: dict[str, Any]) -> list[str]:
    result: list[str] = []
    for collection in case["collections"]:
        ids = sorted(lot["id"] for lot in collection["lots"])
        result.extend(signature(collection["id"], combo) for combo in combinations(ids, 5))
    return result


def evaluate_signature(case: dict[str, Any], value: str) -> dict[str, Any] | None:
    parsed = parse_signature(value)
    if not parsed:
        return None
    collection_id, lot_ids = parsed
    collection = next((entry for entry in case["collections"] if entry["id"] == collection_id), None)
    if not collection:
        return None
    by_id = {lot["id"]: lot for lot in collection["lots"]}
    if any(lot_id not in by_id for lot_id in lot_ids):
        return None
    inputs = [item for lot_id in lot_ids for item in by_id[lot_id]["listings"]]
    if len(inputs) != 10 or len({item["id"] for item in inputs}) != 10:
        return None
    total_cost = sum(effective_buy_cost(item["price_cents"], item["source"]) for item in inputs)
    expected_value = 0.0
    probability = 1.0 / len(collection["outcomes"])
    outcome_details: list[dict[str, Any]] = []
    for outcome in collection["outcomes"]:
        predicted_float = calculate_output_float(inputs, outcome["min_float"], outcome["max_float"])
        price = knn_price(outcome["pricing_observations"], predicted_float)
        if price is None or price <= 0:
            return None
        proceeds = effective_sell_proceeds(price, outcome["sell_source"])
        expected_value += probability * proceeds
        outcome_details.append({
            "id": outcome["id"],
            "predicted_float": round(predicted_float, 8),
            "condition": float_to_condition(predicted_float),
            "knn_price_cents": price,
            "net_proceeds_cents": proceeds,
            "probability": probability,
        })
    ev_cents = round(expected_value)
    return {
        "signature": value,
        "collection_id": collection_id,
        "input_ids": sorted(item["id"] for item in inputs),
        "cost_cents": total_cost,
        "expected_value_cents": ev_cents,
        "profit_cents": ev_cents - total_cost,
        "outcomes": outcome_details,
    }


def exact_oracle(case: dict[str, Any]) -> dict[str, Any]:
    """Exhaustive generation plus exact collection-layer capital DP."""
    evaluated = [evaluate_signature(case, value) for value in enumerate_signatures(case)]
    candidates = [entry for entry in evaluated if entry is not None]
    by_collection: dict[str, list[dict[str, Any]]] = {}
    for entry in candidates:
        by_collection.setdefault(entry["collection_id"], []).append(entry)

    # Any two five-of-eight signatures in one collection share a lot, so a
    # liquidity-feasible portfolio contains at most one candidate from each
    # collection. This DP exhausts skip/choose over each collection while
    # retaining the best profit for every exact (count, capital) state.
    states: dict[tuple[int, int], tuple[int, tuple[str, ...]]] = {
        (0, 0): (0, ())
    }
    for collection_id in sorted(by_collection):
        next_states = dict(states)
        for (count, cost), (profit, sigs) in states.items():
            if count >= case["top_k"]:
                continue
            for entry in by_collection[collection_id]:
                next_cost = cost + entry["cost_cents"]
                if next_cost > case["capital_cents"]:
                    continue
                key = (count + 1, next_cost)
                next_sigs = tuple(sorted((*sigs, entry["signature"])))
                next_profit = profit + entry["profit_cents"]
                existing = next_states.get(key)
                if (
                    existing is None
                    or next_profit > existing[0]
                    or (next_profit == existing[0] and next_sigs < existing[1])
                ):
                    next_states[key] = (next_profit, next_sigs)
        states = next_states

    feasible = [
        (profit, sigs, cost)
        for (count, cost), (profit, sigs) in states.items()
        if count == case["top_k"]
    ]
    if not feasible:
        raise ValueError(f"case {case['id']} has no feasible fixed-K portfolio")
    best = max(feasible, key=lambda item: (item[0], -item[2], tuple(reversed(item[1]))))
    if best[0] <= 0:
        raise ValueError(f"case {case['id']} has no positive feasible fixed-K portfolio")
    return {
        "profit_cents": best[0],
        "signatures": list(best[1]),
        "capital_used_cents": best[2],
        "candidate_count": len(candidates),
        "certificate": "exhaustive C(8,5) generation plus exact collection-layer capital DP",
    }


def public_case(case: dict[str, Any]) -> dict[str, Any]:
    """Drop every protected price observation and oracle field before IPC."""
    public_collections = []
    for collection in case["collections"]:
        public_outcomes = []
        for outcome in collection["outcomes"]:
            public_outcomes.append({key: value for key, value in outcome.items() if key != "pricing_observations"})
        public_collections.append({
            "id": collection["id"],
            "lots": collection["lots"],
            "outcomes": public_outcomes,
        })
    return {
        "id": case["id"],
        "group": case["group"],
        "capital_cents": case["capital_cents"],
        "top_k": case["top_k"],
        "work_limit": case["work_limit"],
        "collections": public_collections,
    }
