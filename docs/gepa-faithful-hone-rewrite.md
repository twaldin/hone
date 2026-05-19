# GEPA-faithful Hone rewrite plan

## Goal

Rewrite Hone around `@twaldin/gepa-ts` `optimize_anything` semantics as the optimizer source of truth. Hone should preserve its purpose, which is making coding CLIs useful as mutators, but it should stop owning a separate optimizer.

The target architecture is:

1. `gepa-ts` owns candidate pools, train/val examples, reflective proposal, parent selection, Pareto frontier, budget accounting, acceptance, callbacks, and result shape.
2. Hone owns a default `harness` adapter that materializes a candidate code state, asks a harness agent to mutate it once, commits the result, and returns the new immutable code-state handle.
3. Evaluation is a normal GEPA evaluator. The default evaluator runs the project test command and returns pass/fail plus speed as `side_info.scores`.

The rewrite should delete or demote any local optimization behavior that competes with GEPA semantics.

## Current divergence

`src/hone/repo_frontier.py` is currently the optimizer. It copies a repository into a managed git workspace, chooses a parent, runs a worker, commits the mutation, scores it, and updates local candidate state.

That is close in spirit, but not faithful enough:

- `RepoCandidate` is a Hone-specific candidate record with `raw_score`, `utility`, trace fields, diffs, gate results, and submetrics.
- `_update_frontier()` keeps a scalar top-k sorted by `(utility, -idx)` and truncates to `frontier_size`; it is not GEPA Pareto-front bookkeeping.
- `_select_parent()` is a local ranked/window heuristic, not GEPA's candidate selector over Pareto-front coverage.
- `HarnessWorker` gives the coding agent an inner scorer proxy, then selects the best inner attempt. That turns the mutator into a second optimizer.
- `policy.py` starts from the optimize-anything reflection prompt but layers on a separate playbook, memory packet, ACE reflection, operational constraints, and prompt knobs.
- `scorer.py` already returns useful `score`, `metrics/submetrics`, `traces`, and JSON envelopes, but Hone interprets them in its own loop instead of returning them through GEPA `side_info`.

These pieces are migration raw material, not the final optimizer.

## GEPA concepts Hone must delegate or port exactly

### Candidate

Use the GEPA candidate shape, not `RepoCandidate`, as the optimizer-facing record.

For code mutation, the seed candidate should be a multi-component `Candidate` object. Minimum viable shape:

```ts
type HoneCodeCandidate = {
  commit_sha: string;
  instructions: string;
};
```

`commit_sha` is the immutable artifact handle. `instructions` is the mutable component that GEPA reflection/proposal can rewrite. If later versions need multiple mutable components, add named components such as `edit_strategy`, `test_strategy`, or `risk_policy`; do not hide them in Hone-specific state outside the candidate.

GEPA remains free to store candidates as `Record<string, string>`. Hone adapter code can wrap/unwrap the string fields into a richer internal `CodeState` record, but optimizer state must remain GEPA state.

### Dataset and valset

Use GEPA's dataset/valset model directly.

Default dataset item:

```ts
type HoneTaskExample = {
  id: string;
  repo_path: string;
  base_commit: string;
  test_command: string;
  prompt?: string;
  timeout_seconds?: number;
};
```

For the first slice, `dataset` and `valset` may both contain one example for the target repository. That is still GEPA-shaped: the evaluator receives `(candidate, { example, opt_state })`, evaluates the candidate against an example, and returns a score plus `side_info`.

Future benchmark mode can provide many examples: different tasks, repos, base commits, test commands, seeds, or fixture branches. The important constraint is that Hone does not invent a parallel task scheduler outside GEPA.

### Evaluator

Use `gepa-ts` evaluator semantics:

```ts
type EvalResult = number | [number, SideInfo];
```

Hone's default evaluator should:

1. Check out `candidate.commit_sha` in an isolated worktree for the `example`.
2. Run `example.test_command`.
3. Measure duration.
4. Return a scalar score and `side_info`.

Recommended default score:

```ts
score = tests_passed ? 1 + speed_bonus : 0;
speed_bonus = clamp((baseline_seconds - candidate_seconds) / baseline_seconds, -0.25, 0.25);
```

This keeps the primary objective obvious: pass tests first, then get faster. Failed tests should never outrank passing tests.

### `side_info.scores`

The evaluator must return objective scores through `side_info.scores` so GEPA can maintain non-degenerate Pareto fronts.

Default `side_info`:

```ts
{
  scores: {
    pass: tests_passed ? 1 : 0,
    speed: speed_score,
    changed_files: changed_files_score
  },
  test_command,
  duration_seconds,
  exit_code,
  stdout_tail,
  stderr_tail,
  changed_files,
  commit_sha
}
```

`pass` and `speed` are required. `changed_files` is optional but useful as a pressure against huge edits; if included it must be normalized so higher is better.

GEPA extracts top-level `side_info.scores` and component-specific `<component>_specific_info.scores`. Hone should start with top-level scores only, then add component-specific scores only if multiple candidate components need different feedback.

### Pareto frontier

Do not port Hone's scalar frontier. Use GEPA state:

- `program_candidates`
- `prog_candidate_val_subscores`
- `prog_candidate_objective_scores`
- `program_at_pareto_front_valset`
- `program_at_pareto_front_objectives`
- selected `frontier_type`

Default `frontier_type` should be `hybrid` once `side_info.scores` is present, because Hone cares about both per-example test performance and objective tradeoffs. Use `instance` only for compatibility if objective scores are missing.

### Reflection LM and proposer

Use `gepa-ts` `reflection_lm` and `ReflectiveMutationProposer`.

Hone should not keep `ace.py`, `memory_packet.py`, or a separate reflective policy loop in the GEPA-faithful path. If Hone needs domain context, pass it as `objective` / `background` or a GEPA-compatible `reflection_prompt_template`. Do not combine both paths in a way that conflicts with `gepa-ts` config validation.

For code mutation, the GEPA proposal is not "edit files directly." It proposes a new candidate component, usually improved `instructions`. The harness adapter then uses that proposed candidate to produce a new commit.

### Budget and metric calls

Use `config.engine.max_metric_calls` as the real evaluation budget. A metric call is one evaluator invocation against one example.

Remove `worker_scorer_budget` from the faithful path. A harness agent should not call the scorer proxy multiple times inside a single proposal. If an agent needs a sanity check, it can run cheap local commands, but GEPA owns metric calls and promotion.

Track CLI cost/tokens as metadata in `side_info`, callbacks, or tracker tables. Do not treat mutator token spend as metric-call budget.

### Result shape

Expose the GEPA result directly, with a thin Hone summary.

Required result fields:

- `best_candidate`
- `best_idx`
- `candidates`
- `val_aggregate_scores`
- `val_subscores`
- `val_aggregate_subscores`
- `total_metric_calls`
- `run_dir`

Hone can add:

- `best_commit_sha`
- `best_worktree_path`
- `best_changed_files`
- `harness_runs`

But these should derive from GEPA candidates and `side_info`, not from a separate Hone manifest.

## Mapping coding CLI mutators to GEPA reflection/proposal

The mutator boundary should be:

```text
GEPA reflection/proposer:
  current candidate + side_info -> improved candidate text fields

Hone harness adapter:
  improved candidate text fields + parent commit + task example -> child commit

GEPA evaluator:
  child commit + task example -> score + side_info
```

This means a coding CLI mutator is not the GEPA proposer. The coding CLI is the executor for a proposed candidate.

Recommended first implementation:

1. Seed candidate has `commit_sha=<base commit>` and `instructions=<initial edit instructions>`.
2. GEPA proposes a new `instructions` value using reflective feedback.
3. Hone `harness` adapter checks out the parent `commit_sha`, writes harness instructions via the harness contract, runs the selected CLI once, commits resulting file changes, and returns a candidate with the new `commit_sha` and proposed `instructions`.
4. GEPA evaluates that child candidate on the valset.

If this requires a `custom_candidate_proposer`, implement it with the `ProposalFn` contract from `gepa-ts`: given the current `Candidate`, reflective dataset, and component names to update, return the next candidate text fields as a `Candidate` object. The same applies to `adapter.propose_new_texts`. `gepa-ts` wraps those returned candidate fields into a `CandidateProposal` internally in `proposer.ts`; do not imply full `CandidateProposal` control unless using a different GEPA extension point. Do not reintroduce `RepoFrontier`.

## Default adapter: `harness`

The default adapter name is `harness`. It should use the existing harness public contract in both languages:

- Python: `RunSpec`, `run`, `run_async`, `build_command`, `parse_output`
- TypeScript: `RunSpec`, `run`, `runAsync`, `buildCommand`, `parseOutput`

Adapter config:

```toml
[adapter.harness]
harness = "codex"
model = "gpt-5.5"
timeout_seconds = 1800
```

Internal flow:

1. Create an isolated git worktree from `parent_commit_sha`.
2. Build a `RunSpec` with:
   - `harness`
   - `model`
   - `workdir`
   - `prompt` from the GEPA-proposed candidate instructions plus task context
   - optional `instructions`
   - env from adapter config
3. Call Python `harness.run()` from the current Python CLI path, or call `@twaldin/harness-ts` if/when the Hone runtime moves to TypeScript.
4. Commit all resulting changes with a deterministic message such as `hone candidate <iteration>`.
5. Return `commit_sha`, token/cost telemetry, stdout/stderr tails, and changed files.

The stable contract to prefer today is the shared harness `RunSpec` / `RunResult` API documented in `/Users/twaldin/harness/SPEC.md`. Python is the smallest integration path for the current Hone repo; TypeScript parity should be tested with the same fixture contract before making TS the primary runtime.

## Default evaluation behavior

The default evaluator is `test_command`.

Config:

```toml
[evaluate]
command = "pytest -q"
timeout_seconds = 600
baseline_commit = "HEAD"
```

Behavior:

1. Run the command once on the baseline commit to establish `baseline_seconds` and baseline pass/fail.
2. For each candidate, run the command in the isolated candidate worktree.
3. Return:
   - scalar score: pass/fail plus speed bonus
   - `side_info.scores.pass`
   - `side_info.scores.speed`
   - command output tails
   - duration
   - exit code
4. If the command times out, return score `0` and `side_info.error = "timeout"`.

The evaluator should not run style gates, hidden gates, or scorer proxies by default. Additional checks can be modeled as extra dataset examples or explicit objective scores.

## CLI and API migration plan

### New API

Add a new module, likely `src/hone/gepa_faithful.py` initially:

```py
def optimize_code(
    *,
    repo_path: Path,
    test_command: str,
    harness: str = "codex",
    model: str | None = None,
    max_metric_calls: int = 20,
    reflection_lm: Callable[[str], Awaitable[str]],
    objective: str | None = None,
    background: str | None = None,
) -> HoneGepaResult:
    ...
```

If Python calls into `@twaldin/gepa-ts`, use a narrow subprocess/IPC boundary and keep the serialized config close to the `optimize_anything` API. If Hone moves to TypeScript, make this a direct `optimize_anything` wrapper.

### CLI

Add a new command first:

```bash
hone gepa run --dir . --test "pytest -q" --harness codex --model gpt-5.5 --max-metric-calls 20
```

Keep existing `hone run` temporarily as legacy. After the new path is stable:

1. Make `hone run` call the GEPA-faithful implementation.
2. Move old `repo_frontier` behavior behind `hone legacy run`.
3. Remove `--frontier-size`, `--ace-interval`, `--worker-scorer-budget`, and inner-loop scorer proxy options from the default path.
4. Replace `--budget` with `--max-metric-calls`.
5. Replace `--scorer` with `--test-command` for default use, while allowing an advanced custom evaluator script later.

### Config

New config shape:

```toml
[gepa]
max_metric_calls = 20
frontier_type = "hybrid"
seed = 0

[reflection]
model = "..."
objective = "Make the project tests pass, then improve speed."
background = "Coding CLI mutates git worktrees."

[adapter.harness]
harness = "codex"
model = "gpt-5.5"
timeout_seconds = 1800

[evaluate]
command = "pytest -q"
timeout_seconds = 600
```

## Focused tests

Add tests in small slices.

1. Candidate serialization:
   - `commit_sha` and `instructions` round-trip through GEPA candidate shape.
   - invalid/missing commit is rejected before harness execution.

2. Harness adapter:
   - fake harness runner mutates a temp git repo once.
   - adapter commits the change and returns a new `commit_sha`.
   - no scorer proxy env vars are exposed in faithful mode.
   - token/cost telemetry is copied into side info metadata.

3. Default evaluator:
   - passing command scores above failing command.
   - faster passing candidate beats slower passing candidate.
   - failing fast candidate does not beat passing slow candidate.
   - timeout returns score `0` and error side info.

4. GEPA integration:
   - fake `reflection_lm` proposes improved instructions.
   - fake harness applies a deterministic edit.
   - `optimize_anything` result includes the accepted child candidate.
   - result exposes `best_commit_sha` derived from `best_candidate`.

5. CLI:
   - `hone gepa run --dir --test --max-metric-calls` builds the expected config.
   - legacy `hone run` still routes to current implementation until the migration flip.
   - after the flip, `hone run` rejects removed inner-loop options with a clear message.

6. Parity guard:
   - fixture-level test that the `harness` adapter uses only `RunSpec` / `RunResult` fields present in both Python harness and `@twaldin/harness-ts`.

## Implementation slices

1. Add GEPA dependency boundary.
   - Decide whether current Hone calls `@twaldin/gepa-ts` through a subprocess runner or starts a TS package migration.
   - Add a minimal `optimize_anything` smoke test with a fake evaluator and fake reflection LM.

2. Add code-state candidate model.
   - Implement commit-backed candidate encode/decode.
   - Add isolated git worktree helpers.

3. Add default test-command evaluator.
   - Port existing `scorer.py` JSON envelope parsing where useful.
   - Return `side_info.scores.pass` and `side_info.scores.speed`.

4. Add faithful harness adapter.
   - Use harness `RunSpec`.
   - Run one CLI mutation per GEPA proposal.
   - Commit the result.
   - Remove scorer proxy from this path.

5. Wire `hone gepa run`.
   - Generate GEPA config.
   - Surface GEPA result plus `best_commit_sha`.
   - Write run artifacts from GEPA state, not a Hone-only manifest.

6. Flip default CLI after tests cover the new path.
   - Keep `repo_frontier.py` only as legacy until deleted.
   - Remove ACE/memory-packet/local-frontier concepts from docs and defaults.

## Non-goals for the first rewrite

- No dashboard.
- No new optimizer loop.
- No multi-attempt scorer proxy inside a harness session.
- No custom Pareto implementation in Hone.
- No broad rewrite of harness itself.
- No hidden benchmark scheduler outside GEPA dataset/valset.
