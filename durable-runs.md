# Durable runs

## Operator quick reference

Inspect the latest run and any campaign pause:

```sh
hone status
# or select a run explicitly
hone status --run <run-id>
```

Resume a paused or interrupted standalone run from the same project root, with the same capsule and sealed options:

```sh
hone run <capsule-dir> --headless --resume
```

Do not pass a new backend on resume. The run-local seal restores and verifies the original backend, capsule, contract, optimizer, and campaign configuration.

Resume a campaign-level provider pause:

```sh
hone resume --campaign <campaign-state-dir>
# if more than one pause is active:
hone resume --campaign <campaign-state-dir> --pause <pause-id>
```

Migrate a paused recursive campaign only from an **untracked, ignored runtime
config**. A tracked config is refused because rewriting it would dirty the
working tree that every later coordinator phase requires clean. Campaign 11's
runtime path is `data/m2-refreeze-final/campaign-frozen-cycle11.json`; that
exact path is ignored after its tracked pre-migration bytes were retained in
Git history. If the runtime copy is absent after landing the untracking commit,
restore it once from the preceding revision:

```sh
git show 8280c569f324a62530ab555b5346ac2237213201:data/m2-refreeze-final/campaign-frozen-cycle11.json \
  > data/m2-refreeze-final/campaign-frozen-cycle11.json
```

Before migration, every nonterminal campaign run's `.hone-version` must equal
the frozen config's current `trustedRuntime.digest`. If a fix lane pre-pinned a
run to an intermediate engine digest, explicitly restore the frozen from-digest
first:

```sh
printf '%s\n' '<frozen trustedRuntime.digest>' \
  > .hone-runs/<nonterminal-campaign-run>/.hone-version
```

The migrator accepts only that from-digest, or the exact target digest when
recovering its own partially completed prior attempt. Any third digest refuses
before mutation and names the required restore value.

After checking out the required engine fix, run:

```sh
hone campaign migrate-source \
  --campaign data/m2-refreeze-final/campaign-frozen-cycle11.json \
  --from <currently-pinned-full-commit> \
  --to <checked-out-full-commit> \
  --reason "<operator reason>"
```

The command requires a clean working tree whose `HEAD` is exactly `--to` and
requires `--from` to match every current campaign source pin. It recomputes the
boot digest, appends a digest-chained migration record to the runtime campaign,
and re-pins every nonterminal campaign run's `.hone-version` while holding its
run lock. Terminal runs are unchanged. File-write authority is the trust anchor
on the single-operator host; the record chain supplies continuity and tamper
evidence, not a separate signer. A foreign run pin, tracked campaign path,
stale `--from`, changed frozen field, or broken migration history refuses
before the campaign file is committed. Ordinary `hone recursive` then accepts
only the new source; the original campaign hash and durable state directory
remain stable.

`events.ndjson` is the supervisor-readable outcome record:

| Record | Meaning | Resume? |
| --- | --- | --- |
| `run.paused`, reason `operator` | Operator requested a durable pause. | Yes |
| `run.paused`, reason `recursive-child-pending` | A recursive child stopped without a durable terminal event. Its reservation stays open and the outer coordinate re-enters deterministically on resume; the child cannot contribute a positive settlement while pending. | Yes |
| `run.paused`, reason `provider-rate-limit`, `provider-auth`, `provider-payment`, `provider-transport`, `provider-5xx`, `returned-model-drift`, or `proxy-failover` | A provider or retryable infrastructure limit stopped spending. `providerStatus` and `pauseId` are recorded when available. | Yes, after correcting or waiting out the cause |
| `run.finished`, status `budget`, reason `budget-exhausted` | A configured token, USD, wall-clock, or evaluator budget ended the run. | No |
| `run.finished`, status `stopped`, reason `session-no-yield-bound` | The per-session no-yield bound ended the run. | No |
| `run.finished`, status `stopped`, reason `operator` | A terminal operator stop, as opposed to a pause. | No |
| `run.finished`, status `failed`, reason `crash` | The run failed rather than reaching a resumable pause boundary. | Investigate; an incomplete checkpoint may still be resumable only if the CLI offers it |
| `run.finished`, status `completed` | The run completed normally. | No |

A pause is deliberately nonterminal: it writes `run.paused` and no `run.finished`. `hone status` prints both `status` and `reason`; operators do not need to infer the outcome from a null candidate or correlate sidecars.

Every active run physically allocates a small `terminal-reserve.bin` before `run.started` or `run.resumed`. Starting or resuming therefore requires about 4 MiB of real free space; allocation failure refuses before appending a lifecycle event. A broker `ENOSPC` response uses a reserved optimizer exit: the trusted backend releases those blocks before teardown, then writes `run.finished` with status `failed` even when an episode was active. The reserve is removed after any ordinary terminal event and retained across pauses. If the terminal write still cannot be made, recursive parents classify the child as pending and durably pause rather than treating nonterminal state as positive evidence or crashing the campaign.

Budget snapshots define `spent.wallClockSec` as active time only: intervals opened by `run.started`/`run.resumed` and closed by `run.paused` or trusted-backend termination. Paused and process-down time does not consume the wall-clock envelope; `lifetimeSec` preserves total elapsed operator time separately. After an unpaused crash, active accounting closes the abandoned interval at its final acknowledged journal fact. This is an evidence clock: it cannot overcharge downtime, and it cannot undercharge work the trusted journal can recognize or settle; an unacknowledged in-flight attempt is deliberately not billable active time and must be retried or recovered through its durable spend journal.

The broker's nondecreasing `activeMs` checkpoints in `broker-state.ndjson` are the budget and exhaustion authority. The public `events.ndjson` lifecycle replay is a supervisor bootstrap clock: it arms the wall timer before the broker is available and migrates non-recursive pre-active-clock runs; the first broker snapshot reconciles it to broker authority. Recursive usage is write-ordered behind the matching broker clock checkpoint. A pre-active-clock recursive ledger has no evidence that separates its old lifetime charge into active and inactive time, so upgrade retains that already-charged value as a conservative active floor and accrues only active time afterward.

Clock rollback fails closed rather than reducing spend. A `run.started` or `run.resumed` boundary later than the broker's current wall clock is refused before backend work, and replay refuses decreasing `activeMs` checkpoints. Operators can distinguish repeated crash/resume with no acknowledged progress from paid activity in reports: `active wall`, total `lifetime`, and the derived `paused/offline` difference are shown separately.

`SIGTERM` and `SIGINT` request the safe default: a durable operator pause that can be resumed. Use `hone stop` when the intent is terminal; it writes `run.finished` with status `stopped` and reason `operator`. Tooling must not treat an OS lifecycle signal as a terminal stop.

Repair has one intentionally conservative pre-fsync case. If the process dies after entering repair but before `episode.invalid` is fsynced, the durable record cannot claim that repair finished, so each resume redoes one repair mutation session. This is correct and budget-bounded, but an operator watching spend may see that additional session. Once `episode.invalid` is durable, the repair decision is replayed and no repair work is repeated.

## Session yield ceiling

Mutation sessions default to a 1,500,000-token no-yield ceiling. A frozen run or meta-campaign may set `sessionNoYieldMaxTokens` to a larger positive integer; the value is schema-validated, sealed into the run config, and inherited by outer and child mutation sessions. Omission keeps the 1,500,000-token default, and configuration cannot lower it.

The pre-existing trusted-operator escape hatch `HONE_SESSION_NO_YIELD_MAX_TOKENS` accepts any positive safe integer, including a value below the default when no sealed config override exists. Prefer the sealed config surface for campaign policy; when both are present, the sealed config wins.

The future pumpfun M1 freeze should set `sessionNoYieldMaxTokens` to approximately 1,700,000 (use `1700000`). That exception accommodates its measured first coherent edit plus bounded smoke while prompt aggregation removes the repeated 2,000-entry evaluator payload. It applies only to that future freeze: never mutate an already-running campaign's budget or policy fields. The sanctioned `campaign migrate-source` transition is deliberately limited to source commits, the recomputed boot digest, and its append-only provenance; it cannot change this ceiling.

## Durability inventory

Before the durable-run cutover, Hone already had several load-bearing pieces:

- `events.ndjson` was an append-only, fsynced public run log. It durably recorded run start/resume, episode starts, candidate and evaluator events, incumbents, budget snapshots, delivery, and terminal events.
- `broker-state.ndjson` durably recorded trusted spend, evaluator-invocation, evaluator-result, lineage, gate, incumbent, corpus, proxy, and artifact facts. CAS writes and scratch snapshots used write-then-fsync/rename ordering.
- `proxy-dispatch.ndjson` and `proxy-trace.ndjson` retained provider admission/settlement and trace accounting. Campaign pause authority and provider-response classification already recognized 401/402/403/429, failover, model drift, and exhausted transport retries.
- Campaign resume restored the selected frozen campaign/capsule and run-local seals. Public run replay restored the incumbent, budget snapshot, completed episodes, and next episode number.
- The M2 refreeze smoke had exercised the journal write path, durable persistence, child-supervisor lifecycle, and the full 21-capsule campaign shape.

The missing boundary was an incomplete inner episode. Public replay advanced `nextEpisode` at `episode.started`, while the optimizer restarted statelessly. A crash after a paid evaluator result but before `episode.completed` could therefore skip the incomplete episode or rerun mutation/evaluation. Completed model tool work also had no paired workspace snapshot, and a classified provider limit could still end as a generic terminal failure instead of a durable nonterminal run outcome.

## Current checkpoint and resume contract

The smallest normal optimizer checkpoint is now a successful model tool execution. Hone snapshots workspace bytes before fsyncing the transcript event that acknowledges the tool, so after a crash the restored workspace may be ahead of the transcript but is never behind it. A provider call killed before it returns can still be retried; Hone cannot claim completion it never received.

At the trusted broker boundary, each outer episode has one fsynced checkpoint fact containing its episode number, parent artifact, and measurement epoch. Candidate admission, the complete evaluator record, gate result, selected incumbent, and `episode.completed` are separately journaled. `episode.completed` is the only episode commit boundary. An invalid-candidate repair explicitly continues the same episode and measurement epoch; it cannot mint a second repair episode.

On resume, the backend receives the active episode reconstructed from trusted journals. It restores, in order, the episode parent, candidate/session trace if present, exact evaluator result if present, gate/incumbent result if present, and completion boundary. Already-recorded stages are not emitted again.

Evaluator replay is permitted only for an explicit resume of the active episode and only when the full durable memo identity matches: run, measurement generation, artifact, capsule and optimizer digests, asset group, seed, evaluator timeout, trusted measurement epoch, and canonical recursive evaluation plan. A replay returns the fsynced record without acquiring a new evaluator slot, charging holdout access, incrementing evaluator invocations, or dispatching through the proxy. Legacy records are never used to replay recursive work because they did not contain the recursive-plan identity.

These rules make resume idempotent: journal append precedes acknowledgement; replay validates single-valued facts; the selected candidate and incumbent are recovered rather than reselected; exact evaluator records are reused without budget charge; and `episode.completed` prevents a completed episode from running again.

## Proof artifacts

Zero-provider-spend CLI artifacts are committed under:

- `fixtures/data/hone-durable-runs/docker-kill-resume/`: the hard-gate proof. The real local backend, real broker, optimizer container, mutation sandbox, and evaluator ran through Docker. The CLI process was killed after one candidate and both evaluator facts were durable but before `episode.completed`; resume claimed the checkpoint, replayed without increasing the two-invocation budget, retired the claim sandbox, completed episode 0, and finished coherently.
- `fixtures/data/hone-durable-runs/kill-resume/`: a supplementary stub-backend CLI lifecycle regression. It does not substitute for the real-broker Docker proof above.
- `fixtures/data/hone-durable-runs/provider-pause/`: a provider-boundary fake emits a simulated HTTP 429 pause, followed by trusted resume and completion. The run journal records `run.paused` with `provider-rate-limit`, status 429, and pause ID before `run.resumed`.
- `fixtures/data/hone-durable-runs/recursive-smoke.v1.json`: a post-change M2 recursive-search smoke dispatched one child through the real Docker evaluator, recorded one trusted score, executed neither the synthetic outer entrypoint nor mutation worker, and made zero model calls.
