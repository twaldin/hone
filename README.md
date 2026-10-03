# Hone

Hone is an experimental engine for improving code against a fixed, measurable objective. You give it a task with a baseline, an evaluator and a budget; a model-backed optimizer proposes changes in a sandbox, and separate trusted code measures each candidate against the baseline and keeps only what actually scores better. The point of the split is that the thing writing the code never gets to grade its own work. I built it to find out how far that loop goes on real performance and quality problems, and whether an optimizer that improves itself on one set of tasks gets better at tasks it has never seen.

It is research code. It runs, it has a large test suite, and it has produced a few honest results, listed below. It is not a packaged tool yet.

This repository is the engine only. The tasks it runs live in **[twaldin/hone-capsules](https://github.com/twaldin/hone-capsules)**.

## A capsule, concretely

A task is packaged as a **capsule**. Here is one of the small ones, [`calibration-varint-decode`](https://github.com/twaldin/hone-capsules/tree/main/capsules/calibration-varint-decode):

```text
capsules/calibration-varint-decode/
  capsule.config.json      objective, image, evaluator command, budget, sandbox limits
  manifest.json            content-addressed identity of everything below
  baseline/
    solution.py            the only file the optimizer may change
    eval.py, worker.py     the evaluator and its worker protocol (protected)
    challenge.json         the public contract (protected)
  assets/train/            cases the optimizer can see
  assets/validation/       cases only the trusted evaluator sees
  diagnostics/
    naive/ improved/ broken/ shortcut/   reference solutions used to check the evaluator
    ordering-report.json   proof the evaluator ranks them in the expected order
```

The objective in its config reads: *"Reduce trusted parent-measured latency for decoding frozen unsigned LEB128 byte streams while preserving the exact sequence of 32-bit values. Only solution.py is mutable."* The budget is 12M tokens, $25, three hours of wall clock and 200 evaluator calls, and the evaluator runs in a pinned container with 512 MiB and one CPU.

Before a capsule is admitted, its evaluator has to rank four reference solutions correctly: a naive one, an improved one, a broken one that must fail, and a **shortcut** that games the visible cases and must not win. That ordering check is what keeps the evaluator from rewarding overfitting. The tools that scaffold a capsule and run that check are in [`capsule-kit/`](capsule-kit/).

## How a run works

1. **Admission.** The trusted CLI checks the capsule's hashes, protected paths, image and ordering report, and seals the run configuration.
2. **Proposal.** The **optimizer** (`optimizer/`) asks a model-backed coding worker to edit the mutable files inside a sandbox.
3. **Measurement.** The **broker** (`trusted/broker/`) runs the evaluator in the pinned image, enforces the budget and records every evaluation in a durable journal. The optimizer's own claims about its work carry no weight.
4. **Selection and delivery.** Only candidates that beat the incumbent on the trusted measurement are kept. You inspect the best candidate and its diff, then deliver it to a repository explicitly; delivery is off by default.

On top of single runs there are **campaigns**, which measure changes to the optimizer itself across a frozen set of capsules, and a **recursive** mode where an outer optimizer edits the inner optimizer and the result is scored on the inner optimizer's performance across a panel of tasks. See [Architecture](docs/architecture.md) and [Methodology](docs/methodology.md).

## Results so far

Only results with retained evidence are listed. Each one is narrow.

**Leduc poker solver, fixed compute: a small real win, after one honest failure.** A capsule scored a standard-library port of a Leduc hold'em CFR+ solver (from the MIT-licensed [`davidvayn/pokersolver`](https://github.com/davidvayn/pokersolver)) by exact exploitability, with quality `q = 1 / (1 + exploitability)`. The rule, fixed before measuring: a candidate only counts if it does not buy its improvement with extra compute.

- The first fixed-compute campaign found a candidate that raised validation q from 0.8453 to 0.8599, but it ran at **1.0543×** the baseline's time against a 1.05× limit. It was rejected and the holdout was never opened.
- A second campaign found a change that keeps the same number of CFR+ sweeps and only reweights the average policy at low iteration counts (iteration → iteration³ below 100 iterations). It ran at **0.9677×** the baseline's pooled runtime (every replicate at most 1.014× against a 1.02× limit, so this is parity, not a speedup). Validation q went from 0.8453 to 0.8599 (+0.0146), and the sealed holdout, opened once after selection, went from 0.7733 to 0.7899 (+0.0166).

The fixed-compute solver is in [`hone-capsules/capsules/leduc-cfr-exploitability/artifacts/fixed-compute-best/`](https://github.com/twaldin/hone-capsules/tree/main/capsules/leduc-cfr-exploitability/artifacts/fixed-compute-best) under its upstream MIT notice. The neighbouring `best/` directory holds an earlier candidate that bought its gain with extra sweeps and doesn't meet the fixed-compute rule. The capsule itself, its sealed cases and the per-case evidence stay private.

**The original Python Hone: a prompt that transferred to held-out bugs.** Before this rewrite, Hone evolved a system prompt for Claude Haiku 4.5 fixing real open-source bugs. On 20 training bugs the solve rate went from about 55% to 92%. On 9 held-out bugs it had never seen, run three times each, it went from 65% to 85%. About half of the training lift transferred. [Write-up](https://github.com/twaldin/hone/blob/v1.0.0/writeup/2026-04-18-haiku-20train-9holdout.md).

**Recursive optimizer campaigns: they ran, and they did not establish transfer.** In August 2026 I calibrated the inner loop (80 cells over four calibration capsules; an inner budget of 4 episodes was enough) and ran several recursive campaigns on a 21-capsule cohort. They exercised the whole machinery, including pauses, resumes and failure accounting, but the promotion decisions in the main campaign were all scored on training cases, so they say nothing about generalization. A later retrospective check on one development task (trade-up profit) found that about 93% of an in-sample gain held on 20 never-scored cases; on another (FLT text input) the measurement could not resolve the effect. There is no result yet showing that a self-improved optimizer does better on unseen tasks.

## Quickstart

You need Node 18+ and pnpm 10.

```sh
git clone https://github.com/twaldin/hone.git
cd hone
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node trusted/cli/bin/hone.js --help
```

That checks the engine without running an optimization, and it needs nothing from the capsules repository. A real run additionally needs Docker on a Linux host, the capsule's exact pinned image, an OpenAI-compatible model endpoint set through `HONE_UPSTREAM_BASE_URL` (and optionally `HONE_UPSTREAM_API_KEY`), and a checkout of [hone-capsules](https://github.com/twaldin/hone-capsules) next to this one. Its README covers the clone; some capsules embed a Git object store, so follow its steps rather than a plain `git clone`. Then:

```sh
export HONE_CAPSULES_ROOT=../hone-capsules/capsules   # or pass --capsules-root on each command
node trusted/cli/bin/hone.js run ../hone-capsules/capsules/<name> --headless
node trusted/cli/bin/hone.js best
node trusted/cli/bin/hone.js diff --stat
```

Without either setting, Hone looks for capsules in `./capsules` under the directory you run it from. [Getting started](docs/getting-started.md) has the details.

## Status and limitations

- **Running a capsule from a fresh clone is not smooth yet.** Production runs require an admission receipt and the pinned image, and there is no public command that builds both for you.
- **Most results above came from one machine and one model route.** Nothing here has been independently reproduced.
- **Terminal tasks are not runnable from the public repos.** Eleven capsules form the final test set for the recursive experiment. Their directories in hone-capsules hold source references (`manifest.reference.json`) so you can read the contract, but their inputs and answers are private so they stay a real test.
- **Some tasks come from private projects.** The trade-up, Monoagent and Floyd capsules are derived tasks released under MIT; the original applications are not. See [PUBLICATION.md](https://github.com/twaldin/hone-capsules/blob/main/PUBLICATION.md) in hone-capsules.
- **The recursive experiment is unfinished.** Cross-task transfer has not been measured, and the evidence publisher is not built.

## Documentation

| Guide | Read it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Dependencies, checks, pointing Hone at capsules and what a real run needs. |
| [CLI](docs/cli.md) | Run, inspect, deliver, calibrate and campaign commands. |
| [Architecture](docs/architecture.md) | The trust boundary between optimizer and evaluator, and the state Hone keeps. |
| [Capsules](docs/capsules.md) | Task packages, admission, capsule-kit and terminal source references. |
| [Durable runs](docs/durable-runs.md) | Pauses, resumes, source migration, image re-pins and closures. |
| [Methodology](docs/methodology.md) | Experiment levels and what each one can show. |
| [Recursive experiment status](docs/m2-readiness.md) | What the recursive campaigns did and what is still missing. |
| [Results](docs/results.md) | What a published result has to include. |

## License

MIT, see [LICENSE](LICENSE). Capsules, including third-party code with its own licenses, are in [hone-capsules](https://github.com/twaldin/hone-capsules).
