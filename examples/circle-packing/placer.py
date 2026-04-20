"""Pack n non-overlapping circles into the unit square [0,1] x [0,1].

The `place(n)` function must return a list of exactly n (x, y, r) tuples such
that every circle lies fully inside the unit square and no two circles
overlap. Score = sum of all radii. Higher is better.

Seed strategy: uniform square grid. Wastes a lot of space when n is not a
perfect square; plenty of room for a smarter packer to improve.
"""
from math import ceil, sqrt


def place(n: int) -> list[tuple[float, float, float]]:
    side = ceil(sqrt(n))
    cell = 1.0 / side
    r = cell / 2
    circles: list[tuple[float, float, float]] = []
    for i in range(n):
        row, col = divmod(i, side)
        circles.append((col * cell + r, row * cell + r, r))
    return circles
