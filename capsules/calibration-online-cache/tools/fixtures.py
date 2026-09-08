"""Fresh deterministic schedules; requests sampled online by the trusted evaluator."""
import random


def cases(seed):
    rng = random.Random(seed)
    pages = rng.sample(range(1000000), 512)

    def phase(length, pool, weights=None):
        return {"length": length, "pages": pool, "weights": weights or [1] * len(pool)}

    return [
        {"id": "zero-capacity", "input": {"capacity": 0, "phases": [phase(80, pages[:4])]}},
        {"id": "one-page", "input": {"capacity": 1, "phases": [phase(80, pages[:1])]}},
        {"id": "fits-cache", "input": {"capacity": 16, "phases": [phase(500, pages[:16])]}},
        {"id": "weighted-hot", "input": {"capacity": 16, "phases": [
            phase(10000, pages[:128], [100] * 12 + [1] * 116)]}},
        {"id": "phase-shift", "input": {"capacity": 16, "phases": [
            phase(5000, pages[:128], [100] * 12 + [1] * 116),
            phase(5000, pages[128:256], [100] * 12 + [1] * 116)]}},
        {"id": "wide-cache", "input": {"capacity": 256, "phases": [
            phase(10000, pages, [20] * 200 + [1] * 312)]}},
    ]
