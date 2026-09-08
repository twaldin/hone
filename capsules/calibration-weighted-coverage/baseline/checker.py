"""Independent checker for the budgeted weighted-coverage task.

check(payload, result) -> (valid, quality, feedback)

  valid    : the payload is within the hard input bounds and the result is a
             well-typed, distinct, in-range, within-budget selection.
  quality  : covered weight / total universe weight in [0, 1] for a valid
             selection (1.0 when the universe carries zero total weight);
             0.0 whenever valid is False.
  feedback : one human-readable line describing the verdict.

The checker derives everything from the payload itself and never imports the
candidate implementation.
"""

from __future__ import annotations

MAX_UNIVERSE = 256
MAX_SETS = 128
MAX_WEIGHT = 1_000_000
MAX_COST = 1_000_000
MAX_BUDGET = 1_000_000_000


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_payload(payload: object) -> None:
    """Raise ValueError when the payload violates the task's hard bounds."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    if set(payload) != {"weights", "sets", "budget"}:
        raise ValueError("payload must have exactly the keys weights, sets, budget")

    weights = payload["weights"]
    if not isinstance(weights, list):
        raise ValueError("weights must be a list")
    if len(weights) > MAX_UNIVERSE:
        raise ValueError(f"universe exceeds {MAX_UNIVERSE} elements")
    for position, weight in enumerate(weights):
        if not _is_int(weight) or weight < 0 or weight > MAX_WEIGHT:
            raise ValueError(f"weights[{position}] must be an int in [0, {MAX_WEIGHT}]")

    sets = payload["sets"]
    if not isinstance(sets, list):
        raise ValueError("sets must be a list")
    if len(sets) > MAX_SETS:
        raise ValueError(f"more than {MAX_SETS} sets")
    universe = len(weights)
    for index, entry in enumerate(sets):
        if not isinstance(entry, dict) or set(entry) != {"elements", "cost"}:
            raise ValueError(f"sets[{index}] must be an object with exactly elements and cost")
        elements = entry["elements"]
        if not isinstance(elements, list):
            raise ValueError(f"sets[{index}].elements must be a list")
        seen: set[int] = set()
        for element in elements:
            if not _is_int(element) or element < 0 or element >= universe:
                raise ValueError(f"sets[{index}].elements must be ints in [0, {universe})")
            if element in seen:
                raise ValueError(f"sets[{index}].elements repeats element {element}")
            seen.add(element)
        cost = entry["cost"]
        if not _is_int(cost) or cost < 1 or cost > MAX_COST:
            raise ValueError(f"sets[{index}].cost must be an int in [1, {MAX_COST}]")

    budget = payload["budget"]
    if not _is_int(budget) or budget < 0 or budget > MAX_BUDGET:
        raise ValueError(f"budget must be an int in [0, {MAX_BUDGET}]")


def check(payload: object, result: object) -> tuple[bool, float, str]:
    try:
        validate_payload(payload)
    except ValueError as exc:
        return False, 0.0, f"invalid payload: {exc}"
    assert isinstance(payload, dict)
    weights: list[int] = payload["weights"]
    sets: list[dict] = payload["sets"]
    budget: int = payload["budget"]

    if not isinstance(result, list):
        return False, 0.0, f"result must be a list of set indices, got {type(result).__name__}"
    chosen: set[int] = set()
    for position, index in enumerate(result):
        if not _is_int(index):
            return False, 0.0, f"result[{position}] is not an int"
        if index < 0 or index >= len(sets):
            return False, 0.0, f"result[{position}]={index} is outside [0, {len(sets)})"
        if index in chosen:
            return False, 0.0, f"result repeats set index {index}"
        chosen.add(index)

    spent = sum(sets[index]["cost"] for index in chosen)
    if spent > budget:
        return False, 0.0, f"selection costs {spent}, exceeding budget {budget}"

    covered_elements: set[int] = set()
    for index in chosen:
        covered_elements.update(sets[index]["elements"])
    covered = sum(weights[element] for element in covered_elements)
    total = sum(weights)
    quality = 1.0 if total == 0 else covered / total
    feedback = (
        f"covered weight {covered}/{total} with {len(chosen)} sets at cost {spent}/{budget}"
    )
    return True, quality, feedback
