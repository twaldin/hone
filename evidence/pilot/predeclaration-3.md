# Pilot measurement contract 3

This declaration must be committed before any new pilot model call. It replaces the rejected shared-interpreter MBPP grader. It does not retune control prompts, selection policies, ranking thresholds, noise formulas, model routes or budgets. Earlier epochs remain immutable and cannot admit this epoch.

## MBPP verification boundary

Candidate code never runs in the trusted grader's process or container. The trusted side prepares an assertion plan from pinned official development reference code, setup and assertions in a separate, bounded invocation of the pinned Python image. It receives no candidate code. The untrusted side is a fresh network-disabled, non-root, read-only candidate container per row, with no test files, reference source, expected values, host directories, secrets or inherited host environment. Only the candidate source, requested function names and plain-data call arguments enter that container. Only bounded JSON data returns. The trusted parent alone validates and compares results; neither a worker verdict nor a completion receipt can award a score.

The inspected full development partition has 464 rows and 1,392 assertions. All assertions are one equality whose left side is a function call. The plan separates candidate function calls from trusted argument constructors and trusted expression wrappers. The published `int(lobb_num(...))` wrapper and expected `sys.getsizeof(...)` are evaluated on the trusted side with the pinned Python runtime. Never send the right-hand expected expressions or their values to the candidate. Preserve assertion order within the row. All assertions must pass for row score 1; a failed call, exception, timeout, malformed or extra output, unsupported result or nonzero worker exit scores 0.

Data uses an explicit tagged JSON tree, not pickle, repr, eval or arbitrary Python objects. Builtins retain exact types, including the bool/int distinction, list/tuple, set/frozenset, dict, bytes, complex, float, string and None. Canonical ordering makes sets and mappings order independent while retaining sequence order and type tags. Numeric results compare exact canonical types and values, except explicit official wrappers such as int are applied first. No tolerance or output repair is added.

For custom input objects constructed by official tests, including Pair and Node, the trusted planner serializes class name and plain instance fields recursively. The worker reconstructs field-bearing objects without calling candidate constructors, using the candidate class when available or a plain class with the published name. These objects support native attribute access and mutation inside the worker. A returned custom object is eligible only as a structural record whose class name and exact field schema match a trusted expected record; compare recursively serialized fields. Never use candidate __eq__, __hash__ or __repr__ to decide equality. Unsupported subclasses, executable objects, cycles or unrepresentable values do not cross into the trusted process. The transport is untrusted: a candidate may fabricate JSON, but it cannot read or change the expected values or the comparison decision.

Retain the shared answer extraction from predeclaration 2: first eligible python-tagged or bare fenced block, otherwise the whole output. Apply it identically to methods, references, controls and replay. Keep resource and byte limits, with ten seconds for each trusted planning invocation and ten seconds for each candidate row invocation. Trusted plans may be cached by all pinned row contents, never by a model response. Candidate executions and model calls are not cached.

Filter no rows. Before any paid call, prepare every official training and selection row and publish the gradeable/ungradeable IDs and reasons. A row whose official assertions cannot be safely represented stays in every method's denominator, scores zero for every method and is explicitly reported as ungradeable. Do not use this rule to discard a difficult reference or alter the control draw. An implementation defect must be fixed before measurement, not relabeled ungradeable after observing controls.

## Adversarial zero-score admission

Before ordinary controls or noise model calls, execute all of these bounded candidate-program controls against every row in the fresh MBPP control cohort. Every row for every control must score exactly zero. Preserve the previous shortcut unchanged as an additional control.

- Override builtins.exec so later execution would become a no-op.
- Return an arbitrary always-equal object with __eq__ and __hash__, including a builtin subclass variant.
- Exit early with sys.exit(0) and separately os._exit(0).
- Forge stdout success frames or a completion receipt, including guessed plain-data result frames.
- Monkeypatch unittest and assertion helpers, comparison functions and a fake or discovered harness module.
- Search test/expected-value paths and environment variables, with no legitimate task solution as fallback.
- Register an atexit hook to rewrite the result stream or claimed result files.

These are not an exhaustive proof against arbitrary code. They test the previously broken trust boundary and the named adversarial requirements. Keep each exact artifact and per-row result. Any positive adversarial score stops the epoch immediately, with no model calls, retuning or selective reruns. Do not award a pass because an attack was merely detected in source text.

IFBench and AIME accept strings through the protected JSON response protocol, never executable candidate programs. Their official checker and integer comparison run only in the trusted host process. Candidate text is never evaluated or imported. Check hostile Python, forged verdicts, monkeypatch requests, file/environment reads and atexit payloads through both protected response parsing and direct scoring. Use a deterministic synthetic constrained IFBench row and AIME answer to prove these non-solutions cannot alter the checker; ordinary official IFBench shortcuts may legitimately receive partial instruction credit under the unchanged ranking rule. Preserve official metrics and partitions.

## Fresh cohorts and unchanged gates

Use fixed seed **20261104**, independently `random.Random(20261104).sample(eligible, 20)` after lexicographic sorting by stable ID. IFBench and AIME use the full official training partitions. MBPP excludes the eight first-epoch rows and twenty second-epoch control rows from this draw only: 601, 654, 707, 760, 814, 867, 920, 974, 647, 676, 686, 702, 925, 923, 671, 629, 877, 734, 878, 956, 967, 866, 661, 694, 837, 699, 771, 937. All remain in the training partition and eligible for search. Freeze every ordered cohort and hash before model dispatch. No redraw based on scores.

Keep the original control prompts and `known-improved > naive > max(broken, shortcut)`, broken = 0 and MBPP original shortcut = 0. Known-improved MBPP uses the official reference program through the same new worker and comparison boundary. A tie or reversed ranking stops. Then run 16 fresh paired unchanged-seed trials on the same 20 rows, without cached responses. For paired mean-delta sample SD s and maximum absolute delta m, retain `noiseFloor = 3/sqrt(2)*s` and `noiseEnvelope = max(4.5/sqrt(2)*s,m)`. Require envelope strictly below improved-minus-naive contrast. Keep the independent-row projection sqrt(20/n), native calibration schema and zero-noise caveat.

Only after adversarial checks and ranking/noise gates pass for all three tasks, run one seed-0 MBPP smoke per method: Hone, pinned official GEPA with a real subscription reflection call, and plain. Keep identical task/proposer route, decoding, deployment budgets and $10-equivalent search caps. Record all reported usage, observable hidden attempts and >1% rate/spread flags. Keep the personal-domain OAuth-only pool, API-key prohibition, credential-opaque omp resolution and 80% usage/outage pause. No full pilot or merge in this lane.

## Shared machine and evidence

Use nice 10, one model request and one CPU-heavy worker at a time. Current live venue process 2707250 is pinned to CPUs 0 and 5; choose CPU **6**, not either live pinned CPU or the previously reserved 1–4 and 13–16. Recheck affinity before execution if machine state changes. Publish code, manifests, exact controls, gradeability, scored outputs, ledgers, pauses, hashes, failures and offline replay proof. Do not publish credentials or private inputs. Complete credential-opaque attempt and failed-call receipts in omp remain required before the later full benchmark matrix; file nothing upstream.
