# CLI reference

Invoke the source CLI with `node trusted/cli/bin/hone.js`. The examples below abbreviate that launcher as `hone`; they assume workspace dependencies are installed. Command parsers in `trusted/cli/src/commands/` and `trusted/cli/src/supervisor.ts` define the accepted options.

## Runs and authoring

```text
hone run <capsule-dir> [--headless] [--budget-usd N]
  [--apply none|branch|pr|auto] [--repo DIR] [--resume]
  [--backend local|stub] [--config JSON]
  [--optimizer-artifact sha256:…]

hone author <objective> [--repo DIR] [--headless] [--acknowledge-dirty]
hone author --workflow ID
  [--gate1 accept|revise|reject | --gate2 approve|reject]
  [--feedback TEXT] [--author owner|agent:ID]
  [--adversarial-validator owner|agent:ID] [--final-reviewer owner|agent:ID]
```

`run` performs a single candidate probe through the trusted supervisor. The default backend is `local`, and delivery defaults to `none`. A budget override can tighten the frozen capsule budget, not enlarge it. Delivery requires an explicit target repository. The stub backend is a controlled testing surface and does not establish production execution.

Run configuration is sealed at creation. `run --resume` uses that stored configuration and rejects another `--config` argument.

A bare positional argument naming a directory with `manifest.json` selects `run`; otherwise it selects `author`. Authoring captures a source baseline and queues durable role requests. With the default boundary, `awaiting-sealed-session` means the requested agent work is still pending. Gate decisions follow the workflow's required state and reviewer identities; the parser also supports explicitly bounded provisional delegation.

## Inspect and deliver

| Command | Purpose |
| --- | --- |
| `hone status [--run ID]` | Read the reconciled run state and non-holdout score. |
| `hone best [--run ID]` | Inspect the current accepted candidate. |
| `hone diff [--stat] [--run ID]` | Inspect its changes. |
| `hone apply --best --repo DIR [--branch NAME] [--run ID]` | Deliver the selected artifact to a branch in an explicitly validated repository. |
| `hone stop [--take-best --repo DIR] [--branch NAME] [--run ID]` | Request a stop, optionally delivering the final accepted candidate. |
| `hone off [--run ID]` | Alias for the stop surface. |

`apply` validates the target and the broker's current artifact selection. It does not overwrite the working tree or stop the run. PR and automatic delivery modes have their own authority requirements; selecting a mode does not bypass those checks.

Operator-local state lives under `.hone-runs`, `.hone-cas` and `.hone-sources`. Event and status output is reconciled with the durable broker journal before delivery. These directories are ignored by Git and are not public result bundles.

## Saturation calibration

`calibration` coordinates the four calibration-only tasks approved in TWA-59. **These commands do not authorize a campaign or provider spending.** The checked-in tasks are non-admitted drafts; they can be planned, but cannot execute.

Planning requires an existing, digest-verified `corpus-provenance.v1` artifact describing the full 16-development/11-terminal cohort. The coordinator rejects calibration identities or manifest digests in either cohort, and rejects calibration assets matching recorded terminal-content hashes. It does not load terminal document bytes or change cohort membership.

Safe planning/inspection, with private paths supplied by the operator:

```sh
mkdir -p .hone-runs
hone calibration plan --drafts --corpus "$CORPUS" --out .hone-runs/calibration-plan.json
hone calibration init --plan .hone-runs/calibration-plan.json --state .hone-runs/calibration
hone calibration status --state .hone-runs/calibration
hone calibration --help
```

`--drafts` reads only the four named packages' `manifest.draft.json` files, retaining their failed diagnostic evidence and marking the state `offline`. It neither issues admission receipts nor promotes draft identities. Without `--drafts`, planning requires full, non-provisional Gate-2 admission and a positive pinned train normalization scale. Plans bind the exact manifests, ordering reports, shared `seeded-astar` image reference, optimizer/runtime digests, cohort provenance and matrix; changed inputs require a separately reviewed plan, not an in-place edit.

The fixed matrix is **80 cells**: four tasks × episode caps **2/4/8/12** × matched seeds **104729, 130363, 155921, 181081, 206369**. Every cap has the same metered maxima: **600,000 tokens, $10, 7,200 seconds and 49 evaluator invocations**. The sandbox setting is **2 GiB / 2 CPUs**. Aggregate upper reservations are **48M tokens, $800 and 160 serial run-hours**, excluding preparation; they are neither measured requirements nor permission to spend.

The existing runtime meters each run's four budget dimensions and applies the sandbox limits **per container**, not as an aggregate process-tree cgroup. Selected-host admission must establish the approved cell isolation/resource conditions. Planning and offline tests do not establish that host evidence.

### Later, separately authorized execution

After the tasks and selected host are admitted, create a new admitted plan/state without `--drafts`. Do not relabel an offline state. Keep production state directly under `.hone-runs` so the existing provider-pause discovery command can find it.

```text
hone calibration run --state .hone-runs/calibration --acknowledge-execution
hone calibration run --state .hone-runs/calibration --acknowledge-execution --max-cells N
hone calibration run --state .hone-runs/calibration --acknowledge-execution --cell KEY --resume
hone calibration run --state .hone-runs/calibration --acknowledge-execution --cell KEY --retry-reason "recorded infrastructure diagnosis"
```

The CLI defaults to **one cell per invocation**. `--max-cells` bounds a serial batch; an OS-backed state lock remains held until the runner settles, including across awaits. There is no scheduler service. The adapter uses the existing local supervisor, frozen inner model route, provider-pause authority, admission checks and broker limits. Delivery is `none`; custom backends, optimizer overrides and paid fallback are not exposed.

`status` lists cell keys, run IDs, dispatches, outcomes and primary-result counts. Dispatch intent is durable **before** launch. A crash leaves an incomplete cell; normal execution refuses to move past unresolved work. `--resume` reconciles or continues the **same run ID and sealed budget**, retaining prior incomplete observations. Downtime counts against the cell's wall-clock envelope. A terminal failure is not resumed automatically.

Retries require an explicit cell and reason. They retain separate run IDs and consume the remaining per-cell envelope across all attempts; unknown spend blocks a retry, and decreasing cumulative meters invalidate a resumed result. **Retries are supplementary and never replace the primary attempt in the scorer**, even when a retry improves. A valid primary cannot be retried. Never reset state or rerun cells until favorable.

A provider pause uses the existing recovery path, followed by explicit same-run reconciliation:

```text
hone resume --campaign .hone-runs/calibration --pause PAUSE_ID
hone calibration run --state .hone-runs/calibration --acknowledge-execution --cell KEY --resume
```

The first command can perform frozen-route preflight; it is not part of offline validation and needs the execution scope.

### Report binding and offline verification

```text
hone calibration report --state .hone-runs/calibration --out PRIVATE_BUNDLE.json
hone calibration verify --state .hone-runs/calibration --bundle PRIVATE_BUNDLE.json
```

These commands launch no runs. They re-read the retained supervisor/broker/proxy evidence and validate contracts, measurement epochs, capsule/seed/asset coordinates and normalization inputs. The bundle embeds the plan and complete attempt history, plus the unchanged scorer report and canonical report/bundle digests. Missing primary cells stay `incomplete`; invalid primary cells stay `invalid`. The existing scorer uses **10,000** stratified bootstrap samples, RNG seed **20260907**, p75 marginal gain, its 90% upper bound and the strict **`<0.02`** rule (ceilings 4/8/12, fallback 12).

Failures can make the selected ceiling shallower. A generated report is not proof of a complete or successful matrix. Inspect all invalid/incomplete cells and unavailable evidence before using its `report` with `generateM2LaunchDraft`; supply the four designated excluded IDs from the verified plan. Its `reportDigest` is the existing launch/freeze binding. Preserve the full bundle and run directories: the vanilla scorer report alone does not carry execution provenance, and freeze does not independently reconstruct those runs. Offline fake-runner bundles are never launch evidence.

The trusted library seam is `initializeCalibration` / `executeCalibration` / `buildCalibrationReport` in `trusted/cli/src/calibration.ts`, with a `CalibrationRunner` implementing `run` and read-only `verify`. The runner mode is pinned to state; offline and trusted records cannot mix. Reproduce planning, limits, process interruption/resume, retries and evidence-drift checks without Docker or providers:

```sh
pnpm --filter @hone/cli exec vitest run test/calibration.test.ts test/calibration-runner.test.ts
```

## Campaigns

```text
hone hone --campaign PATH --headless --phase freeze|search|confirmation|holdout
hone recursive --campaign PATH --headless --phase freeze|search|approve-search|confirmation|terminal|authorize
hone resume [--pause PAUSE_ID] [--campaign CAMPAIGN_STATE_DIR]
```

These are trusted campaign operations, not shortcuts around corpus admission. Freeze requires the appropriate output and artifact inputs; later phases require the preceding frozen state. Recursive authorization additionally validates its gate records, artifact identities and required attestations. Consult the parsers in `commands/hone.ts` and schemas in `schema/src/meta.ts` when assembling a campaign; public end-to-end onboarding is incomplete.

Recursive execution requires a trusted caller to pass `recursiveCommand(args, io, { corpus })`, where `corpus` contains the existing `corpus-provenance.v1` artifact plus its exact `publicSnapshot` and `panelEvidence` document bytes (`BuildBrokerCorpusConfigInputs` without `campaignConfigHash`). The dispatcher verifies the artifact, documents, frozen cohort, capsule digests and current panel assignment, then binds the final campaign hash and passes `corpus`/`corpusCohort` to outer and child runs, including resumes. Missing or drifted inputs refuse before launch.

The public CLI does not yet load these private preparation inputs; its recursive `search`, `confirmation` and `terminal` phases therefore fail closed. `freeze`, `approve-search` and `authorize` do not require document bytes. This trusted API does not add a public corpus format, preparation flag or campaign authorization.

### G1 owner approval before Stage-B search

After reviewing the passing Stage-A G1 record and the winner's diff/mechanism, record approval for **each frozen Stage-B cell**:

```text
hone recursive --campaign "$B" --headless --phase approve-search --record-dir "$A_STATE_DIR" --approver "$OWNER" --reason "$REASON" --attest-diff-confined --attest-mechanism-plausible
hone recursive --campaign "$B" --headless --phase search
```

These are templates for separately authorized campaign work, not permission to execute it. `$A_STATE_DIR` holds `g1-statistical-record.v1.json`. `approve-search` records the owner's supplied attestations; it does not perform that review or launch work.

`g1-search-approval.v1.json` binds the complete destination config hash, target and controller source/bundle identities, owner decision and Stage-A statistical-record digest. The target must be the G1 winner; controller generation 0 must be that record's seed, and controller generation 1 its winner. Search (including default and resumed search) refuses missing, rejected, tampered, stale or mismatched approval before preparing work, then rechecks immediately before launch. Stage-A search is unchanged.

**Compatibility boundary:** existing `g1-authorization.v1.json` records still authorize the later artifact-bound confirmation, and G1/G2 authorization checks still guard terminal dispatch. They do not substitute for pre-search approval; the new approval does not authorize confirmation or terminal work. No `controlWinner` or `generation2` is needed to approve search. Approval retains an absolute Stage-A record-directory path and re-reads the record there: moving/removing that directory or regenerating the record requires fresh owner approval. A changed destination cell also requires fresh approval; there is no automatic migration or invented time-based expiry. As with existing authorizations, these are trusted-local attestations and digest bindings, not cryptographic proof of the named person's identity.

The source record directory itself must be a real directory, not a symlink, at approval and dispatch. Replacing its recorded path with a symlink to relocated records does not preserve approval.

`hone resume` releases a durable campaign pause. It is distinct from `hone run … --resume`, which resumes an individual run. A provider interruption should be understood from its persisted pause or error record before resuming.

Exit codes are 0 for success, 1 for error or decline, 2 for usage errors and 3 for an autonomy-ladder refusal.
