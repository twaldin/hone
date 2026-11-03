# Development optimizer pilot

The pilot decides whether Hone's proposed search policy warrants a larger comparison. It does not support a public optimizer-quality claim. It compares Hone, pinned official GEPA, and a plain agent loop with the same current subscription model and reported-usage budget.

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

The prepare command creates an ignored pilot-specific account-pool file from `omp usage accounts`. It permits only Anthropic OAuth identities on `gmail.com` and `purdue.edu`. It excludes `lindy.ai`, every other provider, and every API key. Public manifests record domain counts and the pool hash, not full account identities. Never commit `.pilot-state` or `.pilot-cache`.

## Admit the evaluator before search

```sh
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot throttle-proof --out .pilot-runs/throttle-proof
nice -n 10 taskset -c 0 pilot/.venv/bin/python -m pilot controls --out .pilot-runs/controls
```

Controls run on the first eight training examples. The known-improved control uses protected development references for AIME and MBPP, and real seed-model outputs for IFBench. The naive control retains the first half of those outputs and uses invalid artifacts for the remainder. Broken artifacts must fail. Shortcut controls attempt self-reported success or evaluator-frame access. These are evaluator diagnostics, not competing optimizer baselines.

Admission requires known-improved > naive > both broken and shortcut. Sixteen fresh unchanged-seed pairs then measure score noise on the same eight-example slice. The native Hone direct-paired calibration uses those deltas and their maximum excursion. Search is refused if the envelope obscures the positive-control contrast. The envelope is a conservative development calibration, not a final-test confidence interval or a guarantee for every future candidate.

A failed control command preserves its evidence. The runner refuses to overwrite it. Stop and inspect the measurement contract instead of rerunning until it passes.

## Development tasks

| Task | Training | Selection | Metric and source |
| --- | ---: | ---: | --- |
| P IFBench | 300 | 300 | Official loose instruction fraction from GEPA artifact `cbefbc1aa0f43dd39874ec4bf42211365dbda42e`. Selection is development-file rows 0–299, training is rows 300–599. This follows released code rather than the planning document's 150-training figure. |
| P AIME | 45 | 45 | Historical 90-question development data at `project-numina/aimo-validation-aime`, revision `13f9e12f613e720c2a2b2f345dd04b998a29494d`. Preserve `Random(0).shuffle`, then halves. Parse the entire response with Python `int`, with no boxed-answer recovery. |
| A MBPP | 374 | 90 | Official full training and validation files at `google-research-datasets/mbpp`, revision `4bb6404fdc6cacfda99d4ac4205087b89d32030c`. Score all published development assertions passing. |

Only explicit development files are fetched. The eager upstream constructors, AIME2025 final dataset, and MBPP test files are never loaded. Ordered membership, source hashes, checker hashes, package versions, and NLP asset hashes are recorded. IFBench scoring code is fetched at runtime from its licensed source. Only download statements and the `dspy.Prediction` container dependency are adapted. Its loose-response variants remain unchanged. Checker randomness is fixed by row identity and the language detector seed is zero.

MBPP is a declared agent-program adaptation, not a claim to reproduce an official optimizer program. Its dataset is [Mostly Basic Python Problems](https://huggingface.co/datasets/google-research-datasets/mbpp), released by Google Research under [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), associated with [Austin et al., Program Synthesis with Large Language Models](https://arxiv.org/abs/2108.07732). The input adds function declarations derived from reference ASTs, never reference bodies or assertions. No Terrarium source or data is used.

The mutable MBPP artifact contains a prompt and Python program. The program runs in a non-root, read-only, network-disabled Docker container without credentials or host home directories. It can make at most two brokered task-model calls, request at most 4,096 output tokens in total, and send at most 65,536 prompt bytes. Program execution has a 30-second bound excluding model wait. The model transport has a 600-second per-request bound.

Solution assertions stay in the trusted evaluator. An isolated solution worker receives only function names and literal arguments. Results return through `repr` and `ast.literal_eval`, never pickle or executable return text. The adaptation supports literal-valued arguments and results, at most 100 function calls, and ten seconds of solution execution. Mutation of caller-owned arguments does not propagate across this boundary. These limits apply identically to every optimizer and can cause a development example to fail even when a less restricted native Python solution would pass.

## Matched reported-usage accounting

Every role passes through `ModelCalls`, including task execution, reflection, judging if present, repairs, and externally repeated requests. Calls, tokens, published-rate dollar-equivalents, wall time, pauses, errors, and observed internal retries are retained. There is no LLM judge for these tasks.

The frozen route is `anthropic/claude-sonnet-4-6` for both task and proposer calls. There is no model fallback. Decoding uses temperature zero and reasoning disabled. P task calls request at most 4,096 output tokens. Proposer calls request at most 2,048. The [published list prices](https://platform.claude.com/docs/en/about-claude/pricing) are $3 input, $15 output, $0.30 cache read, and $3.75 five-minute cache write per million tokens. Cache retention is disabled; any reported cache tokens are still counted and priced.

Each search has a $10-equivalent reported-usage ceiling, 12 million reported tokens, 30,000 model calls, 500 proposer calls, 10,000 scored rollouts, and two hours of active wall time. A conservative token reservation precedes each request. Subscription pauses do not consume active work time, but elapsed wall time and pause duration are both published. Actual subscription billing is not treated as an API dollar invoice. Controls and route proofs have separate published ledgers and are not charged selectively to a method.

Before every model call, the throttle checks broker health and invokes `omp usage --json --no-extensions`. It pauses while any allowed account exceeds 80% of an observed limit, or usage is absent, malformed, or more than ten minutes old. The 20% reserve protects other seats and lanes. Outages pause dispatch and are checked again every 30 seconds. Forced-high and outage injection exercise the same wait loop without interrupting the shared broker.

**Known accounting limit:** omp's final completion usage can omit tokens from internal failed attempts. The pilot accepts this disclosed undercount. The gateway counts Anthropic provider HTTP attempts through omp's opaque fetch override and counts retry logger events without inspecting credential values, request headers, or request bodies. Hidden attempts are provider attempts beyond the first per external call. Logger-event counts are reported separately and are not added again to HTTP-attempt counts. A method is flagged above one hidden attempt per 100 calls, or when method rates differ by more than one percentage point. Zero observed hidden retries is not proof that omitted token volume is zero.

Credential-opaque per-attempt admission and usage receipts inside omp are required before the full matrix. No upstream issue is filed by this task.

## Run and replay

After controls pass, run the three-method, one-seed MBPP smoke:

```sh
nice -n 10 taskset -c 0 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot smoke --controls .pilot-runs/controls --out .pilot-runs/smoke
```

Smoke permits one proposal per method. It exercises the official GEPA reflection callable through the real subscription route but does not spend the full search budget. Hone uses the existing engine's restart draw and native promotion gate, paired training slices of 8, 16, and 32, and fresh paired full-selection measurements. GEPA retains its native reflection renderer, parser, Pareto selection, and strict improvement policy, with an eight-example reflection minibatch. The plain loop proposes from training traces and greedily retains strict full-selection improvements. Every method starts from the same artifact and uses the same artifact fields and deployment limits.

The next lane runs the full 27 searches only after the assistant reviews the smoke evidence:

```sh
nice -n 10 taskset -c 0 env OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 pilot/.venv/bin/python -m pilot pilot --controls evidence/pilot/controls --out .pilot-runs/pilot-27
```

The command runs three methods on three tasks with seeds 0, 1, and 2. Existing run directories are never overwritten. No final test phase is implemented or authorized here. It retains the last completely evaluated eligible artifact when the reported-usage budget ends.

Each run includes candidate artifacts, scored outputs, usage records, calibration identity, task membership, routes, budgets, and file hashes. Verify a retained bundle without model calls:

```sh
pilot/.venv/bin/python -m pilot verify --out .pilot-runs/smoke
```

Hash verification checks retained evidence integrity. It does not promise byte-identical stochastic provider responses on a fresh model replay.
