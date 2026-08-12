import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { CasStore } from "@hone/broker";
import {
  normalizedGain,
  type MetaChildRunOutcome,
  type MetaChildRunRequest,
  type MetaResourceUsage,
  type MetaReservation,
  type MetaWorkIdentity,
  type Sha256Digest,
} from "@hone/meta";
import { selectSaturationCeiling, type SaturationCell } from "@hone/scoring";
import {
  BudgetEnvelope,
  DEFAULT_PROMOTION_RULE,
  M2_INNER_MODEL_ROUTE,
  M2_MODEL_ROUTING,
  M2_OUTER_MODEL_ROUTE,
  MetaCapsuleEntry,
  ProxyTraceRecord,
  canonicalJson,
  type BudgetEnvelope as BudgetEnvelopeValue,
  type MetaCapsuleEntry as MetaCapsuleEntryValue,
  type ProxyPreflightResult,
} from "@hone/schema";
import { createProxy, DEFAULT_UPSTREAM, type DurablePauseProxyHandle, type ProxyConfig } from "@hone/proxy";
import { z } from "zod";
import { admitCapsule, capsuleOracleDigest, capsuleScalarizerDigest, type AdmittedCapsule } from "../admission.js";
import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { EVENTS_FILE, readEvents, writeFileDurable } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { collectOptimizerSnapshot, type OptimizerSnapshot } from "../optimizer-digest.js";
import { resolveCandidateOptimizer } from "../optimizer-artifact.js";
import { casRoot, runsRoot } from "../runs.js";
import { verifiedBootRuntimeDigest } from "../runtime-digest.js";
import {
  CampaignModelRegistry,
  CliChildSupervisor,
  DurableCampaignPauseAuthorityV1,
  assertCleanSourceTree,
  captureSeedCandidate,
  coordinateCampaignResume,
  sourceCommit,
  type CapsuleLocation,
} from "./hone.js";

const CALIBRATION_USAGE =
  "usage: hone calibration --campaign <selection.json> --headless [--state <.hone-runs/path>] [--resume] [--dry-structure] [--smoke-cell N]";
const CAPS = [2, 4, 8, 12] as const;
const CELL_COUNT = 80;
const PRELIGHT_BUDGET = Object.freeze({ tokens: 4_096, usd: 1 });
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CALIBRATION_JOURNAL = "calibration-journal.ndjson";
const PLAN_FILE = "calibration-plan.json";
const PREFLIGHT_FILE = "preflight.json";
const REPORT_FILE = "saturation-report.json";

const CalibrationSelectionV1 = z.object({
  version: z.literal(1),
  capsuleDirs: z.array(z.string().min(1)).length(4),
  episodeCaps: z.array(z.number().int()).length(4),
  seeds: z.array(z.number().int().nonnegative().max(0xffff_ffff)).length(5),
  bootstrap: z.object({
    rngSeed: z.number().int().nonnegative().max(0xffff_ffff),
    samples: z.number().int().positive(),
  }).strict(),
  cellBudget: BudgetEnvelope.optional(),
}).strict();
export type CalibrationSelectionV1 = z.infer<typeof CalibrationSelectionV1>;

interface ImageIdentity {
  readonly reference: string;
  readonly id: string;
  readonly os: "linux";
  readonly architecture: "amd64";
}

interface PreparedCapsule {
  readonly dir: string;
  readonly admitted: AdmittedCapsule;
  readonly entry: MetaCapsuleEntryValue;
  readonly imageIdentity: ImageIdentity;
  readonly bundleDigest: Sha256Digest;
}

interface PreparedOptimizer {
  readonly sourceCommit: string;
  readonly trustedRuntimeDigest: Sha256Digest;
  readonly sourceArtifact: Sha256Digest;
  readonly baseSnapshot: OptimizerSnapshot;
  readonly bundleDigests: ReadonlyMap<string, Sha256Digest>;
}

export interface CalibrationPlanCell {
  readonly coordinate: number;
  readonly capsule: MetaCapsuleEntryValue;
  readonly capsuleDir: string;
  readonly cap: (typeof CAPS)[number];
  readonly seed: number;
  readonly budget: BudgetEnvelopeValue;
  readonly sourceArtifact: Sha256Digest;
  readonly bundleDigest: Sha256Digest;
  readonly workKey: Sha256Digest;
  readonly childRunId: string;
  readonly measurementEpoch: string;
}

export interface CalibrationPlanV1 {
  readonly version: 1;
  readonly configHash: Sha256Digest;
  readonly selection: {
    readonly capsuleIds: readonly string[];
    readonly episodeCaps: readonly number[];
    readonly seeds: readonly number[];
    readonly bootstrap: { readonly rngSeed: number; readonly samples: number };
  };
  readonly routes: {
    readonly outer: typeof M2_OUTER_MODEL_ROUTE;
    readonly inner: typeof M2_INNER_MODEL_ROUTE;
  };
  readonly source: {
    readonly commit: string;
    readonly trustedRuntimeDigest: Sha256Digest;
    readonly optimizerArtifact: Sha256Digest;
  };
  readonly capsules: readonly {
    readonly dir: string;
    readonly entry: MetaCapsuleEntryValue;
    readonly imageIdentity: ImageIdentity;
    readonly bundleDigest: Sha256Digest;
  }[];
  readonly cells: readonly CalibrationPlanCell[];
}

interface CalibrationDependencies {
  readonly admit?: typeof admitCapsule;
  readonly inspectImage?: (reference: string) => ImageIdentity;
  readonly prepareOptimizer?: (
    root: string,
    images: readonly string[],
  ) => Promise<PreparedOptimizer>;
  readonly createProxy?: (config: ProxyConfig) => DurablePauseProxyHandle;
  readonly createSupervisor?: (
    io: CmdIo,
    stateDir: string,
    capsules: ReadonlyMap<string, CapsuleLocation>,
    baseSnapshot: OptimizerSnapshot,
    modelRegistry: CampaignModelRegistry,
    authority: DurableCampaignPauseAuthorityV1,
    configHash: Sha256Digest,
  ) => Pick<CliChildSupervisor, "runLaunched">;
}

interface JournalRecord {
  readonly v: 1;
  readonly type: string;
  readonly coordinate?: number;
  readonly attempt?: 0 | 1;
  readonly request?: MetaChildRunRequest;
  readonly outcome?: MetaChildRunOutcome;
  readonly status?: SaturationCell["status"];
  readonly normalizedGain?: number;
  readonly at: string;
}

function sha256(value: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactDistinct<T>(values: readonly T[], expected: readonly T[], label: string): T[] {
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(sorted).size !== expected.length || canonicalJson(sorted) !== canonicalJson(expected)) {
    throw new UsageError(`${label} must contain exactly ${expected.join(", ")} with no duplicates`);
  }
  return sorted;
}

function distinctSeeds(values: readonly number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);
  if (new Set(sorted).size !== 5) throw new UsageError("calibration seeds must be five distinct explicit uint32 integers");
  return sorted;
}

function resolveCapsuleDirectory(root: string, candidate: string): string {
  const capsuleRoot = resolve(root, "capsules");
  const resolved = resolve(root, candidate);
  if (dirname(resolved) !== capsuleRoot || relative(capsuleRoot, resolved).includes(sep)) {
    throw new UsageError(`calibration capsule directory must be a direct child of ${capsuleRoot}: ${candidate}`);
  }
  return resolved;
}

function defaultInspectImage(reference: string): ImageIdentity {
  let raw: string;
  try {
    raw = execFileSync(
      "docker",
      ["image", "inspect", reference, "--format", "{{json .}}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    );
  } catch (error) {
    throw new UsageError(`calibration image ${reference} is not locally inspectable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const inspected = z.object({
    Id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    Os: z.literal("linux"),
    Architecture: z.literal("amd64"),
    RepoDigests: z.array(z.string()).nullable().optional(),
  }).passthrough().parse(JSON.parse(raw));
  if (!(inspected.RepoDigests ?? []).includes(reference)) {
    throw new UsageError(`calibration image inspect did not resolve the exact manifest reference ${reference}`);
  }
  try {
    execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "--platform", "linux/amd64", reference, "python3", "-I", "-B", "-c", "import platform; assert platform.machine() == 'x86_64'"],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 },
    );
  } catch (error) {
    throw new UsageError(`calibration image ${reference} failed native AMD64 startup: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { reference, id: inspected.Id, os: inspected.Os, architecture: inspected.Architecture };
}

async function defaultPrepareOptimizer(root: string, images: readonly string[]): Promise<PreparedOptimizer> {
  assertCleanSourceTree(root);
  const commit = sourceCommit(root);
  const runtimeDigest = verifiedBootRuntimeDigest() as Sha256Digest;
  const baseSnapshot = collectOptimizerSnapshot(root);
  const cas = new CasStore(casRoot(root));
  const seed = await captureSeedCandidate(root, cas);
  const bundleDigests = new Map<string, Sha256Digest>();
  for (const image of [...new Set(images)].sort()) {
    const resolved = await resolveCandidateOptimizer({
      casDir: casRoot(root),
      artifactHash: seed.artifactHash,
      image,
      baseSnapshot,
    });
    bundleDigests.set(image, resolved.mergedDigest as Sha256Digest);
  }
  return {
    sourceCommit: commit,
    trustedRuntimeDigest: runtimeDigest,
    sourceArtifact: seed.artifactHash,
    baseSnapshot,
    bundleDigests,
  };
}

function componentwiseBudget(
  selected: BudgetEnvelopeValue | undefined,
  capsule: AdmittedCapsule,
): BudgetEnvelopeValue {
  const budget = selected ?? capsule.manifest.budget;
  for (const dimension of ["maxTokens", "maxUsd", "maxWallClockSec", "maxEvaluatorInvocations"] as const) {
    if (budget[dimension] > capsule.manifest.budget[dimension]) {
      throw new UsageError(`calibration cell budget ${dimension}=${budget[dimension]} exceeds capsule ${capsule.manifest.id} ceiling ${capsule.manifest.budget[dimension]}`);
    }
  }
  return budget;
}

export async function buildCalibrationPlan(
  root: string,
  selectionInput: unknown,
  dependencies: CalibrationDependencies = {},
): Promise<{ readonly plan: CalibrationPlanV1; readonly optimizer: PreparedOptimizer; readonly prepared: readonly PreparedCapsule[] }> {
  const selection = CalibrationSelectionV1.parse(selectionInput);
  const caps = exactDistinct(selection.episodeCaps, CAPS, "calibration episode caps") as Array<(typeof CAPS)[number]>;
  const seeds = distinctSeeds(selection.seeds);
  const capsuleDirs = selection.capsuleDirs.map((dir) => resolveCapsuleDirectory(root, dir));
  if (new Set(capsuleDirs).size !== 4) throw new UsageError("calibration capsule directories must be four distinct paths");

  const admit = dependencies.admit ?? admitCapsule;
  const inspectImage = dependencies.inspectImage ?? defaultInspectImage;
  const admitted = capsuleDirs.map((dir) => ({ dir, admitted: admit(dir, { review: "required" }) }));
  if (new Set(admitted.map(({ admitted: item }) => item.manifest.id)).size !== 4) {
    throw new UsageError("calibration capsules must have four distinct real content-addressed identities");
  }
  for (const { admitted: item } of admitted) {
    if (item.provisional || item.approval === null) throw new UsageError(`calibration capsule ${item.manifest.id} lacks non-provisional Gate-2 approval`);
    if (item.manifest.assetGroups.some((group) => group.visibility === "holdout")) {
      throw new UsageError(`calibration capsule ${item.manifest.id} must not expose terminal holdout assets`);
    }
    if (item.manifest.image.includes("bun-module-loader")) {
      throw new UsageError(`calibration capsule ${item.manifest.id} cannot admit the Bun runtime digest`);
    }
  }

  const optimizer = await (dependencies.prepareOptimizer ?? defaultPrepareOptimizer)(
    root,
    admitted.map(({ admitted: item }) => item.manifest.image),
  );
  const prepared = admitted.map(({ dir, admitted: item }): PreparedCapsule => {
    const baseline = item.orderingReport.variants.baseline.train;
    const reference = item.orderingReport.variants.improved.train;
    const entry = MetaCapsuleEntry.parse({
      capsuleId: item.manifest.id,
      capsuleDigest: item.digest,
      image: item.manifest.image,
      oracleDigest: capsuleOracleDigest(item),
      scalarizerDigest: capsuleScalarizerDigest(item),
      qFail: 0,
      qBase: baseline,
      qReference: reference,
      scale: reference - baseline,
    });
    const bundleDigest = optimizer.bundleDigests.get(item.manifest.image);
    if (bundleDigest === undefined) throw new UsageError(`optimizer bundle identity missing for ${item.manifest.image}`);
    return { dir, admitted: item, entry, imageIdentity: inspectImage(item.manifest.image), bundleDigest };
  }).sort((left, right) => left.entry.capsuleId.localeCompare(right.entry.capsuleId));

  const frozenBody = {
    version: 1,
    selection: {
      capsuleIds: prepared.map(({ entry }) => entry.capsuleId),
      episodeCaps: caps,
      seeds,
      bootstrap: selection.bootstrap,
    },
    routes: { outer: M2_OUTER_MODEL_ROUTE, inner: M2_INNER_MODEL_ROUTE },
    source: {
      commit: optimizer.sourceCommit,
      trustedRuntimeDigest: optimizer.trustedRuntimeDigest,
      optimizerArtifact: optimizer.sourceArtifact,
    },
    capsules: prepared.map(({ dir, entry, imageIdentity, bundleDigest }) => ({
      dir: relative(root, dir),
      entry,
      imageIdentity,
      bundleDigest,
      budget: componentwiseBudget(selection.cellBudget, prepared.find((candidate) => candidate.dir === dir)!.admitted),
    })),
  } as const;
  const configHash = sha256(canonicalJson(frozenBody));
  const cells: CalibrationPlanCell[] = [];
  for (const capsule of prepared) {
    for (const cap of caps) {
      for (const seed of seeds) {
        const coordinate = cells.length;
        const coordinateIdentity = { configHash, capsuleId: capsule.entry.capsuleId, cap, seed };
        const coordinateHash = sha256(canonicalJson(coordinateIdentity));
        cells.push({
          coordinate,
          capsule: capsule.entry,
          capsuleDir: relative(root, capsule.dir),
          cap,
          seed,
          budget: componentwiseBudget(selection.cellBudget, capsule.admitted),
          sourceArtifact: optimizer.sourceArtifact,
          bundleDigest: capsule.bundleDigest,
          workKey: coordinateHash,
          childRunId: `run_calibration_${coordinateHash.slice("sha256:".length, "sha256:".length + 24)}`,
          measurementEpoch: `m2-calibration:${coordinateHash.slice("sha256:".length)}`,
        });
      }
    }
  }
  if (cells.length !== CELL_COUNT) throw new UsageError(`calibration planner produced ${cells.length} cells instead of ${CELL_COUNT}`);
  return {
    plan: {
      version: 1,
      configHash,
      selection: frozenBody.selection,
      routes: frozenBody.routes,
      source: frozenBody.source,
      capsules: frozenBody.capsules.map(({ budget: _budget, ...capsule }) => capsule),
      cells,
    },
    optimizer,
    prepared,
  };
}

function stateDirectory(root: string, flag: string | undefined, configHash: Sha256Digest): string {
  const selected = flag === undefined
    ? join(runsRoot(root), `m2-calibration-${configHash.slice("sha256:".length, "sha256:".length + 24)}`)
    : resolve(root, flag);
  const runs = resolve(runsRoot(root));
  const rel = relative(runs, selected);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || resolve(selected) === runs) {
    throw new UsageError("calibration state directory must be a child of the trusted .hone-runs directory");
  }
  return selected;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function appendJournal(path: string, record: JournalRecord): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeAll(fd, Buffer.from(`${canonicalJson(record)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function readJournal(path: string): JournalRecord[] {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path);
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    throw new UsageError("calibration journal has a torn tail; refuse ambiguous resume");
  }
  return bytes.toString("utf8").split("\n").filter(Boolean).map((line, index) => {
    try {
      const parsed = JSON.parse(line) as JournalRecord;
      if (parsed.v !== 1 || typeof parsed.type !== "string" || typeof parsed.at !== "string") throw new Error("invalid record");
      return parsed;
    } catch (error) {
      throw new UsageError(`calibration journal record ${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function remainingBudget(reserved: BudgetEnvelopeValue, usage: MetaResourceUsage): BudgetEnvelopeValue {
  return {
    maxTokens: Math.max(0, reserved.maxTokens - usage.tokens),
    maxUsd: Math.max(0, reserved.maxUsd - usage.usd),
    maxWallClockSec: Math.max(0, reserved.maxWallClockSec - usage.wallClockSec),
    maxEvaluatorInvocations: Math.max(0, reserved.maxEvaluatorInvocations - usage.evaluatorInvocations),
  };
}

function saturationResult(cell: CalibrationPlanCell, outcome: MetaChildRunOutcome): SaturationCell {
  if (outcome.status !== "completed" || outcome.finalEvaluation === null) {
    return {
      capsuleId: cell.capsule.capsuleId,
      cap: cell.cap,
      seed: cell.seed,
      status: outcome.status === "candidate_failed" ? "invalid" : "incomplete",
    };
  }
  const constraintsPass = Object.values(outcome.finalEvaluation.output.constraints).every((value) => value === true);
  const objectives = Object.values(outcome.finalEvaluation.output.objectives);
  if (!outcome.finalEvaluation.output.valid || !constraintsPass || objectives.length !== 1 || !Number.isFinite(objectives[0])) {
    return { capsuleId: cell.capsule.capsuleId, cap: cell.cap, seed: cell.seed, status: "invalid" };
  }
  return {
    capsuleId: cell.capsule.capsuleId,
    cap: cell.cap,
    seed: cell.seed,
    status: "valid",
    normalizedGain: normalizedGain(objectives[0]!, cell.capsule.qBase, cell.capsule.scale),
  };
}

function cellRequest(
  cell: CalibrationPlanCell,
  plan: CalibrationPlanV1,
  attempt: 0 | 1,
  priorSpend: MetaResourceUsage,
  resume: boolean,
): MetaChildRunRequest {
  const identity: MetaWorkIdentity = {
    phase: "search",
    arm: "seed",
    capsuleId: cell.capsule.capsuleId,
    replicate: cell.seed,
    measurementEpoch: cell.measurementEpoch,
    sourceArtifact: cell.sourceArtifact,
    bundleDigest: cell.bundleDigest,
  };
  const reservation: MetaReservation = {
    configHash: plan.configHash,
    workKey: cell.workKey,
    childRunId: cell.childRunId,
    identity,
    reserved: cell.budget,
    envelope: null,
  };
  return {
    identity,
    reservation,
    sourceArtifact: cell.sourceArtifact,
    bundleDigest: cell.bundleDigest,
    capsule: cell.capsule,
    innerEpisodesMax: cell.cap,
    requestedModel: M2_INNER_MODEL_ROUTE,
    remainingBudget: remainingBudget(cell.budget, priorSpend),
    attempt,
    resume,
  };
}

async function preflightIdentityEvidence(root: string, proxyDir: string): Promise<unknown[]> {
  const tracePath = join(proxyDir, "proxy-trace.ndjson");
  if (!existsSync(tracePath)) return [];
  const cas = new CasStore(casRoot(root));
  const evidence: unknown[] = [];
  for (const line of readFileSync(tracePath, "utf8").split("\n").filter(Boolean)) {
    const trace = ProxyTraceRecord.parse(JSON.parse(line));
    let responseId: string | null = null;
    let providerFingerprint: string | null = null;
    let bodyModel: string | null = null;
    try {
      const body = JSON.parse((await cas.readBuffer(trace.responseBody)).toString("utf8")) as Record<string, unknown>;
      responseId = typeof body["id"] === "string" ? body["id"] : null;
      providerFingerprint = typeof body["system_fingerprint"] === "string" ? body["system_fingerprint"] : null;
      bodyModel = typeof body["model"] === "string" ? body["model"] : null;
    } catch {
      // The response body hash and status remain durable even for a non-JSON provider failure.
    }
    const requestedRoute = trace.version === 2 ? trace.requestedRoute : trace.model;
    const returnedModel = trace.version === 2 ? trace.returnedModel : bodyModel;
    const identity = { requestedRoute, returnedModel, providerFingerprint };
    evidence.push({
      role: trace.role,
      requestedRoute,
      returnedModel,
      responseId,
      providerFingerprint,
      driftSentinel: returnedModel === requestedRoute ? `stable:${sha256(canonicalJson(identity))}` : `drift:${sha256(canonicalJson(identity))}`,
      responseBodyHash: trace.responseBody,
      status: trace.status,
      usage: trace.usage,
      estimatedUsd: trace.estimatedUsd,
    });
  }
  return evidence;
}

async function runPreflight(
  root: string,
  stateDir: string,
  plan: CalibrationPlanV1,
  authority: DurableCampaignPauseAuthorityV1,
  env: NodeJS.ProcessEnv,
  resume: boolean,
  create: (config: ProxyConfig) => DurablePauseProxyHandle,
): Promise<ProxyPreflightResult> {
  const runId = `run_calibration_preflight_${plan.configHash.slice("sha256:".length, "sha256:".length + 24)}`;
  const proxyDir = join(stateDir, "preflight-proxy");
  mkdirSync(proxyDir, { recursive: true, mode: 0o700 });
  let recoveryComplete = false;
  let recoverySpend = { tokens: 0, usd: 0 };
  const spend = { tokens: 0, usd: 0 };
  const proxy = create({
    runId,
    routing: M2_MODEL_ROUTING,
    runDir: proxyDir,
    casDir: casRoot(root),
    upstreamBaseUrl: env["HONE_UPSTREAM_BASE_URL"] ?? DEFAULT_UPSTREAM,
    ...(env["HONE_UPSTREAM_API_KEY"] === undefined ? {} : { upstreamApiKey: env["HONE_UPSTREAM_API_KEY"] }),
    checkBudget: () => ({
      allowed: true,
      remaining: {
        tokens: Math.max(0, PRELIGHT_BUDGET.tokens - recoverySpend.tokens - spend.tokens),
        usd: Math.max(0, PRELIGHT_BUDGET.usd - recoverySpend.usd - spend.usd),
      },
    }),
    recordSpend: (settled) => {
      if (!recoveryComplete) return;
      spend.tokens += settled.tokens;
      spend.usd += settled.usd;
    },
    captureCampaignDispatchFence: () => authority.captureCampaignDispatchFence(),
    validateCampaignDispatchFence: (epoch, validation) => authority.validateCampaignDispatchFence(epoch, validation),
    recordCampaignPause: (signal) => authority.recordCampaignPause(signal),
    recordCampaignResume: (signal) => authority.recordCampaignResume(signal),
  });
  try {
    const recovery = await proxy.dispatchRecovery();
    if (recovery.poisoned !== undefined) throw new UsageError(`calibration preflight journal is poisoned: ${recovery.poisoned}`);
    recoverySpend = recovery.chargedTotals;
    recoveryComplete = true;
    const result = resume ? await proxy.resume() : await proxy.preflight();
    const evidence = {
      version: 1,
      configHash: plan.configHash,
      requestedRoutes: { outer: M2_OUTER_MODEL_ROUTE, inner: M2_INNER_MODEL_ROUTE },
      result,
      usage: {
        recovered: recoverySpend,
        current: spend,
        total: { tokens: recoverySpend.tokens + spend.tokens, usd: recoverySpend.usd + spend.usd },
      },
      identities: await preflightIdentityEvidence(root, proxyDir),
    };
    writeFileDurable(join(stateDir, PREFLIGHT_FILE), `${canonicalJson(evidence)}\n`);
    chmodSync(join(stateDir, PREFLIGHT_FILE), 0o600);
    return result;
  } finally {
    await proxy.close();
  }
}

function writeCellEvidence(root: string, stateDir: string, cell: CalibrationPlanCell, records: readonly JournalRecord[]): void {
  const attempts = records.filter((record) => record.coordinate === cell.coordinate && record.outcome !== undefined);
  const terminal = [...attempts].reverse().find((record) => record.type === "attempt-terminal");
  if (terminal?.outcome === undefined) return;
  const executionRunId = terminal.attempt === 1 ? `${cell.childRunId}.retry1` : cell.childRunId;
  const runDir = join(runsRoot(root), executionRunId);
  const events = existsSync(join(runDir, EVENTS_FILE)) ? readEvents(runDir) : [];
  let usage = zeroUsage();
  let bestNormalizedGain: number | null = null;
  const trustedEvents = events.map((event, cursor) => {
    if (event.type === "budget.snapshot" || event.type === "probe.completed") usage = { ...event.budget.spent };
    if (event.type === "eval.completed") {
      const gain = normalizedGain(event.aggregate, cell.capsule.qBase, cell.capsule.scale);
      bestNormalizedGain = bestNormalizedGain === null ? gain : Math.max(bestNormalizedGain, gain);
    }
    return {
      cursor,
      event,
      usage: { ...usage },
      remaining: remainingBudget(cell.budget, usage),
      ...(event.type === "eval.completed"
        ? {
            normalizedGain: normalizedGain(event.aggregate, cell.capsule.qBase, cell.capsule.scale),
            bestNormalizedGain,
          }
        : {}),
    };
  });
  const anytimeCurve = trustedEvents.filter(({ event }) =>
    event.type === "eval.completed"
    || event.type === "episode.invalid"
    || event.type === "budget.snapshot"
    || event.type === "run.finished"
  );
  const output = {
    version: 1,
    coordinate: cell.coordinate,
    identity: cell,
    attempts: attempts.map(({ at, attempt, type, outcome }) => ({ at, attempt, type, outcome })),
    terminal: {
      status: terminal.status,
      normalizedGain: terminal.normalizedGain,
      usage: terminal.outcome.spend,
      remaining: remainingBudget(cell.budget, terminal.outcome.spend),
      responseModel: terminal.outcome.responseModel,
      providerFingerprint: terminal.outcome.providerFingerprint,
      modelDriftSentinel: terminal.outcome.modelDriftSentinel,
    },
    anytimeEvidence: {
      eventLogPath: relative(stateDir, join(runDir, EVENTS_FILE)),
      eventLogHash: terminal.outcome.eventLogHash,
      brokerJournalHash: terminal.outcome.brokerJournalHash,
      proxyTraceHash: terminal.outcome.proxyTraceHash,
      trustedEvents,
      anytimeCurve,
    },
  };
  const cellsDir = join(stateDir, "cells");
  mkdirSync(cellsDir, { recursive: true, mode: 0o700 });
  const path = join(cellsDir, `${String(cell.coordinate).padStart(2, "0")}.json`);
  writeFileDurable(path, `${canonicalJson(output)}\n`);
  chmodSync(path, 0o600);
}

function acquireCoordinatorLock(stateDir: string): () => void {
  const path = join(stateDir, "coordinator.lock");
  try {
    const fd = openSync(path, "wx", 0o600);
    writeAll(fd, Buffer.from(`${process.pid}\n`, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    throw new UsageError(`calibration coordinator is already active or its lock needs owner recovery: ${error instanceof Error ? error.message : String(error)}`);
  }
  return () => rmSync(path, { force: true });
}

function zeroUsage(): MetaResourceUsage {
  return { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
}

function lastTerminalOutcome(records: readonly JournalRecord[], coordinate: number, attempt: 0 | 1): MetaChildRunOutcome | undefined {
  return [...records].reverse().find((record) =>
    record.type === "attempt-terminal"
    && record.coordinate === coordinate
    && record.attempt === attempt
    && record.outcome !== undefined,
  )?.outcome;
}

function attemptIsOpen(records: readonly JournalRecord[], coordinate: number, attempt: 0 | 1): boolean {
  const latest = [...records].reverse().find((record) =>
    record.coordinate === coordinate
    && record.attempt === attempt
    && (record.type === "attempt-started" || record.type === "attempt-terminal"),
  );
  return latest?.type === "attempt-started";
}

export async function calibrationCommand(
  args: string[],
  io: CmdIo,
  dependencies: CalibrationDependencies = {},
): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "resume", "dry-structure"],
    strings: ["campaign", "state", "smoke-cell"],
  });
  if (positionals.length !== 0 || !boolFlag(flags, "headless")) throw new UsageError(CALIBRATION_USAGE);
  const campaignFlag = strFlag(flags, "campaign");
  if (campaignFlag === undefined) throw new UsageError(CALIBRATION_USAGE);
  const campaignPath = resolve(io.root, campaignFlag);
  const selection = JSON.parse(readFileSync(campaignPath, "utf8")) as unknown;
  const { plan, optimizer, prepared } = await buildCalibrationPlan(io.root, selection, dependencies);
  const stateDir = stateDirectory(io.root, strFlag(flags, "state"), plan.configHash);
  const resume = boolFlag(flags, "resume");
  const dryStructure = boolFlag(flags, "dry-structure");
  const smokeFlag = strFlag(flags, "smoke-cell");
  const smokeCell = smokeFlag === undefined ? undefined : Number(smokeFlag);
  if (smokeCell !== undefined && (!Number.isInteger(smokeCell) || smokeCell < 0 || smokeCell >= CELL_COUNT)) {
    throw new UsageError("--smoke-cell must select one coordinate from 0 through 79");
  }
  if (dryStructure && (resume || smokeCell !== undefined)) throw new UsageError("--dry-structure cannot be combined with --resume or --smoke-cell");

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const planPath = join(stateDir, PLAN_FILE);
  if (existsSync(planPath)) {
    const frozen = JSON.parse(readFileSync(planPath, "utf8"));
    if (canonicalJson(frozen) !== canonicalJson(plan)) throw new UsageError("calibration state belongs to a different selection or frozen identity set");
    if (!resume && !dryStructure) throw new UsageError("calibration state already exists; pass --resume to continue the exact frozen selection");
  } else {
    writeFileDurable(planPath, `${canonicalJson(plan)}\n`);
    chmodSync(planPath, 0o600);
  }

  if (dryStructure) {
    const dry = {
      version: 1,
      configHash: plan.configHash,
      cells: plan.cells.length,
      coordinates: plan.cells.map(({ coordinate, capsule, cap, seed, budget, childRunId }) => ({
        coordinate,
        capsuleId: capsule.capsuleId,
        cap,
        seed,
        budget,
        childRunId,
      })),
      modelCalls: 0,
    };
    writeFileDurable(join(stateDir, "dry-structure.json"), `${canonicalJson(dry)}\n`);
    io.out(canonicalJson({ type: "calibration-dry-structure", stateDir, configHash: plan.configHash, cells: CELL_COUNT, modelCalls: 0 }));
    return 0;
  }

  const release = acquireCoordinatorLock(stateDir);
  try {
    const authorityPath = join(stateDir, "campaign-pause.v1.json");
    const authority = DurableCampaignPauseAuthorityV1.open(authorityPath, plan.configHash);
    const create = dependencies.createProxy ?? createProxy;
    if (authority.isCampaignPaused()) {
      if (!resume) throw new UsageError("calibration is durably paused; pass --resume for trusted frozen-route preflight");
      for (const pause of authority.activePauses()) {
        if (pause.runId.startsWith("run_calibration_preflight_")) {
          const result = await runPreflight(io.root, stateDir, plan, authority, io.env, true, create);
          if (!result.passed) throw new UsageError("calibration remains paused because frozen-route preflight failed");
        } else {
          const result = await coordinateCampaignResume({ authorityPath, pauseId: pause.pauseId, root: io.root, env: io.env });
          if (!result.preflight.passed) throw new UsageError("calibration remains paused because child frozen-route preflight failed");
        }
      }
    }
    if (!existsSync(join(stateDir, PREFLIGHT_FILE))) {
      const result = await runPreflight(io.root, stateDir, plan, authority, io.env, false, create);
      if (!result.passed || authority.isCampaignPaused()) throw new UsageError("calibration preflight failed; no cell was admitted");
    }

    const capsuleLocations = new Map<string, CapsuleLocation>(prepared.map(({ dir, admitted }) => [
      admitted.digest,
      { dir, digest: admitted.digest, terminalHoldoutAssetGroupIds: [] },
    ]));
    const modelRegistry = new CampaignModelRegistry(stateDir, plan.configHash, io.root);
    const supervisor = dependencies.createSupervisor?.(
      io,
      stateDir,
      capsuleLocations,
      optimizer.baseSnapshot,
      modelRegistry,
      authority,
      plan.configHash,
    ) ?? new CliChildSupervisor(
      io,
      { promotion: DEFAULT_PROMOTION_RULE, proxyRole: "inner-capsule-improvement", campaignConfigHash: plan.configHash },
      stateDir,
      capsuleLocations,
      optimizer.baseSnapshot,
      modelRegistry,
      authority,
    );
    const journalPath = join(stateDir, CALIBRATION_JOURNAL);
    let records = readJournal(journalPath);
    const selectedCells = smokeCell === undefined ? plan.cells : [plan.cells[smokeCell]!];
    for (const cell of selectedCells) {
      const alreadyTerminal = [...records].reverse().find((record) => record.coordinate === cell.coordinate && record.type === "cell-terminal");
      if (alreadyTerminal !== undefined) continue;
      let attempt: 0 | 1 = 0;
      let spend = zeroUsage();
      const attemptZero = lastTerminalOutcome(records, cell.coordinate, 0);
      if (attemptZero !== undefined) {
        spend = attemptZero.spend;
        if (attemptZero.status === "infrastructure_not_run") attempt = 1;
      }
      const prior = lastTerminalOutcome(records, cell.coordinate, attempt);
      const openAttempt = attemptIsOpen(records, cell.coordinate, attempt);
      let outcome = prior;
      if (outcome === undefined) {
        const request = cellRequest(cell, plan, attempt, spend, openAttempt);
        if (!openAttempt) appendJournal(journalPath, { v: 1, type: "attempt-started", coordinate: cell.coordinate, attempt, request, at: new Date().toISOString() });
        outcome = await supervisor.runLaunched(request, plan.configHash);
        if (authority.isCampaignPaused()) {
          appendJournal(journalPath, { v: 1, type: "attempt-paused", coordinate: cell.coordinate, attempt, request, outcome, at: new Date().toISOString() });
          throw new UsageError(`calibration paused during cell ${cell.coordinate}; resume requires frozen-route preflight`);
        }
        appendJournal(journalPath, { v: 1, type: "attempt-terminal", coordinate: cell.coordinate, attempt, request, outcome, at: new Date().toISOString() });
        records = readJournal(journalPath);
      }
      if (outcome.status === "infrastructure_not_run" && attempt === 0) {
        const retryRequest = cellRequest(cell, plan, 1, outcome.spend, false);
        appendJournal(journalPath, { v: 1, type: "attempt-started", coordinate: cell.coordinate, attempt: 1, request: retryRequest, at: new Date().toISOString() });
        const retry = await supervisor.runLaunched(retryRequest, plan.configHash);
        if (authority.isCampaignPaused()) {
          appendJournal(journalPath, { v: 1, type: "attempt-paused", coordinate: cell.coordinate, attempt: 1, request: retryRequest, outcome: retry, at: new Date().toISOString() });
          throw new UsageError(`calibration paused during cell ${cell.coordinate} retry; resume requires frozen-route preflight`);
        }
        appendJournal(journalPath, { v: 1, type: "attempt-terminal", coordinate: cell.coordinate, attempt: 1, request: retryRequest, outcome: retry, at: new Date().toISOString() });
        records = readJournal(journalPath);
      }
      const finalOutcome = lastTerminalOutcome(records, cell.coordinate, 1) ?? lastTerminalOutcome(records, cell.coordinate, 0);
      if (finalOutcome === undefined) throw new UsageError(`calibration cell ${cell.coordinate} has no durable terminal outcome`);
      const scorerCell = saturationResult(cell, finalOutcome);
      appendJournal(journalPath, {
        v: 1,
        type: "cell-terminal",
        coordinate: cell.coordinate,
        status: scorerCell.status,
        ...(scorerCell.status === "valid" ? { normalizedGain: scorerCell.normalizedGain } : {}),
        at: new Date().toISOString(),
      });
      records = readJournal(journalPath);
      writeCellEvidence(io.root, stateDir, cell, records);
      const terminalCount = records.filter((record) => record.type === "cell-terminal").length;
      if ([20, 40, 60, 80].includes(terminalCount)) {
        io.out(canonicalJson({ type: "calibration-progress", configHash: plan.configHash, completed: terminalCount, total: CELL_COUNT }));
      }
    }

    records = readJournal(journalPath);
    const terminalByCoordinate = new Map<number, JournalRecord>();
    for (const record of records) {
      if (record.type === "cell-terminal" && record.coordinate !== undefined) terminalByCoordinate.set(record.coordinate, record);
    }
    if (smokeCell !== undefined) {
      const terminal = terminalByCoordinate.get(smokeCell);
      io.out(canonicalJson({ type: "calibration-smoke-cell", configHash: plan.configHash, coordinate: smokeCell, terminal }));
      return terminal === undefined ? 1 : 0;
    }
    if (terminalByCoordinate.size !== CELL_COUNT) throw new UsageError(`calibration scoring refused: ${terminalByCoordinate.size}/${CELL_COUNT} cells are terminal`);
    const cells = plan.cells.map<SaturationCell>((cell) => {
      const terminal = terminalByCoordinate.get(cell.coordinate);
      if (terminal?.status === "valid" && terminal.normalizedGain !== undefined) {
        return { capsuleId: cell.capsule.capsuleId, cap: cell.cap, seed: cell.seed, status: "valid", normalizedGain: terminal.normalizedGain };
      }
      if (terminal?.status === "invalid") return { capsuleId: cell.capsule.capsuleId, cap: cell.cap, seed: cell.seed, status: "invalid" };
      return { capsuleId: cell.capsule.capsuleId, cap: cell.cap, seed: cell.seed, status: "incomplete" };
    });
    const report = selectSaturationCeiling(cells, {
      rngSeed: plan.selection.bootstrap.rngSeed,
      bootstrapSamples: plan.selection.bootstrap.samples,
    });
    const reportPath = join(stateDir, REPORT_FILE);
    writeFileDurable(reportPath, `${canonicalJson(report)}\n`);
    chmodSync(reportPath, 0o600);
    const reportDigest = sha256(canonicalJson(report));
    io.out(canonicalJson({
      type: "calibration-complete",
      configHash: plan.configHash,
      reportPath,
      reportDigest,
      selectedCeiling: report.selectedCeiling,
      selectionReason: report.selectionReason,
    }));
    return 0;
  } finally {
    release();
  }
}
