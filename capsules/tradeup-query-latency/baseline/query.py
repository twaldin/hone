"""Frozen seed: SQLite adaptation of owner server/routes/data.ts skin-data query."""
from __future__ import annotations

import sqlite3
from typing import Any

_SEPARATOR = "\x1f"


def _filters(request: dict[str, Any]) -> tuple[str, list[object]]:
    clauses = ["s.stattrak = ?"]
    params: list[object] = [1 if request["stattrak"] else 0]
    rarity = request["rarity"]
    if rarity == "Covert":
        clauses.append("s.rarity = 'Covert' AND s.name NOT LIKE '★%'")
    elif rarity not in ("", "all"):
        clauses.append("s.rarity = ?")
        params.append(rarity)
    collection = request["collection"]
    if collection:
        clauses.append(
            "s.id IN (SELECT scf.skin_id FROM skin_collections scf "
            "JOIN collections cf ON cf.id = scf.collection_id WHERE cf.name = ?)"
        )
        params.append(collection)
    search = request["search"]
    if search:
        clauses.append("s.name LIKE ?")
        params.append(f"%{search}%")
    return " AND ".join(clauses), params


def _query(connection: sqlite3.Connection, request: dict[str, Any]) -> list[dict[str, object]]:
    where, params = _filters(request)
    limit = min(int(request["limit"]), 500)
    offset = (int(request["page"]) - 1) * limit
    rows = connection.execute(
        f"""
        WITH filtered_skins AS MATERIALIZED (
          SELECT s.id, s.name, s.rarity, s.weapon, s.min_float, s.max_float
          FROM skins s WHERE {where}
        ),
        collection_names_by_name AS (
          SELECT name, GROUP_CONCAT(collection_name, X'1F') AS collection_names
          FROM (
            SELECT DISTINCT fs.name AS name, c.name AS collection_name
            FROM skin_collections sc
            JOIN collections c ON c.id = sc.collection_id
            JOIN filtered_skins fs ON fs.id = sc.skin_id
            ORDER BY fs.name, c.name
          ) GROUP BY name
        ),
        listing_stats AS (
          SELECT l.skin_id,
            COUNT(*) AS listing_count,
            MIN(l.price_cents) AS min_price,
            SUM(l.price_cents) AS total_price_cents,
            MAX(l.price_cents) AS max_price,
            MIN(l.float_value) AS min_float_seen,
            MAX(l.float_value) AS max_float_seen
          FROM listings l
          JOIN filtered_skins fs ON fs.id = l.skin_id
          WHERE l.stattrak = ?
          GROUP BY l.skin_id
        )
        SELECT fs.name, fs.rarity, fs.weapon, fs.min_float, fs.max_float,
          cn.collection_names,
          COALESCE(SUM(ls.listing_count), 0) AS listing_count,
          MIN(ls.min_price) AS min_price,
          SUM(ls.total_price_cents) AS total_price_cents,
          MAX(ls.max_price) AS max_price,
          MIN(ls.min_float_seen) AS min_float_seen,
          MAX(ls.max_float_seen) AS max_float_seen
        FROM filtered_skins fs
        LEFT JOIN collection_names_by_name cn ON cn.name = fs.name
        LEFT JOIN listing_stats ls ON ls.skin_id = fs.id
        GROUP BY fs.name, fs.rarity, fs.weapon, fs.min_float, fs.max_float, cn.collection_names
        ORDER BY listing_count DESC, fs.name ASC
        LIMIT ? OFFSET ?
        """,
        [*params, 1 if request["stattrak"] else 0, limit, offset],
    ).fetchall()
    output: list[dict[str, object]] = []
    for row in rows:
        count = int(row[6])
        total = int(row[8]) if row[8] is not None else 0
        output.append(
            {
                "name": row[0],
                "rarity": row[1],
                "weapon": row[2],
                "minFloat": row[3],
                "maxFloat": row[4],
                "collections": [] if row[5] is None else str(row[5]).split(_SEPARATOR),
                "listingCount": count,
                "minPrice": row[7],
                "avgPrice": None if count == 0 else (total + count // 2) // count,
                "maxPrice": row[9],
                "minFloatSeen": row[10],
                "maxFloatSeen": row[11],
            }
        )
    return output


def run(connection: sqlite3.Connection, workload: dict[str, Any]) -> dict[str, object]:
    return {
        "schema": "tradeup-skin-data-response-v1",
        "fixture": workload["fixture"],
        "responses": [
            {"id": request["id"], "rows": _query(connection, request)}
            for request in workload["queries"]
        ],
    }
