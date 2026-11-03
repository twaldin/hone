# Development optimizer pilot

The pilot decides whether Hone's proposed search policy warrants a larger comparison. It does not support a public optimizer-quality claim. It compares Hone, pinned official GEPA, and a plain agent loop with the same current subscription model and reported-usage budget.

[Predeclaration 4](../evidence/pilot/predeclaration-4.md), committed as `030c792` before new model calls, replaces the authored P controls with published optimized instructions and a fresh 40-row draw. [Correction 4a](../evidence/pilot/predeclaration-4a.md) removes a CPU-0 gateway override and prevents provider failures from deciding calibration scores. The transport change requires MBPP re-admission; contract-3 measurements alone cannot authorize the corrected harness. [Handoff 3](../evidence/pilot/handoff-3.md) records the earlier IFBench ranking failure.

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

Preparation builds the pinned HoVer index before any IFBench score can select that alternate. The observed cold preparation called the real `prepare` entrypoint through a measured launcher: 310.97 seconds and 7.32 GiB peak RSS on one CPU. It indexed all 5,233,330 published corpus rows, including the empty metadata row. [Preparation evidence](../evidence/pilot/preparation-4) distinguishes that launcher from the equivalent public replay command. Corpus and numeric-index hashes enter sealed admission evidence. Setup failures occur before model dispatch and cannot become row scores or trigger a new headroom draw.

The prepare command creates an ignored pilot-specific account-pool file from `omp usage accounts`. It permits only Anthropic OAuth identities on `gmail.com` and `purdue.edu`. It excludes `lindy.ai`, every other provider, and every API key. The gateway also installs an OAuth-only native credential-session restriction: environment/configuration fallbacks cannot escape the pool. It selects the bundled model directly, without loading local model overrides. Public manifests record domain counts and the pool hash, not full account identities. Never commit `.pilot-state` or `.pilot-cache`.

Auth and usage child processes receive only an explicit allowlist of home, executable-search, temporary, and configuration/cache directory paths, plus pilot-owned settings. The harness never copies the host environment or reads credential-valued environment variables. The negative route proof uses non-secret fixture strings to prove that native OAuth restrictions reject environment fallbacks before any provider HTTP request.

## Admit the evaluator before search

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot readmit-mbpp --out evidence/pilot/mbpp-readmission-4a
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot adversarial --out evidence/pilot/adversarial-4a
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot throttle-proof --out evidence/pilot/throttle-proof-4a
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot controls --adversarial evidence/pilot/adversarial-4a --out evidence/pilot/controls-4a
```

The first command re-admits MBPP after its transport code changes: full adversarial checks, unchanged controls and unchanged noise procedure. It freezes the source contract and completes offline checks before auth or model bootstrap. The next command carries only that corrected admission forward, checking worker, scorer, transport, MBPP-specialized task/search code, data, route, decoding, cohort and seed hashes. Fresh P attacks pass through direct scoring and every protected response stage in both JSON and raw-protocol modes. A positive attack stops before auth and retains its artifact. Calibration transport failures abort as infrastructure failures, not zero candidate scores or measured gate failures.

P draws use `random.Random(20261105).sample(eligible, 40)` after sorting official training IDs. Their proposed cohorts and admissions are sealed before P model calls. IFBench's official naive seed runs first. A score at least 0.90 replaces IFBench with HoVer without measuring its improved control or noise. AIME keeps its own strict ranking and noise rule, without a replacement. MBPP re-admission keeps its previous 20-row draw, seed and 16 paired trials; its earlier row exclusions affect that draw only, never training or search.

Admission requires known-improved > naive > both broken and shortcut, with broken = 0 and MBPP shortcut = 0. P positives execute published optimized instructions, not trusted answers or a prompt authored here. Sixteen fresh paired unchanged-seed trials measure noise without response caching. Keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, max_abs_delta)`. The envelope must be strictly below the positive-control contrast. Projection uses `sqrt(source_rows/n)`: 40 for P and 20 for MBPP. A tie, reversed rank or obscured contrast stops without retuning. Zero estimated noise is not proof of a noiseless evaluator.

A failed control command preserves its evidence. The runner refuses to overwrite it. Stop and inspect the measurement contract instead of rerunning until it passes.

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
| P IFBench | 300 | 300 | Official loose instruction fraction from GEPA artifact `cbefbc1aa0f43dd39874ec4bf42211365dbda42e`. Selection is development-file rows 0–299, training is rows 300–599. This follows released code rather than the plan's 150-training figure. | Tests prompt optimization against explicit instruction constraints and a non-LLM checker. |
| P HoVer, conditional alternate | 150 | 300 | Official GEPA three-support-document partition, 40% test, 40% validation, 20% train after seed-0 shuffle, with independent seed-1 caps. Discrete normalized supporting-title subset metric. | Replaces IFBench only at the predeclared headroom threshold; adds four-module retrieval optimization without an LLM judge. |
| P AIME | 45 | 45 | Historical 90-question development data at `project-numina/aimo-validation-aime`, revision `13f9e12f613e720c2a2b2f345dd04b998a29494d`. Preserve `Random(0).shuffle`, then halves. The protected response separates `reasoning` and `answer`; apply official `int(pred.answer)` only to `answer`, with no boxed-answer recovery. | Adds reasoning-heavy exact-answer tasks without opening the AIME2025 final panel. |
| A MBPP | 374 | 90 | Official full training and validation files at `google-research-datasets/mbpp`, revision `4bb6404fdc6cacfda99d4ac4205087b89d32030c`. Score all published development assertions passing. | Supplies a CC-BY-4.0 executable agent-program task with deterministic assertions and a bounded, isolated deployment. |

Only explicit development labels are decoded. The eager upstream constructors, AIME2025 final dataset, and MBPP test files are never loaded. HoVer first establishes exact membership using opaque canonical JSON title-token equality, then decodes only the 150 training and 300 selection rows. No held-out row reaches the JSON decoder. Ordered membership, source hashes, checker hashes, package versions, and NLP asset hashes are recorded. IFBench's licensed checker retains every loose-response variant; only download statements and the `dspy.Prediction` container dependency are adapted. Its randomness is fixed by row identity and the language detector seed is zero.

IFBench preserves the released two-stage program. Editable `prompt` supplies generation instructions and editable `revision_prompt` supplies revision instructions. Each stage receives only its own instruction. Generation returns `reasoning` and `response`; revision receives the original query and draft and returns `reasoning` and `final_response`. Only `final_response` enters the official checker. Both calls are metered task calls, and the JSON protocol and metric remain protected.

HoVer preserves the four official modules: initial retrieval, summary, hop-2 query, retrieval, contextual summary, hop-3 query, retrieval. It retrieves 7, 7 and 10 passages and scores their ordered concatenation by gold-title coverage. The corpus pin, BM25S 0.2.12, PyStemmer 2.2.0.3, CPU JAX 0.6.0, English stopwords/stemming and `k1=0.9,b=0.4` are fixed across methods. Public indices with different parameters are not substituted. HoVer data is CC-BY-SA-4.0. The Wikipedia corpus is fetched at runtime, not committed; archived excerpts retain Wikipedia attribution.

HoVer claims and support annotations are attributed to the [HoVer authors](https://github.com/hover-nlp/hover/tree/39b84697f196308f398a251a7aea9b82ae0f0562) under [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/). Retrieval excerpts are attributed to Wikipedia contributors, from the 2017 snapshot under [CC-BY-SA-3.0](https://creativecommons.org/licenses/by-sa/3.0/), via the [pinned DSPy repack](https://github.com/dspy/cache/tree/ef6a5e72a98b47cef31574a400fea8fe149559a3). Each archived passage retains its article-title prefix: its attribution and revision history are `https://en.wikipedia.org/wiki/{URL-encoded title}` and that URL plus `?action=history`. The repack supplies no separate license grant; this harness redistributes neither the full corpus nor the retrieval index.

MBPP is a declared agent-program adaptation, not a claim to reproduce an official optimizer program. Its dataset is [Mostly Basic Python Problems](https://huggingface.co/datasets/google-research-datasets/mbpp), released by Google Research under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), associated with [Austin et al., Program Synthesis with Large Language Models](https://arxiv.org/abs/2108.07732). The input adds function declarations derived from reference ASTs, never reference bodies or assertions. No Terrarium source or data is used.

The mutable MBPP artifact contains a prompt and Python program. The program runs in a non-root, read-only, network-disabled Docker container without credentials or host home directories. It can make at most two brokered task-model calls, request at most 4,096 output tokens in total, and send at most 65,536 prompt bytes. Program execution has a 30-second bound excluding model wait; its owned container is paused while waiting, so candidates cannot compute free of that bound. Container processes run at nice 10. The model transport has a 600-second per-request bound.

The answer is program text. The common extractor takes the first python-tagged or bare fenced block, otherwise the whole output. A trusted planner uses official reference code, setup and assertions in a bounded pinned-Python process without candidate code. It produces function calls with plain-data arguments and protected expected results. A separate fresh candidate container per row receives only candidate source and call arguments. The trusted parent validates returned tagged JSON and decides every equality. No test files, expected values, host directories or credentials enter the candidate container.

Tagged data preserves exact builtin types, sequence order and order-independent mappings and sets. Official wrappers, including `int`, run on the trusted side before comparison. Pair and Node inputs are class-name and field records, reconstructed without candidate constructors. A custom result is compared structurally against the trusted expected class name and field schema. Candidate `__eq__`, `__hash__` and `__repr__` cannot decide the grade. Executable values, unsupported subclasses, cycles, malformed data, extra output, timeouts and failed exits do not pass. Every row remains in the denominator; any safely unrepresentable official row is listed as ungradeable and scores zero for every method.

Adversarial admission exercises execution replacement, always-equal objects, early exits, verdict and receipt forgery, checker monkeypatches, expected-value reads and atexit rewrites. The previous shortcut remains unchanged. IFBench and AIME only accept strings through protected JSON protocols; those strings never execute in their trusted checkers. These controls test the declared boundary, not a general proof against every possible candidate.

## Matched reported-usage accounting

Every role passes through `ModelCalls`, including task execution, reflection, judging if present, repairs, and externally repeated requests. Calls, tokens, published-rate dollar-equivalents, wall time, pauses, errors, and observed internal retries are retained. There is no LLM judge for these tasks.

The frozen route is `anthropic/claude-sonnet-4-6` for both task and proposer calls. There is no model fallback. Decoding uses temperature zero and native reasoning disabled; protected P protocols still request visible reasoning strings. P task calls request at most 4,096 output tokens each. Proposer and format-repair calls request at most 2,048. The [published list prices](https://platform.claude.com/docs/en/about-claude/pricing) are $3 input, $15 output, $0.30 cache read, and $3.75 five-minute cache write per million tokens. Cache retention is disabled; any reported cache tokens are still counted and priced.

Each search has a $10-equivalent reported-usage ceiling, 12 million reported tokens, 30,000 model calls, 500 proposer/repair calls, 10,000 scored rollouts, and two hours of active wall time. A conservative token reservation precedes each request. Throttle polling and subscription pauses do not consume active work time; both are reported separately from elapsed wall time. The binding cap is recorded. Actual subscription billing is not treated as an API dollar invoice. Controls have separate $100-equivalent and 24-hour active-work ceilings per task, recorded before measurement in `measurement-budget.json`; their `search_budget` metadata describes the comparison's $10 cap. Controls and route proofs have separate published ledgers and are not charged selectively to a method.

Before every model call, the throttle checks broker health and invokes `omp usage --json --no-extensions`. It conservatively checks every reported limit for every allowed account, including limits shared with other models. It pauses above 80%, or when usage is absent, malformed, or more than ten minutes old. The 20% reserve protects other seats and lanes. Outages pause dispatch and are checked again every 30 seconds. A failed connection is closed and resolved again after the wait, including when a relocated broker is already healthy. Only usage returned by omp is charged; failed calls and missing usage are counted explicitly. One externally metered healthy retry is allowed, then task execution scores zero or a proposal is rejected. Forced-high and outage injection exercise the same wait loop without interrupting the shared broker.

The retry allowance above applies to each external transport invocation. Native GEPA may retry a failed reflection once more, allowing up to four metered invocations for a proposal versus two for Hone/plain before an optional Hone format repair. This native-policy asymmetry is retained and disclosed. Every observable invocation is counted; missing failed-call usage remains unknown, so these retries are not assumed free.

**Known accounting limits:** omp's final completion usage can omit tokens from internal failed attempts. Non-200 calls currently do not return usage either: their unreported token volume and dollar-equivalent are unknown, not evidence of free failures. The pilot accepts these disclosed undercounts and reports failed-call counts per method. The gateway counts provider HTTP attempts through omp's opaque fetch override and retry logger events. It checks header names only to reject API-key authentication, and separately counts those rejections so the negative auth proof cannot confuse the header guard with a native credential refusal. It never reads credential values or request bodies. Hidden attempts are provider attempts beyond the first per external call. Logger-event counts are reported separately, not added again to HTTP-attempt counts. A method is flagged above one hidden attempt per 100 calls, or when method rates differ by more than one percentage point. Zero observed hidden retries is not proof that omitted token volume is zero.

Credential-opaque per-attempt admission and usage receipts, including failed-call usage, inside omp are required before the later full benchmark matrix beyond this development pilot. No upstream issue is filed by this task.

### Fixed-budget feasibility

Keep the requested $10 ceiling rather than increase it to favor Hone's more expensive gate. The inadmissible v1 IFBench run still provides observed transport costs: 166 calls cost $0.995589-equivalent. A simple projection at that old mean is about $3.60 for a two-call, 300-row selection pass, and $10.80 for Hone's seed/parent/child passes before training or reflection. This is an inference, not a lower bound: the corrected structured two-stage program has not yet been priced. Hone may exhaust the dollar or two-hour active-work cap before its first IFBench promotion. That overhead is part of the fixed-budget result, not grounds to omit the task or grant Hone more budget. The assistant must review the measured feasibility before authorizing the matrix.

## Run and replay

Successful offline admission alone is insufficient. Every selected task's ranking and noise gates must pass, and the assistant must review the smoke evidence before authorizing the next lane:

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot smoke --controls evidence/pilot/controls-4a --out evidence/pilot/smoke-4a
```

Smoke permits one real proposal per method and requires both a successful proposer response and a valid complete proposed artifact. It exercises official GEPA's real subscription reflection callable without spending the full budget. Hone retains the engine's 0.2 restart probability, deterministic restart draw, one format repair, paired training slices of 8, 16 and 32, and fresh paired full-selection promotion measurements. GEPA edits the task's named native components, including separate IFBench and HoVer modules, while retaining its renderer, parser, round-robin component selection, Pareto selection, strict improvement, eight-example reflection minibatch and 10,000-metric-call safety cap. Perfect training minibatches are skipped natively until a proposal or a budget bound. Plain uses training traces and strict full-selection improvement. Every method starts from the same task seed artifact and deployment limits.

The failed `controls-3` bundle and superseded transport-4 admission cannot authorize a search. Only the corrected MBPP re-admission and passing fresh P controls can do so. The development pilot accepts disclosed reported usage and measured hidden-attempt rates. The command below is for the second lane only after the assistant approves all three smoke results.

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls-4a --out .pilot-runs/pilot-27
```

The `pilot` command runs three methods on three tasks with seeds 0, 1 and 2. Existing complete cells are hash-verified and reused. Interrupted cells retain their durable usage prefix and last accepted incumbent and are never selectively rerun. No final test phase is implemented or authorized here.

Each run includes candidate artifacts, scored outputs, usage records, calibration identity, task membership, routes, budgets, and file hashes. Verify a retained bundle without model calls:

```sh
pilot/.venv/bin/python -m pilot verify --out evidence/pilot/smoke-4a
```

Hash verification checks retained evidence integrity. It does not promise byte-identical stochastic provider responses on a fresh model replay.

Reported selection scores are adaptive: they select incumbents and are not unbiased estimates of deployment quality. No free postselection reevaluation or separate confirmation budget is added to this matched-budget smoke. Independent confirmation belongs to a separately authorized larger evaluation, not a public claim from these development scores.

Recompute every retained rollout's score from the pinned development data and archived task-model outputs, without provider credentials or model calls:

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot replay --out evidence/pilot/smoke-4a
```

Replay first verifies the bundle hashes and task-resource identities, then runs the protected metrics again. MBPP replay executes archived solution code in the same isolated worker boundary.

`prepare`, `probe`, and `throttle-proof` regenerate the machine/task manifests, real route check, no-account/environment-fallback rejection check, and forced-high/outage pause proof. Current route evidence is `route-proof-v4`; earlier route, preparation and throttle directories carry explicit superseded status files. `aborted-controls-v1` remains inadmissible measurement evidence, not a passing control run.

## CI and baseline failures

The Pilot GitHub Actions workflow runs frozen dependencies, pinned development metric resources, real Docker, the official metrics and the real Python-to-Bun Hone calibration bridge. It makes no broker or model calls. Container CPU affinity follows the runner's inherited affinity; this shared-machine epoch uses CPU 6.

The three reported CLI failures reproduced on isolated unmodified main at `b91d374b4b8ad4c99df3afcedf12007adad32639`: stale lock metadata, the host Bun digest mismatch, and replaced-socket identity handling. The one requested baseline run recorded 72 passing, three failing and one skipped test. See [main-baseline.json](../evidence/pilot/main-baseline.json); these are pre-existing, not suppressed pilot regressions.
