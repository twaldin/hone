#!/usr/bin/env bash
set -euo pipefail

WORKDIR="${1:?usage: scorer.sh <workdir>}"
RESULT_PATH="${HONE_RESULT_PATH:-}"

if [[ -z "$RESULT_PATH" ]]; then
  echo "HONE_RESULT_PATH is required" >&2
  exit 1
fi

value=$(python3 - "$WORKDIR/counter.py" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(r"value\s*=\s*(-?\d+)", text)
if not match:
    print("0")
else:
    print(match.group(1))
PY
)

score=$(python3 - "$value" <<'PY'
import sys
print(float(sys.argv[1]))
PY
)

python3 - "$RESULT_PATH" "$score" "$value" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
score = float(sys.argv[2])
value = int(sys.argv[3])
path.write_text(json.dumps({"score": score, "metrics": {"value": value}}), encoding="utf-8")
PY

echo "$score"
