Previous reviewer failure feedback, if this is a retry:
unrelated .flt files committed and full test suite fails

Wire the new scorer/gates/metric/stall machinery into the CLI and add project-mode UX (`hone init` / `hone optimize`). The aborted predecessor run failed on this node specifically because CLI tests launched a real harness/mutator and because retry rounds re-introduced the same blockers — read the retry context above carefully and DO NOT regress these guarantees.

Files to create/modify (repo-relative paths only):
- CREATE src/hone/config.py
- MODIFY src/hone/cli.py
- CREATE tests/test_config.py
- CREATE tests/test_cli.py

Config (src/hone/config.py):
- Define HoneConfig dataclass with the fields necessary for an `optimize` invocation: src_dir: str, scorer: str, mutator: str = 'harness:claude-code:sonnet', budget: int = 20, scorer_timeout: int = 3600, frontier_size: int = 4, objective: str = 'Improve the repository so the scorer score increases.', metric_direction: str = 'max', stall: int | None = None, gates: list[dict] = []  # each {name, command}, ace_interval: int = 0, ace_model: str = '', policy_dir: str | None = None.
- Use stdlib tomllib for read (python 3.11+) and a tiny hand-rolled writer (or `tomli_w` if already in pyproject — DO NOT add a new dependency without checking pyproject.toml first; if absent, write a small writer that handles the flat-ish HoneConfig schema we need).
- File location: hone.toml at the project root by default. Provide load_config(path: Path|None) and save_config(cfg: HoneConfig, path: Path) helpers.
- Validation: load_config raises ValueError with a clear message on missing required fields or unknown metric_direction.

CLI (src/hone/cli.py):
- Rename the user-facing concept to 'scorer'. Keep `--grader` as a backwards-compatible alias on `hone run` (typer Option that maps to the same variable; emit a one-line stderr deprecation note when --grader is used but only if --scorer is not also given). The legacy invocation `hone run --dir X --grader ./g.sh ...` MUST still work unchanged.
- Update `hone run` Options: add `--scorer` (preferred), keep `--grader` as alias, add `--stall N` (int, default None/0=disabled), `--metric` choice('max','min', default 'max'), `--gate` (multi: typer Option(list) format 'name=command' or 'name:command'; parse into list[GateSpec]). Pass them through to optimize_repo_frontier.
- Add `hone init`:
    * typer command that interactively (or via flags — accept all fields as flags too so it is scriptable) writes hone.toml in cwd or --to.
    * If hone.toml already exists, refuse to overwrite unless --force.
- Add `hone optimize`:
    * Reads hone.toml (--config <path> override) and runs the same optimize_repo_frontier flow that `hone run` runs. Effectively the body of `run` factored into a private helper `_run_optimize(cfg: HoneConfig, *, output: Path|None, resume: Path|None)` that BOTH `run` and `optimize` call. `run` becomes sugar that constructs a HoneConfig from CLI flags and calls _run_optimize.
- Reporting: the existing rich Panel output should print `total_iterations` from RepoFrontierResult (which is now the actual completed count on stall — do NOT pretend the budget was reached). Append a `[yellow]stalled after N iters[/yellow]` line when the run stopped early due to --stall.

Tests — CRITICAL CONSTRAINT (the aborted run died here):
- tests/test_cli.py MUST NOT spawn a real coding-agent harness or call optimize_repo_frontier with a real mutator. Use typer.testing.CliRunner.
- Monkeypatch BOTH `hone.cli.resolve_mutator` (return a stub object with `propose_edit_mode` that returns a MutatorResult) AND `hone.cli.optimize_repo_frontier` (return a fake RepoFrontierResult). Verify the CLI:
    * Accepts and forwards --scorer.
    * Accepts --grader as an alias when --scorer is absent.
    * Forwards --stall, --metric, --gate to the optimize call (assert-on-call args).
    * Refuses --metric values outside {'max','min'}.
    * `hone init` writes hone.toml with the expected fields.
    * `hone optimize` reads hone.toml and calls the (monkeypatched) optimize function.
    * `hone run` still works with the original `--dir X --grader ./g.sh` invocation form.
- tests/test_config.py: round-trip save_config/load_config; rejection of unknown metric_direction; missing required field error.

Before signaling pass, inspect `git diff --name-status main...HEAD`. Revert/remove unrelated flt injection or local environment noise. Do not include CLAUDE.md, AGENTS.md, .flt/**, $FLT_RUN_DIR/handoffs/<node>.md, pyproject.toml, or uv.lock unless this node task explicitly requires them. Write handoffs under $FLT_RUN_DIR/handoffs/ instead of the project worktree.

Write a handoff markdown file under $FLT_RUN_DIR/handoffs/ summarizing: new CLI commands and flags, hone.toml schema, and the monkeypatch points used by CLI tests so the e2e-smoke node can mirror them.

flt workflow pass when tests are green and your handoff is written under $FLT_RUN_DIR/handoffs/$FLT_AGENT_NAME.md.