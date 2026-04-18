#!/usr/bin/env bash
# Grader: runs ONE agentelo challenge and reports solve ratio.
#
# Usage: agentelo-single-challenge.sh <prompt-file>
#
# Environment:
#   HONE_CHALLENGE  — challenge ID (default: click-pr2421)
#   HONE_HARNESS    — agentelo harness (default: opencode)
#   HONE_MODEL      — model name (default: gpt-5.4)
#
# Requires: bin/agentelo on PATH with --instructions support (commit de0a891+).
#
# Contract:
#   stderr: per-challenge trace for hone's reflective dataset
#   stdout: final float (score = tests_fixed / broken_by_bug) on last line

set -euo pipefail

PROMPT_FILE="${1:?usage: agentelo-single-challenge.sh <prompt-file>}"
CHALLENGE="${HONE_CHALLENGE:-click-pr2421}"
HARNESS="${HONE_HARNESS:-opencode}"
MODEL="${HONE_MODEL:-gpt-5.4}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "grader: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

# Run agentelo practice (no leaderboard submission), capture its JSON result.
TMPDIR_GRADER="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_GRADER"' EXIT

RESULT_FILE="$TMPDIR_GRADER/result.json"

cd ~/agentelo
bin/agentelo practice \
  --challenge "$CHALLENGE" \
  --harness "$HARNESS" \
  --model "$MODEL" \
  --instructions "$PROMPT_FILE" \
  --json > "$RESULT_FILE" 2> >(tee "$TMPDIR_GRADER/agentelo-stderr.log" >&2)

# Parse result
TESTS_OK=$(jq -r '.tests_ok // 0' "$RESULT_FILE")
BASELINE=$(jq -r '.baseline_passing // 0' "$RESULT_FILE")
BROKEN=$(jq -r '.broken_by_bug // 1' "$RESULT_FILE")
TAMPERED=$(jq -r '.tampered // false' "$RESULT_FILE")

# tests_fixed = max(0, tests_ok - baseline_passing)
FIXED=$(( TESTS_OK - BASELINE ))
if (( FIXED < 0 )); then FIXED=0; fi
if [[ "$TAMPERED" == "true" ]]; then FIXED=0; fi

# Per-example trace for hone's reflective_dataset
if [[ "$TAMPERED" == "true" ]]; then
  echo "${CHALLENGE}: TAMPERED (credit revoked): raw_ok=$TESTS_OK baseline=$BASELINE" >&2
else
  echo "${CHALLENGE}: $FIXED/$BROKEN fixed (ok=$TESTS_OK baseline=$BASELINE)" >&2
fi

# Score: solve ratio
SCORE=$(awk -v f="$FIXED" -v b="$BROKEN" 'BEGIN { if (b <= 0) { print "0.0000"; exit } printf "%.4f\n", f / b }')
echo "$SCORE"
