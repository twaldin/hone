# Development optimizer pilot

The pilot decides whether Hone's proposed search policy warrants a larger comparison. It does not support a public optimizer-quality claim. It compares Hone, pinned official GEPA, and a plain agent loop with the same current subscription model and reported-usage budget.

**Admission stopped again: the native MBPP grader permits judge tampering. Do not run searches with this epoch.** [Handoff 2](../evidence/pilot/handoff-2.md) records the stop and retained prefix. [Predeclaration 2](../evidence/pilot/predeclaration-2.md) was committed before the renewed model calls; its ordinary MBPP controls and noise check passed, but independent Docker probes scored assertion bypasses as correct. IFBench noise calibration was interrupted and AIME controls were not run. No smoke search or 27-run pilot is authorized.

## Prepare the runtime

Run from the repository root on Linux with Docker, Bun, uv, pnpm, and omp 18.16.0 installed. Configure the auth broker through omp itself. Do not supply credentials to this repository.

```sh
nice -n 10 taskset -c 0 uv sync --project pilot --frozen
nice -n 10 taskset -c 0 pnpm install --frozen-lockfile --ignore-scripts --network-concurrency=2 --child-concurrency=1
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m nltk.downloader -d .pilot-cache/nltk punkt punkt_tab stopwords averaged_perceptron_tagger_eng
nice -n 10 docker pull python@sha256:623674a14ef93d052bb9b0de4dbf5f28eb578a35263838941cc8aa43213c1487
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot prepare --out .pilot-state/preparation
```

Check the live venue's CPU affinities before using CPU 0 on another machine or date. The retained machine evidence identifies the affinity sets observed during this lane. The runner uses one model request at a time and one candidate measurement at a time.

The prepare command creates an ignored pilot-specific account-pool file from `omp usage accounts`. It permits only Anthropic OAuth identities on `gmail.com` and `purdue.edu`. It excludes `lindy.ai`, every other provider, and every API key. The gateway also installs an OAuth-only native credential-session restriction: environment/configuration fallbacks cannot escape the pool. It selects the bundled model directly, without loading local model overrides. Public manifests record domain counts and the pool hash, not full account identities. Never commit `.pilot-state` or `.pilot-cache`.

Auth and usage child processes receive only an explicit allowlist of home, executable-search, temporary, and configuration/cache directory paths, plus pilot-owned settings. The harness never copies the host environment or reads credential-valued environment variables. The negative route proof uses non-secret fixture strings to prove that native OAuth restrictions reject environment fallbacks before any provider HTTP request.

## Admit the evaluator before search

```sh
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot probe --out .pilot-runs/route-proof
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot throttle-proof --out .pilot-runs/throttle-proof
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot controls --out evidence/pilot/controls-2
```

Controls run first on MBPP, then IFBench and AIME, on 20 training rows per task. Before any model dispatch, the runner records every ordered cohort and hash. Each draw is `random.Random(20261103).sample(eligible, 20)` after sorting stable row IDs; MBPP excludes the eight previously seen control IDs from this draw only, not from training or search. The known-improved control uses protected development references for AIME and MBPP and a stronger constraint-auditing prompt through both IFBench stages. AIME's naive artifact is the seed; MBPP uses the unchanged quick-answer artifact; IFBench deliberately ignores artificial constraints. Broken artifacts and MBPP stdout-forgery shortcuts must fail. P shortcuts send forged success JSON through the official metric. These are evaluator diagnostics, not optimizer baselines.

Admission requires known-improved > naive > both broken and shortcut. Sixteen fresh unchanged-seed pairs measure score noise on the same 20-row cohort, without cached model responses. The native Hone direct-paired calibration uses those deltas and their maximum excursion. Search is refused if the envelope obscures the positive-control contrast. For another slice size, all four calibration bounds scale by `sqrt(20/n)`; training uses one projected noise envelope, not another standard-error penalty. This independent-row approximation is a development calibration, not a final-test confidence interval or guarantee for future candidates.

The AIME/MBPP positive controls check that the metric credits trusted correct answers; their oracle-to-naive contrast is not evidence that small optimizer gains are distinguishable. A zero or perfect naive cohort still fails the strict predeclared ranking; it is not repaired after observing results. A zero estimated noise envelope means the native threshold becomes strict improvement, not proof of a noiseless evaluator. Every control and unchanged arm archives its metric inputs in `evaluations.jsonl`, so the same offline replay command can recompute their scores.

A failed control command preserves its evidence. The runner refuses to overwrite it. Stop and inspect the measurement contract instead of rerunning until it passes.

## Development tasks

| Task | Training | Selection | Metric and source | Why this task |
| --- | ---: | ---: | --- | --- |
| P IFBench | 300 | 300 | Official loose instruction fraction from GEPA artifact `cbefbc1aa0f43dd39874ec4bf42211365dbda42e`. Selection is development-file rows 0–299, training is rows 300–599. This follows released code rather than the plan's 150-training figure. | Tests prompt optimization against explicit instruction constraints and a non-LLM checker. |
| P AIME | 45 | 45 | Historical 90-question development data at `project-numina/aimo-validation-aime`, revision `13f9e12f613e720c2a2b2f345dd04b998a29494d`. Preserve `Random(0).shuffle`, then halves. The protected response separates `reasoning` and `answer`; apply official `int(pred.answer)` only to `answer`, with no boxed-answer recovery. | Adds reasoning-heavy exact-answer tasks without opening the AIME2025 final panel. |
| A MBPP | 374 | 90 | Official full training and validation files at `google-research-datasets/mbpp`, revision `4bb6404fdc6cacfda99d4ac4205087b89d32030c`. Score all published development assertions passing. | Supplies a CC-BY-4.0 executable agent-program task with deterministic assertions and a bounded, isolated deployment. |

Only explicit development files are fetched. The eager upstream constructors, AIME2025 final dataset, and MBPP test files are never loaded. Ordered membership, source hashes, checker hashes, package versions, and NLP asset hashes are recorded. IFBench scoring code is fetched at runtime from its licensed source. Only download statements and the `dspy.Prediction` container dependency are adapted. Its loose-response variants remain unchanged. Checker randomness is fixed by row identity and the language detector seed is zero.

IFBench preserves the released two-stage program: generate `reasoning`/`response`, then independently correct it into `reasoning`/`final_response`. Only `final_response` enters the official checker. Both calls are metered task calls. The task prompt is editable; the structured response protocol and metric remain protected.

MBPP is a declared agent-program adaptation, not a claim to reproduce an official optimizer program. Its dataset is [Mostly Basic Python Problems](https://huggingface.co/datasets/google-research-datasets/mbpp), released by Google Research under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), associated with [Austin et al., Program Synthesis with Large Language Models](https://arxiv.org/abs/2108.07732). The input adds function declarations derived from reference ASTs, never reference bodies or assertions. No Terrarium source or data is used.

The mutable MBPP artifact contains a prompt and Python program. The program runs in a non-root, read-only, network-disabled Docker container without credentials or host home directories. It can make at most two brokered task-model calls, request at most 4,096 output tokens in total, and send at most 65,536 prompt bytes. Program execution has a 30-second bound excluding model wait; its owned container is paused while waiting, so candidates cannot compute free of that bound. Container processes run at nice 10. The model transport has a 600-second per-request bound.

The answer is program text. The shared MBPP scoring boundary extracts the first python-tagged or bare fenced block, or uses the whole output if none exists; exact fence behavior is frozen in predeclaration 2. Candidate source, official setup and every assertion execute as Python in one namespace inside the pinned, non-root, read-only, network-disabled Docker sandbox, with a ten-second timeout. Pair objects, custom types and mutations retain native Python semantics. The literal-only RPC scorer is gone; no rows or assertions are filtered. A successful exit and runner completion receipt are required; candidate stdout is not a verdict. Assertions are not supplied to task-model calls or selection reflection, but they are necessarily visible to adversarial code inside the scoring interpreter. This is not an assertion-secrecy guarantee.

The receipt is a completion check for ordinary solutions, not a tamper-resistant verdict. Real Docker probes in `evidence/pilot/receipt-limit-proof.json` show that replacing built-in execution or accessing the same-interpreter receipt scores 1.0 without running the assertions. This triggers the predeclared measurement-contract gate against altering the judge. Removing proposer hints or manually auditing gains does not repair that contract. The scorer and completed evidence remain unchanged for reproduction; the gate owner must decide the replacement verification boundary before any new model calls.

Scoring currently collapses sandbox startup/daemon failures, timeouts and absent receipts into zero without retaining a structured cause. Noise calibration includes such zeros, and offline replay may disagree after a transient infrastructure failure. This is a known diagnostic limit, not evidence that every zero is a wrong solution. The frozen MBPP shortcut artifact predates the native-assertion contract: its forged worker frames and `AlwaysEqual` do not define the required functions. Its zero checks that artifact only; early-exit and stdout-verdict defenses are covered separately by Docker tests.

## Matched reported-usage accounting

Every role passes through `ModelCalls`, including task execution, reflection, judging if present, repairs, and externally repeated requests. Calls, tokens, published-rate dollar-equivalents, wall time, pauses, errors, and observed internal retries are retained. There is no LLM judge for these tasks.

The frozen route is `anthropic/claude-sonnet-4-6` for both task and proposer calls. There is no model fallback. Decoding uses temperature zero and native reasoning disabled; protected P protocols still request visible reasoning strings. P task calls request at most 4,096 output tokens each. Proposer and format-repair calls request at most 2,048. The [published list prices](https://platform.claude.com/docs/en/about-claude/pricing) are $3 input, $15 output, $0.30 cache read, and $3.75 five-minute cache write per million tokens. Cache retention is disabled; any reported cache tokens are still counted and priced.

Each search has a $10-equivalent reported-usage ceiling, 12 million reported tokens, 30,000 model calls, 500 proposer/repair calls, 10,000 scored rollouts, and two hours of active wall time. A conservative token reservation precedes each request. Throttle polling and subscription pauses do not consume active work time; both are reported separately from elapsed wall time. The binding cap is recorded. Actual subscription billing is not treated as an API dollar invoice. Controls have separate $100-equivalent and 24-hour active-work ceilings per task, recorded before measurement in `measurement-budget.json`; their `search_budget` metadata describes the comparison's $10 cap. Controls and route proofs have separate published ledgers and are not charged selectively to a method.

Before every model call, the throttle checks broker health and invokes `omp usage --json --no-extensions`. It conservatively checks every reported limit for every allowed account, including limits shared with other models. It pauses above 80%, or when usage is absent, malformed, or more than ten minutes old. The 20% reserve protects other seats and lanes. Outages pause dispatch and are checked again every 30 seconds. A failed connection is closed and resolved again after the wait, including when a relocated broker is already healthy. Only usage returned by omp is charged; failed calls and missing usage are counted explicitly. One externally metered healthy retry is allowed, then task execution scores zero or a proposal is rejected. Forced-high and outage injection exercise the same wait loop without interrupting the shared broker.

The retry allowance above applies to each external transport invocation. Native GEPA may retry a failed reflection once more, allowing up to four metered invocations for a proposal versus two for Hone/plain before an optional Hone format repair. This native-policy asymmetry is retained and disclosed. Every observable invocation is counted; missing failed-call usage remains unknown, so these retries are not assumed free.

**Known accounting limits:** omp's final completion usage can omit tokens from internal failed attempts. Non-200 calls currently do not return usage either: their unreported token volume and dollar-equivalent are unknown, not evidence of free failures. The pilot accepts these disclosed undercounts and reports failed-call counts per method. The gateway counts provider HTTP attempts through omp's opaque fetch override and retry logger events. It checks header names only to reject API-key authentication, and separately counts those rejections so the negative auth proof cannot confuse the header guard with a native credential refusal. It never reads credential values or request bodies. Hidden attempts are provider attempts beyond the first per external call. Logger-event counts are reported separately, not added again to HTTP-attempt counts. A method is flagged above one hidden attempt per 100 calls, or when method rates differ by more than one percentage point. Zero observed hidden retries is not proof that omitted token volume is zero.

Credential-opaque per-attempt admission and usage receipts, including failed-call usage, inside omp are required before the full matrix. No upstream issue is filed by this task.

### Fixed-budget feasibility

Keep the requested $10 ceiling rather than increase it to favor Hone's more expensive gate. The inadmissible v1 IFBench run still provides observed transport costs: 166 calls cost $0.995589-equivalent. A simple projection at that old mean is about $3.60 for a two-call, 300-row selection pass, and $10.80 for Hone's seed/parent/child passes before training or reflection. This is an inference, not a lower bound: the corrected structured two-stage program has not yet been priced. Hone may exhaust the dollar or two-hour active-work cap before its first IFBench promotion. That overhead is part of the fixed-budget result, not grounds to omit the task or grant Hone more budget. The assistant must review the measured feasibility before authorizing the matrix.

## Run and replay

The command below documents the smoke interface, not permission to execute this rejected epoch. A corrected, predeclared contract and successful admission on all three tasks are required first:

```sh
nice -n 10 taskset -c 0 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot smoke --controls evidence/pilot/controls-2 --out evidence/pilot/smoke-2
```

Smoke permits one real proposal per method and requires both a successful proposer response and a valid complete proposed artifact. It exercises the official GEPA reflection callable through the subscription route but does not spend the full budget. Hone imports the existing engine's 0.2 restart probability, deterministic restart draw, one format repair, and native promotion gate. It uses paired training slices of 8, 16, and 32 and fresh paired full-selection measurements. GEPA edits native `prompt` and optional `program` components directly, retaining its renderer, parser, round-robin component selection, Pareto selection, strict improvement, eight-example reflection minibatch, and 10,000-metric-call safety cap. Perfect training minibatches are skipped natively; smoke keeps sampling until a real proposal or a budget bound. The plain loop proposes from training traces and greedily retains strict full-selection improvements. Every method starts from the same artifact and uses the same deployment limits.

The 27-search development pilot remains unrun and blocked by the measurement-contract stop. Its eventual launch also requires the assistant's review of admitted smoke evidence. The accounting decision permits this development pilot to use disclosed reported usage and measured hidden-attempt rates. Complete omp attempt/failed-call receipts are a prerequisite for the later full benchmark matrix, not an additional spending cap on the 27-run pilot.

There is no authorized next-lane search command for the rejected `controls-2` epoch. The `pilot` subcommand runs three methods on three tasks with seeds 0, 1, and 2; a corrected evaluator needs its own predeclared admission evidence, not a relabeled copy of this bundle. Existing complete cells are hash-verified and reused. Interrupted cells retain their durable usage prefix and last accepted incumbent and are never selectively rerun. No final test phase is implemented or authorized here.

Each run includes candidate artifacts, scored outputs, usage records, calibration identity, task membership, routes, budgets, and file hashes. Verify a retained bundle without model calls:

```sh
pilot/.venv/bin/python -m pilot verify --out .pilot-runs/smoke
```

Hash verification checks retained evidence integrity. It does not promise byte-identical stochastic provider responses on a fresh model replay.

Reported selection scores are adaptive: they select incumbents and are not unbiased estimates of deployment quality. No free postselection reevaluation or separate confirmation budget is added to this matched-budget smoke. Independent confirmation belongs to a separately authorized larger evaluation, not a public claim from these development scores.

Recompute every retained rollout's score from the pinned development data and archived task-model outputs, without provider credentials or model calls:

```sh
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot replay --out .pilot-runs/smoke
```

Replay first verifies the bundle hashes and task-resource identities, then runs the protected metrics again. MBPP replay executes archived solution code in the same isolated worker boundary.

`prepare`, `probe`, and `throttle-proof` regenerate the machine/task manifests, real route check, no-account/environment-fallback rejection check, and forced-high/outage pause proof. Current route evidence is `route-proof-v4`; earlier route, preparation and throttle directories carry explicit superseded status files. `aborted-controls-v1` remains inadmissible measurement evidence, not a passing control run.

## CI and baseline failures

The Pilot GitHub Actions workflow runs frozen Python dependencies, pinned development metric resources, and the full pilot unittest suite with real Docker and official metrics enabled. It makes no broker or model calls. Sandbox CPU affinity follows the runner's inherited affinity; the shared-machine harness remains pinned to CPU 0.

The three reported CLI failures reproduced on isolated unmodified main at `b91d374b4b8ad4c99df3afcedf12007adad32639`: stale lock metadata, the host Bun digest mismatch, and replaced-socket identity handling. The one requested baseline run recorded 72 passing, three failing and one skipped test. See [main-baseline.json](../evidence/pilot/main-baseline.json); these are pre-existing, not suppressed pilot regressions.
