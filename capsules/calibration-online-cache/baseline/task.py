"""Online LRU baseline. Only the current request and resident cache are visible.

Return a resident page to evict on a full-cache miss, otherwise None. The trusted
parent owns insertion, membership, hit counting and the capacity constraint.
"""
last_seen = {}
clock = 0


def solve(payload):
    global clock
    clock += 1
    page = payload["request"]
    cache = payload["cache"]
    last_seen[page] = clock
    if payload["hit"] or len(cache) < payload["capacity"] or not cache:
        return None
    return min(cache, key=lambda item: (last_seen.get(item, -1), item))
