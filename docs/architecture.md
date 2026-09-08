# Architecture

Hone separates the code being improved from the machinery that decides whether it improved. A **capsule** fixes the task boundary: baseline revision, protected evaluator paths, data groups, execution image, objective and budget. Its identity and admission bind those inputs.

The **trusted supervisor** admits the capsule, seals run configuration and manages execution. The **optimizer** proposes candidates inside that contract. The **broker** controls authorized operations and records durable decisions; the **evaluator** measures candidates, and the **proxy** records model usage against the budget. Candidate artifacts and supporting records use content digests.

## Source map

| Directory | Responsibility |
| --- | --- |
| `schema/` | Capsule, evaluator, broker, run and campaign contracts. |
| `trusted/cli/` | Launcher, supervision, authoring, admission, run inspection and delivery. |
| `trusted/broker/` | Authorized optimizer operations and durable execution authority. |
| `trusted/proxy/` | Model transport, routing and metering. |
| `trusted/scoring/` | Scoring and saturation calculations. |
| `trusted/meta/` | Campaign support. |
| `optimizer/` | Mutable optimization code and worker packaging. |
| `capsules/` | Tasks, evaluators, fixtures and source references. |

The CLI launcher snapshots and seals its runtime dependency closure before loading the trusted implementation. Local execution binds the capsule image and Docker engine. Protected paths and asset visibility constrain what the optimizer may change or observe.

## State and delivery

The run's durable broker journal is the authority for accepted candidates. Status and delivery reconcile against it, including interrupted writes. A delivery operation validates the exact target repository and rechecks the selected artifact before updating a ref. A green-looking log entry alone does not authorize applying a candidate.

Runs and artifacts remain in operator-local state. A public evidence bundle is a separately reviewed projection of those records; it must not expose protected data, provider secrets or raw private execution context.

### Provider failures

The trusted proxy classifies explicit provider errors separately from malformed agent output. For HTTP-success SSE responses, a complete top-level JSON `error` envelope or `event: error` marks a failed upstream operation, even after a valid model chunk. Agent-authored text inside a choice remains opaque.

Structured numeric HTTP error statuses are read from `error.status`, `error.status_code`, `error.code`, then envelope `status` or `status_code`. Auth (`401`/`403`), payment (`402`) and rate-limit (`429`) errors pause immediately; `5xx` errors retain at most three retries before pausing. Explicit failures without a recognized status policy use the same bounded retry limit and then pause as `provider-transport`. Missing or invalid status remains `null`; status is never guessed from a message or error-type string.

Pause and preflight records retain the provider status, while traces retain the HTTP transport status and the response body digest. Each attempt remains charged, including failed streamed attempts. A durable pause blocks further dispatch across restart until explicit resume passes both frozen-route preflights.

## Optimization levels

A single-candidate probe exercises a capsule. An M1 campaign evaluates changes to the optimizer across a frozen task set. M2 adds recursive optimization and transfer evaluation under a separate frozen protocol. The code includes authority-bearing corpus and nested-run operations; these are not unrestricted public CLI calls.

The authoring workflow can queue and advance sealed agent work through gate decisions. The default CLI boundary currently records requests without launching the agents. The [calibration coordinator](cli.md#saturation-calibration) serializes existing supervised runs and binds retained attempts to the existing scorer; it is not a scheduler service or execution authorization. Public onboarding, calibration admission/host validation and complete evidence publication remain integration work. See [Methodology](methodology.md).
