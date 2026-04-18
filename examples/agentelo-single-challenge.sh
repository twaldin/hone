#!/usr/bin/env bash
# Grader: runs ONE agentelo challenge and reports solve ratio.
#
# Usage: agentelo-single-challenge.sh <prompt-file>
#
# Environment:
#   HONE_CHALLENGE    — challenge ID (default: click-pr2421)
#   HONE_HARNESS      — agentelo harness (default: opencode)
#   HONE_MODEL        — model name (default: openai/gpt-5.4)
#   HONE_AGENTELO_DIR — agentelo repo path (default: ~/agentelo)
#
# Contract:
#   stderr: per-challenge trace for hone's reflective dataset
#   stdout: final float (score = tests_fixed / broken_by_bug) on last line

set -euo pipefail

PROMPT_FILE="${1:?usage: agentelo-single-challenge.sh <prompt-file>}"
CHALLENGE="${HONE_CHALLENGE:-click-pr2421}"
HARNESS="${HONE_HARNESS:-opencode}"
MODEL="${HONE_MODEL:-openai/gpt-5.4}"
AGENTELO_DIR="${HONE_AGENTELO_DIR:-$HOME/agentelo}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "grader: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

LOG_FILE="$(mktemp -t hone-grader.XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

cd "$AGENTELO_DIR"

# Run agentelo practice. Its stdout+stderr both go to a log file we scrape.
# We also forward stderr live so cairn/hone can see progress.
set +e
bin/agentelo practice \
  --challenge "$CHALLENGE" \
  --harness "$HARNESS" \
  --model "$MODEL" \
  --instructions "$PROMPT_FILE" \
  > "$LOG_FILE" 2>&1
PRACTICE_EXIT=$?
set -e

# Forward agentelo's last 40 lines of log to our stderr for monitoring.
tail -40 "$LOG_FILE" | sed 's/^/[agentelo] /' >&2

# Read agentelo's own result JSON (most recent for this challenge).
# Practice mode saves it to ~/agentelo/results/<run_id>.json.
RESULT_JSON=$(ls -t "$AGENTELO_DIR"/results/*-"$CHALLENGE"-*.json 2>/dev/null | head -1 || true)
# Fallback: parse stdout summary if JSON isn't found.
SUMMARY=$(grep -oE 'Tests fixed: [0-9]+/[0-9]+' "$LOG_FILE" | tail -1 || true)

if [[ -z "$SUMMARY" ]]; then
  echo "${CHALLENGE}: AGENTELO_FAILED (exit=$PRACTICE_EXIT) no summary line" >&2
  tail -5 "$LOG_FILE" | sed 's/^/[agentelo-fail] /' >&2
  echo "0.0"
  exit 0
fi

FIXED=$(echo "$SUMMARY" | sed -E 's|Tests fixed: ([0-9]+)/([0-9]+).*|\1|')
BROKEN=$(echo "$SUMMARY" | sed -E 's|Tests fixed: ([0-9]+)/([0-9]+).*|\2|')

# Check for REAL tampering (test file modifications), not just cache/build artifacts.
# If tampered_files in the JSON are all cache/__pycache__/.venv/.pytest_cache/.ruff_cache
# we treat it as false positive (practice-mode tamper detection is broader than the backend scorer).
REAL_TAMPER="NO"
if [[ -n "$RESULT_JSON" ]] && command -v jq >/dev/null 2>&1; then
  REAL_TAMPER=$(jq -r '
    (.tampered_files // [])
    | map(select(
        test("__pycache__") | not
        and (test("\\.pytest_cache/") | not)
        and (test("\\.ruff_cache/") | not)
        and (test("\\.venv/") | not)
        and (test("\\.mypy_cache/") | not)
        and (test("node_modules/") | not)
      ))
    | if length > 0 then "YES" else "NO" end
  ' "$RESULT_JSON" 2>/dev/null || echo "NO")
fi

if [[ "$REAL_TAMPER" == "YES" ]]; then
  echo "${CHALLENGE}: TAMPERED (real test-file mods) raw_fixed=$FIXED broken=$BROKEN" >&2
  echo "0.0"
  exit 0
fi

# Per-example trace for hone's reflective_dataset.
echo "${CHALLENGE}: $FIXED/$BROKEN fixed" >&2

# Score: solve ratio.
SCORE=$(awk -v f="$FIXED" -v b="$BROKEN" 'BEGIN { if (b+0 <= 0) { print "0.0000"; exit } printf "%.4f\n", f / b }')
echo "$SCORE"
