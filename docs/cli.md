# CLI reference

Invoke the source CLI with `node trusted/cli/bin/hone.js`. The examples below abbreviate that launcher as `hone`; they assume workspace dependencies are installed. Command parsers in `trusted/cli/src/commands/` and `trusted/cli/src/supervisor.ts` define the accepted options.

Every command accepts `--capsules-root <dir>`, which names the directory holding capsules (normally `hone-capsules/capsules`). Without it, `HONE_CAPSULES_ROOT` is used, and without that, `./capsules` under the current directory. See [Getting started](getting-started.md#pointing-hone-at-capsules).

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

## Model routes and the upstream

Every model call leaves through hone's trusted proxy, which overwrites the requested model with the sealed route for the caller's role, sets `reasoning_effort` when the route names one, and forwards to `HONE_UPSTREAM_BASE_URL` with the bearer from `HONE_UPSTREAM_API_KEY_FILE` (or `HONE_UPSTREAM_API_KEY`). The upstream URL is required; see [Getting started](getting-started.md#before-a-real-run). On the tailnet, the omp gateway is:

```sh
export HONE_UPSTREAM_BASE_URL=http://twaldin-home:4000/v1
export HONE_UPSTREAM_API_KEY_FILE=~/.config/hone/upstream.token   # mode 600
```

Routes are configuration, never request data:

| Where | Keys | Default |
| --- | --- | --- |
| `hone run --config` (sealed run config) | `routing.mutation.model`, `routing.mutation.reasoningEffort` | `HONE_MODEL_ID` at run creation, else `openai-codex/gpt-6.1-sol`; no effort |
| Recursive campaign config (V2) | `routing.outerMutation`, `routing.innerMutation`, `routing.outerReasoningEffort`, `routing.innerReasoningEffort`; `modelObservation.outerRequestedRoute` / `innerRequestedRoute` must repeat the two model ids | launch drafts use `openai-codex/gpt-6.1-sol` for both tiers |
| Calibration selection | `routes.outer`, `routes.inner` | `openai-codex/gpt-5.6-sol` / `openai-codex/gpt-5.6-luna`, so the August 2026 selection keeps its frozen plan |

`outer` serves the outer optimizer and capsule author; `inner` serves inner capsule improvement. Reasoning effort is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. To put the outer tier on astra, freeze a campaign with:

```json
"routing": { "outerMutation": "openai-codex/gpt-6-astra", "innerMutation": "openai-codex/gpt-6.1-sol", "outerReasoningEffort": "high" },
"modelObservation": { "outerRequestedRoute": "openai-codex/gpt-6-astra", "innerRequestedRoute": "openai-codex/gpt-6.1-sol", "...": "…" }
```

A campaign's routes are sealed into every outer and child run (`campaign-session.v1.json`), and resume refuses a run whose routes changed. Configs and run seals frozen before routes were configurable still validate and resolve to their original `openai-codex/gpt-5.6-sol` (outer) and `openai-codex/gpt-5.6-luna` (inner). The M1 (`hone hone`, config V1) protocol stays pinned to `gpt-5.6-sol`.

Identity binding records the requested route and the returned model on every call and pauses a campaign on drift. The omp gateway echoes the requested id verbatim, so hone additionally compares its `x-litellm-model-id` header with the route's bare model name.

## Evaluator time limits

Each evaluator invocation runs under one wall-time cap, chosen in this order:

1. a recursive campaign's frozen `evaluatorTimeoutSec` (default 2700; any integer from 60 to 604800);
2. the capsule manifest's optional `evaluatorTimeoutSec` (same bounds; part of the capsule digest, set through `capsule.config.json` and `scaffold`);
3. the broker default of 600 seconds.

A plain `hone run` therefore uses the capsule's declaration or 600 seconds; the capsule budget's `maxWallClockSec` is the separate whole-run active-time envelope and must cover every evaluation the run may perform. Multi-hour evaluations (for example a ~7 h L2 measurement, `"evaluatorTimeoutSec": 28800`) are supported directly. The 604800-second ceiling also admits a ~74 h full validation (`266400` plus margin), but such a one-shot check is better run outside the optimization loop: every episode would repeat it. An episode's mutation sandbox lives for the whole run wall envelope up to 14 days, so it outlasts long evaluations, and wall envelopes longer than Node's ~24.8-day timer limit are honoured. Each in-sandbox mutation session is still bounded by the optimizer's own `mutationTimeoutSec` (1800 s, at most 3600 s on the broker wire), and one proxied model call by a 30-minute idle socket.

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

`calibration` measures how many inner optimizer episodes are worth paying for before a recursive campaign is frozen. It runs a fixed ladder over four calibration-only capsules that share no source, fixtures or objectives with the campaign cohort.

```text
hone calibration --campaign <selection.json> --headless [--state <.hone-runs/path>] [--resume] [--dry-structure] [--smoke-cell N]
```

The selection file names the capsules, episode caps, matched seeds and bootstrap settings. The one used in August 2026 is [`capsules/m2-calibration-selection.json`](https://github.com/twaldin/hone-capsules/blob/main/capsules/m2-calibration-selection.json) in hone-capsules. It selects `calibration-bitset-rank`, `calibration-varint-decode`, `calibration-byte-escape` and `calibration-interval-merge`, caps **2/4/8/12**, seeds **110729, 221447, 442903, 885811, 1771637** and 10,000 bootstrap samples with RNG seed 1295205714. That is **80 cells**; each cell reserves the capsule's full budget vector. Every listed capsule must be a direct child of the capsules root.

Every capsule must pass non-provisional admission and bind the native `linux/amd64` calibration runtime image before planning. The command freezes a plan under the state directory (default `.hone-runs/m2-calibration-<config-hash prefix>`); an existing plan for a different selection or identity set is refused. `--dry-structure` writes and prints the frozen cell coordinates without any model call. `--smoke-cell N` runs exactly one coordinate.

Before the first cell, the coordinator runs a trusted preflight of both frozen model routes through the broker. Route drift and `401`/`402`/`403`/`429` responses durably pause the calibration; ordinary `5xx` errors get at most three bounded retries before the same pause. A paused calibration continues only with `--resume`, which repeats the frozen-route preflight before admitting another cell. Interrupted cells are terminalized from their durable journals rather than silently rerun.

When all 80 cells are terminal, the coordinator scores them with the registered scorer in [`trusted/scoring/src/saturation.ts`](../trusted/scoring/src/saturation.ts) (p75 stratified paired marginal gain, 90% bootstrap upper bound, strict `< 0.02` rule, fallback 12) and writes `saturation-report.json`. Its canonical digest is what a frozen recursive campaign binds as `calibration.reportDigest`. Invalid cells stay in the scorer input; nothing is trimmed or replaced by a retry.

The August 2026 calibration completed 80/80 cells (55 valid, 25 invalid) and selected an inner ceiling of **4** episodes. Its plan, run state and per-cell evidence are private.

## Campaigns

```text
hone hone --campaign PATH --headless --phase freeze|search|confirmation|holdout
hone recursive --campaign PATH --headless --phase freeze|search|approve-search|confirmation|terminal|authorize [--sealed-base DIR]
hone campaign migrate-source|repin-image|capture-closure|restore-closure|smoke-capsules …
hone resume [--pause PAUSE_ID] [--campaign CAMPAIGN_STATE_DIR]
```

These are trusted campaign operations, not shortcuts around corpus admission. Freeze requires the appropriate output and artifact inputs; later phases require the preceding frozen state. Recursive authorization additionally validates its gate records, artifact identities and required attestations. Consult the parsers in `commands/hone.ts` and schemas in `schema/src/meta.ts` when assembling a campaign; public end-to-end onboarding is incomplete. The `campaign` subcommands maintain an already-frozen campaign: [Durable runs](durable-runs.md) explains source migration, image re-pins and closure capture/restore, and `smoke-capsules` checks that every development-panel capsule of a frozen campaign is installed and settles once before ignition.

A trusted caller can also pass a corpus to `recursiveCommand(args, io, { corpus })`, where `corpus` contains an existing `corpus-provenance.v1` artifact plus its exact `publicSnapshot` and `panelEvidence` document bytes (`BuildBrokerCorpusConfigInputs` without `campaignConfigHash`). When it is supplied, every executing phase verifies the artifact, documents, frozen cohort, capsule digests and current panel assignment, binds the final campaign hash and serves the corpus to the outer run and every child run, including resumes. Missing or drifted inputs refuse before launch. The corpus is optional: without it, recursive phases run as the August 2026 campaigns did. The public CLI has no flag for loading a corpus.

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
