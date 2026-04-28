Decompose this hone final-form implementation into a parallel-execution plan.json.

Task: Implement the medium-scope hone final-form update based on the GEPAResearch comparison and human Q&A decisions.

Context:
- hone is a repository-state optimizer: candidate = git commit over a copied workdir; mutator = coding CLI agent via harness; scorer = user metric.
- GEPAResearch has useful product/workflow ideas to steal: scorer/gate separation, result JSON/traces, metric direction, stall stopping, run config/init/optimize UX, static observability/reporting, discover skill skeleton. Do NOT replace hone's core with GEPA.

Binding requirements:
1. UX
   - Keep existing one-shot command working: .
   - Add/prepare project-mode UX:  and  using saved config, with  still usable as one-shot sugar.
   - Rename user-facing concept to ; keep  as alias/deprecated compatibility.

2. Scorer protocol
   - Legacy scorer contract remains: command gets workdir path, stdout last parseable float is score, stderr is diagnostics.
   - Add optional rich JSON protocol via env vars, especially  and . If JSON exists, parse score/metrics/tasks from it; otherwise fallback to stdout float.
   - Store raw score and normalized utility.

3. Metric and stopping
   - Support metric direction .
   - Support : stop after N iterations without best utility improvement.

4. Gates
   - Add first-class gates as rejectors. Gate commands run against candidate workdir; nonzero gate rejects candidate regardless of scorer result.
   - Store gate results in run records. Keep implementation simple.

5. Static report
   - Add static report generation from run data, not a live dashboard. Markdown or HTML is fine. Include best score, iterations, frontier/best candidate, changed files, gate failures, score trend/traces as available.

6. Discover
   - Add skeleton/docs only for ; do not implement full autonomous benchmark construction.

7. Tests/examples
   - Add unit tests for scorer rich JSON/fallback behavior, gates, metric direction/stall/config as appropriate.
   - Add a tiny e2e smoke example/test if feasible.
   - Run ============================= test session starts ==============================
platform darwin -- Python 3.14.3, pytest-9.0.3, pluggy-1.6.0
rootdir: /Users/twaldin/hone
configfile: pyproject.toml
testpaths: tests
plugins: asyncio-1.3.0, anyio-4.13.0
asyncio: mode=Mode.AUTO, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collected 20 items

tests/test_grader.py .....                                               [ 25%]
tests/test_mutators.py ........                                          [ 65%]
tests/test_policy.py .....                                               [ 90%]
tests/test_repo_frontier.py ..                                           [100%]

============================== 20 passed in 1.89s ==============================.

Implementation notes:
- Existing important files: src/hone/cli.py, src/hone/repo_frontier.py, src/hone/grader.py, src/hone/storage.py, src/hone/policy.py, tests/.
- Prefer small, compatible edits. Avoid broad rewrites.
- No direct dependency on .
- No push/PR. Local implementation only.

## Hard user decisions (binding)
- Primary UX: support both one-shot `hone run` and project-mode `hone init` / `hone optimize`; `run` may be sugar over config/init/optimize but must keep current behavior.
- Scope: medium patch.
- Optimized unit: safe copied directory only; do NOT switch to in-repo worktrees.
- GEPA: do NOT add a direct `gepa.optimize_anything` dependency; steal concepts only.
- Naming: migrate to `scorer`, keep `--grader` as backwards-compatible alias.
- Scorer protocol: legacy stdout-last-float plus optional `$HONE_RESULT_PATH` JSON.
- Gates: first-class rejectors.
- Metric/stopping: implement `max|min` score direction and stall stopping.
- Reporting: static report only, no live dashboard.
- Discover: skeleton/docs only, not real autonomous benchmark construction.
- Acceptance: existing `hone run --dir X --grader ./g.sh` works; add unit tests for scorer/gates/config; add tiny e2e smoke; no PR/push.

## Path discipline
Each per-node task will run in its own git worktree. Reference files by repo-relative paths only. Do not use absolute paths.

Output plan.json in your worktree root with shape:
{
  "default_preset": "<preset>",
  "nodes": [
    {"id": "<slug>", "preset": "<optional>", "task": "...", "depends_on": []}
  ]
}

Presets available:
- pi-coder: good for focused Python/tests/docs edits
- cc-coder: good for multi-file design-sensitive changes
- codex-coder: good alternative focused coder
- gemini-coder: good for broad context scans
- opencode-coder: lighter alternative

Aim for 4-6 nodes. Split by dependency boundaries: scorer/gates core, config/CLI, report, discover/docs, tests/examples if useful. Each node must specify exact file paths and tests. Each node task MUST end with: "flt workflow pass when tests are green and your coder.md handoff is written."

flt workflow pass when plan.json is written and validates against the schema.
