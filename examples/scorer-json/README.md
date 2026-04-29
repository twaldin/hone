# scorer-json example

This example shows a scorer that writes rich JSON to `$HONE_RESULT_PATH` and still prints a float fallback on stdout.
It reads `counter.py`, maps `value = N` to score `N`, and emits `metrics.value` in the JSON payload.
Run locally: `./examples/scorer-json/scorer.sh /path/to/workdir`.
