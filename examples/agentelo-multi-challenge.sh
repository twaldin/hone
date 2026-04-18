#!/usr/bin/env bash
# Grader: runs N agentelo challenges in parallel, reports MEAN solve ratio.
#
# Usage: agentelo-multi-challenge.sh <prompt-file>
#
# Environment:
#   HONE_CHALLENGES   — comma-separated list (default: qs-pr335,qs-pr201,click-pr2956)
#   HONE_HARNESS      — agentelo harness (default: opencode)
#   HONE_MODEL        — model name (default: openai/gpt-5.4)
#   HONE_AGENTELO_DIR — agentelo repo path (default: ~/agentelo)
#   HONE_PARALLEL     — max concurrent challenge runs (default: 3)
#
# Per-challenge wall-clock cap is enforced by hone's --grader-timeout (covers the
# whole batch). macOS lacks GNU `timeout`, so we don't impose a per-call cap here.
#
# Contract:
#   stderr: per-challenge trace lines (used by hone's reflective_dataset)
#   stdout: final float (mean score across challenges) on last line

set -uo pipefail

PROMPT_FILE="${1:?usage: agentelo-multi-challenge.sh <prompt-file>}"
CHALLENGES="${HONE_CHALLENGES:-qs-pr335,qs-pr201,click-pr2956}"
HARNESS="${HONE_HARNESS:-opencode}"
MODEL="${HONE_MODEL:-openai/gpt-5.4}"
AGENTELO_DIR="${HONE_AGENTELO_DIR:-$HOME/agentelo}"
PARALLEL="${HONE_PARALLEL:-3}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "grader: prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d -t hone-multi.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Single-challenge runner — captured per-challenge so we can run in parallel.
run_one() {
  local challenge="$1"
  local out_log="$WORK_DIR/${challenge}.log"
  local out_score="$WORK_DIR/${challenge}.score"

  cd "$AGENTELO_DIR"

  bin/agentelo practice \
    --challenge "$challenge" \
    --harness "$HARNESS" \
    --model "$MODEL" \
    --instructions "$PROMPT_FILE" \
    > "$out_log" 2>&1 || true
  local agentelo_exit=$?

  local result_json
  result_json=$(ls -t "$AGENTELO_DIR"/results/*-"$challenge"-*.json 2>/dev/null | head -1 || true)
  local summary
  summary=$(grep -oE 'Tests fixed: [0-9]+/[0-9]+' "$out_log" | tail -1 || true)

  if [[ -z "$summary" ]]; then
    echo "${challenge}: AGENTELO_FAILED (exit=$agentelo_exit)" >&2
    tail -3 "$out_log" 2>/dev/null | sed "s/^/[${challenge}-fail] /" >&2
    echo "0.0" > "$out_score"
    return 0
  fi

  local fixed broken
  fixed=$(echo "$summary" | sed -E 's|Tests fixed: ([0-9]+)/([0-9]+).*|\1|')
  broken=$(echo "$summary" | sed -E 's|Tests fixed: ([0-9]+)/([0-9]+).*|\2|')

  # Tamper detection (filter cache/build noise).
  local real_tamper="NO"
  if [[ -n "$result_json" ]] && command -v jq >/dev/null 2>&1; then
    real_tamper=$(jq -r '
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
    ' "$result_json" 2>/dev/null || echo "NO")
  fi

  if [[ "$real_tamper" == "YES" ]]; then
    echo "${challenge}: TAMPERED (test-file mods) raw_fixed=$fixed broken=$broken" >&2
    echo "0.0" > "$out_score"
    return 0
  fi

  local score
  score=$(awk -v f="$fixed" -v b="$broken" 'BEGIN {
    if (b+0 <= 0) { print "0.0000"; exit }
    s = f / b
    if (s > 1.0) s = 1.0
    if (s < 0.0) s = 0.0
    printf "%.4f\n", s
  }')
  echo "${challenge}: $fixed/$broken fixed → score=$score" >&2
  echo "$score" > "$out_score"
}

export -f run_one
export AGENTELO_DIR HARNESS MODEL PROMPT_FILE WORK_DIR

# Spawn all challenges with a concurrency cap.
IFS=',' read -ra CHALLENGE_ARR <<< "$CHALLENGES"
echo "multi-grader: starting ${#CHALLENGE_ARR[@]} challenges (parallel=$PARALLEL): ${CHALLENGES}" >&2

pids=()
for challenge in "${CHALLENGE_ARR[@]}"; do
  # Throttle: wait if we have $PARALLEL active jobs.
  while (( $(jobs -rp | wc -l) >= PARALLEL )); do
    sleep 5
  done
  run_one "$challenge" &
  pids+=($!)
done

# Wait for everyone.
for pid in "${pids[@]}"; do
  wait "$pid" || true
done

# Aggregate.
total=0
count=0
sum="0.0"
per_challenge_summary=""
for challenge in "${CHALLENGE_ARR[@]}"; do
  s_file="$WORK_DIR/${challenge}.score"
  if [[ -f "$s_file" ]]; then
    s=$(cat "$s_file")
    sum=$(awk -v a="$sum" -v b="$s" 'BEGIN{printf "%.6f", a+b}')
    per_challenge_summary+="${challenge}=${s} "
    count=$((count+1))
  else
    per_challenge_summary+="${challenge}=MISSING "
  fi
done

if (( count == 0 )); then
  echo "multi-grader: no challenges produced scores" >&2
  echo "0.0"
  exit 0
fi

mean=$(awk -v s="$sum" -v c="$count" 'BEGIN{printf "%.4f", s/c}')
echo "multi-grader: mean=$mean ($per_challenge_summary)" >&2
echo "$mean"
