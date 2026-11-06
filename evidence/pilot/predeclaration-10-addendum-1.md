# Predeclaration 10 addendum 1: locally pinned infrastructure rerun

Commit this addendum before any new search call. The assistant authorized this resumption around `2026-11-06T10:20Z`. This is infrastructure rerun **1 of at most 2** for this search campaign, applying the predeclaration-7 infrastructure allowance under that explicit ruling. It does not authorize a measured-gate retry or another automatic attempt.

## Proven infrastructure cause

The assistant established that our own `omp-update` rolled every seat to omp 18.17.0 during the original run. The frozen version guard at `pilot/runtime.py:434-435` refuses any version except 18.16.0 with `Pilot requires omp 18.16.0`.

| Event, 2026-11-06 UTC | Time |
| --- | --- |
| Seed-1 MBPP/GEPA finished | 08:59:22Z |
| `omp-update` rolled global installations to 18.17.0 | About 09:05Z |
| Installed CLI file birth time | 09:05:40.977Z |
| Seed-1 MBPP/plain startup failed | 09:06:14Z |
| Seed-1 HoVer/Hone startup failed | 09:06:21Z |

The updater event and causal attribution are the assistant's supplied finding, not a new provider experiment. The retained [post-stop file metadata](selection-reuse-10/runtime-stop.json) corroborates the ordering. Its earlier inference label remains an unchanged historical observation. The ruling establishes the cause now. Both failures occurred before ModelCalls and have zero recorded calls. They are infrastructure aborts, not refusals or measured search failures.

The two completed seed-1 MBPP cells, Hone and official GEPA, ran entirely on 18.16.0 and stand as measured. Their raw files and scores remain unchanged. Preserve the entire [original attempt](seeds12-search-10/README.md), including both startup failures. Its stopped status is not erased.

## Local runtime and admission

Install `@oh-my-pi/pi-coding-agent@18.16.0` with an exact-version local npm install under `.pilot-cache/omp-18.16.0`. The runner prepends `$PWD/.pilot-cache/omp-18.16.0/node_modules/.bin` to PATH. The unchanged `pilot/runtime.py` resolves that CLI for both usage commands and Gateway; the unchanged gateway resolves its SDK imports relative to that local CLI's real path. No global omp, auth broker, omp configuration or update schedule changes are allowed.

The real [zero-call admission](runtime-rerun-10/admission.json) passed on the local copy. The strict 18.16.0 ready-frame check passed; runner and gateway selected the same local executable. The core SDK packages are all 18.16.0. The route hash remains `sha256:97208618086a8e7170f8dd26bd24518180e523fddfc4af6ce810cc3e46f21173`. The OAuth-only pool remains gmail.com x2 plus purdue.edu x1, with API keys forbidden and lindy.ai excluded; its hash remains `sha256:c95157948a5b83be8e349005855a8d58dacb7f2fbe5eb9eab0260139ff02d97b`. All execution-source hashes match the original predeclaration-10 admission. The admitted HoVer index was reused and verified by panel admission, not rebuilt.

The [admission script](runtime-rerun-10/admit.py) made zero gateway requests and zero model calls. Retain the [exact dependency lock](runtime-rerun-10/package-lock.json), its hash, the CLI hash and package versions. A missing or changed pinned CLI or lock stops dispatch rather than falling back to global omp.

## Remaining cells and stop accounting

Use a fresh `.pilot-runs/pilot-seeds12-10-rerun1` root and a named systemd user unit with `Restart=no`, CPU 6, nice 10, one-thread settings and explicit `NLTK_DATA`. Set Nice only through the unit, without an additive outer nice wrapper. The [rerun dispatcher](runtime-rerun-10/run.py) uses the unchanged pilot admission, `search_one`, spend reporting and stop checks. Copy and hash-verify only the two completed cells into their matrix paths. Do not call their searches again or resume either interrupted cell directory.

Run the remaining ten cells serially in this order:

| Order | Seed | Task | Method |
| --- | --- | --- | --- |
| 1 | 1 | MBPP | Plain |
| 2 | 1 | HoVer | Hone |
| 3 | 1 | HoVer | Official GEPA |
| 4 | 1 | HoVer | Plain |
| 5 | 2 | MBPP | Hone |
| 6 | 2 | MBPP | Official GEPA |
| 7 | 2 | MBPP | Plain |
| 8 | 2 | HoVer | Hone |
| 9 | 2 | HoVer | Official GEPA |
| 10 | 2 | HoVer | Plain |

The authorization permits exactly one dispatch across the already-triggered infrastructure stop. Carry all four original attempt rows into chronological `attempts.json`, including their usage and pause accounting and the two-failure streak. If the first new cell infrastructure-aborts, it is the third consecutive failure and dispatch stops immediately. After a successful cell, the original stop rules remain unchanged, including two consecutive later infrastructure failures, hidden attempts over 1%, unknown usage over 1%, and the cumulative six-hour pause allowance. Never reset counters at a task, method or seed boundary. A failed admission or substantive review finding requires handback. No automatic rerun is allowed.

Keep the original two zero-call aborts as separate infrastructure overhead. Their known polling prefixes total 5.095183 seconds; their active and wall times remain unavailable. They add no recorded calls or usage. Include all attempt rows when checking cumulative pause and hidden-attempt limits; do not count copied completed cells twice. A per-cell source map distinguishes retained measurements, new attempts and prior failures not reached by this rerun.

## Unchanged measurement and reporting

There is no change to any method's search code, training gates, proposals, restarts, repairs, graders, route, decoding, panel, index, per-cell caps, refusal handling or paired metric. Official GEPA and its adapter remain untouched. Hone and plain retain the exact per-artifact selection-vector reuse policy in predeclaration 10. Refusals score zero and are never retried.

Report the same twelve predeclaration-10 cells using the two retained completed cells and the ten newly authorized cells. Retain selection re-score counts, gate-passers without complete selection vectors and their reasons, phase spend, usage, time, errors and censoring. Report abort overhead separately and retain chronological attempts. Use the existing equal-seed/equal-task aggregation, paired comparisons, 10,000-replicate MT19937 bootstrap and type-7 intervals. Missing contributing cells make an aggregate unavailable; never substitute zero or reweight. Historical seed 0 remains beside, never pooled with Hone or plain across the policy change.

Require green CI and exact-head cross-family READY for this addendum and dispatcher before the first new search call. Preserve the unit name, PID, pinned path and launch gate in lane state. Require final evidence gates again when reporting. Stop before merge. **Final-test evaluation and any seed beyond 2 remain out of scope.**
