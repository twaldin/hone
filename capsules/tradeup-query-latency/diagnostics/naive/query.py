"""Plausible naive N+1 implementation of the owner skin-data query."""
from __future__ import annotations

import sqlite3
from typing import Any


def _filters(request: dict[str, Any]) -> tuple[str, list[object]]:
    clauses = ["s.stattrak = ?"]
    params: list[object] = [1 if request["stattrak"] else 0]
    rarity = request["rarity"]
    if rarity == "Covert":
        clauses.append("s.rarity = 'Covert' AND s.name NOT LIKE '★%'")
    elif rarity not in ("", "all"):
        clauses.append("s.rarity = ?")
        params.append(rarity)
    if request["collection"]:
        clauses.append(
            "s.id IN (SELECT scf.skin_id FROM skin_collections scf "
            "JOIN collections cf ON cf.id = scf.collection_id WHERE cf.name = ?)"
        )
        params.append(request["collection"])
    if request["search"]:
        clauses.append("s.name LIKE ?")
        params.append(f"%{request['search']}%")
    return " AND ".join(clauses), params


def _query(connection: sqlite3.Connection, request: dict[str, Any]) -> list[dict[str, object]]:
    where, params = _filters(request)
    skins = connection.execute(
        f"SELECT s.id,s.name,s.weapon,s.min_float,s.max_float,s.rarity FROM skins s WHERE {where} ORDER BY s.id",
        params,
    ).fetchall()
    grouped: dict[tuple[object, ...], list[str]] = {}
    id_to_key: dict[str, tuple[object, ...]] = {}
    for skin in skins:
        key = (skin[1], skin[5], skin[2], skin[3], skin[4])
        grouped.setdefault(key, []).append(skin[0])
        id_to_key[skin[0]] = key

    # Plausible pre-index implementation: for every request, sort the complete
    # stattrak partition by price and aggregate the selected rows in Python.
    # It is correct, but repeats a full market sort instead of exploiting the
    # owner idx_listings_skin_id index and SQL grouping.
    stats_by_key: dict[tuple[object, ...], list[object]] = {}
    for skin_id, price, float_value in connection.execute(
        """
        SELECT skin_id, price_cents, float_value
        FROM listings WHERE stattrak = ?
        ORDER BY price_cents, id
        """,
        [1 if request["stattrak"] else 0],
    ):
        key = id_to_key.get(skin_id)
        if key is None:
            continue
        stats = stats_by_key.get(key)
        if stats is None:
            stats = [0, None, 0, None, None, None]
            stats_by_key[key] = stats
        stats[0] = int(stats[0]) + 1
        stats[1] = price if stats[1] is None or price < stats[1] else stats[1]
        stats[2] = int(stats[2]) + int(price)
        stats[3] = price if stats[3] is None or price > stats[3] else stats[3]

    # A second independent full sort computes the float extrema, mirroring a
    # naive endpoint that issues separate analytics queries for each column.
    for skin_id, float_value in connection.execute(
        """
        SELECT skin_id, float_value
        FROM listings WHERE stattrak = ?
        ORDER BY float_value, id
        """,
        [1 if request["stattrak"] else 0],
    ):
        key = id_to_key.get(skin_id)
        if key is None:
            continue
        stats = stats_by_key[key]
        stats[4] = float_value if stats[4] is None or float_value < stats[4] else stats[4]
        stats[5] = float_value if stats[5] is None or float_value > stats[5] else stats[5]

    results: list[dict[str, object]] = []
    for key, skin_ids in grouped.items():
        placeholders = ",".join("?" for _ in skin_ids)
        collection_names = [
            row[0]
            for row in connection.execute(
                f"""
                SELECT DISTINCT c.name FROM skin_collections sc
                JOIN collections c ON c.id = sc.collection_id
                WHERE sc.skin_id IN ({placeholders}) ORDER BY c.name
                """,
                skin_ids,
            )
        ]
        stats = stats_by_key.get(key, [0, None, 0, None, None, None])
        count = int(stats[0])
        total = int(stats[2])
        results.append(
            {
                "name": key[0],
                "rarity": key[1],
                "weapon": key[2],
                "minFloat": key[3],
                "maxFloat": key[4],
                "collections": collection_names,
                "listingCount": count,
                "minPrice": stats[1],
                "avgPrice": None if count == 0 else (total + count // 2) // count,
                "maxPrice": stats[3],
                "minFloatSeen": stats[4],
                "maxFloatSeen": stats[5],
            }
        )
    results.sort(key=lambda row: (-int(row["listingCount"]), str(row["name"])))
    limit = min(int(request["limit"]), 500)
    offset = (int(request["page"]) - 1) * limit
    return results[offset : offset + limit]


def run(connection: sqlite3.Connection, workload: dict[str, Any]) -> dict[str, object]:
    return {
        "schema": "tradeup-skin-data-response-v1",
        "fixture": workload["fixture"],
        "responses": [
            {"id": request["id"], "rows": _query(connection, request)}
            for request in workload["queries"]
        ],
    }
