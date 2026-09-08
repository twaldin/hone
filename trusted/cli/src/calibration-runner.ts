import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBrokerJournalEvaluations, type BrokerJournalEvaluationSnapshot } from "@hone/broker";
import { normalizedGain } from "@hone/meta";
import { PROXY_TRACE_FILE } from "@hone/proxy";
import {
  BudgetEnvelope as BudgetEnvelopeSchema,
  CapsuleManifest,
  DiagnosticOrderingReport,
  EvaluationRecord,
  M2_INNER_MODEL_ROUTE,
  ProxyTraceRecord,
  RunConfig,
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
  type BudgetEnvelope,
} from "@hone/schema";
import { CAPSULE_SNAPSHOT_FILE, admitCapsule } from "./admission.js";
import { UsageError } from "./args.js";
import { inspectCalibrationHost } from "./calibration-host.js";
import {
  CALIBRATION_BUDGET,
  CALIBRATION_CAPS,
  CALIBRATION_SANDBOX,
  CALIBRATION_SEEDS,
  CALIBRATION_TASKS,
  type CalibrationHostBinding,
  type CalibrationOutcome,
  type CalibrationPlanInputs,
  type CalibrationRunRequest,
  type CalibrationRunner,
  type CalibrationTask,
  type CalibrationUsage,
} from "./calibration-types.js";
import { loadCapsule } from "./capsule.js";
import { DurableCampaignPauseAuthorityV1 } from "./commands/hone.js";
import { readCorpusProvenanceArtifact } from "./corpus-provenance.js";
import { DOCKER_CREATE_WAL, readDockerCgroupParent } from "./docker-create-gate.js";
import { DOCKER_ENGINE_SEAL } from "./docker-engine-seal.js";
import { EVENTS_FILE, bestArtifact, readEvents, replayRun, writeFileDurable, type RunState } from "./eventlog.js";
import type { CmdIo } from "./io.js";
import {
  collectOptimizerSnapshot,
  computeOptimizerDigest,
  optimizerOverridden,
  resolveOptimizerSnapshotDigest,
  type OptimizerSnapshot,
} from "./optimizer-digest.js";
import { CONTRACT_FILE, RUN_CONFIG_FILE, runsRoot } from "./runs.js";
import { verifiedBootRuntimeDigest } from "./runtime-digest.js";
import { OPTIMIZER_COMPLETE_FILE, RUNTIME_PIN_FILE, runCommand } from "./supervisor.js";
import { resumeSealError } from "./resume-seal.js";

/**
 * Production calibration adapter: loads the four excluded calibration tasks
 * into fixed plan inputs and dispatches each cell through the existing
 * trusted `runCommand` supervisor. Nothing here executes on its own: every
 * limit (episode cap, four-dimensional budget, sandbox, route, admission)
 * is handed to the existing trusted APIs, and every outcome is re-derived
 * from the run's durable records (event log, broker journal, proxy trace,
 * sealed contract/config/manifest files) — never from optimizer reports.
 *
 * Production additionally requires the coordinator to already reside inside
 * a verified native-host cgroup capped at 2 GiB / 2 CPUs. The same parent is
 * forced on every container through the existing Docker creation gate, so
 * host helpers and optimizer/mutation/eval containers share the cell ceiling.
 */

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CALIBRATION_PROXY_ROLE = "inner-capsule-improvement" as const;
const CALIBRATION_ROUTE = M2_INNER_MODEL_ROUTE;
const PINNED_IMAGE_CAPSULE = "seeded-astar";
export const CALIBRATION_PAUSE_AUTHORITY_FILE = "campaign-pause.v1.json";
export const CALIBRATION_EVIDENCE_VERSION = "calibration-evidence.v1";
const CAMPAIGN_SESSION_FILE = "campaign-session.v1.json";
const BROKER_JOURNAL_FILE = "broker-state.ndjson";
const DRAFT_MANIFEST_FILE = "manifest.draft.json";
const BUDGET_DIMENSIONS = ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const;
const USAGE_DIMENSIONS = ["tokens", "usd", "wallClockSec", "evaluatorInvocations"] as const;
const ZERO_USAGE: Readonly<CalibrationUsage> = { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
/** Forbidden on the dispatching invocation: each one substitutes untrusted code or a foreign optimizer. */
const FORBIDDEN_ENV = ["HONE_UNSAFE_BACKEND", "HONE_OPTIMIZER_CMD", "HONE_OPTIMIZER_ENTRY"] as const;

function sha256(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function refuse(message: string): never {
  throw new UsageError(`calibration: ${message}`);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function bounded(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "\uFFFD").slice(0, 512);
}

/** The optimizer-visible final-evaluation coordinate the local backend measures (train, else first non-holdout). */
function finalAssetGroupId(manifest: CapsuleManifest): string | null {
  const group = manifest.assetGroups.find((candidate) => candidate.visibility !== "holdout" && candidate.id === "train")
    ?? manifest.assetGroups.find((candidate) => candidate.visibility !== "holdout");
  return group?.id ?? null;
}

/** qBase/scale exactly as the launch corpus derives them from the pinned ordering report. */
function normalization(report: DiagnosticOrderingReport): { qBase: number; scale: number } | null {
  const baseline = report.variants.baseline.train;
  const reference = report.variants.improved.train;
  if (!(reference > baseline) || baseline < 0 || baseline > 1 || reference < 0 || reference > 1) return null;
  return { qBase: baseline, scale: reference - baseline };
}

/** Undefined when the file is absent or not JSON — callers treat that as missing evidence, never as a crash. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function assertApprovedCeilings(manifest: CapsuleManifest, label: string): void {
  if (!sameCanonical(manifest.budget, CALIBRATION_BUDGET)) {
    refuse(`${label} budget ${canonicalJson(manifest.budget)} is not the approved envelope ${canonicalJson(CALIBRATION_BUDGET)}`);
  }
  if (manifest.sandbox === undefined || !sameCanonical(manifest.sandbox, CALIBRATION_SANDBOX)) {
    refuse(`${label} sandbox ${canonicalJson(manifest.sandbox ?? null)} is not the approved ceiling ${canonicalJson(CALIBRATION_SANDBOX)}`);
  }
}

function pinnedImage(root: string): string {
  return loadCapsule(join(root, "capsules", PINNED_IMAGE_CAPSULE)).image;
}

function loadDraftTask(capsuleDir: string, task: CalibrationTask["task"]): CalibrationTask {
  const manifestPath = join(capsuleDir, DRAFT_MANIFEST_FILE);
  if (!existsSync(manifestPath)) refuse(`${task} has no ${DRAFT_MANIFEST_FILE}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    refuse(`${task} draft manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = CapsuleManifest.safeParse(raw);
  if (!parsed.success) refuse(`${task} draft manifest does not match the capsule schema`);
  const manifest = parsed.data;
  if (deriveCapsuleId({ ...manifest }) !== manifest.id) refuse(`${task} draft id ${manifest.id} does not recompute`);
  const reportPath = resolve(capsuleDir, manifest.diagnosticOrdering.path);
  if (!reportPath.startsWith(`${resolve(capsuleDir)}/`)) refuse(`${task} draft ordering report escapes the capsule`);
  if (!existsSync(reportPath)) refuse(`${task} draft ordering report is missing: ${manifest.diagnosticOrdering.path}`);
  const reportBytes = readFileSync(reportPath);
  if (sha256(reportBytes) !== manifest.diagnosticOrdering.hash) refuse(`${task} draft ordering report drifted from its manifest pin`);
  const report = DiagnosticOrderingReport.safeParse(JSON.parse(reportBytes.toString("utf8")));
  if (!report.success) refuse(`${task} draft ordering report does not match the schema`);
  return {
    task,
    capsuleDir,
    manifest,
    manifestDigest: capsuleDigest(manifest),
    orderingReport: report.data,
    admission: "draft",
  };
}

function loadAdmittedTask(capsuleDir: string, task: CalibrationTask["task"]): CalibrationTask {
  const admitted = admitCapsule(capsuleDir, { review: "required" });
  if (admitted.provisional) refuse(`${task} carries only a provisional delegated approval — calibration requires full Gate-2 admission`);
  if (normalization(admitted.orderingReport) === null) {
    refuse(`${task} ordering report has no positive [0, 1] train reference scale (baseline ${admitted.orderingReport.variants.baseline.train}, improved ${admitted.orderingReport.variants.improved.train})`);
  }
  return {
    task,
    capsuleDir,
    manifest: admitted.manifest,
    manifestDigest: admitted.digest,
    orderingReport: admitted.orderingReport,
    admission: "admitted",
  };
}

/**
 * Fixed plan inputs from the four calibration task directories. Default:
 * full frozen admission (Gate-2 receipt chain, provisional refused). With
 * `drafts`, the content-addressed `manifest.draft.json` and its ordering
 * report are loaded for OFFLINE coordination only and are marked "draft":
 * the production runner refuses every draft before any dispatch.
 */
export function loadCalibrationPlanInputs(
  root: string,
  corpusPath: string,
  options: { drafts?: boolean; cgroupParent?: string; env?: NodeJS.ProcessEnv } = {},
): CalibrationPlanInputs {
  const image = pinnedImage(root);
  if (options.drafts === true && options.cgroupParent !== undefined) refuse("--cgroup-parent is for admitted planning, not offline drafts");
  if (options.drafts !== true && options.cgroupParent === undefined) {
    refuse("admitted planning requires --cgroup-parent and a pre-provisioned aggregate 2 GiB / 2 CPU native-host cgroup");
  }
  const host = options.cgroupParent === undefined
    ? undefined
    : inspectCalibrationHost(image, options.cgroupParent, options.env ?? process.env);
  const corpus = readCorpusProvenanceArtifact(resolve(root, corpusPath));
  const cohortIds = new Set([...corpus.developmentCapsuleIds, ...corpus.terminalCapsuleIds, ...corpus.capsules.map((capsule) => capsule.id)]);
  const cohortDigests = new Set(corpus.capsules.map((capsule) => capsule.digest));
  const tasks: CalibrationTask[] = [];
  const seenIds = new Set<string>();
  for (const task of CALIBRATION_TASKS) {
    const capsuleDir = join(root, "capsules", task);
    if (!existsSync(capsuleDir)) refuse(`calibration task directory is missing: ${capsuleDir}`);
    const loaded = options.drafts === true ? loadDraftTask(capsuleDir, task) : loadAdmittedTask(capsuleDir, task);
    if (loaded.manifest.image !== image) {
      refuse(`${task} image ${loaded.manifest.image} is not the approved pinned image ${image}`);
    }
    assertApprovedCeilings(loaded.manifest, task);
    if (cohortIds.has(loaded.manifest.id) || cohortDigests.has(loaded.manifestDigest)) {
      refuse(`${task} (${loaded.manifest.id}) is a corpus cohort member — calibration tasks must be excluded from development and terminal cohorts`);
    }
    if (seenIds.has(loaded.manifest.id)) refuse(`duplicate calibration capsule id ${loaded.manifest.id}`);
    seenIds.add(loaded.manifest.id);
    tasks.push(loaded);
  }
  return {
    tasks,
    corpus,
    image,
    optimizerDigest: computeOptimizerDigest(image),
    runtimeDigest: verifiedBootRuntimeDigest(),
    ...(host === undefined ? {} : { host }),
  };
}

/** Deterministic per-cell trusted measurement epoch; identical on every same-run resume. */
export function calibrationMeasurementEpoch(planDigest: string, cellKey: string): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ domain: "hone-calibration-measurement-epoch-v1", planDigest, cellKey }))
    .digest("hex");
  return `calibration:${digest}`;
}

/** The exact run config the supervisor must have sealed for a cell; any stored deviation is drift. */
function expectedRunConfig(request: CalibrationRunRequest): RunConfig {
  return RunConfig.parse({
    version: 1,
    capsuleId: request.task.manifest.id,
    objective: request.task.manifest.objective,
    budget: request.remainingBudget,
    routing: { mutation: { model: CALIBRATION_ROUTE } },
    apply: "none",
    headless: true,
    backend: "local",
    improverSeat: false,
    seed: request.cell.seed,
  });
}

interface FileEvidence {
  hash: string;
  bytes: number;
}

function fileEvidence(path: string): FileEvidence | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  return { hash: sha256(bytes), bytes: bytes.length };
}

/** Supervisor observations that cannot be re-collected from disk; verify copies them verbatim. */
export interface CalibrationDispatchRecord {
  resume: boolean;
  exitCode: number | null;
  stderr: string[];
  refusal: string | null;
}

/**
 * Pure evidence collection for one cell run. Everything is derived from the
 * run directory plus the fixed plan; identical inputs yield an identical
 * canonical outcome, which is what `verify` requires.
 */
function collect(io: CmdIo, request: CalibrationRunRequest, dispatch: CalibrationDispatchRecord | null): CalibrationOutcome {
  const { plan, cell, task } = request;
  const runDir = join(runsRoot(io.root), request.runId);
  const measurementEpoch = calibrationMeasurementEpoch(plan.planDigest, cell.key);
  const authorityPath = join(request.stateDir, CALIBRATION_PAUSE_AUTHORITY_FILE);
  const identities = {
    capsuleId: cell.capsuleId,
    capsuleDigest: task.manifestDigest,
    image: plan.image,
    optimizerDigest: plan.optimizerDigest,
    runtimeDigest: plan.runtimeDigest,
    route: CALIBRATION_ROUTE,
    proxyRole: CALIBRATION_PROXY_ROLE,
    campaignConfigHash: plan.planDigest,
    optimizerEpisodesMax: cell.cap,
    maxPublicCandidateEvaluations: 2 * cell.cap,
    seed: cell.seed,
    measurementEpoch,
    host: plan.host ?? null,
  };
  const evidence: Record<string, unknown> = {
    version: CALIBRATION_EVIDENCE_VERSION,
    planDigest: plan.planDigest,
    cellKey: cell.key,
    runId: request.runId,
    runDirPresent: existsSync(runDir),
    identities,
    dispatch,
  };
  const drift: string[] = [];
  const finish = (
    status: CalibrationOutcome["status"],
    resumable: boolean,
    reason: string,
    usage: CalibrationUsage | null,
    normalized?: number,
  ): CalibrationOutcome => {
    evidence["drift"] = drift;
    return {
      status,
      resumable,
      reason,
      usage,
      ...(normalized !== undefined ? { normalizedGain: normalized } : {}),
      evidence,
    };
  };

  if (!existsSync(runDir)) {
    const reason = dispatch?.refusal
      ?? (dispatch?.exitCode == null
        ? "no run directory exists for this dispatch"
        : `supervisor refused before a run directory was minted (exit ${dispatch.exitCode})`);
    return finish("incomplete", false, reason, request.resume ? null : { ...ZERO_USAGE });
  }

  const eventsPath = join(runDir, EVENTS_FILE);
  const eventBytes = existsSync(eventsPath) ? readFileSync(eventsPath) : null;
  const eventLog = eventBytes === null
    ? null
    : { hash: sha256(eventBytes), bytes: eventBytes.length, tornTail: eventBytes.length > 0 && eventBytes[eventBytes.length - 1] !== 0x0a };
  evidence["eventLog"] = eventLog;
  evidence["files"] = {
    contract: fileEvidence(join(runDir, CONTRACT_FILE)),
    runConfig: fileEvidence(join(runDir, RUN_CONFIG_FILE)),
    capsuleSnapshot: fileEvidence(join(runDir, CAPSULE_SNAPSHOT_FILE)),
    campaignSession: fileEvidence(join(runDir, CAMPAIGN_SESSION_FILE)),
    runtimePin: fileEvidence(join(runDir, RUNTIME_PIN_FILE)),
    optimizerComplete: fileEvidence(join(runDir, OPTIMIZER_COMPLETE_FILE)),
    brokerJournal: fileEvidence(join(runDir, BROKER_JOURNAL_FILE)),
    proxyTrace: fileEvidence(join(runDir, PROXY_TRACE_FILE)),
    dockerCreates: fileEvidence(join(runDir, DOCKER_CREATE_WAL)),
    dockerEngine: fileEvidence(join(runDir, DOCKER_ENGINE_SEAL)),
  };

  let state: RunState;
  try {
    state = replayRun(runDir);
  } catch (error) {
    drift.push(`event log is unreplayable: ${error instanceof Error ? error.message : String(error)}`);
    return finish("invalid", false, "run event log is corrupt", null);
  }
  evidence["run"] = {
    started: state.runId !== null,
    finished: state.finished === null ? null : { status: state.finished.status, at: state.finished.at },
    cursor: state.cursor,
    resumeCount: state.resumeCount,
    evalCount: state.evalCount,
    budgetExhaustedDimension: state.budgetExhaustedDimension,
    sealedOptimizerDigest: state.optimizerDigest,
  };
  if (state.runId === null) {
    // Minted but never acknowledged: run.started precedes every backend,
    // proxy, and broker launch, so nothing could have been spent.
    const reason = dispatch?.refusal ?? "run directory exists but no run.started was ever acknowledged";
    return finish("incomplete", false, reason, request.resume ? null : { ...ZERO_USAGE });
  }
  const usage: CalibrationUsage | null = state.lastBudget === null ? null : { ...state.lastBudget.spent };
  evidence["usage"] = usage;

  // Identity binding: the durable records must seal exactly the plan's fixed contract.
  if (state.runId !== request.runId) drift.push(`run.started run id ${state.runId} != ${request.runId}`);
  if (state.capsuleId !== cell.capsuleId) drift.push(`run.started capsule ${state.capsuleId} != ${cell.capsuleId}`);
  if (state.optimizerDigest !== plan.optimizerDigest) drift.push(`sealed optimizer digest ${state.optimizerDigest} != plan ${plan.optimizerDigest}`);
  const started = readEvents(runDir)[0];
  const sealedHash = started?.type === "run.started" ? started.campaignConfigHash : undefined;
  if (sealedHash !== plan.planDigest) drift.push(`run.started campaign seal ${sealedHash ?? "absent"} != plan digest`);
  const pinPath = join(runDir, RUNTIME_PIN_FILE);
  const pinned = existsSync(pinPath) ? readFileSync(pinPath, "utf8").trim() : null;
  if (pinned !== plan.runtimeDigest) drift.push(`runtime pin ${pinned ?? "absent"} != plan ${plan.runtimeDigest}`);
  try {
    if (plan.host === undefined || readDockerCgroupParent(runDir) !== plan.host.cgroupParent) {
      drift.push("Docker create journal lacks the plan's aggregate cgroup seal");
    }
  } catch (error) {
    drift.push(`Docker cgroup seal is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const engineSeal = readJson(join(runDir, DOCKER_ENGINE_SEAL)) as Record<string, unknown> | undefined;
  if (engineSeal?.["engineId"] !== plan.host?.dockerId || engineSeal?.["endpointKind"] !== "local-unix") {
    drift.push("Docker engine seal differs from the inspected native host");
  }
  const snapshot = CapsuleManifest.safeParse(readJson(join(runDir, CAPSULE_SNAPSHOT_FILE)));
  if (!snapshot.success) drift.push("capsule snapshot is missing or unparseable");
  else if (capsuleDigest(snapshot.data) !== task.manifestDigest || !sameCanonical(snapshot.data, task.manifest)) {
    drift.push(`capsule snapshot digest ${capsuleDigest(snapshot.data)} != plan task ${task.manifestDigest}`);
  }
  const storedConfig = RunConfig.safeParse(readJson(join(runDir, RUN_CONFIG_FILE)));
  if (!storedConfig.success) drift.push("stored run config is missing or unparseable");
  else if (!sameCanonical(storedConfig.data, expectedRunConfig(request))) {
    drift.push("stored run config deviates from the fixed calibration contract (budget/route/seed/apply/headless/backend)");
  }
  const contractError = resumeSealError({
    runId: request.runId, runDir, config: expectedRunConfig(request),
    manifest: task.manifest, capsuleDigest: task.manifestDigest,
    optimizerDigest: plan.optimizerDigest, orderingReport: task.orderingReport,
    deliveryTarget: null, sealedContractHash: state.contractHash, sealedOptimizerDigest: state.optimizerDigest,
  });
  if (contractError !== null) drift.push(contractError);
  const session = readJson(join(runDir, CAMPAIGN_SESSION_FILE));
  if (session === null || typeof session !== "object") drift.push("campaign session seal is missing");
  else {
    const seal = session as Record<string, unknown>;
    if (seal["campaignConfigHash"] !== plan.planDigest) drift.push("campaign session seal binds a foreign config hash");
    if (seal["proxyRole"] !== CALIBRATION_PROXY_ROLE) drift.push(`campaign session proxy role ${String(seal["proxyRole"])} != ${CALIBRATION_PROXY_ROLE}`);
    if (seal["authorityPath"] !== authorityPath) drift.push("campaign session pause authority path differs from the calibration authority");
    if (seal["corpusDigest"] !== undefined) drift.push("calibration run unexpectedly sealed a frozen corpus");
  }
  if (existsSync(join(runDir, "optimizer-artifact.json"))) drift.push("run selected a candidate optimizer artifact; calibration executes the default optimizer only");

  if (drift.length > 0) {
    return finish("invalid", false, `durable run records drifted from the fixed calibration contract: ${drift[0]}`, usage);
  }
  if (state.finished === null) {
    return finish("incomplete", true, "run has no durable terminal event; only a same-run resume may settle it", usage);
  }
  const terminal = state.finished.status;
  if (terminal === "failed") return finish("invalid", false, "run terminated failed", usage);
  if (terminal === "stopped") return finish("incomplete", false, "run was stopped before settlement; stopped runs never restart implicitly", usage);

  // completed | budget: every evidence file must be whole and every trace on the frozen route.
  if (eventLog === null || eventLog.tornTail) {
    drift.push("event log has a torn tail after a terminal event");
    return finish("invalid", false, "run event log is torn", usage);
  }
  let journal: BrokerJournalEvaluationSnapshot;
  try {
    journal = readBrokerJournalEvaluations(runDir);
  } catch (error) {
    drift.push(`broker journal unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return finish("invalid", false, "broker evidence is unavailable or torn", usage);
  }
  evidence["brokerJournal"] = { hash: journal.journalHash, lineCount: journal.lineCount, evaluations: journal.records.length };
  if (journal.measurementEpochs.some((epoch) => epoch !== measurementEpoch)) {
    drift.push("broker evaluations do not belong to this cell's sealed measurement epoch");
    return finish("invalid", false, "broker measurement epoch drifted", usage);
  }
  const tracePath = join(runDir, PROXY_TRACE_FILE);
  const traceBytes = existsSync(tracePath) ? readFileSync(tracePath) : Buffer.alloc(0);
  if (traceBytes.length > 0 && traceBytes[traceBytes.length - 1] !== 0x0a) {
    drift.push("proxy trace has a torn tail");
    return finish("invalid", false, "proxy trace is torn", usage);
  }
  const route = observeRoute(traceBytes);
  evidence["proxyTrace"] = {
    hash: existsSync(tracePath) ? sha256(traceBytes) : null,
    records: route.records,
    requestedRoutes: route.requestedRoutes,
    returnedModels: route.returnedModels,
    roles: route.roles,
  };
  if (route.error !== null) {
    drift.push(route.error);
    return finish("invalid", false, `provider route evidence drifted: ${route.error}`, usage);
  }

  const baseline = state.baselineArtifact;
  const selected = bestArtifact(state) ?? baseline;
  const assetGroupId = finalAssetGroupId(task.manifest);
  const finalEvaluation = selected === null || assetGroupId === null
    ? undefined
    : journal.records.filter((record) =>
      record.artifactHash === selected.hash
      && record.capsuleId === cell.capsuleId
      && record.assetGroupId === assetGroupId
      && record.seed === cell.seed).at(-1);
  if (selected === null) {
    drift.push("no trusted baseline or best artifact");
    return finish("invalid", false, "run has no trusted baseline or best artifact", usage);
  }
  if (finalEvaluation === undefined) {
    drift.push(`no trusted evaluation joins artifact ${selected.hash} at ${assetGroupId ?? "no group"}/seed ${cell.seed}`);
    return finish("invalid", false, "selected artifact has no trusted final evaluation at the cell coordinate", usage);
  }
  const parsedFinal = EvaluationRecord.parse(finalEvaluation);
  const objectives = Object.values(parsedFinal.output.objectives);
  const constraintsPass = Object.values(parsedFinal.output.constraints).every((value) => value === true);
  const scale = normalization(task.orderingReport);
  const objective = objectives.length === 1 ? objectives[0] : undefined;
  const qRaw = objective !== undefined && Number.isFinite(objective) ? objective : null;
  const final = {
    artifactHash: selected.hash,
    baselineArtifactHash: baseline?.hash ?? null,
    assetGroupId,
    seed: parsedFinal.seed,
    evaluationHash: sha256(canonicalJson(parsedFinal)),
    valid: parsedFinal.output.valid && constraintsPass && qRaw !== null,
    qRaw,
    qBase: scale?.qBase ?? null,
    scale: scale?.scale ?? null,
  };
  evidence["final"] = final;
  if (!final.valid || final.qRaw === null) {
    drift.push("final evaluation is invalid");
    return finish("invalid", false, "trusted final evaluation is invalid; invalid work is not measurable", usage);
  }
  if (scale === null) {
    drift.push("ordering report yields no positive normalization scale");
    return finish("invalid", false, "pinned ordering report yields no positive normalization scale", usage);
  }
  if (usage === null) {
    drift.push("terminal run carries no budget snapshot");
    return finish("invalid", false, "terminal run has no durable budget snapshot; spend is unknown", null);
  }
  const maxima = withinMaxima(usage, request.remainingBudget);
  if (maxima !== null) {
    drift.push(maxima);
    return finish("invalid", false, `spend exceeds the approved maxima: ${maxima}`, usage);
  }
  const gain = normalizedGain(final.qRaw, scale.qBase, scale.scale);
  return finish("valid", false, `run ${terminal}; final evaluation ${final.evaluationHash} normalized against the pinned ordering report`, usage, gain);
}


function withinMaxima(usage: CalibrationUsage, remaining: BudgetEnvelope): string | null {
  for (const [index, dimension] of USAGE_DIMENSIONS.entries()) {
    const budgetDimension = BUDGET_DIMENSIONS[index]!;
    const value = usage[dimension];
    if (!Number.isFinite(value) || value < 0) return `${dimension} spend ${value} is not a finite nonnegative number`;
    if (value > CALIBRATION_BUDGET[budgetDimension]) return `${dimension} spend ${value} exceeds the approved ${CALIBRATION_BUDGET[budgetDimension]}`;
    if (value > remaining[budgetDimension]) return `${dimension} spend ${value} exceeds the attempt envelope ${remaining[budgetDimension]}`;
  }
  return null;
}

function observeRoute(traceBytes: Buffer): {
  records: number;
  requestedRoutes: string[];
  returnedModels: string[];
  roles: string[];
  error: string | null;
} {
  const requested = new Set<string>();
  const returned = new Set<string>();
  const roles = new Set<string>();
  let records = 0;
  let error: string | null = null;
  const lines = traceBytes.length === 0 ? [] : traceBytes.toString("utf8").split("\n").filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    let trace: ProxyTraceRecord;
    try {
      trace = ProxyTraceRecord.parse(JSON.parse(line));
    } catch {
      error ??= `proxy trace line ${index + 1} is corrupt`;
      continue;
    }
    records++;
    roles.add(trace.role);
    requested.add(trace.model);
    if (trace.model !== CALIBRATION_ROUTE) error ??= `proxy requested ${trace.model} instead of ${CALIBRATION_ROUTE}`;
    if (trace.version === 2) {
      requested.add(trace.requestedRoute);
      if (trace.requestedRoute !== CALIBRATION_ROUTE) error ??= `proxy requested route ${trace.requestedRoute} instead of ${CALIBRATION_ROUTE}`;
      if (trace.returnedModel !== null) {
        returned.add(trace.returnedModel);
        if (trace.returnedModel !== CALIBRATION_ROUTE) error ??= `provider returned ${trace.returnedModel} for ${CALIBRATION_ROUTE}`;
      }
    }
  }
  return {
    records,
    requestedRoutes: [...requested].sort(),
    returnedModels: [...returned].sort(),
    roles: [...roles].sort(),
    error,
  };
}

/** Everything a dispatch needs to have re-proven before the supervisor is invoked. */
function assertDispatchContract(io: CmdIo, request: CalibrationRunRequest, snapshot: OptimizerSnapshot): { task: CalibrationTask; host: CalibrationHostBinding } {
  const { plan, cell, task } = request;
  for (const name of FORBIDDEN_ENV) {
    if (io.env[name] !== undefined) refuse(`${name} is set — calibration executes only the built-in local backend and the sealed default optimizer`);
  }
  if (plan.version !== "calibration-plan.v1") refuse(`unsupported plan version ${String(plan.version)}`);
  if (!SHA256_PATTERN.test(plan.planDigest)) refuse("plan digest is not sha256:<64 hex>");
  if (plan.concurrency !== 1) refuse("calibration runs exactly one active cell");
  if (!sameCanonical(plan.budget, CALIBRATION_BUDGET)) refuse("plan budget is not the approved per-cell envelope");
  if (!sameCanonical(plan.sandbox, CALIBRATION_SANDBOX)) refuse("plan sandbox is not the approved ceiling");
  if (plan.image !== pinnedImage(io.root)) refuse(`plan image ${plan.image} is not the pinned ${PINNED_IMAGE_CAPSULE} image`);
  const planCell = plan.cells.find((candidate) => candidate.key === cell.key);
  if (planCell === undefined || !sameCanonical(planCell, cell)) refuse(`cell ${cell.key} is not a plan cell`);
  if (!CALIBRATION_TASKS.includes(cell.task)) refuse(`cell task ${cell.task} is not a calibration task`);
  if (!(CALIBRATION_CAPS as readonly number[]).includes(cell.cap)) refuse(`cell cap ${cell.cap} is not an approved cap`);
  if (!(CALIBRATION_SEEDS as readonly number[]).includes(cell.seed)) refuse(`cell seed ${cell.seed} is not a matched seed`);
  const planTask = plan.tasks.find((candidate) => candidate.task === cell.task);
  if (planTask === undefined || !sameCanonical(planTask, task)) refuse(`task ${cell.task} is not the plan's task record`);
  if (task.admission !== "admitted") refuse(`${task.task} is an offline draft (${task.manifest.id}); drafts are never dispatched`);
  if (plan.host === undefined) refuse("production calibration requires a verified aggregate host resource binding");
  const currentHost = inspectCalibrationHost(plan.image, plan.host.cgroupParent, io.env);
  if (!sameCanonical(currentHost, plan.host)) refuse("selected-host resource/runtime binding drifted from the plan");
  if (task.manifest.id !== cell.capsuleId) refuse(`cell capsule ${cell.capsuleId} != task manifest ${task.manifest.id}`);
  if (deriveCapsuleId({ ...task.manifest }) !== task.manifest.id) refuse(`task manifest id ${task.manifest.id} does not recompute`);
  if (capsuleDigest(task.manifest) !== task.manifestDigest) refuse(`task manifest digest ${task.manifestDigest} does not recompute`);
  if (task.manifest.image !== plan.image) refuse(`${task.task} image ${task.manifest.image} != plan image ${plan.image}`);
  assertApprovedCeilings(task.manifest, task.task);
  if (normalization(task.orderingReport) === null) refuse(`${task.task} ordering report yields no positive normalization scale`);
  const envelope = BudgetEnvelopeSchema.safeParse(request.remainingBudget);
  if (!envelope.success) refuse("remaining budget is not a sealable envelope (every dimension must stay positive)");
  for (const dimension of BUDGET_DIMENSIONS) {
    if (request.remainingBudget[dimension] > CALIBRATION_BUDGET[dimension]) {
      refuse(`remaining ${dimension} ${request.remainingBudget[dimension]} exceeds the approved ${CALIBRATION_BUDGET[dimension]}`);
    }
  }
  if (!/^run_[a-zA-Z0-9_.-]+$/.test(request.runId)) refuse(`run id ${request.runId} is invalid`);

  // On-disk re-admission: the capsule that will execute must still be the
  // exact admitted bytes the plan froze, with a live Gate-2 receipt chain.
  const capsuleDir = join(io.root, "capsules", task.task);
  const admitted = admitCapsule(capsuleDir, { review: "required" });
  if (admitted.provisional) refuse(`${task.task} is only provisionally approved`);
  if (admitted.digest !== task.manifestDigest) refuse(`${task.task} drifted on disk: ${admitted.digest} != plan ${task.manifestDigest}`);
  if (!sameCanonical(admitted.orderingReport, task.orderingReport)) refuse(`${task.task} ordering report drifted on disk`);

  // Source binding: the SAME captured optimizer closure and trusted runtime for every cell and resume.
  const optimizerDigest = resolveOptimizerSnapshotDigest(io.env, plan.image, snapshot);
  if (optimizerDigest !== plan.optimizerDigest) refuse(`optimizer drift: ${optimizerDigest} != plan ${plan.optimizerDigest}`);
  const runtimeDigest = verifiedBootRuntimeDigest();
  if (runtimeDigest !== plan.runtimeDigest) refuse(`trusted runtime drift: ${runtimeDigest} != plan ${plan.runtimeDigest}`);
  return { task: { ...task, capsuleDir }, host: plan.host };
}

class ProductionCalibrationRunner implements CalibrationRunner {
  readonly mode = "trusted" as const;
  private snapshot: OptimizerSnapshot | null = null;

  constructor(private readonly io: CmdIo) {}

  private optimizerSnapshot(): OptimizerSnapshot {
    this.snapshot ??= collectOptimizerSnapshot();
    return this.snapshot;
  }

  private childIo(stderr: string[]): CmdIo {
    return {
      root: this.io.root,
      env: this.io.env,
      isTTY: false,
      out: () => {},
      err: (line) => {
        stderr.push(bounded(line));
        if (stderr.length > 16) stderr.shift();
      },
    };
  }

  async run(request: CalibrationRunRequest): Promise<CalibrationOutcome> {
    const snapshot = this.optimizerSnapshot();
    const { task, host } = assertDispatchContract(this.io, request, snapshot);
    const { plan, cell } = request;
    const authority = DurableCampaignPauseAuthorityV1.open(
      join(request.stateDir, CALIBRATION_PAUSE_AUTHORITY_FILE),
      plan.planDigest as `sha256:${string}`,
    );
    if (authority.isCampaignPaused()) {
      refuse("campaign provider policy is durably paused; only the trusted campaign resume coordinator may reopen admission");
    }
    const runDir = join(runsRoot(this.io.root), request.runId);
    const trusted = {
      runId: request.runId,
      measurementEpoch: calibrationMeasurementEpoch(plan.planDigest, cell.key),
      optimizerEpisodesMax: cell.cap,
      sandboxCgroupParent: host.cgroupParent,
      sandboxDockerEngineId: host.dockerId,
      maxPublicCandidateEvaluations: 2 * cell.cap,
      optimizerBaseSnapshot: snapshot,
      proxyRole: CALIBRATION_PROXY_ROLE,
      campaignPauseAuthority: authority,
      campaignConfigHash: plan.planDigest as `sha256:${string}`,
    };
    const stderr: string[] = [];

    if (!request.resume) {
      if (existsSync(runDir)) refuse(`run ${request.runId} already exists; a fresh dispatch never reconciles or restarts it`);
      const configPath = join(request.stateDir, `child-config-${request.runId}.json`);
      writeFileDurable(configPath, `${JSON.stringify({
        routing: { mutation: { model: CALIBRATION_ROUTE } },
        apply: "none",
        headless: true,
        seed: cell.seed,
        budget: request.remainingBudget,
      }, null, 2)}\n`);
      chmodSync(configPath, 0o600);
      const exitCode = await runCommand([task.capsuleDir, "--headless", "--config", configPath], this.childIo(stderr), trusted);
      return collect(this.io, request, { resume: false, exitCode, stderr, refusal: null });
    }

    if (!existsSync(runDir)) {
      return collect(this.io, request, { resume: true, exitCode: null, stderr, refusal: "resume requested but the run directory was never minted" });
    }
    let finished = false;
    let started = false;
    try {
      const state = replayRun(runDir);
      started = state.runId !== null;
      finished = state.finished !== null;
    } catch {
      return collect(this.io, request, { resume: true, exitCode: null, stderr, refusal: "resume requested but the durable state cannot be replayed" });
    }
    if (!started) {
      return collect(this.io, request, { resume: true, exitCode: null, stderr, refusal: "resume requested but the run never acknowledged run.started" });
    }
    if (finished) {
      return collect(this.io, request, { resume: true, exitCode: null, stderr, refusal: "run already terminal; reconciled without launch" });
    }
    const exitCode = await runCommand([task.capsuleDir, "--headless", "--resume"], this.childIo(stderr), trusted);
    return collect(this.io, request, { resume: true, exitCode, stderr, refusal: null });
  }

  async verify(request: CalibrationRunRequest, outcome: CalibrationOutcome): Promise<void> {
    const recorded = outcome.evidence["dispatch"];
    const dispatch = recorded === null || recorded === undefined ? null : parseDispatch(recorded);
    const recomputed = collect(this.io, request, dispatch);
    if (canonicalJson(recomputed) !== canonicalJson(outcome)) {
      refuse(`recorded outcome for ${request.cell.key} (${request.runId}) does not match the re-collected run evidence`);
    }
  }
}

function parseDispatch(value: unknown): CalibrationDispatchRecord {
  if (value === null || typeof value !== "object") refuse("recorded dispatch evidence is malformed");
  const record = value as Record<string, unknown>;
  const { resume, exitCode, stderr, refusal } = record;
  if (
    typeof resume !== "boolean"
    || !(exitCode === null || typeof exitCode === "number")
    || !Array.isArray(stderr) || !stderr.every((line) => typeof line === "string")
    || !(refusal === null || typeof refusal === "string")
    || Object.keys(record).length !== 4
  ) {
    refuse("recorded dispatch evidence is malformed");
  }
  return { resume, exitCode, stderr: stderr as string[], refusal };
}

/** Production runner: trusted mode only; every dispatch goes through the existing `runCommand` supervisor. */
export function createCalibrationRunner(io: CmdIo): CalibrationRunner {
  return new ProductionCalibrationRunner(io);
}
