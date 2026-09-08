import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BudgetEnvelope as BudgetEnvelopeSchema,
  CapsuleManifest,
  DiagnosticOrderingReport,
  IMAGE_DIGEST_REF,
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
  validateDiagnosticOrdering,
  type BudgetEnvelope,
} from "@hone/schema";
import { selectSaturationCeiling, type SaturationCell, type SaturationCeilingReport } from "@hone/scoring";
import { z } from "zod";
import { UsageError } from "./args.js";
import {
  CALIBRATION_BOOTSTRAP,
  CALIBRATION_BUDGET,
  CALIBRATION_CAPS,
  CALIBRATION_SANDBOX,
  CALIBRATION_SEEDS,
  CALIBRATION_TASKS,
  type CalibrationAttempt,
  type CalibrationCell,
  type CalibrationOutcome,
  type CalibrationPlan,
  type CalibrationPlanInputs,
  type CalibrationReportBundle,
  type CalibrationRunRequest,
  type CalibrationRunner,
  type CalibrationState,
  type CalibrationTask,
  type CalibrationUsage,
} from "./calibration-types.js";
import { verifyCorpusProvenance } from "./corpus-provenance.js";
import { writeFileDurable } from "./eventlog.js";
import { LaunchCorpusProvenance } from "./launch-draft.js";
import { acquireRunLock } from "./supervisor.js";

/**
 * Bounded saturation-calibration coordinator (TWA-91): the durable serial
 * driver for the 4-task x {2,4,8,12} x 5-seed grid whose report freezes the
 * M2 inner-episode ceiling (`resolveCalibration` in ./launch-draft.ts).
 *
 * The whole coordinator state is ONE canonical, digest-bound JSON document
 * (`calibration-state.v1.json`) rewritten durably at every transition. Every
 * dispatch intent is persisted BEFORE the runner is invoked, so a crash
 * mid-run leaves an interrupted intent that can only be settled by an
 * explicit same-run resume — never by a fresh launch. Outcomes are appended,
 * never replaced: the first attempt of a cell alone feeds the scorer; explicit
 * retries are retained as supplementary evidence. The runner owns actual
 * resource enforcement; this module only accounts and refuses.
 */

export const CALIBRATION_PLAN_VERSION = "calibration-plan.v1";
export const CALIBRATION_STATE_VERSION = "calibration-state.v1";
export const CALIBRATION_REPORT_VERSION = "calibration-report.v1";
export const CALIBRATION_STATE_FILE = "calibration-state.v1.json";
export const CALIBRATION_RESERVATIONS = { tokens: 48_000_000, usd: 800, serialHours: 160 } as const;
export const CALIBRATION_PRIMARY_REASON = "primary";

const PLAN_DIGEST_DOMAIN = "hone-m2-calibration-plan-v1";
const STATE_DIGEST_DOMAIN = "hone-m2-calibration-state-v1";
const RUN_ID_DOMAIN = "hone-m2-calibration-run-v1";
const BUNDLE_DIGEST_DOMAIN = "hone-m2-calibration-bundle-v1";
const BUDGET_DIMENSIONS = ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const;
const USAGE_DIMENSIONS: Record<(typeof BUDGET_DIMENSIONS)[number], keyof CalibrationUsage> = {
  maxTokens: "tokens",
  maxUsd: "usd",
  maxWallClockSec: "wallClockSec",
  maxEvaluatorInvocations: "evaluatorInvocations",
};

/** Test seam: the coordinator's only clock. */
export const calibrationClock = {
  now(): string {
    return new Date().toISOString();
  },
};

export type CalibrationRecordedOutcome = CalibrationAttempt["outcomes"][number];

export interface ExecuteCalibrationOptions {
  cellKey?: string;
  resume?: boolean;
  retryReason?: string;
  maxCells?: number;
}

function refuse(why: string): never {
  throw new UsageError(`calibration refused: ${why}`);
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function parseWith<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown, label: string): z.infer<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  refuse(`${label} is malformed: ${issues}`);
}

function elapsedSeconds(from: string, to: string): number {
  return (Date.parse(to) - Date.parse(from)) / 1000;
}

function copyBudget(budget: BudgetEnvelope): BudgetEnvelope {
  return {
    maxTokens: budget.maxTokens,
    maxUsd: budget.maxUsd,
    maxWallClockSec: budget.maxWallClockSec,
    maxEvaluatorInvocations: budget.maxEvaluatorInvocations,
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ISO_TIME = z.string().datetime();
const CalibrationTaskLabel = z.enum(CALIBRATION_TASKS);
const SaturationCapSchema = z.union([z.literal(2), z.literal(4), z.literal(8), z.literal(12)]);

const CalibrationTaskSchema = z
  .object({
    task: CalibrationTaskLabel,
    capsuleDir: z.string().min(1),
    manifest: CapsuleManifest,
    manifestDigest: SHA256,
    orderingReport: DiagnosticOrderingReport,
    admission: z.enum(["draft", "admitted"]),
  })
  .strict();

const CalibrationPlanInputsSchema = z
  .object({
    tasks: z.array(CalibrationTaskSchema).length(CALIBRATION_TASKS.length),
    corpus: LaunchCorpusProvenance,
    image: z.string().regex(IMAGE_DIGEST_REF),
    optimizerDigest: SHA256,
    runtimeDigest: SHA256,
  })
  .strict();

const CalibrationCellSchema = z
  .object({
    key: z.string().min(1),
    capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
    task: CalibrationTaskLabel,
    cap: SaturationCapSchema,
    seed: z.number().int(),
  })
  .strict();

const CalibrationPlanSchema = CalibrationPlanInputsSchema.extend({
  version: z.literal(CALIBRATION_PLAN_VERSION),
  budget: BudgetEnvelopeSchema.strict(),
  sandbox: z.object({ memoryBytes: z.literal(CALIBRATION_SANDBOX.memoryBytes), cpus: z.literal(CALIBRATION_SANDBOX.cpus) }).strict(),
  concurrency: z.literal(1),
  bootstrap: z
    .object({ rngSeed: z.literal(CALIBRATION_BOOTSTRAP.rngSeed), bootstrapSamples: z.literal(CALIBRATION_BOOTSTRAP.bootstrapSamples) })
    .strict(),
  reservations: z
    .object({
      tokens: z.literal(CALIBRATION_RESERVATIONS.tokens),
      usd: z.literal(CALIBRATION_RESERVATIONS.usd),
      serialHours: z.literal(CALIBRATION_RESERVATIONS.serialHours),
    })
    .strict(),
  cells: z.array(CalibrationCellSchema).length(CALIBRATION_TASKS.length * CALIBRATION_CAPS.length * CALIBRATION_SEEDS.length),
  planDigest: SHA256,
}).strict();

export function calibrationCellKey(task: CalibrationTask["task"], cap: number, seed: number): string {
  return `${task}/cap${cap}/seed${seed}`;
}

function checkTask(task: CalibrationTask, image: string): void {
  const label = `task ${task.task} (${task.capsuleDir})`;
  const derived = deriveCapsuleId({ ...task.manifest });
  if (derived !== task.manifest.id) refuse(`${label}: manifest id ${task.manifest.id} does not recompute (${derived})`);
  const digest = capsuleDigest(task.manifest);
  if (digest !== task.manifestDigest) refuse(`${label}: manifestDigest ${task.manifestDigest} does not recompute (${digest})`);
  if (task.manifest.image !== image) {
    refuse(`${label}: manifest image ${task.manifest.image} differs from the shared calibration image ${image}`);
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    if (task.manifest.budget[dimension] > CALIBRATION_BUDGET[dimension]) {
      refuse(`${label}: manifest budget ${dimension}=${task.manifest.budget[dimension]} exceeds the approved per-cell envelope ${CALIBRATION_BUDGET[dimension]}`);
    }
  }
  const sandbox = task.manifest.sandbox;
  if (sandbox !== undefined) {
    if (sandbox.memoryBytes > CALIBRATION_SANDBOX.memoryBytes) {
      refuse(`${label}: manifest sandbox memoryBytes=${sandbox.memoryBytes} exceeds the approved ${CALIBRATION_SANDBOX.memoryBytes}`);
    }
    if (sandbox.cpus !== undefined && sandbox.cpus > CALIBRATION_SANDBOX.cpus) {
      refuse(`${label}: manifest sandbox cpus=${sandbox.cpus} exceeds the approved ${CALIBRATION_SANDBOX.cpus}`);
    }
  }
  const violations = validateDiagnosticOrdering(task.orderingReport);
  if (task.admission === "admitted") {
    if (violations.length > 0 || task.orderingReport.failures.length > 0) {
      refuse(`${label}: admitted task carries a failing diagnostic ordering report: ${[...task.orderingReport.failures, ...violations].join("; ")}`);
    }
  }
}

/**
 * Deterministic plan assembly: identity/exclusion/bounds validation over the
 * verified inputs, then the fixed 80-cell grid in task/cap/seed order. Drafts
 * are accepted here (an offline rehearsal plan); trusted execution refuses
 * them at initialization.
 */
export function createCalibrationPlan(inputs: CalibrationPlanInputs): CalibrationPlan {
  const parsed = parseWith(CalibrationPlanInputsSchema, inputs, "calibration plan inputs");
  const corpus = verifyCorpusProvenance(parsed.corpus, "calibration corpus provenance");

  const byLabel = new Map<CalibrationTask["task"], CalibrationTask>();
  for (const task of parsed.tasks) {
    if (byLabel.has(task.task)) refuse(`task ${task.task} appears more than once`);
    byLabel.set(task.task, task);
  }
  const tasks = CALIBRATION_TASKS.map((label) => {
    const task = byLabel.get(label);
    if (task === undefined) refuse(`task ${label} is missing; the four approved calibration tasks are required`);
    return task;
  });

  const ids = new Set<string>();
  const digests = new Set<string>();
  const corpusIds = new Set(corpus.capsules.map((capsule) => capsule.id));
  const corpusDigests = new Set(corpus.capsules.map((capsule) => capsule.digest));
  const terminalContent = new Set(corpus.terminalContentHashes);
  for (const task of tasks) {
    checkTask(task, parsed.image);
    if (ids.has(task.manifest.id)) refuse(`capsule id ${task.manifest.id} is shared by two calibration tasks`);
    if (digests.has(task.manifestDigest)) refuse(`manifest digest ${task.manifestDigest} is shared by two calibration tasks`);
    ids.add(task.manifest.id);
    digests.add(task.manifestDigest);
    if (corpusIds.has(task.manifest.id)) {
      refuse(`task ${task.task} capsule ${task.manifest.id} is part of the frozen launch cohort; calibration tasks must be excluded from every development and terminal capsule`);
    }
    if (corpusDigests.has(task.manifestDigest)) {
      refuse(`task ${task.task} manifest digest ${task.manifestDigest} matches a frozen launch cohort capsule`);
    }
    for (const [path, hash] of Object.entries(task.manifest.contentHashes)) {
      if (terminalContent.has(hash)) refuse(`task ${task.task} content ${path} (${hash}) is terminal cohort content`);
    }
  }

  const cells: CalibrationCell[] = [];
  for (const task of tasks) {
    for (const cap of CALIBRATION_CAPS) {
      for (const seed of CALIBRATION_SEEDS) {
        cells.push({ key: calibrationCellKey(task.task, cap, seed), capsuleId: task.manifest.id, task: task.task, cap, seed });
      }
    }
  }

  const body: Omit<CalibrationPlan, "planDigest"> = {
    version: CALIBRATION_PLAN_VERSION,
    tasks,
    corpus,
    image: parsed.image,
    optimizerDigest: parsed.optimizerDigest,
    runtimeDigest: parsed.runtimeDigest,
    budget: copyBudget(CALIBRATION_BUDGET),
    sandbox: { memoryBytes: CALIBRATION_SANDBOX.memoryBytes, cpus: CALIBRATION_SANDBOX.cpus },
    concurrency: 1,
    bootstrap: { rngSeed: CALIBRATION_BOOTSTRAP.rngSeed, bootstrapSamples: CALIBRATION_BOOTSTRAP.bootstrapSamples },
    reservations: { ...CALIBRATION_RESERVATIONS },
    cells,
  };
  return { ...body, planDigest: sha256(canonicalJson({ domain: PLAN_DIGEST_DOMAIN, plan: body })) };
}

/** Shape-parse, then require the recorded plan to be exactly what its inputs recompute. */
export function validateCalibrationPlan(value: unknown): CalibrationPlan {
  const plan = parseWith(CalibrationPlanSchema, value, "calibration plan");
  const recomputed = createCalibrationPlan({
    tasks: plan.tasks,
    corpus: plan.corpus,
    image: plan.image,
    optimizerDigest: plan.optimizerDigest,
    runtimeDigest: plan.runtimeDigest,
  });
  if (canonicalJson(recomputed) !== canonicalJson(plan)) {
    refuse(`calibration plan ${plan.planDigest} does not match its deterministic recomputation (${recomputed.planDigest}); refusing a drifted or hand-edited plan`);
  }
  return recomputed;
}

function planCell(plan: CalibrationPlan, cellKey: string): CalibrationCell {
  const cell = plan.cells.find((candidate) => candidate.key === cellKey);
  if (cell === undefined) refuse(`cell ${JSON.stringify(cellKey)} is not part of plan ${plan.planDigest}`);
  return cell;
}

export function calibrationRunId(planDigest: string, cellKey: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ domain: RUN_ID_DOMAIN, planDigest, cellKey, ordinal }), "utf8")
    .digest("hex");
  return `run_cal_${digest.slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const UsageSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    usd: z.number().finite().nonnegative(),
    wallClockSec: z.number().finite().nonnegative(),
    evaluatorInvocations: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Reserved evidence key. The coordinator records its own judgement here so
 * the runner's raw result provenance survives verbatim: `reported` restores
 * exactly what the runner returned (for `runner.verify`), and `synthetic`
 * marks outcomes no run API can reproduce (a runner throw, a malformed
 * result, or an envelope exhausted during downtime). A runner result that
 * already carries this key is malformed.
 */
export const CALIBRATION_COORDINATOR_EVIDENCE_KEY = "coordinator";

/** zod's `.optional()` yields `number | undefined`; the shared types are exact-optional, so an absent gain is dropped. */
function withoutUndefinedGain<T extends { normalizedGain?: number | undefined }>(value: T): Omit<T, "normalizedGain"> & { normalizedGain?: number } {
  const { normalizedGain, ...rest } = value;
  return normalizedGain === undefined ? rest : { ...rest, normalizedGain };
}

const OutcomeStatus = z.enum(["valid", "invalid", "incomplete"]);

const ReportedOutcomeSchema = z
  .object({
    status: OutcomeStatus,
    resumable: z.boolean(),
    reason: z.string().min(1),
    normalizedGain: z.number().finite().optional(),
  })
  .strict()
  .transform(withoutUndefinedGain);

const CoordinatorEvidenceSchema = z.union([
  z.object({ synthetic: z.enum(["runner-threw", "malformed-outcome", "wall-clock-before-resume"]) }).strict(),
  z.object({ judgement: z.string().min(1), reported: ReportedOutcomeSchema }).strict(),
]);

const OutcomeBody = z
  .object({
    status: OutcomeStatus,
    resumable: z.boolean(),
    reason: z.string().min(1),
    usage: UsageSchema.nullable(),
    normalizedGain: z.number().finite().optional(),
    evidence: z.record(z.unknown()),
  })
  .strict();

const OutcomeSchema = OutcomeBody.transform(withoutUndefinedGain);

const RecordedOutcomeSchema = OutcomeBody.extend({
  at: ISO_TIME,
  evidence: z.record(z.unknown()).refine(
    (evidence) => !(CALIBRATION_COORDINATOR_EVIDENCE_KEY in evidence) || CoordinatorEvidenceSchema.safeParse(evidence[CALIBRATION_COORDINATOR_EVIDENCE_KEY]).success,
    { message: `evidence.${CALIBRATION_COORDINATOR_EVIDENCE_KEY} is not a coordinator record` },
  ),
})
  .strict()
  .transform(withoutUndefinedGain);

/**
 * The outcome exactly as the runner returned it, or null when the coordinator
 * synthesized the record and there is nothing a run API could reproduce.
 */
export function runnerReportedOutcome(recorded: CalibrationRecordedOutcome): CalibrationOutcome | null {
  const { at: _at, evidence, ...raw } = recorded;
  const { [CALIBRATION_COORDINATOR_EVIDENCE_KEY]: marker, ...runnerEvidence } = evidence;
  if (marker === undefined) return { ...raw, evidence: runnerEvidence };
  const coordinator = CoordinatorEvidenceSchema.parse(marker);
  if ("synthetic" in coordinator) return null;
  const { normalizedGain: _judged, ...rest } = raw;
  return { ...rest, ...coordinator.reported, evidence: runnerEvidence };
}

const AttemptSchema = z
  .object({
    cellKey: z.string().min(1),
    /** Zero-based per cell: 0 is the primary attempt that alone feeds the scorer; retries follow. */
    ordinal: z.number().int().nonnegative(),
    runId: z.string().regex(/^run_cal_[0-9a-f]{32}$/),
    reason: z.string().min(1),
    startedAt: ISO_TIME,
    dispatches: z.array(z.object({ at: ISO_TIME, resume: z.boolean() }).strict()).min(1),
    outcomes: z.array(RecordedOutcomeSchema),
    remainingBudget: BudgetEnvelopeSchema.strict(),
  })
  .strict();

const StateSchema = z
  .object({
    version: z.literal(CALIBRATION_STATE_VERSION),
    plan: z.unknown(),
    mode: z.enum(["offline", "trusted"]),
    attempts: z.array(AttemptSchema),
    stateDigest: SHA256,
  })
  .strict();

function stateDigest(state: Omit<CalibrationState, "stateDigest">): string {
  return sha256(canonicalJson({ domain: STATE_DIGEST_DOMAIN, state }));
}

function lastOutcome(attempt: CalibrationAttempt): CalibrationRecordedOutcome | null {
  return attempt.outcomes.length > 0 ? attempt.outcomes[attempt.outcomes.length - 1]! : null;
}

/**
 * Unsettled: no outcome yet (interrupted intent) or the latest outcome is
 * resumable. Dispatch count is irrelevant — a resume may itself be
 * interrupted, so several intents can precede one outcome — but a terminal
 * outcome is always the attempt's final event.
 */
function isUnsettled(attempt: CalibrationAttempt): boolean {
  const last = lastOutcome(attempt);
  return last === null || last.resumable;
}

/** Wall clock a settled attempt consumed: the runner's cumulative figure or the coordinator-observed elapsed span, whichever is larger. */
function consumedWallClockSec(attempt: CalibrationAttempt, usage: CalibrationUsage): number {
  const last = lastOutcome(attempt);
  const observed = last === null ? 0 : elapsedSeconds(attempt.startedAt, last.at);
  return Math.max(usage.wallClockSec, observed);
}

/**
 * The envelope a retry attempt starts with: the approved per-cell envelope
 * minus everything every prior attempt of the cell consumed. Unknown prior
 * spend (null usage) makes the remainder unknowable, which refuses.
 */
function retryBudget(priors: readonly CalibrationAttempt[], cellKey: string): BudgetEnvelope {
  const remaining = copyBudget(CALIBRATION_BUDGET);
  for (const prior of priors) {
    const last = lastOutcome(prior);
    if (last === null || last.usage === null) {
      refuse(`cell ${cellKey} attempt ${prior.ordinal} (${prior.runId}) has unknown resource usage; a retry cannot bound the remaining budget`);
    }
    const usage = { ...last.usage };
    for (const outcome of prior.outcomes) {
      if (outcome.usage === null) continue;
      for (const dimension of BUDGET_DIMENSIONS) {
        const key = USAGE_DIMENSIONS[dimension];
        usage[key] = Math.max(usage[key], outcome.usage[key]);
      }
    }
    remaining.maxTokens -= usage.tokens;
    remaining.maxUsd -= usage.usd;
    remaining.maxEvaluatorInvocations -= usage.evaluatorInvocations;
    remaining.maxWallClockSec -= Math.ceil(consumedWallClockSec(prior, usage));
  }
  for (const dimension of BUDGET_DIMENSIONS) {
    const floor = dimension === "maxUsd" ? 0 : 1;
    if (remaining[dimension] < floor) {
      refuse(`cell ${cellKey} has exhausted its per-cell ${dimension} envelope across ${priors.length} attempt(s); no retry budget remains`);
    }
  }
  return remaining;
}

function checkOutcomeLegality(attempt: CalibrationAttempt, index: number): void {
  const outcome = attempt.outcomes[index]!;
  const label = `cell ${attempt.cellKey} attempt ${attempt.ordinal} outcome ${index + 1}`;
  const isLast = index === attempt.outcomes.length - 1;
  if (!isLast && !(outcome.status === "incomplete" && outcome.resumable)) {
    refuse(`${label} was followed by another dispatch but is not a resumable incomplete outcome`);
  }
  if (outcome.status !== "incomplete" && outcome.resumable) refuse(`${label} is ${outcome.status} yet marked resumable`);
  if (outcome.status !== "valid" && outcome.normalizedGain !== undefined) refuse(`${label} is ${outcome.status} yet carries a normalizedGain`);
  if (outcome.status === "valid") {
    if (outcome.usage === null) refuse(`${label} is valid with unknown usage`);
    if (outcome.normalizedGain === undefined) refuse(`${label} is valid without a normalizedGain`);
    if (usageOverrun(outcome.usage, attempt.remainingBudget) !== null) refuse(`${label} is valid despite overrunning its envelope`);
    if (regressedUsage(attempt.outcomes.slice(0, index), outcome.usage)) refuse(`${label} is valid despite cumulative usage decreasing on resume`);
    if (elapsedSeconds(attempt.startedAt, outcome.at) > attempt.remainingBudget.maxWallClockSec) {
      refuse(`${label} is valid despite exceeding its wall-clock envelope including downtime`);
    }
  }
  const marker = outcome.evidence[CALIBRATION_COORDINATOR_EVIDENCE_KEY];
  if (marker !== undefined && !("synthetic" in (marker as object)) && (outcome.status !== "invalid" || outcome.resumable)) {
    refuse(`${label} carries a coordinator judgement but is not a terminal invalid outcome`);
  }
  // The i-th outcome needs at least i+1 dispatches before it (an interrupted
  // intent has no outcome, so a later dispatch may produce it); outcomes are
  // recorded in order.
  if (Date.parse(outcome.at) < Date.parse(attempt.dispatches[index]!.at)) refuse(`${label} is recorded before dispatch ${index + 1}`);
  if (index > 0 && Date.parse(outcome.at) < Date.parse(attempt.outcomes[index - 1]!.at)) refuse(`${label} precedes outcome ${index}`);
}

function checkAttemptLegality(plan: CalibrationPlan, attempt: CalibrationAttempt, priors: readonly CalibrationAttempt[]): void {
  const label = `cell ${attempt.cellKey} attempt ${attempt.ordinal}`;
  planCell(plan, attempt.cellKey);
  if (attempt.ordinal !== priors.length) refuse(`${label} is out of order; expected ordinal ${priors.length}`);
  const expectedRunId = calibrationRunId(plan.planDigest, attempt.cellKey, attempt.ordinal);
  if (attempt.runId !== expectedRunId) refuse(`${label} runId ${attempt.runId} does not derive from the plan (expected ${expectedRunId})`);
  if (attempt.outcomes.length > attempt.dispatches.length) {
    refuse(`${label} has ${attempt.dispatches.length} dispatch(es) but ${attempt.outcomes.length} outcome(s)`);
  }
  const last = lastOutcome(attempt);
  if (last !== null && !last.resumable && Date.parse(attempt.dispatches[attempt.dispatches.length - 1]!.at) > Date.parse(last.at)) {
    refuse(`${label} was dispatched again after its terminal ${last.status} outcome`);
  }
  if (attempt.dispatches[0]!.at !== attempt.startedAt) refuse(`${label} startedAt differs from its first dispatch`);
  for (const [index, dispatch] of attempt.dispatches.entries()) {
    if (dispatch.resume !== index > 0) refuse(`${label} dispatch ${index + 1} has resume=${dispatch.resume}`);
    if (index > 0 && Date.parse(dispatch.at) < Date.parse(attempt.dispatches[index - 1]!.at)) {
      refuse(`${label} dispatch ${index + 1} precedes dispatch ${index}`);
    }
  }
  if (attempt.ordinal === 0) {
    if (attempt.reason !== CALIBRATION_PRIMARY_REASON) refuse(`${label} is the primary attempt but records reason ${JSON.stringify(attempt.reason)}`);
    if (canonicalJson(attempt.remainingBudget) !== canonicalJson(CALIBRATION_BUDGET)) {
      refuse(`${label} does not start from the approved per-cell envelope`);
    }
  } else {
    const previous = priors[priors.length - 1]!;
    const previousLast = lastOutcome(previous);
    if (isUnsettled(previous) || previousLast === null) refuse(`${label} was dispatched while attempt ${previous.ordinal} was unsettled`);
    if (previousLast.status === "valid") refuse(`${label} retries a cell whose attempt ${previous.ordinal} already scored valid`);
    if (Date.parse(attempt.startedAt) < Date.parse(previousLast.at)) refuse(`${label} started before attempt ${previous.ordinal} settled`);
    if (canonicalJson(attempt.remainingBudget) !== canonicalJson(retryBudget(priors, attempt.cellKey))) {
      refuse(`${label} remainingBudget does not equal the approved envelope minus every prior attempt's usage`);
    }
  }
  for (let index = 0; index < attempt.outcomes.length; index++) checkOutcomeLegality(attempt, index);
}

/**
 * Parse + digest-verify + legality check of a whole state document. The plan
 * is recomputed, every attempt derives from the plan, at most one attempt is
 * unsettled and it is the most recent one (one active cell), and every
 * recorded history is one the coordinator could have produced.
 */
export function validateCalibrationState(value: unknown): CalibrationState {
  const raw = parseWith(StateSchema, value, "calibration state");
  const plan = validateCalibrationPlan(raw.plan);
  const state: CalibrationState = { version: raw.version, plan, mode: raw.mode, attempts: raw.attempts, stateDigest: raw.stateDigest };
  const { stateDigest: recorded, ...body } = state;
  const expected = stateDigest(body);
  if (recorded !== expected) refuse(`calibration state digest ${recorded} does not recompute (${expected}); the document drifted since it was written`);
  if (state.mode === "trusted") {
    for (const task of plan.tasks) {
      if (task.admission !== "admitted") refuse(`trusted state carries draft task ${task.task}; only admitted tasks may execute`);
    }
  }
  const priorsByCell = new Map<string, CalibrationAttempt[]>();
  let unsettled: CalibrationAttempt | null = null;
  for (const attempt of state.attempts) {
    if (unsettled !== null) {
      refuse(`cell ${attempt.cellKey} attempt ${attempt.ordinal} was dispatched while cell ${unsettled.cellKey} attempt ${unsettled.ordinal} was unsettled`);
    }
    const priors = priorsByCell.get(attempt.cellKey) ?? [];
    checkAttemptLegality(plan, attempt, priors);
    priors.push(attempt);
    priorsByCell.set(attempt.cellKey, priors);
    if (isUnsettled(attempt)) unsettled = attempt;
  }
  return state;
}

export function calibrationStatePath(stateDir: string): string {
  return join(stateDir, CALIBRATION_STATE_FILE);
}

function assertOwnerOnly(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) refuse(`${path} must be a regular file, never a symlink`);
  if ((stat.mode & 0o077) !== 0) refuse(`${path} is not owner-only (expected mode 0600)`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) refuse(`${path} is not owned by the current user`);
}

function persistState(stateDir: string, body: Omit<CalibrationState, "stateDigest">): CalibrationState {
  const state: CalibrationState = { ...body, stateDigest: stateDigest(body) };
  const path = calibrationStatePath(stateDir);
  writeFileDurable(path, `${canonicalJson(state)}\n`);
  chmodSync(path, 0o600);
  return state;
}

/** Read + parse + digest-verify + legality check; any drift refuses. */
export function readCalibrationState(stateDir: string): CalibrationState {
  const path = calibrationStatePath(stateDir);
  if (!existsSync(path)) refuse(`${path} does not exist; initialize the calibration first`);
  assertOwnerOnly(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    refuse(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCalibrationState(raw);
}

/** Every coordinator entry point serializes on the state directory's OS lock: one active cell, process-wide. */
async function withStateLock<T>(stateDir: string, planDigest: string, body: () => Promise<T>): Promise<T> {
  const runId = `calibration_${planDigest.slice("sha256:".length, "sha256:".length + 16)}`;
  const release = await acquireRunLock(stateDir, runId, { pid: process.pid, runId, nonce: randomUUID() });
  try {
    return await body();
  } finally {
    await release();
  }
}

/**
 * Mint the state document. Trusted mode refuses drafts and never relabels an
 * offline rehearsal; an existing state is never overwritten.
 */
export async function initializeCalibration(
  stateDir: string,
  plan: CalibrationPlan,
  mode: CalibrationState["mode"],
): Promise<CalibrationState> {
  const validated = validateCalibrationPlan(plan);
  if (mode !== "offline" && mode !== "trusted") refuse(`unknown calibration mode ${JSON.stringify(mode)}`);
  if (mode === "trusted") {
    for (const task of validated.tasks) {
      if (task.admission !== "admitted") {
        refuse(`task ${task.task} is a draft (${task.capsuleDir}); trusted calibration executes admitted tasks only`);
      }
    }
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return withStateLock(stateDir, validated.planDigest, async () => {
    const path = calibrationStatePath(stateDir);
    if (existsSync(path)) refuse(`${path} already exists; a calibration state is never re-initialized`);
    return persistState(stateDir, { version: CALIBRATION_STATE_VERSION, plan: validated, mode, attempts: [] });
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function usageOverrun(usage: CalibrationUsage, budget: BudgetEnvelope): string | null {
  for (const dimension of BUDGET_DIMENSIONS) {
    const spent = usage[USAGE_DIMENSIONS[dimension]];
    if (spent > budget[dimension]) return `${USAGE_DIMENSIONS[dimension]} ${spent} exceeds ${dimension} ${budget[dimension]}`;
  }
  return null;
}

function regressedUsage(prior: readonly CalibrationOutcome[], usage: CalibrationUsage): boolean {
  return prior.some((outcome) => outcome.usage !== null && BUDGET_DIMENSIONS.some(
    (dimension) => usage[USAGE_DIMENSIONS[dimension]] < outcome.usage![USAGE_DIMENSIONS[dimension]],
  ));
}

function buildRequest(state: CalibrationState, attempt: CalibrationAttempt, stateDir: string, resume: boolean): CalibrationRunRequest {
  const cell = planCell(state.plan, attempt.cellKey);
  const task = state.plan.tasks.find((candidate) => candidate.task === cell.task);
  if (task === undefined) refuse(`cell ${cell.key} names task ${cell.task} which the plan does not carry`);
  return {
    plan: state.plan,
    cell,
    task,
    runId: attempt.runId,
    resume,
    remainingBudget: copyBudget(attempt.remainingBudget),
    stateDir,
  };
}

function syntheticOutcome(
  synthetic: "runner-threw" | "malformed-outcome" | "wall-clock-before-resume",
  fields: Pick<CalibrationOutcome, "status" | "resumable" | "reason" | "usage">,
  evidence: Record<string, unknown>,
  at: string,
): CalibrationRecordedOutcome {
  return { ...fields, evidence: { ...evidence, [CALIBRATION_COORDINATOR_EVIDENCE_KEY]: { synthetic } }, at };
}

/**
 * The coordinator's judgement over what the runner reported: terminal
 * statuses are never resumable, a valid score needs known usage and a finite
 * gain, and any overrun of the attempt's envelope — including wall clock
 * measured from the attempt's start across downtime — is invalid, never a
 * score. Usage and evidence are kept verbatim; when the judgement overrides
 * the runner's status, the reported status/reason/gain are retained under
 * `evidence.coordinator.reported` so verification sees the raw result.
 */
function judgeOutcome(attempt: CalibrationAttempt, reported: unknown, at: string): CalibrationRecordedOutcome {
  const parsed = OutcomeSchema.safeParse(reported);
  const reserved = parsed.success && CALIBRATION_COORDINATOR_EVIDENCE_KEY in parsed.data.evidence;
  if (!parsed.success || reserved) {
    const issues = reserved
      ? `evidence.${CALIBRATION_COORDINATOR_EVIDENCE_KEY} is reserved for the coordinator`
      : parsed.success ? "" : parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    return syntheticOutcome(
      "malformed-outcome",
      { status: "invalid", resumable: false, reason: `coordinator: runner returned a malformed outcome (${issues})`, usage: null },
      { malformedOutcome: reported },
      at,
    );
  }
  const outcome = parsed.data;
  const invalidate = (judgement: string): CalibrationRecordedOutcome => {
    const { normalizedGain, status, resumable, reason, ...rest } = outcome;
    return {
      ...rest,
      status: "invalid",
      resumable: false,
      reason: `coordinator: ${judgement}; runner reported ${status}: ${reason}`,
      evidence: {
        ...outcome.evidence,
        [CALIBRATION_COORDINATOR_EVIDENCE_KEY]: { judgement, reported: withoutUndefinedGain({ status, resumable, reason, normalizedGain }) },
      },
      at,
    };
  };
  if (outcome.usage !== null) {
    const overrun = usageOverrun(outcome.usage, attempt.remainingBudget);
    if (overrun !== null) return invalidate(`resource envelope overrun (${overrun})`);
    if (regressedUsage(attempt.outcomes, outcome.usage)) return invalidate("cumulative usage decreased on resume");
  }
  const elapsed = elapsedSeconds(attempt.startedAt, at);
  if (elapsed > attempt.remainingBudget.maxWallClockSec) {
    return invalidate(`wall clock ${Math.ceil(elapsed)}s since ${attempt.startedAt} exceeds ${attempt.remainingBudget.maxWallClockSec}s including downtime`);
  }
  if (outcome.status !== "incomplete" && outcome.resumable) return invalidate(`${outcome.status} outcome marked resumable`);
  if (outcome.status === "valid") {
    if (outcome.usage === null) return invalidate("valid outcome with unknown usage");
    if (outcome.normalizedGain === undefined) return invalidate("valid outcome without a normalizedGain");
  } else if (outcome.normalizedGain !== undefined) {
    return invalidate(`${outcome.status} outcome carries a normalizedGain`);
  }
  return { ...outcome, at };
}

interface Dispatch {
  attempt: CalibrationAttempt;
  resume: boolean;
}

class Coordinator {
  private state: CalibrationState;

  constructor(
    private readonly stateDir: string,
    private readonly runner: CalibrationRunner,
  ) {
    this.state = readCalibrationState(stateDir);
    if (runner.mode !== this.state.mode) {
      refuse(`state ${stateDir} is ${this.state.mode} but the runner is ${runner.mode}; modes never mix`);
    }
  }

  get current(): CalibrationState {
    return this.state;
  }

  private commit(attempts: CalibrationAttempt[]): void {
    const { stateDigest: _old, ...body } = this.state;
    this.state = persistState(this.stateDir, { ...body, attempts });
  }

  private unsettledAttempt(): CalibrationAttempt | null {
    const last = this.state.attempts[this.state.attempts.length - 1];
    return last !== undefined && isUnsettled(last) ? last : null;
  }

  /** Resume MUST name the exact unfinished attempt; a terminal attempt never restarts implicitly. */
  resume(cellKey: string): Dispatch {
    const attempts = this.state.attempts.filter((candidate) => candidate.cellKey === cellKey);
    const attempt = attempts[attempts.length - 1];
    if (attempt === undefined) refuse(`cell ${cellKey} has never been dispatched; nothing to resume`);
    if (!isUnsettled(attempt)) {
      const last = lastOutcome(attempt);
      refuse(`cell ${cellKey} attempt ${attempt.ordinal} (${attempt.runId}) is settled as ${last?.status ?? "unknown"} and is not resumable; a terminal outcome is never rerun implicitly (use an explicit retry)`);
    }
    const at = calibrationClock.now();
    const elapsed = elapsedSeconds(attempt.startedAt, at);
    const resumed: CalibrationAttempt = { ...attempt, dispatches: [...attempt.dispatches, { at, resume: true }], outcomes: [...attempt.outcomes] };
    if (elapsed > attempt.remainingBudget.maxWallClockSec) {
      // The envelope is already gone including downtime: settle without dispatching.
      resumed.outcomes.push(syntheticOutcome(
        "wall-clock-before-resume",
        {
          status: "invalid",
          resumable: false,
          reason: `coordinator: wall clock ${Math.ceil(elapsed)}s since ${attempt.startedAt} exceeds ${attempt.remainingBudget.maxWallClockSec}s before resume`,
          usage: lastOutcome(attempt)?.usage ?? null,
        },
        {},
        at,
      ));
      this.replace(resumed);
      refuse(`cell ${cellKey} attempt ${attempt.ordinal} exhausted its wall-clock envelope during downtime; recorded invalid`);
    }
    this.replace(resumed);
    return { attempt: resumed, resume: true };
  }

  /** Explicit supplementary retry: prior attempt terminal and not valid, remaining budget bounded across every prior attempt. */
  retry(cellKey: string, reason: string): Dispatch {
    if (this.unsettledAttempt() !== null) this.refuseUnsettled();
    const priors = this.state.attempts.filter((candidate) => candidate.cellKey === cellKey);
    const previous = priors[priors.length - 1];
    if (previous === undefined) refuse(`cell ${cellKey} has never been dispatched; a retry needs a prior invalid or incomplete attempt`);
    const last = lastOutcome(previous);
    if (isUnsettled(previous) || last === null) refuse(`cell ${cellKey} attempt ${previous.ordinal} is unsettled; resume it before retrying`);
    if (last.status === "valid") refuse(`cell ${cellKey} attempt ${previous.ordinal} scored valid; retries only follow invalid or incomplete attempts`);
    return this.append(cellKey, priors.length, reason, retryBudget(priors, cellKey));
  }

  /** Next untouched cell in plan order, or null when every cell has a primary attempt. */
  nextPrimary(): Dispatch | null {
    if (this.unsettledAttempt() !== null) this.refuseUnsettled();
    const touched = new Set(this.state.attempts.map((attempt) => attempt.cellKey));
    const cell = this.state.plan.cells.find((candidate) => !touched.has(candidate.key));
    if (cell === undefined) return null;
    return this.append(cell.key, 0, CALIBRATION_PRIMARY_REASON, copyBudget(CALIBRATION_BUDGET));
  }

  private refuseUnsettled(): never {
    const attempt = this.unsettledAttempt()!;
    const interrupted = attempt.outcomes.length === 0;
    refuse(
      `cell ${attempt.cellKey} attempt ${attempt.ordinal} (${attempt.runId}) is ${interrupted ? "an interrupted dispatch without an outcome" : "incomplete and resumable"}; `
      + `settle it with an explicit same-run resume (cellKey ${attempt.cellKey}, resume) before any other dispatch`,
    );
  }

  private append(cellKey: string, ordinal: number, reason: string, remainingBudget: BudgetEnvelope): Dispatch {
    planCell(this.state.plan, cellKey);
    const at = calibrationClock.now();
    const attempt: CalibrationAttempt = {
      cellKey,
      ordinal,
      runId: calibrationRunId(this.state.plan.planDigest, cellKey, ordinal),
      reason,
      startedAt: at,
      dispatches: [{ at, resume: false }],
      outcomes: [],
      remainingBudget,
    };
    this.commit([...this.state.attempts, attempt]);
    return { attempt, resume: false };
  }

  private replace(attempt: CalibrationAttempt): void {
    const index = this.state.attempts.findIndex((candidate) => candidate.runId === attempt.runId);
    if (index < 0) throw new Error(`calibration attempt ${attempt.runId} vanished from state`);
    const attempts = [...this.state.attempts];
    attempts[index] = attempt;
    this.commit(attempts);
  }

  /** Invoke the runner against a persisted intent; a throw becomes a recorded resumable-incomplete outcome with the error preserved. */
  async run(dispatch: Dispatch): Promise<CalibrationRecordedOutcome> {
    const request = buildRequest(this.state, dispatch.attempt, this.stateDir, dispatch.resume);
    let recorded: CalibrationRecordedOutcome;
    try {
      const reported = await this.runner.run(request);
      recorded = judgeOutcome(dispatch.attempt, reported, calibrationClock.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = error instanceof Error
        ? { name: error.name, message, ...(error.stack === undefined ? {} : { stack: error.stack }) }
        : { message };
      recorded = syntheticOutcome(
        "runner-threw",
        { status: "incomplete", resumable: true, reason: `runner threw: ${message}`, usage: null },
        { error: detail },
        calibrationClock.now(),
      );
    }
    this.replace({ ...dispatch.attempt, outcomes: [...dispatch.attempt.outcomes, recorded] });
    return recorded;
  }
}

/**
 * Serial bounded execution under the state lock. Exactly one of: explicit
 * resume of a named unfinished attempt; explicit retry (reason + cell) of a
 * terminal non-valid attempt; or the next untouched cells in plan order (at
 * most `maxCells`). Any resumable outcome stops the invocation — the next
 * cell is never visited while an attempt is unsettled.
 */
export async function executeCalibration(
  stateDir: string,
  runner: CalibrationRunner,
  options: ExecuteCalibrationOptions = {},
): Promise<CalibrationState> {
  const { cellKey, resume, retryReason, maxCells } = options;
  if (resume === true && retryReason !== undefined) refuse("resume and retry are mutually exclusive");
  if (resume === true && cellKey === undefined) refuse("resume requires the cellKey of the unfinished attempt");
  if (retryReason !== undefined && (typeof retryReason !== "string" || retryReason.trim().length === 0)) refuse("a retry requires a non-empty reason");
  if (retryReason !== undefined && cellKey === undefined) refuse("a retry requires the cellKey of the invalid or incomplete attempt");
  if (cellKey !== undefined && resume !== true && retryReason === undefined) refuse("cellKey is only meaningful with resume or retryReason");
  if (maxCells !== undefined && (!Number.isSafeInteger(maxCells) || maxCells < 1)) refuse(`maxCells must be a positive integer, got ${String(maxCells)}`);
  if (runner.mode !== "offline" && runner.mode !== "trusted") refuse(`runner mode ${JSON.stringify(runner.mode)} is unknown`);
  const probe = readCalibrationState(stateDir);
  return withStateLock(stateDir, probe.plan.planDigest, async () => {
    const coordinator = new Coordinator(stateDir, runner);
    if (resume === true) {
      await coordinator.run(coordinator.resume(cellKey!));
      return coordinator.current;
    }
    if (retryReason !== undefined) {
      await coordinator.run(coordinator.retry(cellKey!, retryReason));
      return coordinator.current;
    }
    const limit = maxCells ?? Number.POSITIVE_INFINITY;
    for (let visited = 0; visited < limit; visited++) {
      const dispatch = coordinator.nextPrimary();
      if (dispatch === null) break;
      const outcome = await coordinator.run(dispatch);
      if (outcome.resumable) break;
    }
    return coordinator.current;
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function scorerCells(state: CalibrationState): SaturationCell[] {
  const primaries = new Map<string, CalibrationAttempt>();
  for (const attempt of state.attempts) {
    if (attempt.ordinal === 0) primaries.set(attempt.cellKey, attempt);
  }
  return state.plan.cells.map((cell) => {
    const primary = primaries.get(cell.key);
    const outcome = primary === undefined ? null : lastOutcome(primary);
    if (outcome !== null && outcome.status === "valid" && outcome.normalizedGain !== undefined) {
      return { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: "valid", normalizedGain: outcome.normalizedGain };
    }
    return { capsuleId: cell.capsuleId, cap: cell.cap, seed: cell.seed, status: outcome === null ? "incomplete" : outcome.status === "valid" ? "incomplete" : outcome.status };
  });
}

function assembleBundle(state: CalibrationState): CalibrationReportBundle {
  const report: SaturationCeilingReport = selectSaturationCeiling(scorerCells(state), {
    rngSeed: state.plan.bootstrap.rngSeed,
    bootstrapSamples: state.plan.bootstrap.bootstrapSamples,
  });
  const reportDigest = sha256(canonicalJson(report));
  const body: Omit<CalibrationReportBundle, "bundleDigest"> = { version: CALIBRATION_REPORT_VERSION, state, report, reportDigest };
  return { ...body, bundleDigest: sha256(canonicalJson({ domain: BUNDLE_DIGEST_DOMAIN, bundle: body })) };
}

/**
 * Score the recorded state without dispatching or altering it. Every
 * attempt's latest runner-produced outcome is re-verified against the run
 * APIs through the runner, exactly as the runner returned it (earlier
 * resumable outcomes are history, retained but superseded by the same run's
 * later evidence; coordinator-synthesized records — a runner throw, a
 * malformed result, an envelope exhausted in downtime — carry nothing a run
 * API can reproduce and stay as recorded). Then the vanilla scorer runs with
 * the frozen bootstrap settings and the bundle binds state, report and
 * digests.
 */
export async function buildCalibrationReport(stateDir: string, runner: CalibrationRunner): Promise<CalibrationReportBundle> {
  const probe = readCalibrationState(stateDir);
  return withStateLock(stateDir, probe.plan.planDigest, async () => {
    const state = readCalibrationState(stateDir);
    if (runner.mode !== state.mode) refuse(`state ${stateDir} is ${state.mode} but the verifying runner is ${runner.mode}; modes never mix`);
    for (const attempt of state.attempts) {
      const outcome = lastOutcome(attempt);
      if (outcome === null) continue;
      const reported = runnerReportedOutcome(outcome);
      if (reported === null) continue;
      await runner.verify(buildRequest(state, attempt, stateDir, attempt.dispatches.length > 1), reported);
    }
    const bundle = assembleBundle(state);
    const after = readCalibrationState(stateDir);
    if (after.stateDigest !== state.stateDigest) throw new Error("calibration state changed under the report lock");
    return bundle;
  });
}

const BundleSchema = z
  .object({
    version: z.literal(CALIBRATION_REPORT_VERSION),
    state: z.unknown(),
    report: z.unknown(),
    reportDigest: SHA256,
    bundleDigest: SHA256,
  })
  .strict();

/** Verify a bundle end to end: state legality, scorer recomputation, and both digest bindings. Mode is whatever the state says; offline is never relabeled. */
export function verifyCalibrationReport(bundle: unknown): CalibrationReportBundle {
  const raw = parseWith(BundleSchema, bundle, "calibration report bundle");
  const state = validateCalibrationState(raw.state);
  const recomputed = assembleBundle(state);
  if (canonicalJson(recomputed.report) !== canonicalJson(raw.report)) {
    refuse(`calibration report does not match the trusted recomputation (rngSeed ${state.plan.bootstrap.rngSeed}, samples ${state.plan.bootstrap.bootstrapSamples}); refusing a drifted or hand-edited report`);
  }
  if (recomputed.reportDigest !== raw.reportDigest) refuse(`reportDigest ${raw.reportDigest} does not recompute (${recomputed.reportDigest})`);
  if (recomputed.bundleDigest !== raw.bundleDigest) refuse(`bundleDigest ${raw.bundleDigest} does not recompute (${recomputed.bundleDigest})`);
  return recomputed;
}
