"""Budgeted weighted coverage: multi-start lazy greedy with swap local search.

solve(payload) -> list[int]

Same contract as the baseline. Strategy:

  1. Lazy ratio greedy (marginal gains are submodular, so stale heap entries
     are refreshed only when they surface) from the empty selection.
  2. Restart the same greedy with each of the most promising sets forced in
     first, plus the best single affordable set; keep the heaviest result.
  3. Polish the best selection with add moves and 1-for-1 swaps until no move
     increases covered weight.

Every candidate produced is affordable, so the answer is never worse than the
plain greedy the baseline computes.
"""

from __future__ import annotations

import heapq

RESTARTS = 24
MAX_POLISH_ROUNDS = 128


def _items(sets: list[dict], weights: list[int]) -> list[list[tuple[int, int]]]:
    return [[(1 << e, weights[e]) for e in entry["elements"] if weights[e] > 0] for entry in sets]


def _gain(items: list[tuple[int, int]], covered: int) -> int:
    return sum(w for bit, w in items if not covered & bit)


def _greedy(
    items: list[list[tuple[int, int]]],
    masks: list[int],
    costs: list[int],
    budget: int,
    chosen: list[int],
    covered: int,
    spent: int,
    value: int,
) -> tuple[list[int], int, int, int]:
    remaining = budget - spent
    picked = set(chosen)
    heap: list[tuple[float, int, int]] = []
    for index, cost in enumerate(costs):
        if index in picked or cost > remaining:
            continue
        gain = _gain(items[index], covered)
        if gain > 0:
            heapq.heappush(heap, (-gain / cost, -gain, index))
    while heap:
        neg_ratio, neg_gain, index = heapq.heappop(heap)
        cost = costs[index]
        if cost > remaining:
            continue
        gain = _gain(items[index], covered)
        if gain <= 0:
            continue
        if gain != -neg_gain:
            heapq.heappush(heap, (-gain / cost, -gain, index))
            continue
        chosen.append(index)
        picked.add(index)
        covered |= masks[index]
        remaining -= cost
        value += gain
    return chosen, covered, budget - remaining, value


def _polish(
    items: list[list[tuple[int, int]]],
    masks: list[int],
    costs: list[int],
    budget: int,
    chosen: list[int],
    value: int,
) -> tuple[list[int], int]:
    count = len(costs)
    for _ in range(MAX_POLISH_ROUNDS):
        spent = sum(costs[i] for i in chosen)
        covered = 0
        for i in chosen:
            covered |= masks[i]
        best_delta = 0
        best_move: tuple[int, int] | None = None  # (remove or -1, add)
        # Add moves.
        picked = set(chosen)
        for add in range(count):
            if add in picked or costs[add] > budget - spent:
                continue
            delta = _gain(items[add], covered)
            if delta > best_delta:
                best_delta = delta
                best_move = (-1, add)
        # Swap moves: loss of the removed set's exclusive weight versus the
        # gain of the added set against the remaining coverage.
        for position, remove in enumerate(chosen):
            others = 0
            for j, i in enumerate(chosen):
                if j != position:
                    others |= masks[i]
            loss = _gain(items[remove], others)
            room = budget - spent + costs[remove]
            for add in range(count):
                if add in picked or costs[add] > room:
                    continue
                delta = _gain(items[add], others) - loss
                if delta > best_delta:
                    best_delta = delta
                    best_move = (remove, add)
        if best_move is None:
            break
        remove, add = best_move
        if remove >= 0:
            chosen.remove(remove)
        chosen.append(add)
        value += best_delta
    return chosen, value


def solve(payload: dict) -> list[int]:
    weights: list[int] = payload["weights"]
    sets: list[dict] = payload["sets"]
    budget: int = payload["budget"]
    if not sets or not any(weights):
        return []

    items = _items(sets, weights)
    masks = [sum(bit for bit, _ in entry) for entry in items]
    costs = [entry["cost"] for entry in sets]
    full = [_gain(entry, 0) for entry in items]

    best_chosen, _, _, best_value = _greedy(items, masks, costs, budget, [], 0, 0, 0)

    affordable = [i for i in range(len(sets)) if costs[i] <= budget and full[i] > 0]
    by_ratio = sorted(affordable, key=lambda i: (-full[i] / costs[i], -full[i], i))
    by_weight = sorted(affordable, key=lambda i: (-full[i], costs[i], i))
    starts: list[int] = []
    for index in by_ratio[:RESTARTS] + by_weight[:RESTARTS]:
        if index not in starts:
            starts.append(index)
    for start in starts:
        chosen, _, _, value = _greedy(
            items, masks, costs, budget, [start], masks[start], costs[start], full[start]
        )
        if value > best_value:
            best_chosen, best_value = chosen, value

    best_chosen, best_value = _polish(items, masks, costs, budget, list(best_chosen), best_value)
    best_chosen.sort()
    return best_chosen
