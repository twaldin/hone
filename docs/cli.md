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

## Campaigns

```text
hone hone --campaign PATH --headless --phase freeze|search|confirmation|holdout
hone recursive --campaign PATH --headless --phase freeze|search|confirmation|terminal|authorize
hone resume [--pause PAUSE_ID] [--campaign CAMPAIGN_STATE_DIR]
```

These are trusted campaign operations, not shortcuts around corpus admission. Freeze requires the appropriate output and artifact inputs; later phases require the preceding frozen state. Recursive authorization additionally validates its gate records, artifact identities and required attestations. Consult the parsers in `commands/hone.ts` and schemas in `schema/src/meta.ts` when assembling a campaign; public end-to-end onboarding is incomplete.

`hone resume` releases a durable campaign pause. It is distinct from `hone run … --resume`, which resumes an individual run. A provider interruption should be understood from its persisted pause or error record before resuming.

Exit codes are 0 for success, 1 for error or decline, 2 for usage errors and 3 for an autonomy-ladder refusal.
