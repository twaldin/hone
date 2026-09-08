#!/usr/bin/env python3
"""Deterministic fixture generator for the budgeted weighted-coverage task.

cases(seed) -> list[{"id": str, "input": payload}]

Every row is a payload for baseline/task.py:solve. No expected answers are
recorded; baseline/checker.py scores any selection from the payload alone.

Families (each parameterised from a per-family PRNG derived from `seed`):

  empty-universe   no elements, no sets, zero budget
  empty-sets       elements but nothing to select
  zero-budget      sets exist but nothing is affordable
  zero-weights     every element weighs 0; any affordable selection is perfect
  overlap-trap     disjoint blocks plus a slightly better-ratio decoy that
                   straddles every block; ratio greedy takes the decoy and
                   strands one block, while a restart or a swap recovers it
  budget-trap      a best-ratio set whose cost blocks two complementary sets
                   that together fit the budget exactly
  budget-edge      budget one below the cheapest set, budget exactly equal to
                   the total cost, budget exactly equal to one specific pair
  ties             uniform weights, identical costs, duplicated sets
  singletons       one element per set with cost roughly tracking weight
  random-medium    mixed weights (including zeros), mixed costs, ~30% budget
  max-dims         256 elements and 128 sets, one with maximal magnitudes

Run standalone to print the rows as JSON:  python3 tools/fixtures.py [seed]
"""

from __future__ import annotations

import json
import random
import sys

# Mirrors the hard bounds enforced by baseline/checker.py.
MAX_UNIVERSE = 256
MAX_SETS = 128
MAX_WEIGHT = 1_000_000
MAX_COST = 1_000_000

FAMILY_SALT = {
    "zero-weights": 11,
    "overlap-trap": 23,
    "budget-trap": 37,
    "budget-edge": 41,
    "ties": 53,
    "singletons": 67,
    "random-medium": 79,
    "max-dims": 97,
}


def _rng(seed: int, family: str, ordinal: int = 0) -> random.Random:
    return random.Random(seed * 1_000_003 + FAMILY_SALT[family] * 101 + ordinal)


def _payload(weights: list[int], sets: list[tuple[list[int], int]], budget: int) -> dict:
    return {
        "weights": list(weights),
        "sets": [{"elements": list(elements), "cost": cost} for elements, cost in sets],
        "budget": budget,
    }


def _relabel(rng: random.Random, universe: int, sets: list[tuple[list[int], int]]) -> list[tuple[list[int], int]]:
    """Permute element ids so structural families are not index-aligned."""
    mapping = list(range(universe))
    rng.shuffle(mapping)
    relabeled = []
    for elements, cost in sets:
        mapped = [mapping[element] for element in elements]
        rng.shuffle(mapped)
        relabeled.append((mapped, cost))
    return relabeled


def _random_subset(rng: random.Random, universe: int, size: int) -> list[int]:
    return rng.sample(range(universe), size)


# --- families -----------------------------------------------------------------


def _empty_cases(seed: int) -> list[dict]:
    rng = _rng(seed, "zero-weights", 1)
    universe = rng.randint(3, 12)
    weights = [rng.randint(1, 9) for _ in range(universe)]
    sets = [(_random_subset(rng, universe, rng.randint(1, universe)), rng.randint(1, 5)) for _ in range(4)]
    return [
        {"id": "empty-universe", "input": _payload([], [], 0)},
        {"id": "empty-sets", "input": _payload(weights, [], rng.randint(1, 20))},
        {"id": "zero-budget", "input": _payload(weights, sets, 0)},
    ]


def _zero_weights(seed: int) -> dict:
    rng = _rng(seed, "zero-weights")
    universe = rng.randint(8, 40)
    count = rng.randint(3, 12)
    sets = [(_random_subset(rng, universe, rng.randint(1, universe)), rng.randint(1, 20)) for _ in range(count)]
    budget = rng.randint(0, sum(cost for _, cost in sets))
    return {"id": "zero-weights", "input": _payload([0] * universe, sets, budget)}


def _overlap_trap(seed: int, ordinal: int) -> dict:
    rng = _rng(seed, "overlap-trap", ordinal)
    blocks = rng.randint(3, 6)
    block_size = rng.randint(2 * blocks, 4 * blocks)
    universe = blocks * block_size
    weight = rng.randint(1, 5)
    cost = rng.randint(4, 12)

    block_sets = [
        (list(range(b * block_size, (b + 1) * block_size)), cost) for b in range(blocks)
    ]
    # Decoy: one more element than a block, drawn round-robin across blocks so
    # it overlaps every block a little and beats each block's ratio slightly.
    decoy: list[int] = []
    for k in range(block_size + 1):
        b = k % blocks
        decoy.append(b * block_size + (k // blocks))
    # Fillers: poor ratio, moderately expensive; they absorb first-fit budget.
    fillers = []
    for _ in range(rng.randint(2, 4)):
        fillers.append((_random_subset(rng, universe, rng.randint(1, 3)), cost + rng.randint(1, 4)))

    sets = [(decoy, cost)]
    interleaved = block_sets[:]
    for filler in fillers:
        interleaved.insert(rng.randint(0, len(interleaved)), filler)
    sets.extend(interleaved)
    sets = _relabel(rng, universe, sets)
    return {
        "id": f"overlap-trap-{ordinal}",
        "input": _payload([weight] * universe, sets, blocks * cost),
    }


def _budget_trap(seed: int, ordinal: int) -> dict:
    rng = _rng(seed, "budget-trap", ordinal)
    pair_cost = rng.randint(5, 9)
    budget = 2 * pair_cost
    decoy_cost = pair_cost + rng.randint(1, 3)
    pair_size = rng.randint(6, 12)
    # Strictly better ratio than a pair member, but far short of the pair's
    # combined coverage; decoy + either pair member exceeds the budget.
    decoy_size = (decoy_cost * pair_size) // pair_cost + 1
    assert decoy_size < 2 * pair_size
    universe = decoy_size + 2 * pair_size
    weight = rng.randint(1, 4)

    decoy = list(range(decoy_size))
    first = list(range(decoy_size, decoy_size + pair_size))
    second = list(range(decoy_size + pair_size, universe))
    fillers = []
    leftover = budget - decoy_cost
    for _ in range(rng.randint(1, 3)):
        fillers.append((_random_subset(rng, universe, 1), max(1, leftover)))
    sets = [(decoy, decoy_cost), (first, pair_cost)] + fillers + [(second, pair_cost)]
    sets = _relabel(rng, universe, sets)
    return {"id": f"budget-trap-{ordinal}", "input": _payload([weight] * universe, sets, budget)}


def _budget_edge(seed: int) -> list[dict]:
    rng = _rng(seed, "budget-edge")
    universe = rng.randint(20, 48)
    weights = [rng.randint(1, 20) for _ in range(universe)]
    count = rng.randint(6, 14)
    sets = [
        (_random_subset(rng, universe, rng.randint(2, universe // 2)), rng.randint(3, 25))
        for _ in range(count)
    ]
    cheapest = min(cost for _, cost in sets)
    total = sum(cost for _, cost in sets)
    a, b = rng.sample(range(count), 2)
    pair_budget = sets[a][1] + sets[b][1]
    return [
        {"id": "budget-edge-below-min", "input": _payload(weights, sets, cheapest - 1)},
        {"id": "budget-edge-exact-total", "input": _payload(weights, sets, total)},
        {"id": "budget-edge-exact-pair", "input": _payload(weights, sets, pair_budget)},
    ]


def _ties(seed: int) -> dict:
    rng = _rng(seed, "ties")
    universe = rng.randint(24, 60)
    size = rng.randint(3, 6)
    cost = rng.randint(2, 7)
    distinct = rng.randint(6, 12)
    base = [(_random_subset(rng, universe, size), cost) for _ in range(distinct)]
    sets = base + [(list(elements), cost) for elements, cost in rng.choices(base, k=rng.randint(4, 10))]
    rng.shuffle(sets)
    budget = cost * rng.randint(2, distinct - 1)
    return {"id": "ties", "input": _payload([rng.randint(1, 3)] * universe, sets, budget)}


def _singletons(seed: int) -> dict:
    rng = _rng(seed, "singletons")
    universe = rng.randint(30, 90)
    weights = [rng.randint(1, 60) for _ in range(universe)]
    sets = [([element], max(1, weights[element] // rng.randint(2, 6) + rng.randint(0, 4))) for element in range(universe)]
    rng.shuffle(sets)
    budget = sum(cost for _, cost in sets) * rng.randint(25, 45) // 100
    return {"id": "singletons", "input": _payload(weights, sets, budget)}


def _random_medium(seed: int, ordinal: int) -> dict:
    rng = _rng(seed, "random-medium", ordinal)
    universe = rng.randint(40, 120)
    weights = [0 if rng.random() < 0.12 else rng.randint(1, 50) for _ in range(universe)]
    count = rng.randint(20, 60)
    sets = []
    for _ in range(count):
        size = rng.randint(1, max(2, universe // 4))
        cost = rng.randint(1, 30)
        sets.append((_random_subset(rng, universe, size), cost))
    budget = sum(cost for _, cost in sets) * rng.randint(8, 20) // 100
    return {"id": f"random-medium-{ordinal}", "input": _payload(weights, sets, budget)}


def _max_dims(seed: int, ordinal: int, extreme: bool) -> dict:
    rng = _rng(seed, "max-dims", ordinal)
    universe = MAX_UNIVERSE
    if extreme:
        weights = [rng.choice((0, 1, MAX_WEIGHT, rng.randint(1, MAX_WEIGHT))) for _ in range(universe)]
    else:
        weights = [rng.randint(0, 100) for _ in range(universe)]
    sets = []
    for _ in range(MAX_SETS):
        # Heavy overlap: sets are drawn from a hot region plus scattered picks.
        hot = rng.randint(0, universe - 1)
        span = rng.randint(4, 48)
        elements = {(hot + k) % universe for k in range(span)}
        elements.update(_random_subset(rng, universe, rng.randint(0, 12)))
        # Cost tracks size with noise so cheap giants do not trivialise the case.
        size = len(elements)
        if extreme:
            cost = size * rng.randint(MAX_COST // 128, MAX_COST // 64)
        else:
            cost = max(1, size * rng.randint(5, 15) // 10 + rng.randint(-3, 3))
        elements_list = sorted(elements)
        rng.shuffle(elements_list)
        sets.append((elements_list, cost))
    total_cost = sum(cost for _, cost in sets)
    budget = total_cost * rng.randint(4, 9) // 100
    return {"id": f"max-dims-{ordinal}", "input": _payload(weights, sets, budget)}


def cases(seed: int) -> list[dict]:
    rows: list[dict] = []
    rows.extend(_empty_cases(seed))
    rows.append(_zero_weights(seed))
    rows.extend(_overlap_trap(seed, k) for k in range(3))
    rows.extend(_budget_trap(seed, k) for k in range(2))
    rows.extend(_budget_edge(seed))
    rows.append(_ties(seed))
    rows.append(_singletons(seed))
    rows.extend(_random_medium(seed, k) for k in range(3))
    rows.append(_max_dims(seed, 0, extreme=False))
    rows.append(_max_dims(seed, 1, extreme=True))
    return rows


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    json.dump(cases(seed), sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
