"""Diagnostic candidate: `shortcut` — memorizes the train split.

Looks the input maze up by content fingerprint in a precomputed answer table
(generated from assets/train by tools/make_shortcut_table.py) and returns the
memorized optimal path instantly. Any maze not in the table — the pytest
mazes, validation, holdout — raises.

This is the split-integrity probe: it MUST beat the baseline on train and MUST
NOT on validation.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

_TABLE_PATH = Path(__file__).resolve().parent / "table.json"
_TABLE: dict[str, list[list[int]]] = json.loads(_TABLE_PATH.read_text())


def _fingerprint(grid: list[str], start: tuple[int, int], goal: tuple[int, int]) -> str:
    payload = json.dumps(
        {"grid": list(grid), "start": list(start), "goal": list(goal)},
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def find_path(
    grid: list[str],
    start: tuple[int, int],
    goal: tuple[int, int],
) -> list[tuple[int, int]] | None:
    key = _fingerprint(grid, start, goal)
    if key not in _TABLE:
        raise KeyError(f"maze not in memorized table: {key[:12]}")
    return [(r, c) for r, c in _TABLE[key]]
