#!/usr/bin/env bash
# Grader for the circle-packing example.
#
# Usage: ./grader.sh <path>
#   - If <path> is a file, it's treated as the mutated placer.py
#   - If <path> is a directory, placer.py is loaded from inside it
#
# Score on stdout's last line; per-rollout diagnostics as JSON on stderr.
set -euo pipefail

TARGET="${1:?usage: grader.sh <path-to-placer.py-or-dir>}"
if [ -d "$TARGET" ]; then
  PLACER="$TARGET/placer.py"
else
  PLACER="$TARGET"
fi

python3 - "$PLACER" <<'PY'
import importlib.util
import json
import math
import sys
import traceback

path = sys.argv[1]

spec = importlib.util.spec_from_file_location("placer", path)
m = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(m)
except Exception:
    tb = traceback.format_exc(limit=2).strip().splitlines()[-1]
    print(json.dumps({"error": f"import_failed: {tb}"}), file=sys.stderr)
    print("0.0")
    sys.exit(0)


def validate(circles):
    for i, (x, y, r) in enumerate(circles):
        if r <= 0:
            return f"non-positive radius at circle {i}"
        if x - r < -1e-9 or x + r > 1 + 1e-9:
            return f"circle {i} x-range [{x - r:.4f},{x + r:.4f}] outside [0,1]"
        if y - r < -1e-9 or y + r > 1 + 1e-9:
            return f"circle {i} y-range [{y - r:.4f},{y + r:.4f}] outside [0,1]"
    n = len(circles)
    for i in range(n):
        for j in range(i + 1, n):
            x1, y1, r1 = circles[i]
            x2, y2, r2 = circles[j]
            d = math.hypot(x1 - x2, y1 - y2)
            if d + 1e-9 < r1 + r2:
                slack = (r1 + r2) - d
                return f"overlap between circles {i} and {j} (depth {slack:.4f})"
    return None


CASES = [7, 12, 20]
total = 0.0
for n in CASES:
    try:
        circles = list(m.place(n))
    except Exception as e:
        print(json.dumps({"n": n, "valid": False, "score": 0.0, "error": f"exception: {e}"}), file=sys.stderr)
        continue
    if len(circles) != n:
        print(json.dumps({"n": n, "valid": False, "score": 0.0,
                          "error": f"wrong count: got {len(circles)}, expected {n}"}), file=sys.stderr)
        continue
    err = validate(circles)
    if err:
        print(json.dumps({"n": n, "valid": False, "score": 0.0, "error": err}), file=sys.stderr)
        continue
    s = sum(r for (_x, _y, r) in circles)
    print(json.dumps({"n": n, "valid": True, "score": s}), file=sys.stderr)
    total += s

print(f"{total:.6f}")
PY
