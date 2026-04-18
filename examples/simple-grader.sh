#!/usr/bin/env bash
# Trivial example grader. Scores a prompt by counting "keyword" mentions.
# Usage: simple-grader.sh <prompt-path>
#
# This is intentionally dumb so you can smoke-test hone without burning
# real evaluation compute. Replace with your real grader (e.g. test pass rate,
# solve rate on a benchmark).

set -euo pipefail

PROMPT_PATH="${1:?usage: simple-grader.sh <prompt-path>}"

if [[ ! -f "$PROMPT_PATH" ]]; then
  echo "grader: prompt file not found: $PROMPT_PATH" >&2
  exit 1
fi

count=$(grep -ci "keyword" "$PROMPT_PATH" || true)

# stderr: per-example trace (hone parses these into reflective_dataset)
echo "keyword-count: $count mentions" >&2
echo "length-chars: $(wc -c < "$PROMPT_PATH") chars" >&2

# stdout: final score on last line (hone reads the LAST parseable float)
# Score = min(count / 5, 1.0)
score=$(awk -v c="$count" 'BEGIN { s = c / 5.0; if (s > 1.0) s = 1.0; printf "%.4f\n", s }')
echo "$score"
