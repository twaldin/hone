"""Authoritative online simulation: no trace, fixture seed or future request crosses IPC.

Fixtures are deterministic distribution schedules, not published answer traces.
Each request is sampled by the trusted parent only AFTER the prior decision. A
private SystemRandom source prevents source-visible fixture reconstruction.
"""
import secrets


def validate(payload):
    if not isinstance(payload, dict) or set(payload) != {"capacity", "phases"}:
        raise ValueError("expected capacity and phases")
    capacity, phases = payload["capacity"], payload["phases"]
    if type(capacity) is not int or not 0 <= capacity <= 256:
        raise ValueError("capacity must be an integer from 0 through 256")
    if not isinstance(phases, list) or not phases:
        raise ValueError("nonempty phase schedule required")
    total = 0
    for phase in phases:
        if not isinstance(phase, dict) or set(phase) != {"length", "pages", "weights"}:
            raise ValueError("invalid phase")
        length, pages, weights = phase["length"], phase["pages"], phase["weights"]
        if type(length) is not int or length <= 0:
            raise ValueError("phase length must be positive")
        if not isinstance(pages, list) or not 1 <= len(pages) <= 1024:
            raise ValueError("phase page pool exceeds bounds")
        if any(type(page) is not int or page < 0 for page in pages) or len(set(pages)) != len(pages):
            raise ValueError("page IDs must be distinct nonnegative integers")
        if not isinstance(weights, list) or len(weights) != len(pages):
            raise ValueError("weights must match pages")
        if any(type(weight) is not int or not 1 <= weight <= 10000 for weight in weights):
            raise ValueError("weights must be positive bounded integers")
        total += length
    if total > 10000:
        raise ValueError("trace exceeds 10000 requests")
    return total


def transition(cache, capacity, page, victim):
    """Check a decision independently of candidate bookkeeping; never accept prefetch."""
    hit = page in cache
    full_miss = not hit and capacity > 0 and len(cache) == capacity
    if full_miss:
        if type(victim) is not int or victim not in cache:
            raise ValueError("full-cache miss requires one resident eviction")
        cache.remove(victim)
    elif victim is not None:
        raise ValueError("eviction is allowed only on a full-cache miss")
    if not hit and capacity > 0:
        cache.add(page)
    if len(cache) > capacity:
        raise ValueError("hard capacity exceeded")
    return hit


def evaluate(payload, call, rng=None):
    total = validate(payload)
    rng = secrets.SystemRandom() if rng is None else rng
    cache, hits = set(), 0
    capacity = payload["capacity"]
    for phase in payload["phases"]:
        cumulative, weight_sum = [], 0
        for weight in phase["weights"]:
            weight_sum += weight
            cumulative.append(weight_sum)
        for _ in range(phase["length"]):
            # Draw only the current request. The worker never inherits this RNG,
            # the distribution schedule, or an already-materialized future trace.
            draw = rng.randrange(weight_sum)
            index = 0
            while draw >= cumulative[index]:
                index += 1
            page = phase["pages"][index]
            result = call({"request": page, "cache": sorted(cache),
                           "capacity": capacity, "hit": page in cache})
            hits += transition(cache, capacity, page, result)
    return True, hits / total, f"{hits}/{total} hits; all capacity/eviction checks passed"
