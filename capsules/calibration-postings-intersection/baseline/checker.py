"""Protected checker for the posting-list intersection calibration task.

Independent of ``task.py`` (never imported): the expected answer is derived by
counting how many lists each id appears in, which shares no code path with the
merge/set/bisect strategies a candidate is likely to use.

``check(payload, result) -> (ok, quality, feedback)``

* ``ok``       True only when the payload is inside the hard input bounds AND
               ``result`` is exactly the sorted intersection with exact types.
* ``quality``  1.0 when ``ok`` else 0.0 (exact task; no partial credit).
* ``feedback`` short human-readable reason on failure, ``"exact"`` on success.

Hard input bounds (violations reject the case rather than the candidate's
answer, so a malformed fixture can never be scored as a candidate win):

* ``payload["lists"]`` is a list of at most ``MAX_LISTS`` lists
* every member has at most ``MAX_LEN`` entries
* every entry is an ``int`` (``bool`` rejected) in ``[0, MAX_DOC_ID]``
* every member is strictly increasing

Result requirements: ``type(result) is list``, every element ``type(...) is
int`` (``bool``/``float`` rejected even when numerically equal), strictly
increasing (duplicates and out-of-order rejected), equal to the expected
intersection. Zero lists and any empty member both expect ``[]``.
"""

from __future__ import annotations

MAX_LISTS = 8
MAX_LEN = 20_000
MAX_DOC_ID = 2**31 - 1


def _validate_payload(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return "payload must be an object"
    lists = payload.get("lists")
    if type(lists) is not list:
        return "payload.lists must be a list"
    if len(lists) > MAX_LISTS:
        return f"payload.lists has {len(lists)} lists; max {MAX_LISTS}"
    for idx, member in enumerate(lists):
        if type(member) is not list:
            return f"payload.lists[{idx}] must be a list"
        if len(member) > MAX_LEN:
            return f"payload.lists[{idx}] has {len(member)} entries; max {MAX_LEN}"
        previous = -1
        for pos, value in enumerate(member):
            if type(value) is not int:
                return f"payload.lists[{idx}][{pos}] is not an int"
            if value < 0 or value > MAX_DOC_ID:
                return f"payload.lists[{idx}][{pos}]={value} outside [0, {MAX_DOC_ID}]"
            if value <= previous:
                return f"payload.lists[{idx}] not strictly increasing at index {pos}"
            previous = value
    return None


def _validate_result(result: object) -> str | None:
    if type(result) is not list:
        return f"result must be a list, got {type(result).__name__}"
    previous = -1
    for pos, value in enumerate(result):
        if type(value) is not int:
            return f"result[{pos}] is not an int ({type(value).__name__})"
        if value < 0 or value > MAX_DOC_ID:
            return f"result[{pos}]={value} outside [0, {MAX_DOC_ID}]"
        if value == previous:
            return f"result contains duplicate {value} at index {pos}"
        if value < previous:
            return f"result not sorted at index {pos} ({value} after {previous})"
        previous = value
    return None


def _expected(lists: list[list[int]]) -> list[int]:
    """Ids whose occurrence count equals the number of lists.

    Each list is strictly increasing (validated), so an id contributes at
    most one count per list and a full count means presence in every list.
    """
    if not lists:
        return []
    counts: dict[int, int] = {}
    for member in lists:
        if not member:
            return []
        for value in member:
            counts[value] = counts.get(value, 0) + 1
    needed = len(lists)
    return sorted(value for value, count in counts.items() if count == needed)


def check(payload: object, result: object) -> tuple[bool, float, str]:
    problem = _validate_payload(payload)
    if problem is not None:
        return False, 0.0, f"invalid input: {problem}"
    problem = _validate_result(result)
    if problem is not None:
        return False, 0.0, f"invalid result: {problem}"

    expected = _expected(payload["lists"])  # type: ignore[index]
    got: list[int] = result  # type: ignore[assignment]
    if got == expected:
        return True, 1.0, "exact"

    expected_set = set(expected)
    got_set = set(got)
    missing = [value for value in expected if value not in got_set]
    extra = [value for value in got if value not in expected_set]
    detail = f"expected {len(expected)} ids, got {len(got)}"
    if missing:
        detail += f"; missing {len(missing)} (first {missing[0]})"
    if extra:
        detail += f"; extra {len(extra)} (first {extra[0]})"
    return False, 0.0, f"wrong intersection: {detail}"
