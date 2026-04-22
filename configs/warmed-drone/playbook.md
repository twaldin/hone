# hone mutator playbook

Task: edit files in this workdir to produce a candidate that scores higher on
the grader. Hone runs the grader after you exit — your job is just to make
the edit and hand back.

## Priority #1: Do not crash

The seed baseline scores {seed_score} — it works. Almost every regression in
this project comes from introducing crashes. A slow-but-stable candidate always
outscores a fast-but-crashed one. Before making ANY edit, ask: "Could this
break the core control loop?" If yes, make a SMALLER change or a DIFFERENT
change.

## How to choose what to change

1. **Understand the seed first.** Read the seed code before editing. Identify
   what keeps the system stable (the control flow, the safety bounds, the
   fallback logic). Your edit must not break these.

2. **Diagnose from traces.** Read `structured_traces` with focus on:
   - Crash reason and timing: `crashed=True` at gate 0 means you broke something
     fundamental. `crashed=True` at gate 3+ means a more targeted fix is possible.
   - `approach_angles`: values > 30° suggest overly aggressive steering.
   - `gates` passed: 0/N means the core loop is broken, not just tuning.
   - If NO traces show a clean run, the code is fundamentally broken — revert
     toward the seed's approach, don't try to tune parameters.

3. **Check recent_attempts for patterns.** If the last several attempts all
   crashed the same way, you are in a rut. Try one of:
   - Revert to a working baseline and make a DIFFERENT, smaller change.
   - Edit a DIFFERENT function or file.
   - Adjust an existing parameter instead of rewriting logic.

4. **Prefer parameter tuning over logic rewrites.** Changing a gain, threshold,
   or lookahead distance is safer than rewriting a control function. If you must
   rewrite logic, change ONE function and verify it handles the same edge cases.

## How to edit

- Make ONE focused change per iteration. Multiple changes make it impossible to
  know what helped or hurt.
- If `base_diff_stat` shows large changes from seed, consider whether some of
  those should be reverted — accumulated drift is a common crash source.
- Edits should be legible to a future iteration that reads the diff.

## Sanity check before exiting

- Confirm the code imports without errors.
- Trace through the main loop mentally for a simple case. If you can't convince
  yourself it handles a straight-line case, it will crash.
- If your sanity check fails, revert and try a smaller change. A working-but-
  worse candidate is always more useful than a broken one.