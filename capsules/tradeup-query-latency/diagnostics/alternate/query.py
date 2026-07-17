"""Independent faster diagnostic: rank indexed listing aggregates before decorating top rows."""
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


def _query(
    connection: sqlite3.Connection,
    request: dict[str, Any],
    listing_stats: dict[str, tuple[object, ...]],
) -> list[dict[str, object]]:
    where, params = _filters(request)
    skins = connection.execute(
        f"""
        SELECT s.id, s.name, s.rarity, s.weapon, s.min_float, s.max_float
        FROM skins s WHERE {where} ORDER BY s.id
        """,
        params,
    ).fetchall()
    collections_by_skin: dict[str, set[str]] = {}
    for skin_id, collection_name in connection.execute(
        f"""
        SELECT s.id, c.name
        FROM skins s
        JOIN skin_collections sc ON sc.skin_id = s.id
        JOIN collections c ON c.id = sc.collection_id
        WHERE {where}
        ORDER BY s.id, c.name
        """,
        params,
    ):
        collections_by_skin.setdefault(skin_id, set()).add(collection_name)

    grouped: dict[tuple[object, ...], dict[str, object]] = {}
    for skin_id, name, rarity, weapon, min_float, max_float in skins:
        key = (name, rarity, weapon, min_float, max_float)
        aggregate = grouped.get(key)
        if aggregate is None:
            aggregate = {
                "name": name,
                "rarity": rarity,
                "weapon": weapon,
                "minFloat": min_float,
                "maxFloat": max_float,
                "collections": set(),
                "listingCount": 0,
                "minPrice": None,
                "totalPrice": 0,
                "maxPrice": None,
                "minFloatSeen": None,
                "maxFloatSeen": None,
            }
            grouped[key] = aggregate
        aggregate["collections"].update(collections_by_skin.get(skin_id, set()))  # type: ignore[union-attr]
        stats = listing_stats.get(skin_id)
        if stats is None:
            continue
        count, min_price, total_price, max_price, min_seen, max_seen = stats
        aggregate["listingCount"] = int(aggregate["listingCount"]) + int(count)
        aggregate["totalPrice"] = int(aggregate["totalPrice"]) + int(total_price)
        if aggregate["minPrice"] is None or min_price < aggregate["minPrice"]:
            aggregate["minPrice"] = min_price
        if aggregate["maxPrice"] is None or max_price > aggregate["maxPrice"]:
            aggregate["maxPrice"] = max_price
        if aggregate["minFloatSeen"] is None or min_seen < aggregate["minFloatSeen"]:
            aggregate["minFloatSeen"] = min_seen
        if aggregate["maxFloatSeen"] is None or max_seen > aggregate["maxFloatSeen"]:
            aggregate["maxFloatSeen"] = max_seen

    ranked = sorted(grouped.values(), key=lambda row: (-int(row["listingCount"]), str(row["name"])))
    limit = min(int(request["limit"]), 500)
    offset = (int(request["page"]) - 1) * limit
    output: list[dict[str, object]] = []
    for aggregate in ranked[offset : offset + limit]:
        count = int(aggregate.pop("listingCount"))
        total = int(aggregate.pop("totalPrice"))
        aggregate["listingCount"] = count
        aggregate["avgPrice"] = None if count == 0 else (total + count // 2) // count
        aggregate["collections"] = sorted(aggregate["collections"])
        output.append(aggregate)
    return output


def run(connection: sqlite3.Connection, workload: dict[str, Any]) -> dict[str, object]:
    # Cache the expensive indexed listing aggregate once for the seven-query
    # workload, while retaining independent SQL filtering per request.
    listing_stats = {
        row[0]: row[1:]
        for row in connection.execute(
            """
            SELECT skin_id, COUNT(*), MIN(price_cents), SUM(price_cents), MAX(price_cents),
              MIN(float_value), MAX(float_value)
            FROM listings GROUP BY skin_id
            """
        )
    }
    return {
        "schema": "tradeup-skin-data-response-v1",
        "fixture": workload["fixture"],
        "responses": [
            {"id": request["id"], "rows": _query(connection, request, listing_stats)}
            for request in workload["queries"]
        ],
    }
