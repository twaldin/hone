# Development optimizer pilot

[Predeclaration 6](../evidence/pilot/predeclaration-6.md), committed before new pilot calls, authorizes one IFBench re-admission after correcting the official inherited seed-1 sample of 150 training rows. Selection remains the official first 300 development rows. All prior IFBench measurements are [invalid-cohort evidence](../evidence/pilot/invalid-ifbench-cohorts-6.json), preserved unchanged. MBPP and HoVer admissions stand. No matrix or merge is authorized.

The pilot decides whether Hone's proposed search policy warrants a larger comparison. It does not support a public optimizer-quality claim. It compares Hone, pinned official GEPA, and a plain agent loop with the same current subscription model and reported-usage budget.

[Predeclaration 4](../evidence/pilot/predeclaration-4.md), committed as `030c792` before new model calls, replaces the authored P controls with published optimized instructions and a fresh 40-row draw. [Correction 4a](../evidence/pilot/predeclaration-4a.md) removes a CPU-0 gateway override and prevents provider failures from deciding calibration scores. The transport change requires MBPP re-admission; contract-3 measurements alone cannot authorize the corrected harness. [Handoff 3](../evidence/pilot/handoff-3.md) records the earlier IFBench ranking failure.

Contract 4a stopped under AIME's noise gate. Its envelope, 0.07616286, exceeded the 0.075 improved-minus-naive contrast. MBPP and IFBench passed. [Handoff 7](../evidence/pilot/handoff-7.json) preserves the unchanged failure and all prior usage. [Predeclaration 5](../evidence/pilot/predeclaration-5.md), committed as `0bd3067` before new pilot calls, withdraws AIME and admits the already frozen HoVer reserve once. A HoVer gate failure produces a two-task MBPP + IFBench pilot with no further substitutions. An infrastructure abort produces no admitted panel. The $10 search cap and selection sets do not change.

## Prepare the runtime

Run from the repository root on Linux with Docker, Bun, uv, pnpm, and omp 18.16.0 installed. Configure the auth broker through omp itself. Do not supply credentials to this repository.

```sh
nice -n 10 taskset -c 6 uv sync --project pilot --frozen --extra retrieval
nice -n 10 taskset -c 6 pnpm install --frozen-lockfile --ignore-scripts --network-concurrency=2 --child-concurrency=1
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m nltk.downloader -d .pilot-cache/nltk punkt punkt_tab stopwords averaged_perceptron_tagger_eng
nice -n 10 docker pull python@sha256:623674a14ef93d052bb9b0de4dbf5f28eb578a35263838941cc8aa43213c1487
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot prepare --out .pilot-state/preparation-4
```

Inspect the live venue's CPU affinities before every heavy run. This epoch uses CPU 6 and avoids CPUs 0–5 and 13–16, including the venue's earlier 0/5 pin. The runner uses one model request and one CPU-heavy worker at a time.

Preparation verifies the pinned HoVer index before its admission attempt. The observed cold preparation called the real `prepare` entrypoint through a measured launcher: 310.97 seconds and 7.32 GiB peak RSS on one CPU. It indexed all 5,233,330 published corpus rows, including the empty metadata row. [Preparation evidence](../evidence/pilot/preparation-4) distinguishes that launcher from the equivalent public replay command. Corpus and numeric-index hashes enter sealed admission evidence. Setup failures occur before model dispatch and cannot become row scores or authorize a smaller panel.

The prepare command creates an ignored pilot-specific account-pool file from `omp usage accounts`. It permits only Anthropic OAuth identities on `gmail.com` and `purdue.edu`. It excludes `lindy.ai`, every other provider, and every API key. The gateway also installs an OAuth-only native credential-session restriction: environment/configuration fallbacks cannot escape the pool. It selects the bundled model directly, without loading local model overrides. Public manifests record domain counts and the pool hash, not full account identities. Never commit `.pilot-state` or `.pilot-cache`.

Auth and usage child processes receive only an explicit allowlist of home, executable-search, temporary, and configuration/cache directory paths, plus pilot-owned settings. The harness never copies the host environment or reads credential-valued environment variables. The negative route proof uses non-secret fixture strings to prove that native OAuth restrictions reject environment fallbacks before any provider HTTP request.

## Admit the evaluator before search

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot adversarial --out evidence/pilot/adversarial-6
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot controls --adversarial evidence/pilot/adversarial-6 --out evidence/pilot/controls-6
```

The first command carries MBPP and HoVer forward without model calls after sealed-evidence and task-specific source equivalence checks. It runs IFBench checker/protocol attacks outside candidate control before auth. The second command measures IFBench once on its corrected official partition. Calibration provider errors abort as infrastructure failures, never zero scores or measured gate failures.

MBPP re-admission is accepted only after 660 successful task calls, nonempty naive/noise outputs and a complete offline score replay. The sealed `audit.json` binds these checks to the control, call and evaluation files. This rejects a silent Docker outage that could fake zero noise. Reuse also requires every consumed score and audit file to be listed in the completed seal. Startup failures are retained; no automatic restart is authorized. Smoke and pilot enforce CPU 6 themselves, not only through the documented shell prefix.

IFBench takes `Random(1).sample(source_rows[300:600], 150)`, then freezes a 40-row draw from sorted training IDs with seed `20261106`. Selection stays `source_rows[:300]`. HoVer retains its seed-20261105 40-row draw and passing 16-pair calibration. MBPP retains its previous 20-row draw and 16 pairs. AIME stays withdrawn.

Admission requires known-improved > naive > both broken and shortcut, with broken = 0 and MBPP shortcut = 0. P positives execute published optimized instructions, not trusted answers or a prompt authored here. Sixteen fresh paired unchanged-seed trials measure noise without response caching. Keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, max_abs_delta)`. The envelope must be strictly below the positive-control contrast. Projection uses `sqrt(source_rows/n)`: 40 for P and 20 for MBPP. An IFBench checker, headroom, ranking or noise failure selects MBPP + HoVer, labelled a two-task development pilot, without retuning or substitution. Zero estimated noise is not proof of a noiseless evaluator.

A failed control command preserves its evidence. The runner refuses to overwrite that output folder. A second folder would be a prohibited second attempt, not a fresh authorization, and would create another external call ledger. This epoch uses only `evidence/pilot/controls-6`. Only a recorded IFBench checker, headroom, ranking or noise failure authorizes the MBPP + HoVer fallback. Missing results and infrastructure failures never do.

## Published P controls

The pinned [GEPA artifact](https://github.com/gepa-ai/gepa-artifact/tree/cbefbc1aa0f43dd39874ec4bf42211365dbda42e) publishes final programs under MIT, copyright 2025 Lakshya A Agrawal. The retained [license](../pilot/published-controls.LICENSE) covers the extracted instructions. Selection is fixed to seed 0, GPT-4.1-mini, GEPA-MERGE, falling back to GEPA only when that optimizer directory is absent. AIME uses that metadata-only fallback. No pilot or final-test score chooses a checkpoint.

| External historical validation | Official seed | Compile-selected program | Checkpoint |
| --- | ---: | ---: | ---: |
| IFBench | 81.89 | 90.03 | 7 |
| AIME | 46.67 | 60.00 | 27 |
| HoVer | 44.67 | 52.67 | 17 |

These are published validation percentages, not current-model pilot results. The final exports match the selected checkpoint bytes exactly. [The extracted controls](../pilot/published-controls.json) record program, development-state and archive hashes. The inert reader never executes pickle reducers, constructors or imports. Non-instruction strings stay opaque; attached LMs, demos, training examples, traces and callbacks are rejected before export.

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot.published --archive .pilot-cache/upstream-gepa/experiment_runs_data.tar.gz --output pilot/published-controls.json
```

The replay input is the pinned archive at `https://media.githubusercontent.com/media/gepa-ai/gepa-artifact/cbefbc1aa0f43dd39874ec4bf42211365dbda42e/experiment_runs_data.tar.gz`, SHA256 `0e1db10331bbbdd48701443b0690d5b7b8abef841a73b76882d26853b3f38dd7`, 1,931,042,598 bytes. A published gain need not transfer to Sonnet; the unchanged current-model ranking gate decides admission.


## Development tasks

| Task | Training | Selection | Metric and source | Why this task |
| --- | ---: | ---: | --- | --- |
| P IFBench | 150 | 300 | Official loose instruction fraction from GEPA artifact `cbefbc1aa0f43dd39874ec4bf42211365dbda42e`. Training applies `Random(1).sample(rows[300:600], 150)`; selection is `rows[:300]`. | Tests explicit instruction constraints with a non-LLM checker. Earlier 300-row-cohort measurements are invalid for official admission. |
| P HoVer | 150 | 300 | Official GEPA three-support-document partition, 40% test, 40% validation, 20% train after seed-0 shuffle, with independent seed-1 caps. Discrete normalized supporting-title subset metric. | Passed its single frozen admission attempt; replaces withdrawn AIME and adds four-module retrieval optimization without an LLM judge. |
| A MBPP | 374 | 90 | Official full training and validation files at `google-research-datasets/mbpp`, revision `4bb6404fdc6cacfda99d4ac4205087b89d32030c`. Score all published development assertions passing. | Supplies a CC-BY-4.0 executable agent-program task with deterministic assertions and a bounded, isolated deployment. |

AIME's historical 45/45 development split and contract-4a measurements remain available for replay, not search. Its failed noise gate is not part of an admitted panel.

Only explicit development labels are decoded. The eager upstream constructors, AIME2025 final dataset, and MBPP test files are never loaded. HoVer first establishes exact membership using opaque canonical JSON title-token equality, then decodes only the 150 training and 300 selection rows. No held-out row reaches the JSON decoder. Ordered membership, source hashes, checker hashes, package versions, and NLP asset hashes are recorded. IFBench's licensed checker retains every loose-response variant; only download statements and the `dspy.Prediction` container dependency are adapted. Its randomness is fixed by row identity and the language detector seed is zero.

IFBench preserves the released two-stage program. Editable `prompt` supplies generation instructions and editable `revision_prompt` supplies revision instructions. Each stage receives only its own instruction. Generation returns `reasoning` and `response`; revision receives the original query and draft and returns `reasoning` and `final_response`. Only `final_response` enters the official checker. Both calls are metered task calls, and the JSON protocol and metric remain protected.

HoVer preserves the four official modules: initial retrieval, summary, hop-2 query, retrieval, contextual summary, hop-3 query, retrieval. It retrieves 7, 7 and 10 passages and scores their ordered concatenation by gold-title coverage. The corpus pin, BM25S 0.2.12, PyStemmer 2.2.0.3, CPU JAX 0.6.0, English stopwords/stemming and `k1=0.9,b=0.4` are fixed across methods. Public indices with different parameters are not substituted. HoVer data is CC-BY-SA-4.0. The Wikipedia corpus is fetched at runtime, not committed; archived excerpts retain Wikipedia attribution.

HoVer claims and support annotations are attributed to the [HoVer authors](https://github.com/hover-nlp/hover/tree/39b84697f196308f398a251a7aea9b82ae0f0562) under [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/). Retrieval excerpts are attributed to Wikipedia contributors, from the 2017 snapshot under [CC-BY-SA-3.0](https://creativecommons.org/licenses/by-sa/3.0/), via the [pinned DSPy repack](https://github.com/dspy/cache/tree/ef6a5e72a98b47cef31574a400fea8fe149559a3). Each archived passage retains its article-title prefix: its attribution and revision history are `https://en.wikipedia.org/wiki/{URL-encoded title}` and that URL plus `?action=history`. The repack supplies no separate license grant; this harness redistributes neither the full corpus nor the retrieval index.

MBPP is a declared agent-program adaptation, not a claim to reproduce an official optimizer program. Its dataset is [Mostly Basic Python Problems](https://huggingface.co/datasets/google-research-datasets/mbpp), released by Google Research under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), associated with [Austin et al., Program Synthesis with Large Language Models](https://arxiv.org/abs/2108.07732). The input adds function declarations derived from reference ASTs, never reference bodies or assertions. No Terrarium source or data is used.

The mutable MBPP artifact contains a prompt and Python program. The program runs in a non-root, read-only, network-disabled Docker container without credentials or host home directories. It can make at most two brokered task-model calls, request at most 4,096 output tokens in total, and send at most 65,536 prompt bytes. Program execution has a 30-second bound excluding model wait; its owned container is paused while waiting, so candidates cannot compute free of that bound. Container processes run at nice 10. The model transport has a 600-second per-request bound.

The answer is program text. The common extractor takes the first python-tagged or bare fenced block, otherwise the whole output. A trusted planner uses official reference code, setup and assertions in a bounded pinned-Python process without candidate code. It produces function calls with plain-data arguments and protected expected results. A separate fresh candidate container per row receives only candidate source and call arguments. The trusted parent validates returned tagged JSON and decides every equality. No test files, expected values, host directories or credentials enter the candidate container.

Tagged data preserves exact builtin types, sequence order and order-independent mappings and sets. Official wrappers, including `int`, run on the trusted side before comparison. Pair and Node inputs are class-name and field records, reconstructed without candidate constructors. A custom result is compared structurally against the trusted expected class name and field schema. Candidate `__eq__`, `__hash__` and `__repr__` cannot decide the grade. Executable values, unsupported subclasses, cycles, malformed data, extra output, timeouts and failed exits do not pass. Every row remains in the denominator; any safely unrepresentable official row is listed as ungradeable and scores zero for every method.

Adversarial admission exercises execution replacement, always-equal objects, early exits, verdict and receipt forgery, checker monkeypatches, expected-value reads and atexit rewrites. The previous shortcut remains unchanged. IFBench and HoVer accept strings only through protected JSON protocols; those strings never execute in their trusted checkers. The archived AIME checker has the same separation. These controls test the declared boundary, not a general proof against every possible candidate.

## Matched reported-usage accounting

Every role passes through `ModelCalls`, including task execution, reflection, judging if present, repairs, and externally repeated requests. Calls, tokens, published-rate dollar-equivalents, wall time, pauses, errors, and observed internal retries are retained. There is no LLM judge for these tasks.

The frozen route is `anthropic/claude-sonnet-4-6` for both task and proposer calls. There is no model fallback. Decoding uses temperature zero and native reasoning disabled; protected P protocols still request visible reasoning strings. P task calls request at most 4,096 output tokens each. Proposer and format-repair calls request at most 2,048. The [published list prices](https://platform.claude.com/docs/en/about-claude/pricing) are $3 input, $15 output, $0.30 cache read, and $3.75 five-minute cache write per million tokens. Cache retention is disabled; any reported cache tokens are still counted and priced.

Each search has a $10-equivalent reported-usage ceiling, 12 million reported tokens, 30,000 model calls, 500 proposer/repair calls, 10,000 scored rollouts, and two hours of active wall time. A conservative token reservation precedes each request. Throttle polling and subscription pauses do not consume active work time; both are reported separately from elapsed wall time. The binding cap is recorded. Actual subscription billing is not treated as an API dollar invoice. Controls have separate $100-equivalent and 24-hour active-work ceilings per task, recorded before measurement in `measurement-budget.json`; their `search_budget` metadata describes the comparison's $10 cap. Controls and route proofs have separate published ledgers and are not charged selectively to a method.

Before every model call, the throttle checks broker health and invokes `omp usage --json --no-extensions`. It conservatively checks every reported limit for every allowed account, including limits shared with other models. It pauses above 80%, or when usage is absent, malformed, or more than ten minutes old. The 20% reserve protects other seats and lanes. Outages pause dispatch and are checked again every 30 seconds. A failed connection is closed and resolved again after the wait, including when a relocated broker is already healthy. Only usage returned by omp is charged; failed calls and missing usage are counted explicitly. One externally metered healthy retry is allowed, then task execution scores zero or a proposal is rejected. Forced-high and outage injection exercise the same wait loop without interrupting the shared broker.

The retry allowance above applies to each external transport invocation. Native GEPA may retry a failed reflection once more, allowing up to four metered invocations for a proposal versus two for Hone/plain before an optional Hone format repair. This native-policy asymmetry is retained and disclosed. Every observable invocation is counted; missing failed-call usage remains unknown, so these retries are not assumed free.

**Known accounting limits:** omp's final completion usage can omit tokens from internal failed attempts. Non-200 calls currently do not return usage either: their unreported token volume and dollar-equivalent are unknown, not evidence of free failures. The pilot accepts these disclosed undercounts and reports failed-call counts per method. The gateway counts provider HTTP attempts through omp's opaque fetch override and retry logger events. It checks header names only to reject API-key authentication, and separately counts those rejections so the negative auth proof cannot confuse the header guard with a native credential refusal. It never reads credential values or request bodies. Hidden attempts are provider attempts beyond the first per external call. Logger-event counts are reported separately, not added again to HTTP-attempt counts. A method is flagged above one hidden attempt per 100 calls, or when method rates differ by more than one percentage point. Zero observed hidden retries is not proof that omitted token volume is zero.

Credential-opaque per-attempt admission and usage receipts, including failed-call usage, inside omp are required before the later full benchmark matrix beyond this development pilot. No upstream issue is filed by this task.

### Fixed-budget feasibility

Keep the $10 ceiling and complete selection sets. Contract-4a IFBench calibration spent $15.85554-equivalent and 1,655,348 reported tokens across 1,360 model-evaluated rollouts. Scaling that observed mean gives about $3.49755 and 365,150 tokens for one 300-row selection pass, or $10.49264 for three passes before training or proposal. This is an inference from calibration, not a measured search or a lower bound. The three MBPP smokes report actual phase spend. Selection overhead is part of the fixed-budget result, not grounds to omit rows or grant Hone more budget. The assistant reviews those measured costs before authorizing the pilot.

## Run and replay

HoVer passed its single frozen admission attempt. The lane rebased onto security merge `ba38511431f0dd5f0fd506ddea406ae274e68e3e` before any smoke, installed Handlebars 4.7.10, Vitest 3.2.6 and Tinypool 2.1.2, and committed the [new execution seal](../evidence/pilot/security-seal-5.json): `sha256:561c9d10fbbe7768a725921c4c54ac8bc24d412eed6f060834e85fcc192772ce`. The pilot uses one pinned Python image for its isolated processes and host Bun for the native policy bridge; it does not exercise the full containerized optimizer/mutation launcher. The Python image content digest stayed unchanged. A fresh production-command probe verified Python 3.12.16, UID 65534, CPU 6, nice 10, read-only storage and denied network access. All 13 admitted scoring-source hashes stayed unchanged.

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot smoke --controls evidence/pilot/controls-5 --out evidence/pilot/smoke-5
```

Smoke permits one real proposal per method and requires both a successful proposer response and a valid complete proposed artifact. It exercises official GEPA's real subscription reflection callable without spending the full budget. Hone retains the engine's 0.2 restart probability, deterministic restart draw, one format repair, paired training slices of 8, 16 and 32, and fresh paired full-selection promotion measurements. GEPA edits the task's named native components, including separate IFBench and HoVer modules, while retaining its renderer, parser, round-robin component selection, Pareto selection, strict improvement, eight-example reflection minibatch and 10,000-metric-call safety cap. Perfect training minibatches are skipped natively until a proposal or a budget bound. Plain uses training traces and strict full-selection improvement. Every method starts from the same task seed artifact and deployment limits.

Earlier IFBench control bundles cannot authorize a contract-6 search. The current panel carries MBPP and HoVer after unchanged-execution validation and requires a terminal IFBench admission outcome. Each method's existing `spend.json` reconciles ordered ledger calls to proposal, training-evaluation and selection-evaluation spend. Repairs are proposal spend; reported failed calls and external retries remain charged. Incomplete evaluation tails stay explicitly unassigned rather than appearing free. Allocation relies on complete ordered evaluation records and their call/token/cost totals, not independently timestamped phase offsets. The command below is for another lane only after the assistant reviews the valid measured run plan and explicitly authorizes it.

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls-6 --out .pilot-runs/pilot
```

The `pilot` command runs three methods with seeds 0, 1 and 2 on the admitted panel: 27 searches for three tasks or 18 for the narrowed two-task pilot. Neither is authorized in this lane. Existing complete cells are hash-verified and reused. Interrupted cells retain their durable usage prefix and last accepted incumbent and are never selectively rerun. No final-test phase is implemented or authorized here.

Each run includes candidate artifacts, scored outputs, usage records, calibration identity, task membership, routes, budgets, and file hashes. Verify a retained bundle without model calls:

```sh
pilot/.venv/bin/python -m pilot verify --out evidence/pilot/smoke-5
```

Hash verification checks retained evidence integrity. It does not promise byte-identical stochastic provider responses on a fresh model replay.

Reported selection scores are adaptive: they select incumbents and are not unbiased estimates of deployment quality. No free postselection reevaluation or separate confirmation budget is added to this matched-budget smoke. Independent confirmation belongs to a separately authorized larger evaluation, not a public claim from these development scores.

Recompute every retained rollout's score from the pinned development data and archived task-model outputs, without provider credentials or model calls:

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot replay --out evidence/pilot/smoke-5
```

Replay first verifies the bundle hashes and task-resource identities, then runs the protected metrics again. MBPP replay executes archived solution code in the same isolated worker boundary.

`prepare`, `probe`, and `throttle-proof` regenerate the machine/task manifests, real route check, no-account/environment-fallback rejection check, and forced-high/outage pause proof. Current route evidence is `route-proof-v4`; earlier route, preparation and throttle directories carry explicit superseded status files. `aborted-controls-v1` remains inadmissible measurement evidence, not a passing control run.

## Measured contract-5 results

[The report](../evidence/pilot/results-5.json) links the frozen controls, raw calls, phase reconciliation and replay results. MBPP and HoVer passed their measured gates. IFBench's unchanged numerical results below came from the wrong training cohort and cannot admit the official partition. AIME's failed evidence remains withdrawn. The complete panel is blocked.

| Task | Improved | Naive | Broken | Shortcut | Noise envelope | Contrast |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MBPP | 0.950 | 0.700 | 0 | 0 | 0.086535 | 0.250 |
| IFBench, wrong cohort | 0.950 | 0.800 | 0 | 0.2125 | 0.067409 | 0.150 |
| HoVer | 0.600 | 0.325 | 0 | 0 | 0.178765 | 0.275 |

Each seed-0 MBPP smoke used the unchanged 90-row selection set, $10-equivalent ceiling and one-proposal limit. Dollar-equivalent phase columns include all reported invocation usage.

| Method | Selection | Calls | Tokens | Proposal | Training | Selection cost | Total | Wall seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Hone | 0.766667 | 115 | 21,661 | $0.016053 | $0.032064 | $0.116382 | $0.164499 | 385.34 |
| Official GEPA | 0.766667 | 107 | 21,275 | $0.016845 | $0.020376 | $0.112452 | $0.149673 | 375.06 |
| Plain | 0.777778 | 189 | 33,097 | $0.016053 | $0.010908 | $0.235674 | $0.262635 | 647.85 |

All three had zero hidden attempts, missing retry observations, failed calls, missing usage, unassigned calls and throttle pauses. Official GEPA made a real subscription reflection call and proposed an unchanged prompt. Hone rejected its proposal at the paired training gate; plain rejected its child after full selection. All three retained the identical seed artifact. Different scores for the identical seed are measurement variation, not an optimizer-quality result. These smokes prove the exercised integration paths, not a successful promotion or the full matrix.

**Superseded planning inference, not a valid run plan:** pre-review task-specific token/cost/time ratios projected about 35.3 million reported tokens and 86.9 serial wall-hours for 27 cells at the observed polling/quota duty cycle. The IFBench basis is now known to use a non-official cohort, so the estimate cannot authorize a matrix and needs reassessment after a new admission. It also assumes future proposal frequency, artifact behavior and latency resemble the samples. The report preserves the calculation and assumptions. The broad ceilings remain $270-equivalent, 324 million reported tokens and 54 active hours; quota and broker pauses have no finite wall-time bound.

HoVer's calibration also projects about $3.67349 per 300-row selection pass, or $11.02047 for three passes before training or proposal. Like IFBench's $10.49264 projection, this is a fixed-budget feasibility risk, not a measured search result. No cap or selection set was changed. The assistant must review the measured smoke phase costs before authorizing either matrix. Credential-opaque per-attempt and failed-call usage receipts in omp remain a prerequisite for the full matrix.

## CI and baseline failures

The Pilot GitHub Actions workflow runs frozen dependencies, pinned development metric resources, real Docker, the official metrics and the real Python-to-Bun Hone calibration bridge. It makes no broker or model calls. Container CPU affinity follows the runner's inherited affinity; this shared-machine epoch uses CPU 6.

The three reported CLI failures reproduced on isolated unmodified main at `b91d374b4b8ad4c99df3afcedf12007adad32639`: stale lock metadata, the host Bun digest mismatch, and replaced-socket identity handling. The one requested baseline run recorded 72 passing, three failing and one skipped test. See [main-baseline.json](../evidence/pilot/main-baseline.json); these are pre-existing, not suppressed pilot regressions.
