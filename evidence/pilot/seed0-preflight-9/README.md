# First-seed pilot stopped before search

The requested outcome was six full searches at seed 0, Hone, official GEPA and plain on MBPP and HoVer, to decide whether to fund seeds 1 and 2. No search started. The brief's stop condition, "a gate or harness check fails before the first search", fired during the dispatch check.

This record is a preflight stop, not predeclaration 9, a failed optimizer result, or permission to execute a modified harness. Predeclaration 9 was not finalized or committed. No search call preceded this record.

## Observed harness mismatch

At source head `cdb1e75fc76c2c3e44f313208e8f86d92ee50291`, `pilot/__main__.py:923` uses `args.seed` only for `smoke`. The `pilot` command always selects `(0, 1, 2)`. Adding `--seed 0` to the frozen command therefore does not restrict it to the authorized six cells.

The [zero-call diagnostic](check.py) invokes the real CLI parser and dispatch loop. It substitutes an admitted-panel fixture, an empty environment, a recording search boundary, and no-op accounting and file writers. It does not load task data, validate admission, execute an optimizer, contact a provider, or exercise the throttle. The [recorded output](result.json) shows 18 dispatch-boundary visits across seeds 0, 1 and 2, rather than six visits at seed 0.

A second fixture returns infrastructure failures for the first two cells, each with one call, one hidden attempt and one unknown-usage call. Those are synthetic receipts, not consumed usage. The same loop still visits all 18 cells. Thus the dispatcher does not stop new cells after the brief's hidden-attempt, unknown-usage or two-consecutive-infrastructure-failures conditions. `pilot/runtime.py:396-405` and `:521-524` report retry flags, but `pilot/__main__.py:923-935` does not use those flags to stop dispatch. This diagnostic proves the dispatcher behavior only, not the handling of a real failed provider attempt.

The frozen command in `run-plan-8a.json` is unchanged. The harness, model route, account pool, throttle and broker configuration are unchanged. No final-test labels were read. No new controls, smokes, route probes or search cells ran.

## Intended contract, not executed

The authorized cells are MBPP × Hone, GEPA, plain and HoVer × Hone, GEPA, plain, all at seed 0. Each retains the smoke's $10-equivalent cap, 12 million charged tokens, 30,000 model calls, 500 proposer or repair calls, 10,000 scored rollouts and 7,200 active seconds. These are ceilings, not measured spend.

The selection metrics remain MBPP's all-development-assertions-pass fraction on 90 selection rows and HoVer's official supporting-title subset score on 300 selection rows. A paired comparison must use the unchanged seed artifact on those same rows. Neither `run-plan-8a.json` nor `docs/pilot.md` specifies a confidence-interval method. The existing projected noise envelope is not a confidence interval, as `pilot/search.py:89` states. No interval method was invented for this stopped run.

Provider refusals remain score zero, never retried, and conservatively charged under predeclaration 8. The intended runtime keeps nice 10, CPU 6 and the plan's one-thread settings. If execution becomes possible, serial cells are the smaller choice: one model-dispatch stream preserves more subscription and CPU capacity for other seats than two concurrent cells. No concurrency or throttle-tolerance claim was measured here.

Seeds 1 and 2, also called seeds 2-3 by ordinal in the brief, and any final-test evaluation remain out of scope. No systemd unit or long-running process was started. Unit name and PID are both absent.

## Per-cell accounting

All six cells have status `not_started`. A dash means unmeasured, not zero performance. Each phase entry is calls / charged tokens / dollar-equivalent. Search wall time and pauses are not measured because the cells never began.

| Task | Method | Chosen selection / seed selection | Paired delta / interval | Proposal | Training eval | Selection eval | Search wall / pauses | Refusals | Hidden attempts | Unknown-usage calls | Changed artifact retained |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| MBPP | Hone | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| MBPP | GEPA | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| MBPP | Plain | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | Hone | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | GEPA | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | Plain | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |

Reported and estimated tokens and charges are separately zero in every phase. There are no hidden-attempt or unknown-usage rates with a nonzero denominator. The fixture receipts are excluded from these tables.

## Per-method totals across both tasks

| Method | Completed / intended cells | Calls | Reported / estimated tokens | Reported / estimated dollar-equivalent | Proposal / training / selection dollar-equivalent | Refusals / hidden attempts | Interval excludes zero | Changed artifact retained |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Hone | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | Not assessed | Not assessed |
| GEPA | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | Not assessed | Not assessed |
| Plain | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | Not assessed | Not assessed |

No optimizer comparison is available. These are not evidence that the methods fail to improve the starting artifact.

## Replay and handoff

Run the dispatch diagnostic without dependencies, account files or model access:

```sh
nice -n 10 taskset -c 6 python3 evidence/pilot/seed0-preflight-9/check.py
```

Compare its JSON with `result.json`. Source hashes bind the observation to the frozen runner, runtime and plan. The bundle manifest also hashes this diagnostic and report. Hash verification needs only the standard-library pilot imports:

```sh
python3 -m pilot verify --out evidence/pilot/seed0-preflight-9
```

The smaller next task is to make the existing pilot dispatcher honor a first-seed-only run and the brief's stop rules, then prove those boundaries offline before authorizing search. It must also locate or explicitly resolve the missing interval specification before committing an executable predeclaration 9. This lane deliberately makes no harness changes after its stop condition. No live unit or PID needs handoff, and this evidence PR must not merge under this brief.
