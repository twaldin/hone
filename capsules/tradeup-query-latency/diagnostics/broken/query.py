"""Intentionally broken diagnostic: discards every ranked row."""
from __future__ import annotations

import sqlite3
from typing import Any


def run(_connection: sqlite3.Connection, workload: dict[str, Any]) -> dict[str, object]:
    return {
        "schema": "tradeup-skin-data-response-v1",
        "fixture": workload["fixture"],
        "responses": [{"id": request["id"], "rows": []} for request in workload["queries"]],
    }
