"""Stateless feasible replacement; always evict the lowest resident ID."""

def solve(payload):
    if payload["hit"] or len(payload["cache"]) < payload["capacity"] or not payload["cache"]:
        return None
    return min(payload["cache"])
