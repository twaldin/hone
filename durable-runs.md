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

`events.ndjson` is the supervisor-readable outcome record:

| Record | Meaning | Resume? |
| --- | --- | --- |
| `run.paused`, reason `operator` | Operator requested a durable pause. | Yes |
| `run.paused`, reason `provider-rate-limit`, `provider-auth`, `provider-payment`, `provider-transport`, `provider-5xx`, `returned-model-drift`, or `proxy-failover` | A provider or retryable infrastructure limit stopped spending. `providerStatus` and `pauseId` are recorded when available. | Yes, after correcting or waiting out the cause |
| `run.finished`, status `budget`, reason `budget-exhausted` | A configured token, USD, wall-clock, or evaluator budget ended the run. | No |
| `run.finished`, status `stopped`, reason `session-no-yield-bound` | The per-session no-yield bound ended the run. | No |
| `run.finished`, status `stopped`, reason `operator` | A terminal operator stop, as opposed to a pause. | No |
| `run.finished`, status `failed`, reason `crash` | The run failed rather than reaching a resumable pause boundary. | Investigate; an incomplete checkpoint may still be resumable only if the CLI offers it |
| `run.finished`, status `completed` | The run completed normally. | No |

A pause is deliberately nonterminal: it writes `run.paused` and no `run.finished`. `hone status` prints both `status` and `reason`; operators do not need to infer the outcome from a null candidate or correlate sidecars.

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

Zero-provider-spend live CLI artifacts are committed under:

- `fixtures/data/hone-durable-runs/kill-resume/`: a real CLI process killed with `SIGKILL` after `eval.completed`, then resumed to one coherent `run.finished`. `evidence.v1.json` names the commands, exit codes, record files, and uniqueness/accounting assertions.
- `fixtures/data/hone-durable-runs/provider-pause/`: a provider-boundary fake emits a simulated HTTP 429 pause, followed by trusted resume and completion. The run journal records `run.paused` with `provider-rate-limit`, status 429, and pause ID before `run.resumed`.
