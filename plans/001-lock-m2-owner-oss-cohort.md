> Historical design record. This file preserves an earlier plan and its review discussion. See [current methodology and status](../docs/methodology.md) for implemented behavior and remaining work.

# Plan 001: Lock the M2 owner + OSS capsule cohort
> **Status:** Reviewed and accepted. The task identities below are locked by this document; capsule bytes/digests freeze only after every task passes admission. If a listed task fails, stop and revise this plan—do not silently substitute a reserve.
> 
> **Planned at Hone:** `d66a5a6c04d393d944d07e8efb45c34938ceb03e`
> 
> **Date:** 2026-07-15
## Decision
Run one controlled M2 generation against **16 train capsules** split evenly between owner-repository product work and current-head open-source performance work. Open **12 terminal holdout capsules** only after search and confirmation close: four owner-repository transfer tasks and eight OSS repositories never used in optimizer feedback.
## Capsule list at a glance
### M2 train: 16 capsules
1. `tradeup-profit`
  
2. `monoagent-context-retention`
  
3. `flt-text-input`
  
4. `agentelo-scoring`
  
5. `flt-dag-orphan-recovery`
  
6. `harness-session-log-normalization`
  
7. `hone-optimizer-mode-canonicalization`
  
8. `floyd-block-search-render`
  
9. `bun-module-loader`
  
10. `ripgrep-search`
  
11. `esbuild-bundling`
  
12. `zstd-codec`
  
13. `simdjson-parse`
  
14. `uv-resolver`
  
15. `biome-parser-formatter`
  
16. `orjson-serialization`
  
### Terminal transfer: 12 holdout capsules
1. `tradeup-query-latency`
  
2. `flt-workflow-parser`
  
3. `floyd-custom-scoreboard-render`
  
4. `harness-pi-readiness`
  
5. `node-url`
  
6. `duckdb-tpch`
  
7. `swc-transform`
  
8. `quickjs-interpreter`
  
9. `sqlite-speedtest1`
  
10. `tree-sitter-parse`
  
11. `mimalloc-allocator`
  
12. `brotli-codec`
  
### M2 result
Run a two-stage recursive campaign over the 16 development capsules: `G0 → G1` on panel A, then a paired `G0-controller` versus `G1-controller` tournament on fresh panel B with the same `G1` target to produce `G2`. Close selection and confirmation, then compare `G0`, `G1`, and `G2` on the 12 untouched holdouts. RelayBench reports inner and outer learning curves, paired controller-transfer efficiency, adjacent-generation transfer, the 50/50 owner/OSS terminal estimand, sign consistency, finite-task intervals, exact sign tests, A-A and randomized-label calibration, control discrimination, resource efficiency, complete failure accounting, and registered optimizer/model transfer cells.

This is deliberately not “let the agent make Bun faster” as an unbounded prompt. Every flagship challenge has:

- a pinned source revision;
  
- one bounded subsystem and source envelope;
  
- a frozen workload and one oriented scalar;
  
- exact correctness/result hashes and full relevant tests as hard gates;
  
- isolated, interleaved Linux measurements;
  
- build files, benchmark code, fixtures, tests, and evaluator outside the mutable surface;
  
- allocation/RSS and output-quality non-regression gates;
  
- no network and no repository history in the mutation sandbox.
  

A current-head Bun patch that improves the frozen loader benchmark and survives Bun’s relevant suite is an upstream-quality result. It is not evidence that Hone is “better than the Bun team” unless maintainers independently validate and merge it.
## What the pilot established
The fresh M1 pilot proved the runtime and evidence path, not self-improvement:

- GPT-5.6-sol improved `seeded-astar` twice in episode 0: `+0.36044` and `+0.34831` aggregate.
  
- GLM-5.2 improved the same saturated task by `+0.14421` in episode 0.
  
- GPT improved `monoagent-context-retention` from `0.56547` to `0.89026` in episode 0.
  
- GPT produced an evaluator-invalid `tradeup-profit` candidate.
  
- The candidate-producing optimizer was not varied in those fresh runs.
  
- No holdout was opened.
  

Therefore:

1. retire `seeded-astar` from capability scoring;
  
2. keep it only as a smoke/conformance capsule;
  
3. make M2’s treatment the **optimizer artifact**, not the execution model;
  
4. use hard current-head tasks where no known winning patch is supplied to the agent;
  
5. reserve terminal tasks by repository to measure transfer.
  

Evidence: `.hone-runs/relaybench-m1-pilot/report.json`.
## M2 recursive estimands
Primary questions:

1. **Level 1 — inner-kernel improvement:** while `G0` runs the outer search on development panel A, do later candidate optimizer artifacts produce better inner-loop outcomes than early candidates under identical child budgets?
2. **Level 2 — recursive outer transfer:** after panel A selects `G1`, is `G1` a better outer improver than `G0` when both controllers start from the same `G1` target, receive the same fresh panel-B feedback, and have the same outer/child budgets?
3. **Terminal generational transfer:** on untouched terminal capsules, are `G1 - G0` and `G2 - G1` both positive?

For every outer trajectory, record candidate ordinal `j`, candidate artifact, validity, per-capsule normalized score, panel mean, best-so-far panel mean, and cumulative tokens/USD/wall-clock/evaluator calls. Report:

- final best score;
- area under best-so-far versus candidate ordinal;
- area under best-so-far versus cumulative tokens and wall clock;
- candidates, tokens, and wall time to normalized thresholds `0.5`, `0.75`, and `0.9`, with unreached thresholds explicitly censored;
- valid-candidate yield;
- early and late slope without fitting an extrapolative growth law.

For every child run, record the analogous best-so-far curve over inner episode, tokens, wall clock, and evaluator calls. The maximum at outer iteration 10 is never compared only to iteration 1; the complete anytime curve and every failed/duplicate candidate remain in the evidence.

Stage-B controller transfer is paired by panel, target optimizer `G1`, outer seed/replicate, model observation, runtime, and budget. The only varied factor is controller optimizer `G0` versus `G1`.

Terminal unit: one capsule-level full-run replicate, not a test case, evaluator seed, episode, or outer candidate.

Terminal analysis:

1. compute paired `G1 - G0` and `G2 - G1` normalized gains for every capsule;
2. average each adjacent-generation contrast within owner and OSS strata;
3. average the two stratum means 50/50;
4. show every capsule delta, inner anytime curve, and resource vector;
5. never pool test cases as independent observations.

### Frozen development panels

Panel A (`G0 → G1`) contains `OWN-T01`, `OWN-T03`, `OWN-T06`, `OWN-T08`, `OSS-T01`, `OSS-T03`, `OSS-T05`, and `OSS-T07`.

Fresh panel B (paired controller transfer and `G1 → G2`) contains `OWN-T02`, `OWN-T04`, `OWN-T05`, `OWN-T07`, `OSS-T02`, `OSS-T04`, `OSS-T06`, and `OSS-T08`.

Each panel is exactly four owner and four OSS tasks. No task appears in both panels.
## Locked train cohort: 16 capsules
All 16 capsules contribute equally. The eight owner tasks and eight OSS tasks therefore also form an exact 50/50 owner/OSS score.
### Owner-repository train tasks
| ID | Capsule | Frozen source | Objective and primary scalar | Character |
|---|---|---|---|---|
| `OWN-T01` | `tradeup-profit` | Existing `cap_5c967d0f3b0d`, digest `sha256:fd36f7f50dcedd6a38d1f6751a6135f26d29c3e71235c59875e6c2cdcd84f932` | Maximize fixed-capital top-3 expected net profit over sealed cases; invalid/duplicate/over-capital selections fail closed. | Current product, open quality, private. |
| `OWN-T02` | `monoagent-context-retention` | Existing `cap_d5ca7c9f999b`, digest `sha256:a48be2217d65125145aede0b81d95eac6a193b5247a5a525d71d12f7bbcba652` | Maximize valid weighted structured-record utility under a hard character cap while preserving current input exactly. | Current product, open quality, private. |
| `OWN-T03` | `flt-text-input` | Existing `cap_2e06839ec475`, digest `sha256:e974bb5b137be017822535491d3bf01cf3b944debb6f2d1b0a8f71d8d9e44521` | Pass sealed Unicode, escape, multiline, completion, history, and editing-state cases with bounded emissions. | Bounded state machine, MIT. |
| `OWN-T04` | `agentelo-scoring` | Existing `cap_25cf14225449`, digest `sha256:eb810a23894e478d7cbaf61a69c4de95a45ac07e67f826f33dbb8ed02d015698` | Pass sealed no-diff/infrastructure/precedence/dedup scoring cases and reward-hacking gates. | Bounded classification, MIT. |
| `OWN-T05` | `flt-dag-orphan-recovery` | Baseline FLT `2f3c9e2f10ef8d93a61233766f3796a576d9f497`; reference commit `031ac46be6aaab11e96cd722b5369e4376fe68b2` | Repair plan-reread orphan retirement and parallel spawn-failure stalls. `q = passed sealed transitions / declared transitions`; only workflow engine implementation is mutable. | Historical post-cutoff recovery, async state machine, MIT. |
| `OWN-T06` | `harness-session-log-normalization` | Baseline Harness `e101371004685014913c7e0085821caf96db244b`; reference commit `5b09ed7` | Correctly recover model, usage, cost, and completion state from sealed Crush/Gemini/Kilo/OpenCode/Qwen/SWE-agent transcripts. `q = weighted required fields recovered / declared fields`; transcript fixtures and schema are protected. | Multi-adapter parsing, MIT. |
| `OWN-T07` | `hone-optimizer-mode-canonicalization` | Baseline Hone `ca768494ecff546d1ff37c116e36e4e362d052e1`; reference commit `2649981` | Make optimizer source snapshots byte-identical across executable-bit/umask differences while retaining real executable identity. `q = passed cross-host identity cases / declared cases`; tests and canonical oracle protected. | Cross-platform artifact correctness, owner source. |
| `OWN-T08` | `floyd-block-search-render` | Baseline Floyd Addons `f5e048d4a8254646306cbf596379416be6401700`; reference commit `315036de` | Minimize Block Search p99 frame cost and allocations on a frozen scene while preserving exact selected blocks and rendered command stream. `q = reciprocal geometric mean of p99 time and allocation rate`; correctness is a hard gate. | Current-product rendering performance, private. |
### OSS current-head train tasks The pinned revisions below were read from GitHub on 2026-07-15. Every capsule must vendor only license-permitted source and record the upstream license and revision.
| ID | Repository and pinned revision | Frozen challenge | Scalar and hard gates |
|---|---|---|---|
| `OSS-T01` | [oven-sh/bun `5187e27669440a72ab1b082f92b7f1b5ca94cfc1`](https://github.com/oven-sh/bun/commit/5187e27669440a72ab1b082f92b7f1b5ca94cfc1) | Improve cold and warm module-loader performance on frozen ESM/TS graphs derived from `bench/module-loader`. Mutable envelope: `src/resolver/**` only. | Reciprocal geometric mean wall time across graph shapes; exact exports/side effects, relevant Bun tests, peak RSS ≤ baseline +2%. |

> **Reviewed revision (2026-07-18, owner-approved):** `OSS-T01` repinned from `a227ad991b62fc4e9b9ee5e998ad6c2e6508fe88` to `5187e27669440a72ab1b082f92b7f1b5ca94cfc1` (2026-07-03, the last self-buildable commit before the July-04 stream rewrite). The original pin cannot be built from a clean checkout: its pinned prebuilt WebKit (`autobuild-4895f45…`) regenerates `JSReadableStream*`/`WritableStreamSink` bindings that the checkout no longer declares; verified compile failures on `a227ad99`, `16c55763`, and `ced0d4ff`. Challenge, workloads, scalar, and hard gates are unchanged. Measured on the replacement: clean native build 506.8 s (`-j2`), resolver-touch incremental rebuild+link 190.4 s.
| `OSS-T02` | [BurntSushi/ripgrep `227381db0ee83dfa4341f1e27ff9617c0f5ad992`](https://github.com/BurntSushi/ripgrep/commit/227381db0ee83dfa4341f1e27ff9617c0f5ad992) | Improve mixed literal, regex, Unicode, ignore-file, and many-small-file searches on a frozen tree using the repository `benchsuite`. | Reciprocal geometric mean latency; exact stdout/stderr/exit hashes, relevant tests, peak RSS ≤ baseline +2%. |
| `OSS-T03` | [evanw/esbuild `6ff1d8b0d8c134e867a397eef39702a223ebef9e`](https://github.com/evanw/esbuild/commit/6ff1d8b0d8c134e867a397eef39702a223ebef9e) | Improve bundling of frozen TS/JSX/ESM/CJS graphs without changing output semantics. | Reciprocal geometric mean build time; output and sourcemap semantic hashes, parser/bundler tests, output bytes ≤ baseline +1%. |
| `OSS-T04` | [facebook/zstd `5c7b7bad26808e6b40ac3b3d0075466e27738a9d`](https://github.com/facebook/zstd/commit/5c7b7bad26808e6b40ac3b3d0075466e27738a9d) | Improve level-1/3 compression and decompression throughput over text, JSON, binary, and repetitive corpora. | Geometric mean throughput; exact round trip, upstream tests, compressed size no worse than baseline by >0.25%. |
| `OSS-T05` | [simdjson `8e6bac94877f2d3d026000d36ce81e0aaf38d26f`](https://github.com/simdjson/simdjson/commit/8e6bac94877f2d3d026000d36ce81e0aaf38d26f) | Improve DOM and On-Demand parsing over mixed corpora using the upstream `benchmark` harness. | Geometric mean GB/s; exact parse/event hashes, malformed-input behavior, full relevant tests, peak RSS ≤ baseline +2%. |
| `OSS-T06` | [astral-sh/uv `336535f83fd933ea54685e24e3c08468339937ce`](https://github.com/astral-sh/uv/commit/336535f83fd933ea54685e24e3c08468339937ce) | Improve cold and warm dependency resolution on a frozen offline package index using `crates/uv-bench` and `scripts/benchmark`. | Reciprocal geometric mean resolver time; exact lockfile and selected distributions, resolver tests, peak RSS ≤ baseline +2%. |
| `OSS-T07` | [biomejs/biome `8ebafe1c7489f1f7af379b8e52b8ad063c82d28a`](https://github.com/biomejs/biome/commit/8ebafe1c7489f1f7af379b8e52b8ad063c82d28a) | Improve JS/TS/CSS parser+formatter throughput across frozen large files using crate benches and the upstream benchmark project. | Reciprocal geometric mean time; byte-exact formatting, diagnostic hashes, idempotence, parser/formatter tests, peak RSS ≤ baseline +2%. |
| `OSS-T08` | [ijl/orjson `705515d77b28429d0b7c30c3d781abe52e8a1e5a`](https://github.com/ijl/orjson/commit/705515d77b28429d0b7c30c3d781abe52e8a1e5a) | Improve dumps+loads throughput across dataclass, datetime, NumPy, Unicode, and nested corpora using `bench/`. | Geometric mean throughput; byte-exact dumps where specified, semantic hashes for loads, full tests, peak RSS ≤ baseline +2%. |
## Locked terminal cohort: 12 capsules The outer optimizer, candidate selection, prompts, and search logs must never see these tasks, repository identities, fixtures, source trees, profiler output, scores, or feedback before search ranking and train confirmation are durably closed.
The terminal report averages the four owner tasks and eight OSS tasks within strata, then averages the two stratum means 50/50. This prevents the larger OSS stratum from erasing owner-product regressions.
### Owner-repository terminal tasks
| ID | Capsule/source | Frozen challenge |
|---|---|---|
| `OWN-H01` | Existing `tradeup-query-latency`, `cap_929b5f74f9ef`, digest `sha256:7046ddc9ca1613de06f0b4263362a139cd1a8866b683f625c9e8fde7e84e8bbd` | Reduce fixed Linux query latency while preserving the exact registered response+quality hash. |
| `OWN-H02` | Existing `flt-workflow-parser`, `cap_ec5c5ad0ad97`, digest `sha256:1c86d9618e0dc2afb37ad22933b82260d37d90d68a06991f28161f3813378872` | Improve legacy/DAG/gate/reference/preset/generated YAML parsing with exact AST, localized errors, and round-trip stability. |
| `OWN-H03` | Floyd Addons baseline `7c7360d4f68bf4505be64abc258ecf3067bb8dcf`; reference commit `ad9358c8` | Minimize Custom Scoreboard p99 frame cost and allocations while preserving exact layout and draw commands. |
| `OWN-H04` | Harness baseline `1815353f85f8f052fea30812aaca3be485c51d30`; reference commit `39ff71f` | Correct Pi idle-prompt readiness detection and project-instructions backup behavior across sealed process traces and filesystem states. |
### OSS current-head terminal tasks
| ID | Repository and pinned revision | Frozen challenge | Scalar and hard gates |
|---|---|---|---|
| `OSS-H01` | [nodejs/node `9df0e9b4d4a5be5ce7506fae44acb6667bb68d6b`](https://github.com/nodejs/node/commit/9df0e9b4d4a5be5ce7506fae44acb6667bb68d6b) | Improve WHATWG URL parse/serialize/SearchParams throughput using `benchmark/url`. | Geometric mean ops/sec; WHATWG URL tests and exact serialized outputs, heap/RSS ≤ baseline +2%. |
| `OSS-H02` | [duckdb/duckdb `117e1a46be1c903c5a36ee3c881c125597f93c60`](https://github.com/duckdb/duckdb/commit/117e1a46be1c903c5a36ee3c881c125597f93c60) | Improve TPC-H Q1/Q6/Q12 execution on frozen SF1 data using `benchmark/tpch`. | Reciprocal geometric mean latency; exact result hashes, planner/executor tests, peak RSS ≤ baseline +2%. |
| `OSS-H03` | [swc-project/swc `d5fd89520be380493479d232b88c532e94e1df94`](https://github.com/swc-project/swc/commit/d5fd89520be380493479d232b88c532e94e1df94) | Improve TS/JS/React parse+transform throughput on frozen corpora. | Reciprocal geometric mean time; AST/output semantic hashes, transform tests, output size ≤ baseline +1%, RSS ≤ baseline +2%. |
| `OSS-H04` | [bellard/quickjs `04be246001599f5995fa2f2d8c91a0f198d3f34c`](https://github.com/bellard/quickjs/commit/04be246001599f5995fa2f2d8c91a0f198d3f34c) | Improve selected interpreter microbenchmarks from `tests/microbench.js` and module startup. | Geometric mean throughput; selected Test262 subset and exact observable outputs, binary size ≤ baseline +1%. |
| `OSS-H05` | [sqlite/sqlite `21fb3ccb37648b93433c592f3f6f7d5ef37de56c`](https://github.com/sqlite/sqlite/commit/21fb3ccb37648b93433c592f3f6f7d5ef37de56c) | Improve selected `test/speedtest1.c` read, join, aggregate, and index workloads on frozen databases. | Reciprocal geometric mean time; exact result/database hashes, SQLite quick tests, file size/RSS non-regression. |
| `OSS-H06` | [tree-sitter/tree-sitter `1ffd612be56259938c47507bbe953af739c7f640`](https://github.com/tree-sitter/tree-sitter/commit/1ffd612be56259938c47507bbe953af739c7f640) | Improve full and incremental JS/Rust/Python parsing using `crates/cli/benches/benchmark.rs`. | Geometric mean bytes/sec; exact trees/edit results, parser tests, peak RSS ≤ baseline +2%. |
| `OSS-H07` | [microsoft/mimalloc `76d3f8a934f9761e4ee75fa8b071e58d482f2758`](https://github.com/microsoft/mimalloc/commit/76d3f8a934f9761e4ee75fa8b071e58d482f2758) | Improve allocator throughput on frozen single-thread, multi-thread, small-object, and fragmentation workloads. | Geometric mean ops/sec; allocator stress tests, peak committed memory and fragmentation no worse than baseline by >1%. |
| `OSS-H08` | [google/brotli `037b70e2ad03b20480e6407ed5851e0f114b67a7`](https://github.com/google/brotli/commit/037b70e2ad03b20480e6407ed5851e0f114b67a7) | Improve compression+decompression throughput on frozen web/text/binary corpora. | Geometric mean throughput; exact round trip, upstream tests, compressed size no worse than baseline by >0.25%. |
## Source and publication policy - Public OSS capsule source, evaluator glue, manifests, frozen workloads, and results may be published only when upstream licenses permit redistribution and notices are preserved.
- `trade-up-bot`, Monoagent, and Floyd source/fixtures remain private. Publish only allowed aggregate evidence and redacted task metadata.
  
- Hone, FLT, Harness, and Agentelo publication follows their actual repository licenses; do not infer a license from public visibility.
  
- No upstream patch is called an “improvement” until it passes the full capsule, reproduces outside Hone, is human diff-reviewed, and survives an upstream-style benchmark run.
  
- Open upstream PRs separately. Hone never auto-pushes or auto-opens PRs.
  
## Current-head OSS normalization
A current-head challenge intentionally has no privileged winning patch. Do not fabricate a reference artifact.

For each OSS performance capsule:

1. measure an interleaved A-A baseline on the frozen Linux machine;
  
2. estimate the capsule standard deviation `sigma` on the oriented scalar `q`;
  
3. set the preregistered reference target numerically, not as hidden source: `qReference = qBase + max(5 * sigma, 0.05 * abs(qBase - qFail))`;
  
4. record that target construction in the manifest provenance;
  
5. use deliberately slower-but-correct controls to prove evaluator sensitivity;
  
6. require at least one independently authored valid source perturbation to move the metric without violating hard gates, but do not require it to beat baseline.
  

This preserves the existing normalized-gain shape while keeping the task genuinely open-ended.
## Product workflow and constitutional boundary
### One human and agent entrypoint
`hone "<objective>"` is the primary interface for a human or an external coding agent. Explicit commands such as `hone run`, `hone author`, `hone best`, `hone diff`, `hone apply`, `hone status`, `hone stop`, and `hone off` compile to the same durable intent and run state machine; they are not separate orchestration systems.

Every task starts from a fresh offline checkout of the exact local `HEAD` commit. Staged, unstaged, ignored, and untracked files are not copied. Interactive use must acknowledge a dirty ambient tree; headless use fails unless the caller supplies the explicit dirty-tree acknowledgement. `.env` and other secret-bearing ambient files never enter the source snapshot, capsule, image layer, evaluator, or mutation workspace. Runtime credentials are injected only through trusted ephemeral mounts or the metering proxy and are never persisted.

The same sealed Pi coding-session worker serves capsule authoring, evaluator authoring, adversarial validation, inner task improvement, outer optimizer improvement, and authoring repair. Roles differ only by trusted context, mutable workspace, model route, and capability envelope. An external Codex/Claude agent pilots the same headless CLI and NDJSON protocol; it does not bypass Hone's internal coding agents or admission state machine.

### Two-gate capsule authoring
Capsule creation is a durable workflow:

1. a capsule-author session inspects the fresh checkout and proposes the objective, source identity/license, mutable and protected surfaces, capsule-specific toolchain image, evaluator/split design, scalar and hard gates, and resource range;
2. Gate 1 accepts, rejects, or returns natural-language revisions to that same author;
3. evaluator and adversarial-author sessions build the capsule and produce broken, naive, shortcut, and improved/reference diagnostics;
4. trusted admission executes ordering, A-A/noise, exploit, reproducibility, and bounded-build checks;
5. Gate 2 reviews exact source/image/oracle/scalarizer/manifest hashes plus calibration and provenance before minting an immutable capsule identity.

A delegated headless agent may approve a provisional private `apply:none` capsule under a hard budget. Provisional evidence cannot enter corpus statistics, optimizer promotion, or terminal workflows. M2 admission requires owner approval or a named independent reviewer with a durable delegation receipt. Author, adversarial validator, and final reviewer identities are recorded; one identity cannot satisfy all three roles.

### Constitution and search freedom
Trusted code freezes and enforces the game: source and artifact identity, capsule/evaluator/holdout integrity, model observation, credential custody, componentwise resource accounting, event and trace completeness, promotion authority, and predecessor-controlled succession.

The optimizer owns all strategy: search and selection algorithms, prompts and context, agent topology, parent/repair/restart policy, candidate and episode allocation, capsule sampling and fidelity, stopping, branching, successive halving, self-A/B, compiler and dependency choices inside the frozen build contract, and eventually proposals to replace the complete optimization process. Present named constants are mutable defaults or campaign factors, never constitutional truths.

The optimizer artifact being judged cannot modify the capsule source, protected evaluator assets, comparison corpus, trusted event record, or judging rule for that same campaign. It may propose replacements for any of them as future game artifacts. The currently seated trusted kernel and an independent cross-family review test such a proposal on fresh tasks; explicit external authority seats it. A proposed kernel never evaluates or installs itself, and every succession retains the previous sealed kernel and one-command rollback.

The north star is not a permanently hand-designed search algorithm. Frontier coding agents should eventually rewrite every strategic component and propose better games. Fresh capsules plus predecessor-held measurement authority decide whether those proposals are actually better.

## Capsule admission gates
Every task must pass all gates before the M2 config freezes.

1. **Source identity:** exact commit/tree, license, mutable files, protected files, toolchain lock, and image digest.
  
2. **No answer leakage:** no `.git`, patch, reference implementation, commit message, issue text, profiler conclusion, or network access in the mutation sandbox.
  
3. **Correctness:** evaluator returns one finite oriented scalar only after all hard gates pass; malformed/crashed/timed-out candidates map to `qFail`.
  
4. **Determinism:** five fresh-process baseline runs yield identical correctness/result hashes.
  
5. **Noise:** interleaved A-A calibration on the target Linux profile; measurement noise must be ≤20% of the frozen normalization scale.
  
6. **Sensitivity:** broken, slower-correct, and reward-hacking diagnostics rank as preregistered.
  
7. **Headroom:** for train tasks only, three two-episode seed-optimizer pilots must produce at least one valid non-baseline candidate, but the task must not reach its reference/target in all three runs.
  
8. **Holdout seal:** terminal tasks receive no optimizer pilot. Only trusted A-A, correctness, sensitivity, and noise work is allowed.
  
9. **Bounded build:** clean build plus one evaluation fits its capsule wall-clock, memory, disk, and output caps with at least 30% headroom.
  
10. **Exploit review:** independent review covers protected-path escape, benchmark special-casing, fixture fingerprinting, output fabrication, timer tampering, build-script mutation, and dead-code benchmark bypass.
  

If a listed task fails, stop. A task can move to `reserve` only in a new reviewed revision of this plan before any optimizer search begins.
## M2 recursive campaign contract
### Fixed scientific shell
Freeze these judging identities after admission:

- development panel A: exactly 8 capsules;
- fresh development panel B: exactly 8 different capsules;
- unopened terminal cohort: exactly 12 capsules;
- stage A: controller `G0` starts from target `G0` and produces selected `G1`;
- stage-A confirmation arms: `G0`, selected `G1`, broken control, and degraded control;
- stage B: three paired replicates of `G0`-controller and `G1`-controller, all starting from the exact selected `G1` target on the same fresh Panel B;
- stage-B confirmation arms: `G1`, best `G0`-controller result, selected `G2`, broken control, and degraded control;
- confirmation replicates: 3 per arm/capsule;
- terminal arms: exact `G0`, `G1`, and `G2`;
- terminal replicates: 3 per arm/capsule;
- application: `none`; any selected source is branch-only after human review.

After `G1` confirmation, pause for owner diff/evidence review. After `G2` confirmation, pause again. Terminal identities and bytes become reachable only after both development gates close successfully.

### Mutable search under equal resources
The treatment is the complete optimizer artifact, not a hand-authored candidate schedule and not the execution model. Every outer trajectory receives the same componentwise search envelope:

`12 * (resource vector for one complete eight-capsule candidate at the calibrated inner ceiling)`.

This is twelve full-panel candidate **equivalents**, not a requirement to emit twelve candidates. Inside the envelope the optimizer controls candidate count, inner episode count below the ceiling, capsule allocation/fidelity, stopping, branching, restarts, repair, successive halving, concurrency, and nested self-A/B. Search comparisons use complete best-so-far curves at matched cumulative tokens, active wall clock, evaluator calls, and other frozen resource dimensions. A stopped trajectory carries its incumbent forward; invalid, duplicate, failed, and censored work remains in the evidence.

Fixed confirmation and terminal judging resources are separate from search and cannot be borrowed. Unused search resources do not transfer between paired controller arms or replicates.

### Calibrated inner safety ceiling
Before campaign freeze, run four excluded calibration-only capsules at episode caps `2`, `4`, `8`, and `12`, with five matched seeds per capsule/cap cell: 80 independent full runs. For each capsule and adjacent cap, bootstrap the 20 paired capsule-seed final normalized-gain deltas, stratified by capsule. Select the smallest ceiling among `4`, `8`, and `12` whose next-depth 75th-percentile marginal gain has a 90% upper confidence bound below `0.02`. Use the 75th percentile so easy saturated tasks cannot hide continued gains on harder tasks. Invalid or incomplete deeper cells count against the deeper cap. If no comparison satisfies the rule, select `12`.

This value is only a trusted safety ceiling for M2. Optimizers may stop earlier and allocate episodes unevenly. The rule, cells, seeds, images, resource vectors, and practical-gain threshold freeze before official Panel-A search.

### Recursive capabilities and corpus
`spawnRun` and `queryCorpus` are production M2 capabilities, not deferred stubs.

- mutable controller depth 0 may spawn capsule runs at depth 1;
- a depth-1 optimizer may reserve one further delegated sub-run/self-A-B at depth 2;
- depth 2 cannot call `spawnRun`;
- every descendant slice is reserved componentwise from all ancestors before launch;
- retry, replay, and crash recovery cannot mint a second slice;
- unused reservations return only after durable child settlement.

At campaign start, trust freezes one content-addressed public history/evidence snapshot shared by all arms. Stage A may query it plus metered Panel-A evidence. Once `G1` is durably selected, the same closed Panel-A evidence is added to both Stage-B controller contexts. Panel-B feedback is available only through each controller's metered calls. Terminal repositories, identities, assets, and evidence are absent until the terminal gate opens. Every corpus response is deterministic, cursor-addressed, and logged.

### Models, provider, and durable pause
Freeze role routes for M2:

- outer optimizer/capsule-author reasoning: observed `gpt-5.6-sol`;
- inner capsule improvement: observed `gpt-5.6-terra`.

The same optimizer artifact crosses both roles. Requested role/route and returned model identity are recorded for every request; route drift fails closed. Later RelayBench campaigns may vary optimizer-generator and executor model as explicit factors.

All model calls pass through a metered, fixed provider route. Record requested and returned model identity. [Historical private deployment and account topology omitted.]

After proxy failover, `401`, `402`, `403`, `429`, or returned-model drift immediately causes a durable global campaign pause. Transport errors and `5xx` receive at most three trusted bounded-jitter retries, then the same pause. Malformed successful agent output is candidate/session invalidity, not provider outage. Reported usage for every attempt remains charged. Pause stops new model calls and child admission, seals cursors/artifacts/traces/ledgers, excludes only verified provider-outage time from active wall budgets, and preserves the same campaign/config hash. Resume is explicit after both frozen routes preflight successfully.

### Expected evidence volume
Search has no exact child-run cardinality. Its resource envelopes equal the former `96` Stage-A plus `576` Stage-B full-child design at the calibrated ceiling, but an optimizer may realize those resources through a different number and topology of sessions.

Fixed judging remains:

- stage-A confirmation: `4 * 8 * 3 = 96` full runs;
- stage-B confirmation: `5 * 8 * 3 = 120` full runs;
- terminal generations: `3 * 12 * 3 = 108` full runs;
- total fixed judging: `324` full runs, plus mutable search, authoring/admission/A-A work, and separately metered outer calls.

The previous `996` value is retained only as the resource-equivalent reference design, never as an exact success criterion.

### Conditional scaled M2b
Pre-register a roughly 5,000-full-child-equivalent M2b, but do not launch it solely because compute is available. M2b requires complete M2 replay/integrity, successful `G1` and `G2` development gates, terminal adjacent-generation transfer not contradicted, material unsaturated best-so-far gain near the M2 envelope boundary, acceptable valid-candidate yield and provider reliability, and a newly frozen development/terminal corpus. Evaluator, trust-boundary, model-identity, or transfer failure triggers diagnosis and a new reviewed design rather than brute-force scaling. Freeze M2b's fresh cohort, shell, trigger calculation, and analysis before any M2b authoring evidence is opened.

## Frozen recursive promotion and reporting gates
Panel A selects `G1` only if:

1. paired improvement over `G0` exceeds `2 * SE` under the frozen panel-A analysis;
2. task sign is positive on at least 6/8 panel-A capsules;
3. sign is positive on at least 3/4 owner and 3/4 OSS panel-A capsules;
4. broken and degraded controls rank below `G0` and `G1`;
5. no budget, model-identity, source-integrity, or ledger gate fails;
6. the optimizer diff is confined, intelligible, and has a plausible mechanism.

Panel B supports recursive outer transfer only if:

1. the `G1` controller has higher best-so-far AUC by candidate ordinal and by tokens in at least 2/3 paired outer replicates;
2. the paired mean AUC deltas are positive;
3. `G1` reaches every commonly reached threshold in no more tokens than `G0`;
4. its valid-candidate yield is not lower;
5. selected `G2` passes the same task-sign, control, integrity, and diff-read gates on panel B.

Open terminal capsules once only after both development stages and their confirmations close.

A terminal result supports an M2 recursive-transfer claim only if:

1. the frozen 50/50 owner/OSS terminal estimand is positive for both `G1 - G0` and `G2 - G1`;
2. both stratum means are positive for both adjacent-generation contrasts;
3. at least 9/12 task signs are positive for each contrast;
4. no capsule has a normalized adjacent-generation regression below `-0.5`;
5. all evidence bundles pass RelayBench factor matching and completeness;
6. all OSS candidate patches reproduce on the frozen Linux host outside the optimizer loop.

Failure is reported without changing thresholds, dropping outer trajectories, or replacing tasks.
## What can be claimed
### Blog post after M2
A strong, honest blog post is realistic if M2 passes:

> A frozen GPT-5.6-sol-generated optimizer artifact improved the same GPT-5.6-sol coding loop versus the seed optimizer under equal budgets, first on 16 development capsules and then with positive transfer across 12 terminal owner/OSS capsules. Every score came from sandboxed trusted evaluators, complete traces were retained, and the resulting OSS patches were independently reproduced.

That would be genuinely interesting. The current pilot alone supports only: “the runtime works and GPT found strong task-level improvements.”

The most compelling individual story would be an upstream-quality current-head Bun/Node/DuckDB/etc. patch with measured gains, hard correctness, and maintainer review. Report the exact subsystem and benchmark—not “better than the whole team.”
### Paper after a later M3
M2 remains too small for a broad population claim. The existing review estimated that task interaction can require roughly 31 independent terminal tasks even with many replicates. A serious paper should therefore add:

- at least 32 new untouched terminal capsules across at least 16 repositories;
  
- no more than two terminal capsules per repository in the primary analysis;
  
- three independent outer-search seeds, not one lucky search;
  
- A-A calibration, randomized treatment labels, broken/degraded controls, and exact factor matching;
  
- a pre-registered hierarchical analysis with repository clustering;
  
- public, reproducible capsules for the primary claim; private owner tasks as a separate ecological-validity stratum;
  
- generator/executor transfer cells: optimizer generated by model A/B, executed by A/B;
  
- provider-attested model identity if available; otherwise scope claims to the observed route alias;
  
- full candidate-attempt publication, including invalids and failures.
  

One successful M2 generation is **one-generation optimizer improvement**, not recursive self-improvement or model-weight improvement.

A credible recursive claim requires at least:

1. `G0` seed generates `G1` under a frozen budget;
  
2. seated `G1` generates `G2` under the same budget and train protocol;
  
3. `G0`, `G1`, and `G2` are compared on a new unopened terminal cohort;
  
4. capsule-level performance improves monotonically with uncertainty intervals excluding the relevant null;
  
5. the gain survives at least one off-diagonal execution model;
  
6. the mechanism is visible in the optimizer diffs rather than explained by extra tokens, changed tools, evaluator leakage, or model drift.
  
## Implementation sequence
### Phase A — Freeze task contracts
1. Create one task-contract JSON per listed capsule with source SHA, objective, mutable/protected paths, build/test/eval commands, workload hashes, hard gates, scalar, and publication status.
  
2. Record OSS license files and notices.
  
3. Record owner-private redaction rules.
  
4. Review the 28 contracts before building evaluators.
  

**Gate:** a script validates exactly 16 train IDs and 12 terminal IDs, unique source/task identities, no overlap, and all required fields.
### Phase B — Author and admit owner capsules
1. Re-admit the four existing train and two existing terminal capsules under the M2 contract.
  
2. Author `OWN-T05` through `OWN-T08` from the exact baseline revisions above.
  
3. Author `OWN-H03` and `OWN-H04` without optimizer access.
  
4. Run correctness, A-A, sensitivity, and exploit gates.
  

**Gate:** all 12 owner capsules have signed admission reports; terminal access ledger contains trusted-authoring events only.
### Phase C — Author and admit OSS capsules
1. Clone each exact revision into offline authoring workspaces.
  
2. Build frozen toolchain images on the target Linux architecture.
  
3. Freeze workloads and expected outputs separately from mutable source.
  
4. Implement process-isolated interleaved timing and memory measurement.
  
5. Run full relevant upstream tests plus task-specific correctness hashes.
  
6. Run the admission gates; do not expose terminal source to optimizer infrastructure.
  

**Gate:** all 16 OSS capsules have signed admission reports and reproducible baseline measurements. No task substitution.
### Phase D — Pre-register and run recursive M2
1. Complete the four-capsule, five-seed `2/4/8/12` saturation calibration and freeze the selected inner ceiling.
2. Freeze source, capsule, image, oracle, scalarizer, optimizer, model-route, corpus, resource-envelope, pause-policy, config, and analysis digests.
3. Run global A-A and randomized-label checks.
4. Execute Stage-A mutable search under its 12-full-panel-equivalent envelope and persist every outer/inner anytime event.
5. Close Panel-A ranking, execute 96 fixed confirmation runs, and pause for owner review of selected `G1`.
6. Use exact `G1` as the common target for three paired Panel-B `G0`-controller and `G1`-controller trajectories under matched envelopes.
7. Persist every Panel-B search attempt and evaluate frozen recursive controller-transfer metrics.
8. Close Panel-B ranking, execute 120 fixed confirmation runs, and pause for owner review of selected `G2`.
9. If and only if both development gates pass, open the 108-run `G0`/`G1`/`G2` terminal phase once.
10. Reproduce every OSS patch outside Hone, ingest all evidence into RelayBench, and publish success or failure without threshold changes.
11. Evaluate the pre-registered conditional M2b trigger from the sealed M2 evidence.

**Gate:** exact fixed judging cells plus complete resource-ledger settlement and explicit terminal `invalid/not_run` records for every planned cell; no missing candidate, trajectory, request, child, pause, or corpus response is silently dropped.
## Stop conditions
Stop and report before search if:

- any source revision, license, benchmark entrypoint, or test suite cannot be reproduced;
  
- a current-head task has noise above its allowed fraction of scale;
  
- a task can be gamed by editing benchmark/build/test/fixture files;
  
- a clean build/eval cannot fit the resource envelope;
  
- a train task is saturated in all seed pilots;
  
- any terminal task identity or feedback reaches the optimizer path;
  
- the model route cannot be observed consistently;
  
- the full 392-run campaign cannot be reserved componentwise.
  

Stop after search without opening terminal tasks if train promotion gates fail.
## Out of scope
- training or changing model weights;
  
- claiming general intelligence or unbounded recursive improvement;
  
- claiming superiority over an OSS team from one frozen benchmark;
  
- automatic upstream PR creation or merging;
  
- live market, production, account, or credential access;
  
- GPU-sensitive challenges in M2;
  
- changing trusted evaluators or campaign thresholds after candidate results are seen.
  
## Done criteria
- [ ] 
  
  Roughdraft review accepts or explicitly revises every listed task.
  
- [ ] 
  
  Exactly 16 train and 12 terminal task contracts are frozen.
  
- [ ] 
  
  All 28 capsules pass admission without substitution.
  
- [ ] 
  
  M2 config and analysis digests are frozen before search.
  
- [ ] 
  
  A-A and controls pass.
  
- [ ] 
  
  Search, confirmation, and conditional terminal phases produce complete evidence.
  
- [ ] 
  
  OSS patches reproduce outside Hone and preserve upstream licenses.
  
- [ ] 
  
  Report language matches the claim ladder above.
