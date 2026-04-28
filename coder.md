# Coder Handoff

## Files changed

**Created:**
- `src/hone/scorer.py` — new scorer module
- `src/hone/gates.py` — new gates module
- `tests/test_scorer.py` — scorer tests (8 tests)
- `tests/test_gates.py` — gates tests (5 tests)

**Modified:**
- `src/hone/grader.py` — thin shim; re-exports from scorer.py
- `src/hone/storage.py` — `RunManifest` gains `metric_direction`, `stall`, `completed_iterations`; status gains `'stalled'`
- `src/hone/repo_frontier.py` — major rewrite of main loop
- `tests/test_repo_frontier.py` — 4 new test cases added; existing tests unchanged

## New public symbols

### `hone.scorer`
- `ScorerError` — raised on bad scorer or unparseable output; re-exported from `hone.grader` as `GraderError`
- `ScorerResult` — dataclass: `raw_score`, `utility`, `trace_stderr`, `raw_stdout`, `returncode`, `metrics`, `tasks`, `gate_results`, `json_path_used`. Has `.score` property (alias for `raw_score`) for backward compat.
- `run_scorer(scorer, workdir, timeout_seconds=3600, metric_direction='max', env=None) -> ScorerResult`

### `hone.gates`
- `GateSpec` — dataclass: `name: str`, `command: str`
- `GateResult` — dataclass: `name`, `passed`, `returncode`, `stdout`, `stderr`, `duration_s`
- `run_gates(gates, workdir, timeout_seconds=600) -> list[GateResult]`
- `rejected(results) -> bool` — True if any gate failed

### `hone.repo_frontier` new kwargs on `optimize_repo_frontier`
- `metric_direction: str = 'max'` — `'min'` flips utility so lower raw_score wins
- `stall: int | None = None` — stop after N iters without improvement; mutator errors and gate rejections count
- `gates: list[GateSpec] | None = None` — gates evaluated before frontier/best update
- `scorer_path: Path | None = None` — overrides `grader_path` when provided

## CLI node wiring note

Wire these CLI flags:
- `--metric-direction [max|min]` → `metric_direction`
- `--stall N` → `stall=N`
- `--gate NAME:CMD` (repeatable) → build `GateSpec(name, command)` list → `gates`
- `--scorer PATH` → `scorer_path`

## Risk / reviewer focus

- `_update_frontier` now sorts on `utility` not `raw_score` — correct for min direction, verify frontier is stable.
- Stall counter resets to 0 only on strict utility improvement; gate rejection and mutator error both increment it.
- `manifest.completed_iterations` and `manifest.total_iterations` are both set after every iteration including failures.
- `_load_resume_state` derives utility from `rec.get("utility", ...)` to handle old jsonl format gracefully.
- `GraderResult.score` property works via `ScorerResult.score` → `raw_score`; all existing grader tests pass.
