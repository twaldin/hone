Previous reviewer failure feedback, if this is a retry:
unrelated fleet/local files and full test suite is not green

Implement the hone scorer + gates + metric/stall core. This is the foundation node — no CLI/UX/report changes here.

Files to create/modify (repo-relative paths only — work in your worktree):
- CREATE src/hone/scorer.py
- CREATE src/hone/gates.py
- MODIFY src/hone/repo_frontier.py
- MODIFY src/hone/storage.py
- MODIFY src/hone/grader.py (keep as a thin backwards-compatible shim that re-exports from scorer.py — do NOT delete; existing imports must keep working)
- CREATE tests/test_scorer.py
- CREATE tests/test_gates.py
- MODIFY tests/test_repo_frontier.py (add stall + gate-rejection + metric-direction cases; do NOT remove existing tests)

Scorer (src/hone/scorer.py):
- Define ScorerResult dataclass: raw_score: float, utility: float, trace_stderr: str, raw_stdout: str, returncode: int, metrics: dict, tasks: list, gate_results: list, json_path_used: bool.
- run_scorer(scorer: str|Path, workdir: str|Path, timeout_seconds: int = 3600, metric_direction: str = 'max', env: dict|None = None) -> ScorerResult.
- Invocation contract: invoked as `<scorer> <workdir>`. Two extra env vars are exported in addition to the parent env: HONE_RESULT_PATH (path to a tempfile the scorer MAY write JSON to) and HONE_TRACE_DIR (a tempdir the scorer MAY write per-task traces to). Both must exist before invocation. Use tempfile.NamedTemporaryFile/mkstemp + tempfile.mkdtemp inside a try/finally so they are cleaned up after parsing.
- Parsing rules:
  - If HONE_RESULT_PATH was written and contains valid JSON with a numeric 'score' field, take score from there. Optional fields: 'metrics' (dict), 'tasks' (list of dicts), 'utility' (float — if absent, derive). Set json_path_used=True.
  - Else fall back to legacy: parse last parseable float on stdout (existing _parse_score logic). Set json_path_used=False.
  - On non-zero exit, behavior matches legacy grader.py: return raw_score=0.0, preserve stderr trace, returncode=proc.returncode.
- Utility normalization: utility = raw_score if metric_direction == 'max' else -raw_score. Store both. Higher utility is always better internally.
- Reuse the timeout / GraderError-style error semantics — but expose a ScorerError alias (and re-export GraderError for back-compat). Do NOT change the legacy run_grader signature: src/hone/grader.py should `from hone.scorer import run_scorer, ScorerError as GraderError, ScorerResult as GraderResult` and define `run_grader = run_scorer` (or a thin wrapper that drops new kwargs). Existing tests/test_grader.py must continue to pass without edits.

Gates (src/hone/gates.py):
- Define GateSpec dataclass: name: str, command: str (a single shell-ready command line).
- Define GateResult dataclass: name: str, passed: bool, returncode: int, stdout: str, stderr: str, duration_s: float.
- run_gates(gates: list[GateSpec], workdir: Path, timeout_seconds: int = 600) -> list[GateResult]. Run sequentially via subprocess.run with shell=True, cwd=workdir. Nonzero return = passed=False. Bound stdout/stderr to ~4000 chars each. Catch TimeoutExpired and record passed=False with a synthetic stderr message.
- Provide rejected(results) -> bool helper: True if any GateResult.passed is False.

repo_frontier.py changes (THIS IS THE CRITICAL BUG-FIX AREA — review the aborted-run blockers carefully):
- Add new kwargs to optimize_repo_frontier (all with safe defaults so existing callers/tests still work):
    metric_direction: str = 'max'   # 'max' or 'min'
    stall: int | None = None         # None = disabled
    gates: list[GateSpec] | None = None
    scorer_path: Path | None = None  # alias accepted in addition to grader_path
  Treat scorer_path as authoritative when both passed; fall back to grader_path otherwise.
- Replace internal grader call with run_scorer; keep ScorerResult fields on RepoCandidate (extend RepoCandidate with raw_score, utility, gate_results — utility replaces score for ALL frontier/best comparisons internally; expose raw_score externally via candidates and run.json).
- Best/frontier comparisons MUST be on utility (so 'min' direction works). External-facing fields (best_score, run.json, RepoFrontierResult.best_score) must report raw_score for legacy compatibility — utility is internal only.
- Stall accounting (CRITICAL — the aborted run failed here):
    * Maintain iters_without_best_improvement counter. Reset to 0 only when a child's utility strictly exceeds the running best utility.
    * MUTATOR FAILURE counts as a completed non-improving iteration: increment stall counter, log to mutations.jsonl with 'kind': 'mutator_error', and check stall before continuing the loop.
    * GATE REJECTION counts as a completed non-improving iteration: do NOT update best/frontier with the rejected child, increment stall counter, log to mutations.jsonl with 'kind': 'gate_rejected' including the failing gate name(s), and check stall.
    * SCORER non-zero exit / parse failure that yields raw_score=0.0 still goes through normal accept-but-not-improve logic (counter increments unless 0 happens to beat best — same rule).
    * If iters_without_best_improvement >= stall (when stall is not None), break the loop after recording the iteration. Repeated gate/mutator failures CANNOT bypass --stall.
- Early-stop / actual-iteration accounting (CRITICAL):
    * Track completed_iterations as the count of for-loop iterations that ran (regardless of acceptance/error/gate). It is NOT the budget.
    * Persist manifest.status='stalled' (or 'done' if the natural budget completed) and manifest.total_iterations = completed_iterations.
    * Save manifest after every iteration (including failures/gate rejections) so a crashed run on disk reflects truth.
    * RepoFrontierResult.total_iterations = completed_iterations.
- Add gate evaluation step BEFORE updating best/frontier: after grading, if gates is non-empty, run gates against the child workdir (still on the child sha). If any gate fails, mark the child as gate_rejected (do not add to frontier, do not update best, increment stall, persist gate_results to mutations.jsonl).
- mutations.jsonl: keep existing seed/child/error rows; add 'gate_results' field on accepted child rows; add new 'kind': 'gate_rejected' rows; ensure 'frontier', 'iter', 'parent_idx' present on every row including the new ones. Persist 'utility' alongside 'parent_score'/'child_score' so the report node can render direction-aware curves.

storage.py changes:
- Extend RunManifest with optional fields: metric_direction: str = 'max', stall: int | None = None, completed_iterations: int = 0, status options now include 'stalled'.
- Keep total_iterations field but document (in dataclass docstring) that it equals completed_iterations on stall/early-stop, NOT budget. Update repo_frontier.py to set both consistently.

Tests (must run with `uv run pytest -q` green):
- tests/test_scorer.py:
    * Legacy fallback: scorer that only writes stdout float — parses correctly, json_path_used=False.
    * Rich JSON: scorer that writes {"score": 0.7, "metrics": {"x": 1}, "tasks": [{"id": "a", "score": 1.0}]} to $HONE_RESULT_PATH — parses score from JSON, populates metrics/tasks, json_path_used=True.
    * JSON malformed -> falls back to stdout float.
    * metric_direction='min' -> utility = -raw_score.
    * Non-zero exit -> raw_score=0.0, returncode preserved.
    * Tempfile cleanup: HONE_RESULT_PATH file removed after call.
- tests/test_gates.py:
    * All-pass gate list -> rejected()==False.
    * One failing gate -> rejected()==True; results carry returncode and stderr.
    * Timeout -> passed=False with synthetic message.
- tests/test_repo_frontier.py additions (use _EditingMutator-style fakes; no real harness):
    * Stall on mutator failure: a mutator that always raises MutatorError with stall=2 stops at exactly 2 completed iterations and result.total_iterations==2.
    * Stall on gate rejection: a passing scorer + a gate that always fails (e.g. `false`) with stall=2 stops at 2 and best_score equals seed score.
    * metric_direction='min': lower-is-better grader picks the lowest-scoring candidate as best.
    * Manifest on stall: run.json on disk after stall has status='stalled' and total_iterations equal to completed iterations.

Before signaling pass, inspect `git diff --name-status main...HEAD`. Revert/remove unrelated flt injection or local environment noise. Do not include CLAUDE.md, AGENTS.md, .flt/**, $FLT_RUN_DIR/handoffs/<node>.md, pyproject.toml, or uv.lock unless this node task explicitly requires them. Write handoffs under $FLT_RUN_DIR/handoffs/ instead of the project worktree.

Write a handoff markdown file under $FLT_RUN_DIR/handoffs/ summarizing: which files changed, the new public symbols (ScorerResult, GateSpec, run_scorer, run_gates, the new kwargs on optimize_repo_frontier), and a one-line note for the CLI node about how to wire --metric/--stall/--gate.

flt workflow pass when tests are green and your handoff is written under $FLT_RUN_DIR/handoffs/.