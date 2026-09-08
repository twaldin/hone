"""Independent checker for the calibration-sequence-diff task.

`check(payload, result)` returns `(ok, quality, feedback)`. `ok` is True only
when the payload is within the hard bounds, `result` has exactly the declared
shape, replaying it consumes every `before` token and produces every `after`
token, and the number of `insert` plus `delete` operations equals
`len(before) + len(after) - 2 * LCS`. `quality` is 1.0 when ok, else 0.0.

The LCS length is recomputed here with a two-row length-only DP; this module
must never import the candidate `task.py`.
"""

from __future__ import annotations

MAX_TOKENS = 1024

EQUAL = "equal"
DELETE = "delete"
INSERT = "insert"
OPS = frozenset((EQUAL, DELETE, INSERT))


def _is_token_list(value: object) -> bool:
    return isinstance(value, list) and all(type(token) is str for token in value)


def _validate_payload(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return "payload must be an object"
    for key in ("before", "after"):
        if key not in payload:
            return f"payload missing {key!r}"
        if not _is_token_list(payload[key]):
            return f"payload[{key!r}] must be a list of str tokens"
        if len(payload[key]) > MAX_TOKENS:
            return f"payload[{key!r}] has {len(payload[key])} tokens; limit is {MAX_TOKENS}"
    return None


def lcs_length(before: list[str], after: list[str]) -> int:
    """Length of the longest common subsequence via a two-row DP."""
    if len(before) < len(after):
        before, after = after, before
    m = len(after)
    prev = [0] * (m + 1)
    for token in before:
        cur = [0] * (m + 1)
        for j in range(1, m + 1):
            if token == after[j - 1]:
                cur[j] = prev[j - 1] + 1
            else:
                up = prev[j]
                left = cur[j - 1]
                cur[j] = up if up >= left else left
        prev = cur
    return prev[m]


def check(payload: object, result: object) -> tuple[bool, float, str]:
    problem = _validate_payload(payload)
    if problem is not None:
        return False, 0.0, problem
    before = payload["before"]
    after = payload["after"]

    if not isinstance(result, list):
        return False, 0.0, f"result must be a list, got {type(result).__name__}"

    i = 0
    j = 0
    edits = 0
    for index, item in enumerate(result):
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            return False, 0.0, f"result[{index}] must be a [op, token] pair"
        op, token = item
        if type(op) is not str or op not in OPS:
            return False, 0.0, f"result[{index}] has invalid op {op!r}"
        if type(token) is not str:
            return False, 0.0, f"result[{index}] token must be str, got {type(token).__name__}"
        if op == EQUAL:
            if i >= len(before) or j >= len(after):
                return False, 0.0, f"result[{index}] equal past end of input"
            if before[i] != token or after[j] != token:
                return False, 0.0, (
                    f"result[{index}] equal {token!r} does not match "
                    f"before[{i}]={before[i]!r} / after[{j}]={after[j]!r}"
                )
            i += 1
            j += 1
        elif op == DELETE:
            if i >= len(before) or before[i] != token:
                return False, 0.0, f"result[{index}] delete {token!r} does not match before[{i}]"
            i += 1
            edits += 1
        else:
            if j >= len(after) or after[j] != token:
                return False, 0.0, f"result[{index}] insert {token!r} does not match after[{j}]"
            j += 1
            edits += 1

    if i != len(before):
        return False, 0.0, f"script consumed {i} of {len(before)} before tokens"
    if j != len(after):
        return False, 0.0, f"script produced {j} of {len(after)} after tokens"

    minimal = len(before) + len(after) - 2 * lcs_length(before, after)
    if edits != minimal:
        return False, 0.0, f"script uses {edits} edits; minimum is {minimal}"
    return True, 1.0, f"minimal script with {edits} edits over {len(result)} operations"
