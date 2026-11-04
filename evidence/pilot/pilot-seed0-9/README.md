# Development pilot, seed 0: unit startup handback

The requested outcome is six full searches, Hone, official GEPA and plain on MBPP and HoVer, before funding the remaining seeds. The admitted index was verified, copied and admitted successfully. The actual six-cell unit then failed during startup, before any cell or model call. The brief's unchanged pre-search harness-failure handback rule applies. The unit was not restarted.

## What passed before launch

[Artifact evidence](../index-artifact-9/README.md) records hashing every one of the eight admitted-source files, matching all five index files and both corpus files against the frozen receipt, copying with `cp -a`, and hashing every copied file again. The original source was never written. The fresh-build reproducibility limit and likely vocabulary-ordering cause are recorded there. No BM25S code was changed, no index was rebuilt, and no gate was relaxed.

The standalone unchanged admission entrypoint passed with MBPP + HoVer selected, CPU 6, nice 10, zero model calls and no final-test labels loaded. That invocation explicitly supplied the lane's `NLTK_DATA` path before Python startup.

The executed head, `19b70ddcc9f373ec2abf22302fee02fdc8c7f386`, had green CI and exact-head cross-family READY from `xai-oauth/grok-4.7` before launch. CI passed 264 Python tests and twelve native receipt tests. Predeclaration 9 remained unchanged from commit `a5ebc90`.

## Actual unit failure and ownership

The owned unit was `hone-seed0-9-20261104T225929.service`, with `Restart=no`, CPU 6, nice 10 and the correct lane worktree. Its main PID was 3839792. It started at 2026-11-04 23:00:02 UTC and exited with status 1 at 23:01:44 UTC, after 101.429 seconds of service runtime. Current MainPID is 0; no pilot process remains live.

The [controller record](controller.json), [stop record](stop.json) and [unit journal](unit-journal.log) preserve the exact command and failure. This was a real execution of the pilot CLI, not a synthetic test:

```text
main -> load_panel -> load_admission -> load_task(ifbench)
     -> _nlp_assets -> nltk.data.find
LookupError: Resource punkt not found
```

The launcher omitted `NLTK_DATA`. The resource files are installed in this lane's `.pilot-cache/nltk`, and the standalone preflight successfully used them. In `pilot/__main__.py`, `main` calls `load_panel` before the later `environment` call sets that path. Therefore the unit's NLP lookup did not search the lane cache. This is a launch-environment omission, not a corrupt admitted index, an optimizer failure, or an IFBench noise-gate change. IFBench asset identity is checked by the existing complete admission loader even though search selects only MBPP + HoVer.

The failure occurred before gateway creation, cell dispatch or `.pilot-runs/pilot-seed0-9` creation. No provider request, proposal, new scored rollout, refusal, hidden attempt or final-test evaluation occurred. The 101.429 seconds are startup/setup wall time, not a method's search wall time. The earlier successful preflight is not substituted for this failed unit invocation.

## Per-cell selection and accounting

All six cells are `not_started`. A dash means unavailable inference, not zero performance. Phase entries are calls / charged tokens / dollar-equivalent. Reported and estimated tokens and charges are separately zero. No cell wall, active, polling or pause time was measured because no cell began.

| Task | Method | Chosen / unchanged selection | Paired delta / 95% interval | Proposal | Training eval | Selection eval | Cell wall / pauses | Refusals | Hidden attempts | Unknown-usage calls | Changed artifact retained |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| MBPP | Hone | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| MBPP | GEPA | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| MBPP | Plain | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | Hone | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | GEPA | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |
| HoVer | Plain | — / — | — / — | 0 / 0 / $0 | 0 / 0 / $0 | 0 / 0 / $0 | — / — | 0 | 0 | 0 | Not assessed |

No unassigned incomplete evaluation tail exists. Hidden-attempt and unknown-usage rates have no nonzero denominator. Synthetic regression and smoke receipts are excluded from pilot accounting.

## Per-method totals across both tasks

| Method | Completed / intended | Calls | Reported / estimated tokens | Reported / estimated dollar-equivalent | Proposal / training / selection dollar-equivalent | Refusals / hidden attempts | Equal-weight paired delta / interval | Interval excludes zero | Changed artifact retained |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| Hone | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | — / — | Not assessed | Not assessed |
| GEPA | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | — / — | Not assessed | Not assessed |
| Plain | 0 / 2 | 0 | 0 / 0 | $0 / $0 | $0 / $0 / $0 | 0 / 0 | — / — | Not assessed | Not assessed |

No optimizer comparison or practical-threshold assessment is available. This is not evidence that any method succeeds or fails to improve the unchanged seed. The [machine-readable report](../results-9-seed0.json) explicitly retains all missing cell inputs and unavailable inference.

## Replay and next prerequisite

Verify the raw attempt bundle without data loaders, credentials or models:

```sh
python3 -m pilot verify --out evidence/pilot/pilot-seed0-9
```

Recompute the no-search report with the current offline reporter and compare it with `results-9-seed0.json`:

```sh
nice -n 10 taskset -c 6 python3 -m pilot.results --runs evidence/pilot/pilot-seed0-9 --out .pilot-state/results-9-seed0-replay.json
```

The concrete next launch prerequisite is to supply `NLTK_DATA=/home/tim/worktrees/hone/hone-hone-pilot-seed0-1/.pilot-cache/nltk` before Python starts, matching the successful preflight. No asset download, index rebuild, re-admission or optimizer change is needed to address this observed lookup error. This is a handoff recommendation, not an executed retry or permission to ignore the stop rule.

The verified admitted cache copy remains in this worktree; the failed fresh-build bytes were replaced by that authorized copy, and their earlier mismatch hashes remain preserved. The original source directory remains read-only. The failed unit and its journal remain available for inspection, with no live PID and no automatic restart. Another search attempt requires resumption after this handback. PR #37 must remain unmerged.
