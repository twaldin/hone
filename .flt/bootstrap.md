Previous reviewer failure feedback, if this is a retry:
unrelated fleet/local files and full test suite is not green

Generate a static (Markdown) report from a completed hone run directory. NOT a live dashboard. Read-only over `<run_dir>/run.json`, `<run_dir>/mutations.jsonl`, and `<run_dir>/traces/`.

Files to create/modify:
- CREATE src/hone/report.py
- MODIFY src/hone/cli.py (add a `hone report` command; coordinate with the cli-config-integration node — your edits should be additive and avoid clobbering its changes)
- CREATE tests/test_report.py

Report (src/hone/report.py):
- generate_report(run_dir: Path) -> str: returns Markdown text.
- Sections (in order):
    1. Header: run id, status (running/done/stalled/error/cancelled), metric_direction, budget vs total_iterations (note explicitly when stalled).
    2. Best candidate: idx, sha (short), raw score, utility, branch.
    3. Iteration summary: a small Markdown table — iter | parent | child | parent_score | child_score | delta | kind (accepted/mutator_error/gate_rejected) | changed_files_short.
    4. Score trend: an inline ASCII sparkline (e.g. unicode block chars `▁▂▃▄▅▆▇█`) over child_score across iterations; skip iters with no child_score.
    5. Frontier evolution: final frontier indices + scores.
    6. Gate failures: for any gate_rejected rows, list iter, gate name(s), short stderr.
    7. Changed files (top 10 by frequency across accepted iterations).
- write_report(run_dir: Path, output: Path) -> Path: writes the Markdown to output (creates parent dirs). If output is a directory, write `<output>/report.md`.
- Tolerate missing files (no traces dir, no gate rows, run still running) — degrade sections gracefully instead of erroring.

CLI (src/hone/cli.py — additive):
- Add `hone report` command: --run <run_dir> (required, must exist), --output <path> (default <run_dir>/report.md), --stdout flag (print to stdout instead of writing).
- IMPORTANT: pull the up-to-date cli.py from the cli-config-integration branch via git rebase/merge BEFORE editing if that node has landed. Otherwise edit additively in a clearly bounded section near the bottom of cli.py.

Tests:
- tests/test_report.py: build a tiny synthetic run dir on disk (write run.json + mutations.jsonl with a few rows including one mutator_error and one gate_rejected). Assert the rendered Markdown contains: status, best score, the ascii sparkline, and a 'gate_rejected' row.

Before signaling pass, inspect `git diff --name-status main...HEAD`. Revert/remove unrelated flt injection or local environment noise. Do not include CLAUDE.md, AGENTS.md, .flt/**, $FLT_RUN_DIR/handoffs/<node>.md, pyproject.toml, or uv.lock unless this node task explicitly requires them. Write handoffs under $FLT_RUN_DIR/handoffs/ instead of the project worktree.

Write a handoff markdown file under $FLT_RUN_DIR/handoffs/ summarizing: report sections, the input files it reads, and any new CLI surface added.

flt workflow pass when tests are green and your handoff is written under $FLT_RUN_DIR/handoffs/$FLT_AGENT_NAME.md.