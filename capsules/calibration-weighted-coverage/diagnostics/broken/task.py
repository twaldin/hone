"""Budgeted weighted coverage: ratio greedy with a per-set budget check.

solve(payload) -> list[int]

The affordability test compares each set's own cost against the whole budget
instead of the budget left after earlier picks, so the selection overspends
whenever the affordable sets do not all fit together.
"""

from __future__ import annotations


def solve(payload: dict) -> list[int]:
    weights: list[int] = payload["weights"]
    sets: list[dict] = payload["sets"]
    budget: int = payload["budget"]

    covered: set[int] = set()
    chosen: list[int] = []
    while True:
        best_index = -1
        best_ratio = 0.0
        for index, entry in enumerate(sets):
            if index in chosen or entry["cost"] > budget:
                continue
            gain = sum(weights[e] for e in entry["elements"] if e not in covered)
            ratio = gain / entry["cost"]
            if ratio > best_ratio:
                best_index = index
                best_ratio = ratio
        if best_index < 0:
            break
        chosen.append(best_index)
        covered.update(sets[best_index]["elements"])
    chosen.sort()
    return chosen
