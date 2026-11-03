# Admission 2: stop before search

The goal was a proven development harness for Hone, official GEPA and a plain agent loop. The harness is **not admitted**. No smoke search or 27-run pilot ran; no PR was opened and no READY verdict is claimed.

## Why this stops

The plan's unchanged H7 measurement-contract gate kills an epoch when a candidate can alter the judge or win through an invalid proxy. Real pinned-Docker probes show both execution replacement and forged completion receipts score 1.0 without running the assertions; see [receipt-limit-proof.json](receipt-limit-proof.json).

A second end-to-end probe used an actual bounded agent program, not a direct scorer shortcut. It emitted `import builtins; builtins.exec = lambda *args, **kwargs: None`, made **zero model calls**, and scored **20/20** on the fresh MBPP training cohort. It did not implement the requested functions. See [agent-judge-bypass-proof.json](agent-judge-bypass-proof.json). This is a demonstrated metric exploit, not a speculation about assertion secrecy. Ordinary controls passing does not override it. Removing prompt hints or auditing winners does not restore a protected evaluator.

Calibration was interrupted with SIGINT on its proven-owned PID 2645489 after the defect was confirmed. The running command's `finally` blocks closed its transport and sealed its durable evidence prefix. No controls, prompts, scoring rules or cohort membership were retuned. No process is intentionally left running.

## Predeclaration and tasks

[Predeclaration 2](predeclaration-2.md) was committed as `cf46763ccfcfe551cd7f436f0aa3595902a5c70e` before renewed model calls. Every task's 20-row draw was frozen first: independent `Random(20261103).sample` over lexicographically sorted eligible IDs; MBPP excluded the prior eight rows from controls only. Every official training and selection row remains in its partition. Final-test material was not loaded.

| Task | Train / selection | Official development metric | Choice |
|---|---:|---|---|
| P IFBench | 300 / 300 | Released official loose instruction fraction; pinned GEPA artifact development file and transformation | Constraint-following prompt task; fixed two-stage program |
| P AIME | 45 / 45 | Historical 90-row development file, official shuffled halves and integer answer comparison | Exact-answer reasoning task; no 2025 final panel |
| A MBPP | 374 / 90 | Official full train/validation assertions, native Python semantics; CC-BY-4.0 | Licensed bounded agent-program task; no Terrarium material |

Sources, revisions, memberships and checker hashes are in the retained manifests and [task documentation](../../docs/pilot.md#development-tasks).

## Controls and noise

| Task | Rows / arm | Improved | Naive | Broken | Shortcut | Noise result |
|---|---:|---:|---:|---:|---:|---|
| MBPP | 20 | 1.0000 | 0.6000 | 0 | 0 | Ordinary ranking passed; 16 paired unchanged trials, SD 0.0442531, floor 0.0938749, envelope 0.1408124 < contrast 0.4 |
| IFBench | 20 | 0.8875 | 0.8375 | 0 | 0.1166667 | Ranking passed; interrupted during noise calibration, 2 complete pairs retained; no valid floor/envelope or admission |
| AIME | 20 frozen | — | — | — | — | Not run after contract stop |

These results do not validate MBPP against a malicious candidate. The bypass program above scores 1.0 with no task solution or model work.

## Recorded usage, not a method comparison

| Calibration | Calls | Reported tokens | List-rate equivalent | Elapsed seconds | High/outage pauses | Observed hidden attempts |
|---|---:|---:|---:|---:|---:|---:|
| MBPP | 660 | 115,936 | $1.083348 | 2366.788 | 0 | 0 |
| Interrupted IFBench prefix | 311 | 230,023 | $2.142285 | 2313.516 | 0 | 0 |
| Total recorded prefix | 971 | 345,959 | $3.225633 | 4680.304 | 0 | 0 |

The interrupted IFBench request was in flight at SIGINT. Its completion and any provider-side tokens are unobserved and absent from the prefix. This is an additional explicit accounting limit, not a free call. Both saved ledgers report zero failed calls, missing-usage completions and retry logger events among their recorded calls. Throttle polling consumed 1590.579 seconds separately from high/outage pauses. Actual subscription charges are not inferred from list-rate equivalents.

| Smoke method | Selection score | Calls / tokens / equivalent / wall / pauses / hidden attempts |
|---|---|---|
| Hone | Not run | Not measured |
| Official GEPA | Not run | Not measured; real subscription reflection bridge remains unproved |
| Plain loop | Not run | Not measured |

All methods use the same omp-resolved subscription route. The ignored private pool permits gmail.com ×2 and purdue.edu ×1 only; lindy.ai and API keys are excluded. No credentials were read or copied by the harness author.

## Throttle and replay proof

The retained [forced-high/outage proof](throttle-proof-v2/result.json) injected utilization 0.99 against the 0.80 threshold, then a broker outage, then a live normal reading. One 0.102994-second pause occurred; dispatch happened only after resume. The live broker was not interrupted. The later anonymous [capacity snapshot](capacity-snapshot.json) observed account maximum fractions 0, 0.11 and 0.11. Weekly percentage windows expose no absolute token allowance, so these percentages cannot predict a guaranteed throttle duration.

`python -m pilot verify --out evidence/pilot/controls-2` verified the frozen prefix hash:

`sha256:dcaf786190c10f51d7aaf140909a4a8ede9476c479e44952c727c37882b47567`

`python -m pilot replay --out evidence/pilot/controls-2` independently reproduced **880 scored rollouts**, zero model calls, no final-test material. The prefix is preserved unchanged; no incomplete noise trial was promoted into a result.

## Tests and CI

- Local corrected-contract suite at `05444a4`: 95 passing, no skips, including real Docker and official metrics.
- After review fixes: [GitHub Actions run 41582251076](https://github.com/twaldin/hone/actions/runs/41582251076), exact code head `32a4cbf5c48c67333973052a6b888e974d503757`: **99 passing, no skips**. Includes real Python→Bun native Hone policy gates using measure-generated 20-row calibration at n=8 and n=90. This is not proof of optimizer smoke behavior.
- Earlier repository verification: native optimizer 71 passing, capsule-kit 70 passing, workspace typecheck exit 0. The reported CLI failures reproduced on isolated **unmodified main** `b91d374b4b8ad4c99df3afcedf12007adad32639`: 72 passing, 3 failing, 1 skipped in the requested three-file run. See [main-baseline.json](main-baseline.json). They are pre-existing, not suppressed.
- Cross-family review on `05444a4` found the receipt defect. CLI all-task sealed admission, proposer disclosure and native-policy CI findings were corrected at `32a4cbf`. The contract defect is deliberately not hidden or patched after measurement. **No READY verdict.**

## Run plan is blocked

There is no authorized next-lane search command for this rejected epoch. The safe next command is offline reproduction:

```sh
nice -n 10 taskset -c 0 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot replay --out evidence/pilot/controls-2
```

The nominal 27-run limits remain $270-equivalent, 324 million reported tokens and 54 aggregate active-work hours. These are declared ceilings, **not measured usage estimates or strict elapsed bounds**: in-flight work, usage polling, outages and subscription pauses add time. No defensible per-method token or throttled-hours estimate is available without admitted smokes. The observed calibration token mix is not a substitute for search measurements.

Decision for the gate owner: predeclare a verification boundary in which arbitrary candidate Python cannot alter the grader, or explicitly narrow the artifact/MBPP execution contract. Recommend the protected verification boundary rather than accepting manual winner audits as a repair. Preserve native custom-object behavior and all official development assertions if MBPP stays; this run does not authorize another retune or new draw. Credential-opaque internal-attempt and failed-call usage receipts in omp remain a prerequisite for the **later full benchmark matrix**; no upstream issue was filed.
