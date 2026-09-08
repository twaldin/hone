"""Frequency-aware online replacement; historical counts only, no future inputs."""
counts = {}
last = {}
clock = 0


def solve(payload):
    global clock
    clock += 1
    if clock % 256 == 0:
        for item in list(counts):
            counts[item] //= 2
            if counts[item] == 0:
                del counts[item]
    page, cache = payload["request"], payload["cache"]
    counts[page] = counts.get(page, 0) + 1
    last[page] = clock
    if payload["hit"] or len(cache) < payload["capacity"] or not cache:
        return None
    return min(cache, key=lambda item: (counts.get(item, 0), last.get(item, 0), item))
