# Inner-Worker Mode

## Concept

hone's outer loop (`optimize_repo_frontier`) drives a budget of *iterations*, each
calling `Worker.propose()` once.  The *inner-worker* extension lets one iteration
contain multiple scored attempts internally, so a capable coding agent can
self-correct within a single turn rather than waiting for the outer loop to
restart.

```
outer loop: budget iterations
  └─ each iteration: Worker.propose()
       └─ HarnessWorker: up to worker_budget scorer calls
```

## Budget semantics

| Flag | Meaning |
|------|---------|
| `--budget N` | outer-loop iterations (mutator calls) |
| `--worker-budget M` | max scorer calls per `Worker.propose()` call |

**Total grader invocations ≤ N × M.**

Within a single `propose()` call, the effective budget is
`min(worker_budget, scorer_budget)` where `scorer_budget` is passed in by
`repo_frontier` (the outer-loop's per-iteration budget).  This ensures the
outer loop retains control even if a worker is misconfigured.

## When to use inner-worker mode

Use `HarnessWorker` when:

- The agent is a capable coding-loop (claude-code, opencode, etc.) that benefits
  from intermediate feedback during its session.
- The grader is fast enough that M calls per iteration is affordable.
- You want the agent to self-select its best attempt rather than always taking
  the last commit.

Use `LocalWorker` (the default) when:
- You want exactly one grader call per iteration.
- The agent is a simple text mutator, not a coding loop.

## Scorer-readonly safety guarantee

If `scorer_readonly=True` (the default), the proxy:

1. Rejects any `HONE_GRADER_PATH` that resolves inside `HONE_WORKDIR` —
   the agent cannot substitute a fake grader by editing the workdir.
2. Computes `sha256(grader_bytes)` before and after each grader invocation.
   If they differ, the attempt is marked `notes="scorer-tamper"` and the
   policy decision is recorded in the budget file.

Tamper detection does not abort the run — the attempt is still recorded with
its score — but the notes field lets callers audit or discount tampered
attempts.

## Proxy protocol

`HarnessWorker.propose()` materializes a shell script at
`<run_dir>/.hone-scorer` and passes `HONE_SCORER_PROXY=<path>` in the
harness environment.  The agent can invoke it as `"$HONE_SCORER_PROXY"`.

Each proxy call:

1. `git stash push --include-untracked -m hone-worker-attempt-{N}` — snapshot.
2. `git stash apply stash@{0}` — show snapshot to grader.
3. `run_grader(HONE_GRADER_PATH, HONE_WORKDIR)` → `GraderResult`.
4. `git reset --hard HEAD && git clean -fd` — strip grader side effects.
5. `git stash apply stash@{0}` — restore agent's working state for next edit.
6. Decrement budget, append attempt record to budget file.
7. Print JSON envelope: `{"score", "submetrics", "attempt_idx", "remaining_budget"}`.

The stash is retained (step 5 uses `apply`, not `pop`) so every snapshot is
available for post-session restoration.

## Budget file format

Written at `<run_dir>/.hone-budget-<uid>.json`:

```json
{
  "remaining": 2,
  "attempts": [
    {
      "attempt_idx": 0,
      "score": 0.72,
      "submetrics": {"accuracy": 0.8, "latency": 0.6},
      "pushed": true,
      "stash_ref": "stash@{0}",
      "traces_path": null,
      "trace_stderr": "...",
      "raw_stdout": "...",
      "parsed_envelope": null,
      "notes": ""
    }
  ],
  "policy_decisions": []
}
```

`pushed=false` means the workdir had no changes at that call (no-op stash).
`notes="scorer-tamper"` indicates a readonly policy violation.

## Stash restoration (LIFO math)

After the harness session, stashes are ordered newest-first:

```
stash@{0}  = attempt N-1   (most recent push)
stash@{1}  = attempt N-2
...
stash@{N-1} = attempt 0
```

To restore attempt K (push position P among pushed stashes):

```
stash_ref = stash@{total_pushed - 1 - P}
```

This is identical to `repo_frontier._restore_best_stash`.  `HarnessWorker`
handles restoration itself before returning; `repo_frontier`'s
`_restore_best_stash` call is a no-op (stash_log is empty because
`scorer_fn` was never called).

## Worked example: autoresearch-style usage

```bash
hone optimize \
  --src ./myproject \
  --grader ./grade.py \
  --mutator harness:claude-code:sonnet \
  --worker harness:claude-code:sonnet \
  --budget 5 \
  --worker-budget 3
```

With `budget=5` and `worker_budget=3`, at most 15 grader calls occur.  Each
iteration the agent edits code, calls `$HONE_SCORER_PROXY` up to 3 times to
check intermediate scores, then exits.  hone selects the snapshot that scored
highest across those 3 attempts and commits it.

For example, `claude-code` might:
1. Make an initial edit → call proxy → score 0.52
2. Refine the edit → call proxy → score 0.71
3. Try a different approach → call proxy → score 0.65

hone picks attempt 1 (score 0.71), restores that snapshot, and commits it as
the iteration's candidate.

## Integration points for cli-config-docs

- `--worker harness:<adapter>[:<model>]` activates `HarnessWorker`.
- `--worker-budget N` sets `worker_budget` (default 1, same as LocalWorker).
- `--scorer-readonly / --no-scorer-readonly` controls the safety policy
  (default: readonly enforced).
- `resolve_worker(spec, mutator=..., worker_budget=N, scorer_readonly=True)`
  in `src/hone/workers/resolver.py` is the programmatic entry point.
