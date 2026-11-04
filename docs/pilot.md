# Development optimizer pilot

[Predeclaration 8](../evidence/pilot/predeclaration-8.md) records the gate owner's terminal-refusal ruling before new pilot calls. A provider-classified non-retryable refusal ends the current rollout with empty output and score zero, identically for every method, control and seed. Refusals are never retried. A request hash that is both refused and answered stops dispatch immediately and selects neither a panel nor a fallback.

[Diagnosis 7](../evidence/pilot/diagnosis-7.json) traced the two earlier apparent 502 failures to terminal provider refusals. Their original `controls-6` receipts and infrastructure-failure label remain unchanged. [Predeclaration 7](../evidence/pilot/predeclaration-7.md) still governs genuine infrastructure-only retries. [Predeclaration 6](../evidence/pilot/predeclaration-6.md) still fixes the cohort, controls and gates. MBPP and HoVer admissions stand after exact-source transition checks, archived all-success call checks and score replay. No installed omp, broker or system configuration changed.

[Correction 8a](../evidence/pilot/predeclaration-8a.md) fixes native gzip request observation without changing contract 8. `controls-8` infrastructure-aborted before its first row completed: three external invocations, one provider request, 159 reported tokens, $0.001353-equivalent, no refusals and no gate result. [Diagnosis 8](../evidence/pilot/diagnosis-8.json) preserves the failure and distinguishes observed SDK errors from the inferred real-abort attribution. The final predeclared infrastructure allowance is `controls-7b`; no automatic restart is installed.

`controls-7b` completed all 16 pairs on 2026-11-04 without a controller restart. IFBench passed ranking and headroom but failed noise admission: envelope `0.11728121252997001` exceeds contrast `0.02083333333333337`. The selected panel is MBPP + HoVer, a two-task development pilot. There are no further substitutions or retries after this measured failure. [The terminal audit](../evidence/pilot/admission-audit-8a.json) binds the independent arithmetic and refusal counts to the sealed evidence. One improved-arm refusal on `ifbench:train:537` scored zero; all other control and noise arms had zero refusals. No refusal nondeterminism or transport failure occurred.

Call 2507 answered after one internal retry, so final-call receipts report no transport failure while the failed attempt's token usage remains unknown. This run's observed hidden-attempt rate was 1/2616, or 0.03823%, below the 1% flag threshold. [The verification record](../evidence/pilot/verification-8a.json) binds source-audit provenance and the zero-model replay and test results.

The [initial first-seed preflight](../evidence/pilot/seed0-preflight-9/README.md) stopped before any search at the frozen source because `pilot --seed 0` selected all three seeds and did not enforce dispatcher stop rules. That historical diagnostic remains bound to its original source head. The assistant then authorized the corrections and specified the interval method. [Predeclaration 9](../evidence/pilot/predeclaration-9.md), committed before search, fixes six seed-0 cells, the paired and hierarchical bootstrap, and the 2-point practical threshold. No final-test evaluation is authorized.

Replay the historical `seed0-preflight-9/check.py` only at commit `fb813867adf95690bfd79954f7f573bcdf90dbed`, where that script and the original dispatcher coexist. Its expected 18 dispatches intentionally do not describe the corrected runner.

The corrected runner then [stopped at real admission](../evidence/pilot/seed0-9/README.md), before any search: the freshly prepared HoVer index differs from the admitted receipt in four hashes. The pinned corpus, package versions and recipe match, but exact index equality does not. No gate was relaxed or rerun. All six cells remain unstarted with zero model spend; no optimizer comparison is available.

The owner then authorized [exact admitted-artifact reuse](../evidence/pilot/index-artifact-9/README.md). All eight source files matched the admitted artifact and the `cp -a` copy rehashed identically. The source remains read-only; only this lane's copy enters the harness. Fresh rebuilds are not byte-reproducible under the pinned recipe, so future admitted reruns must reuse this artifact rather than rebuild or re-admit it.

The unchanged admission entrypoint passed on the verified copy, selecting MBPP + HoVer without model calls or final-test labels. [The result](../evidence/pilot/index-artifact-9/admission.json) records this authorized continuation separately from the preserved earlier stops.

The subsequent [actual six-cell unit failed before dispatch](../evidence/pilot/pilot-seed0-9/README.md): its launcher omitted `NLTK_DATA`, unlike the successful standalone preflight. The existing loader checks IFBench's NLP assets before the later environment setup, even though IFBench is excluded from the search panel. The installed lane cache was not on NLTK's lookup path. This triggers the unchanged pre-search handback rule. The unit was not restarted; zero of six cells started, model spend is zero, and no quality comparison is available. Final-test labels remain sealed.

The owner authorized a new attempt with `NLTK_DATA` set in the systemd unit before Python starts. The CLI now calls `configure_nlp` before admission, and the child environment uses that same setup function. Account-pool setup remains after admission. The [launch regression](../evidence/pilot/launch-environment-9.json) fails before this correction and passes with it. The resource path, measurement gates, predeclaration 9 and stop rules are unchanged. The earlier failed unit remains a separate historical stop, not a cell to retry.

The pilot decides whether Hone's proposed search policy warrants a larger comparison. It does not support a public optimizer-quality claim. It compares Hone, pinned official GEPA, and a plain agent loop with the same current subscription model and reported-plus-estimated charged budget.

[Predeclaration 4](../evidence/pilot/predeclaration-4.md), committed as `030c792` before new model calls, replaces the authored P controls with published optimized instructions and a fresh 40-row draw. [Correction 4a](../evidence/pilot/predeclaration-4a.md) removes a CPU-0 gateway override and prevents provider failures from deciding calibration scores. The transport change requires MBPP re-admission; contract-3 measurements alone cannot authorize the corrected harness. [Handoff 3](../evidence/pilot/handoff-3.md) records the earlier IFBench ranking failure.

Contract 4a stopped under AIME's noise gate. Its envelope, 0.07616286, exceeded the 0.075 improved-minus-naive contrast. MBPP and IFBench passed. [Handoff 7](../evidence/pilot/handoff-7.json) preserves the unchanged failure and all prior usage. [Predeclaration 5](../evidence/pilot/predeclaration-5.md), committed as `0bd3067` before new pilot calls, withdraws AIME and admits the already frozen HoVer reserve once. A HoVer gate failure produces a two-task MBPP + IFBench pilot with no further substitutions. An infrastructure abort produces no admitted panel. The $10 search cap and selection sets do not change.

## Prepare the runtime

Run from the repository root on Linux with Docker, Bun, uv, pnpm, and omp 18.16.0 installed. Configure the auth broker through omp itself. Do not supply credentials to this repository.

Before `prepare` or any admission/search command, verify and copy the admitted HoVer retrieval artifact using the [predeclaration-9 reuse evidence](../evidence/pilot/index-artifact-9/README.md). Do not let an empty cache trigger a fresh index build for an admitted rerun. A source or copy hash mismatch requires handback, not rebuilding or relaxing the exact gate.

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

Correction 8a used the zero-model source proof and final `controls-7b` infrastructure allowance from predeclaration 7. The commands below record that completed attempt, not permission to run it again. Never overwrite or restart existing evidence. The IFBench cohort, artifacts, caps and gates stayed unchanged.

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot adversarial --out evidence/pilot/adversarial-8a
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot controls --adversarial evidence/pilot/adversarial-8a --out evidence/pilot/controls-7b
```

The zero-model `adversarial-8`, `adversarial-8-final` and `adversarial-8-dispatch` setups remain unchanged. The current source proof is `adversarial-8a`. The source transition also binds the unchanged prior transition and the new transport declaration. This is not a new draw, a gate retune, or an extra allowance beyond the two approved infrastructure replacements.

The first command carries MBPP and HoVer forward without model calls after sealed-evidence and exact old/new source checks. It runs IFBench checker/protocol attacks outside candidate control before auth. The second command measures IFBench once. Terminal refusals are zero-score task responses; transport errors remain infrastructure failures, never candidate scores or measured gate failures. Both the transport and official GEPA reflection bridge prevent refusal redispatch.

Refusal receipts expose only category, request hash, role and row/arm context. A cloned provider stream supplies structured terminal evidence, including bare refusal/sensitive stop reasons with category `unspecified`; model text and generic 502 messages cannot classify refusals. Native request bytes pass unchanged. Only a terminal refusal triggers bounded gzip decoding and token counting of the original JSON. Caller metadata never enters requests or their hashes. Reported usage stays separate from estimated charges; unknown refusal usage retains the existing 4096-token allowance and full requested output maximum. [The current source audit](../evidence/pilot/source-audit-8a.json) records failing-before gzip regressions, real native-router/ledger fixtures and exact source authorization.

MBPP re-admission is accepted only after 660 successful task calls, nonempty naive/noise outputs and a complete offline score replay. The sealed `audit.json` binds these checks to the control, call and evaluation files. This rejects a silent Docker outage that could fake zero noise. Reuse also requires every consumed score and audit file to be listed in the completed seal. Startup failures are retained; no automatic restart is authorized. Smoke and pilot enforce CPU 6 themselves, not only through the documented shell prefix.

IFBench takes `Random(1).sample(source_rows[300:600], 150)`, then freezes a 40-row draw from sorted training IDs with seed `20261106`. Selection stays `source_rows[:300]`. HoVer retains its seed-20261105 40-row draw and passing 16-pair calibration. MBPP retains its previous 20-row draw and 16 pairs. AIME stays withdrawn.

Admission requires known-improved > naive > both broken and shortcut, with broken = 0 and MBPP shortcut = 0. P positives execute published optimized instructions, not trusted answers or a prompt authored here. Sixteen fresh paired unchanged-seed trials measure noise without response caching. Keep `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s, max_abs_delta)`. The envelope must be strictly below the positive-control contrast. Projection uses `sqrt(source_rows/n)`: 40 for P and 20 for MBPP. An IFBench checker, headroom, ranking or noise failure selects MBPP + HoVer, labelled a two-task development pilot, without retuning or substitution. Zero estimated noise is not proof of a noiseless evaluator.

A failed control command preserves its evidence and refuses to overwrite that folder. The current runner authorizes only `evidence/pilot/controls-7b`, the last infrastructure allowance. No automatic restart is introduced. A refusal or completed gate result cannot use infrastructure retry eligibility. A completed IFBench checker, headroom, ranking or noise failure selects MBPP + HoVer. Missing results and refusal nondeterminism do not.

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

The [final-verifier reference audit](../evidence/pilot/reference-audit-6/README.md) exercised every development row without model calls. All 464 rows are gradeable. The official reference passes 364/374 training rows and 88/90 selection rows, or 452/464 overall. Ten failed references return a float where the assertions expect an int; two diagnostic workers exit unsuccessfully. Exact failing IDs and validated canonical mismatches are retained. This is a reference pass rate, not a mathematical score ceiling: another valid solution can return the exact expected types. Neither the verifier nor the denominator was changed to make the reference perfect.

Adversarial admission exercises execution replacement, always-equal objects, early exits, verdict and receipt forgery, checker monkeypatches, expected-value reads and atexit rewrites. The previous shortcut remains unchanged. IFBench and HoVer accept strings only through protected JSON protocols; those strings never execute in their trusted checkers. The archived AIME checker has the same separation. These controls test the declared boundary, not a general proof against every possible candidate.

## Matched reported-plus-estimated accounting

Every role passes through `ModelCalls`, including task execution, reflection, judging if present, repairs, and externally repeated requests. Calls, tokens, published-rate dollar-equivalents, wall time, pauses, errors, and observed internal retries are retained. There is no LLM judge for these tasks.

The frozen route is `anthropic/claude-sonnet-4-6` for both task and proposer calls. There is no model fallback. Decoding uses temperature zero and native reasoning disabled; protected P protocols still request visible reasoning strings. P task calls request at most 4,096 output tokens each. Proposer and format-repair calls request at most 2,048. The [published list prices](https://platform.claude.com/docs/en/about-claude/pricing) are $3 input, $15 output, $0.30 cache read, and $3.75 five-minute cache write per million tokens. Cache retention is disabled; any reported cache tokens are still counted and priced.

Each search has a $10-equivalent charged-usage ceiling, 12 million charged tokens, 30,000 model calls, 500 proposer/repair calls, 10,000 scored rollouts, and two hours of active wall time. Charged totals combine provider-reported usage and separately labelled conservative refusal estimates. A conservative token reservation precedes each request. Throttle polling and subscription pauses do not consume active work time; both are reported separately from elapsed wall time. The binding cap is recorded. Actual subscription billing is not treated as an API dollar invoice. Controls have separate $100-equivalent and 24-hour active-work ceilings per task, recorded before measurement in `measurement-budget.json`; their `search_budget` metadata describes the comparison's $10 cap. Controls and route proofs have separate published ledgers and are not charged selectively to a method.

Before every model call, the throttle checks broker health and invokes `omp usage --json --no-extensions`. It conservatively checks every reported limit for every allowed account, including limits shared with other models. It pauses above 80%, or when usage is absent, malformed, or more than ten minutes old. The 20% reserve protects other seats and lanes. Outages pause dispatch and are checked again every 30 seconds. A failed connection is closed and resolved again after the wait, including when a relocated broker is already healthy. Failed calls and missing usage are counted explicitly. One externally metered healthy retry remains for non-refusal call failures; a terminal refusal is never retried. Calibration transport failures abort without a measured gate result. Forced-high and outage injection exercise the same wait loop without interrupting the shared broker.

The retry allowance above applies to each external non-refusal transport invocation. Native GEPA may retry a failed reflection once more, allowing up to four metered invocations for a proposal versus two for Hone/plain before an optional Hone format repair. This native-policy asymmetry is retained and disclosed. The refusal latch blocks that fallback for a refused proposal, then clears before the next logical proposal. Every observable invocation is counted; missing non-refusal failed-call usage remains unknown, so these retries are not assumed free.

**Known accounting limits:** omp's final completion usage can omit tokens from internal failed attempts. Non-refusal transport failures without usage have unknown token volume and dollar-equivalent, not evidence of free failures. Unknown terminal-refusal usage instead receives the conservative estimated charge described above. The pilot discloses these distinctions and reports failed-call counts per method. The gateway counts provider HTTP attempts through omp's opaque fetch override and retry logger events. It checks header names only to reject API-key authentication, and separately counts those rejections so the negative auth proof cannot confuse the header guard with a native credential refusal. Hone never inspects credential values; it counts provider JSON locally without persisting the wire body or using candidate text to classify refusals. Hidden attempts are provider attempts beyond the first per external call. Logger-event counts are reported separately, not added again to HTTP-attempt counts. A method is flagged above one hidden attempt per 100 calls, or when method rates differ by more than one percentage point. Zero observed hidden retries is not proof that omitted token volume is zero.

Credential-opaque per-attempt admission and usage receipts, including failed-call usage, inside omp are required before the later full benchmark matrix beyond this development pilot. No upstream issue is filed by this task.

### Fixed-budget feasibility

Keep the $10 ceiling and complete selection sets. The earlier IFBench illustration, $3.49755 per selection pass and $10.49264 for three, came from the invalid contract-4a cohort and is not a corrected-partition price estimate. [Run plan 8](../evidence/pilot/run-plan-8.json) preserves the earlier infrastructure abort. [Run plan 8a](../evidence/pilot/run-plan-8a.json) uses the completed calibration and selects MBPP + HoVer. Its serial 18-search projection is 27.53 million tokens, $141.24-equivalent and 64.42 wall-hours including 1.13 inferred validation-setup hours. It separates 33.76 active hours, 29.47 usage-polling hours and 0.048 observed-duty pause hours. These are inferred search costs, not new runs or guaranteed elapsed time. Prior calibration costs are reported separately. The three-task projection is a counterfactual only: IFBench is not admitted. Neither matrix is authorized, and selection overhead remains charged.

## Run and replay

HoVer passed its single frozen admission attempt. The lane rebased onto security merge `ba38511431f0dd5f0fd506ddea406ae274e68e3e` before any smoke, installed Handlebars 4.7.10, Vitest 3.2.6 and Tinypool 2.1.2, and committed the [new execution seal](../evidence/pilot/security-seal-5.json): `sha256:561c9d10fbbe7768a725921c4c54ac8bc24d412eed6f060834e85fcc192772ce`. The pilot uses one pinned Python image for its isolated processes and host Bun for the native policy bridge; it does not exercise the full containerized optimizer/mutation launcher. The Python image content digest stayed unchanged. A fresh production-command probe verified Python 3.12.16, UID 65534, CPU 6, nice 10, read-only storage and denied network access. All 13 admitted scoring-source hashes stayed unchanged.

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu pilot/.venv/bin/python -m pilot smoke --controls evidence/pilot/controls-5 --out evidence/pilot/smoke-5
```

Smoke permits one real proposal per method and requires both a successful proposer response and a valid complete proposed artifact. It exercises official GEPA's real subscription reflection callable without spending the full budget. Hone retains the engine's 0.2 restart probability, deterministic restart draw, one format repair, paired training slices of 8, 16 and 32, and fresh paired full-selection promotion measurements. GEPA edits the task's named native components, including separate IFBench and HoVer modules, while retaining its renderer, parser, round-robin component selection, Pareto selection, strict improvement, eight-example reflection minibatch and 10,000-metric-call safety cap. Perfect training minibatches are skipped natively until a proposal or a budget bound. Plain uses training traces and strict full-selection improvement. Every method starts from the same task seed artifact and deployment limits.

Earlier IFBench bundles, including the `controls-8` infrastructure abort, cannot authorize a search. The terminal `controls-7b` outcome selects only MBPP + HoVer after unchanged-execution validation. Each method's `spend.json` reconciles ordered calls to proposal, training-evaluation and selection-evaluation spend. Repairs, failed calls and external retries remain counted; incomplete evaluation tails remain explicitly unassigned. Predeclaration 9 restricts the development run to six cells. After the recorded startup handback, another attempt requires resumption authorization, unchanged admission, green CI and an exact-head cross-family READY. The launch form below supplies the existing NLP cache before Python starts; it is not an executed retry.

```sh
nice -n 10 taskset -c 6 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 JAX_PLATFORMS=cpu NLTK_DATA="$PWD/.pilot-cache/nltk" pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls-7b --seed 0 --out .pilot-runs/pilot-seed0-9
```

The `pilot` command honors exactly its `--seed`, defaulting to 0, on the admitted panel. It runs cells serially and checks finished receipts before the next cell: run-wide hidden attempts above 1%, any cell's unknown usage above 1%, or two consecutive infrastructure failures stop new dispatch. Exactly 1% is allowed. `stop.json` and `comparison.json` preserve the reason and counts; the active cell finishes before a rate-based stop. The throttle also enforces the remaining six-hour total pause allowance. Existing complete cells are hash-verified and reused; interrupted cells retain durable usage and are never selectively rerun. Seeds 1 and 2 and all final-test evaluation remain out of scope.

Each run includes candidate artifacts, scored outputs, usage records, calibration identity, task membership, routes, budgets, and file hashes. Verify a retained bundle without model calls:

```sh
pilot/.venv/bin/python -m pilot verify --out evidence/pilot/smoke-5
```

Hash verification checks retained evidence integrity. It does not promise byte-identical stochastic provider responses on a fresh model replay.

Reported selection scores are adaptive: they select incumbents and are not unbiased estimates of deployment quality. No free postselection reevaluation or separate confirmation budget is added to this matched-budget smoke. Independent confirmation belongs to a separately authorized larger evaluation, not a public claim from these development scores.

For seed 0, `python -m pilot.results --runs .pilot-runs/pilot-seed0-9 --out evidence/pilot/results-9-seed0.json` computes inference entirely from archived development outputs. It resamples unique paired selection instances 10,000 times for each task and method, then uses a task-and-instance hierarchical bootstrap for the equal-weight two-task mean. Both report 95% percentile intervals. An unchanged artifact compares the same baseline vector with itself, so stochastic rescoring cannot masquerade as an artifact improvement. The report labels adaptive selection, the 2-point practical threshold, and no superiority claim or Holm correction. The earlier `results-9.json` remains the historical no-search stop report.

Interrupted pause prefixes retain their per-cell `pause_accounting_incomplete` marker. Their per-method exact pause total is unavailable; `timing.lower_bounds.pause_seconds` reports the summed known prefix instead. [The precision regression and zero-model CLI smoke](../evidence/pilot/report-precision-9.json) cover both incomplete and complete timing, with 264 passing Python tests.

Recompute every retained rollout's score from the pinned development data and archived task-model outputs, without provider credentials or model calls:

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot replay --out evidence/pilot/smoke-5
```

Replay first verifies the bundle hashes and task-resource identities, then runs the protected metrics again. MBPP replay executes archived solution code in the same isolated worker boundary.

`prepare`, `probe`, and `throttle-proof` regenerate the machine/task manifests, real route check, no-account/environment-fallback rejection check, and forced-high/outage pause proof. Current route evidence is `route-proof-v4`; earlier route, preparation and throttle directories carry explicit superseded status files. `aborted-controls-v1` remains inadmissible measurement evidence, not a passing control run.

## Contract-9 verification and admission stop

[Verification 9](../evidence/pilot/verification-9.json) records 263 passing Python tests with real Docker and official metrics, twelve passing native receipt tests, and failing-before dispatch, startup-pause and interrupted-pause regressions. It also records the real admission failure, zero-model startup and recovery smokes, and byte-identical stopped-run report replay. The [source transition](../evidence/pilot/source-transition-9.json) preserves the authenticated contract-8a execution baseline without changing archived control bundles.

## Contract-8 verification and setup

The corrected source passes 224 Python tests with real Docker and official metrics, plus twelve Bun receipt tests. Native-router fixtures cover full, bare-refusal, bare-sensitive and native gzip requests through ledger settlement with one dispatch each. A two-proposal regression proves that Hone, official GEPA and plain each count a refused proposal once, continue to the next logical proposal and retain its successful artifact. Shared public/private history and durable markers also block later probes at unrelated output paths. Startup reports admit no panel when usage is absent or zero. Workspace typechecking, 71 native optimizer tests and 70 capsule-kit tests pass.

[The setup measurement](../evidence/pilot/setup-overhead-8.json) records one cold MBPP load at 226.73 seconds and one warm 720-rollout retained-admission validation at 349.52 seconds, on CPU 6 at nice 10 without model calls. Eleven validations per matrix plus that load imply 1.13 setup hours. This is one observation, not a latency distribution or hard bound. Carrying it across later transport-only corrections is an explicit inference; corpus/index preparation is separate.

Forecasts inspect every calibration call receipt. Estimated refusal charges cannot conceal missing transport usage. Unknown non-refusal volume is disclosed separately, and any affected projection is a conditional known-charge lower bound, not an exact total-dollar forecast. Both matrices remain unauthorized.

## Historical contract-6 result and prospective plan

The contract-6 runner labelled the corrected IFBench attempt infrastructure-failure during the improved control. Diagnosis 7 later identified terminal refusals behind both local 502 statuses. The completed naive mean was 0.841667. Frozen totals remain 128 calls, 141,064 reported tokens, $1.160328-equivalent and 1,365.35 seconds of ledger wall time. Calls 127 and 128 lacked usage in Hone's receipts; their omitted volume remains unknown and is not retroactively charged or scored. Hidden attempts were zero. A stale-account-usage pause lasted 254.49 seconds.

Call 128 was the then-frozen runner's single externally metered retry of call 127. The attempt itself was never restarted. Contract 8 prohibits retrying these terminal refusals. These external invocations remain distinct from omp's observed internal hidden-attempt count, which was zero.

The earlier runner retained its abort rather than inventing a score or fallback. That frozen infrastructure label does not establish an outage or activate a measured-gate-failure fallback.

[The replayable run-plan report](../evidence/pilot/run-plan-6.json) preserves actual calibration per task and per-method smoke phase spend. Regenerate it without model calls:

```sh
nice -n 10 taskset -c 6 pilot/.venv/bin/python -m pilot.run_plan --controls evidence/pilot/controls-6 --out .pilot-state/run-plan-6-replay.json
```

At contract 6, the prospective MBPP + HoVer 18-cell estimate was 27.53 million reported tokens and 63.77 serial wall-hours, including 0.49 hours of measured retained-admission setup. Its components were 33.76 active hours, 29.47 usage-polling hours, 0.048 hours of observed-rate pauses and the setup estimate. That epoch had not selected or admitted a complete panel, and no matrix was authorized. MBPP projections used each method's actual smoke; HoVer used task-calibration ratios, not invented method-search results. Future proposer frequency and candidate deployment costs remained uncertain.

At that epoch, a three-task point forecast was unavailable because the corrected IFBench admission and calibration were incomplete. Its ceilings were $270-equivalent, 324 million reported tokens and 54 active hours across 27 cells. The prospective two-task ceilings were $180-equivalent, 216 million tokens and 36 active hours. Neither had a finite elapsed-wall upper bound: high usage, stale or missing readings, and broker outages pause dispatch. Corpus download/index preparation was separate. No matrix was run or authorized.

## Measured contract-5 results

[The report](../evidence/pilot/results-5.json) links the frozen controls, raw calls, phase reconciliation and replay results. MBPP and HoVer passed their measured gates. IFBench's unchanged numerical results below came from the wrong training cohort and cannot admit the official partition. AIME's failed evidence remains withdrawn. The complete panel was blocked at contract 5.

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

HoVer's admitted calibration projects about $3.67349 per 300-row selection pass, or $11.02047 for three passes before training or proposal. This is a fixed-budget feasibility risk, not a measured search result. The earlier IFBench $10.49264 figure belongs only to invalid-cohort history and is not used by the current plan. No cap or selection set was changed. The assistant must review measured smoke phase costs before authorizing either matrix. Credential-opaque per-attempt and failed-call usage receipts in omp remain a prerequisite for the full matrix.

## CI and baseline failures

The Pilot GitHub Actions workflow runs frozen dependencies, pinned development metric resources, real Docker, the official metrics and the real Python-to-Bun Hone calibration bridge. It makes no broker or model calls. Container CPU affinity follows the runner's inherited affinity; this shared-machine epoch uses CPU 6.

The three reported CLI failures reproduced on isolated unmodified main at `b91d374b4b8ad4c99df3afcedf12007adad32639`: stale lock metadata, the host Bun digest mismatch, and replaced-socket identity handling. The one requested baseline run recorded 72 passing, three failing and one skipped test. See [main-baseline.json](../evidence/pilot/main-baseline.json); these are pre-existing, not suppressed pilot regressions.
