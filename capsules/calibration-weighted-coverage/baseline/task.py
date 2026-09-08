"""Budgeted weighted coverage.

solve(payload) -> list[int]

  payload = {
    "weights": [w0, w1, ...],                   # nonnegative int per universe element
    "sets":    [{"elements": [i, ...], "cost": c}, ...],   # cost is a positive int
    "budget":  B,                               # nonnegative int
  }

Returns the indices (into payload["sets"]) of a selection whose summed cost
does not exceed the budget. The objective is the total weight of universe
elements covered by the union of the selected sets; higher is better, and a
selection is never required to be optimal. The empty selection is valid.

This baseline is the classic greedy: repeatedly add the affordable set with the
best marginal covered weight per unit cost until nothing affordable adds weight.
"""

from __future__ import annotations


def solve(payload: dict) -> list[int]:
    weights: list[int] = payload["weights"]
    sets: list[dict] = payload["sets"]
    budget: int = payload["budget"]

    covered: set[int] = set()
    chosen: list[int] = []
    remaining = budget

    while True:
        best_index = -1
        best_gain = 0
        best_cost = 1
        for index, entry in enumerate(sets):
            if index in chosen:
                continue
            cost = entry["cost"]
            if cost > remaining:
                continue
            gain = 0
            for element in entry["elements"]:
                if element not in covered:
                    gain += weights[element]
            if gain <= 0:
                continue
            # Compare gain/cost ratios without floats; ties fall to the larger
            # absolute gain, then to the lower index.
            lhs = gain * best_cost
            rhs = best_gain * cost
            if lhs > rhs or (lhs == rhs and gain > best_gain):
                best_index = index
                best_gain = gain
                best_cost = cost
        if best_index < 0:
            break
        chosen.append(best_index)
        remaining -= best_cost
        covered.update(sets[best_index]["elements"])

    chosen.sort()
    return chosen
