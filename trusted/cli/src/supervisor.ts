import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApplyMode, BudgetEnvelope, M2ProxyRole, ModelRouting, PromotionRule, RunConfig, RunEvent } from "@hone/schema";
import type { BudgetState, CapsuleManifest, DiagnosticOrderingReport, M2ProxyRole as M2ProxyRoleValue } from "@hone/schema";
import type { BrokerCorpusConfig, BrokerRecursiveConfig, TrustedEvaluationStrategy } from "@hone/broker";
import {
  admitCapsule,
  authenticateFrozenCapsuleAssets,
  freezeCapsuleAssets,
  revalidateForResume,
  writeCapsuleSnapshot,
} from "./admission.js";
import { UsageError, boolFlag, parseFlags, strFlag } from "./args.js";
import { createBackend as createLocalBackend } from "./backends/local.js";
import { createBackend as createStubBackend } from "./backends/stub.js";
import { applyContractRevision, budgetEnvelopeError, contractHash, renderContract } from "./contract.js";
import { brokerCorpusConfigDigest, corpusCohortFenceError, type CorpusCohortBinding } from "./corpus-provenance.js";
import { LadderLockedError, deliver, ladderLocked, LADDER_REFUSAL } from "./deliver.js";
import { DELIVERY_TARGET_FILE, assertTargetIdentity, isEmbeddedBaselineTarget, readSealedDeliveryTarget, sealDeliveryTarget } from "./delivery-target.js";
import type { DeliveryTarget } from "./delivery-target.js";
import { appendEvent, readEvents, replayRun, writeFileDurable } from "./eventlog.js";
import type { RunState } from "./eventlog.js";
import type { CmdIo } from "./io.js";
import {
  assertOptimizerArtifactSeal,
  readOptimizerArtifactSeal,
  resolveCandidateOptimizer,
  resolveSealedCandidateOptimizer,
  writeOptimizerArtifactSeal,
} from "./optimizer-artifact.js";
import type { OptimizerArtifactSeal, ResolvedCandidateOptimizer } from "./optimizer-artifact.js";
import {
  OPTIMIZER_DIGEST_RE,
  collectOptimizerSnapshot,
  optimizerOverridden,
  resolveOptimizerDigest,
  resolveOptimizerSnapshotDigest,
} from "./optimizer-digest.js";
import type { OptimizerSnapshot } from "./optimizer-digest.js";
import { deferred, sleep } from "./promise.js";
import { exitReport, formatDelta, formatHumanReport, formatSpend } from "./report.js";
import { resumeSealError } from "./resume-seal.js";
import { computeTrustedRuntimeDigest, verifiedBootRuntimeDigest } from "./runtime-digest.js";
import {
  CONTRACT_FILE,
  SUPERVISOR_FILE,
  casRoot,
  findResumableRun,
  loadRunConfigFile,
  mintRunDirDurable,
  mintRunId,
  runsRoot,
  writeRunConfigFile,
} from "./runs.js";
import type { CampaignPauseAuthority, ChildLike, ProbeReport, RunnerBackend, RunnerBackendContext } from "./types.js";

const RUN_USAGE =
  "usage: hone run <capsule-dir> [--headless] [--budget-usd N] [--apply none|branch|pr|auto] [--repo <dir>] [--resume] [--backend stub|local] [--config <json>] [--optimizer-artifact sha256:<64hex>]";
const CAMPAIGN_SESSION_FILE = "campaign-session.v1.json";
const CampaignSessionSealV1 = z.object({
  version: z.literal(1),
  campaignConfigHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  authorityPath: z.string().min(1),
  proxyRole: M2ProxyRole,
  /** Canonical digest of the exact frozen corpus wire config, when the run carries one. */
  corpusDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
}).strict();
type CampaignSessionSealV1 = z.infer<typeof CampaignSessionSealV1>;

function assertCampaignAuthority(
  campaignConfigHash: `sha256:${string}`,
  proxyRole: M2ProxyRoleValue | undefined,
  authority: CampaignPauseAuthority | undefined,
): asserts authority is CampaignPauseAuthority {
  if (proxyRole === undefined || authority === undefined) {
    throw new UsageError("campaign-sealed runs require their trusted proxy role and campaign pause authority");
  }
  if (authority.configHash !== campaignConfigHash || authority.path === undefined) {
    throw new UsageError("trusted campaign pause authority does not match the run's sealed campaign config");
  }
}

function readCampaignSessionSeal(runDir: string): CampaignSessionSealV1 {
  const path = join(runDir, CAMPAIGN_SESSION_FILE);
  if (!existsSync(path)) throw new UsageError(`campaign-sealed run is missing ${CAMPAIGN_SESSION_FILE}`);
  return CampaignSessionSealV1.parse(JSON.parse(readFileSync(path, "utf8")));
}
function campaignSessionFenceError(
  runDir: string,
  campaignConfigHash: `sha256:${string}` | undefined,
  proxyRole: M2ProxyRoleValue | undefined,
  authority: CampaignPauseAuthority | undefined,
  corpus: BrokerCorpusConfig | undefined,
  cohort: CorpusCohortBinding | undefined,
): string | null {
  if (campaignConfigHash === undefined) {
    return proxyRole === undefined && authority === undefined && corpus === undefined && cohort === undefined
      ? null
      : "legacy run acquired campaign authority, an M2 proxy role, or a frozen corpus";
  }
  try {
    assertCampaignAuthority(campaignConfigHash, proxyRole, authority);
    const seal = readCampaignSessionSeal(runDir);
    if (
      seal.campaignConfigHash !== campaignConfigHash
      || seal.proxyRole !== proxyRole
      || seal.authorityPath !== authority.path
    ) {
      return "campaign session role/config/authority seal changed";
    }
    if (corpus !== undefined && corpus.provenance.campaignConfigHash !== campaignConfigHash) {
      return "frozen corpus provenance does not carry the run's sealed campaign config hash";
    }
    if (seal.corpusDigest !== (corpus === undefined ? undefined : brokerCorpusConfigDigest(corpus))) {
      return "campaign corpus seal changed";
    }
    if ((corpus === undefined) !== (cohort === undefined)) {
      return cohort === undefined
        ? "frozen corpus requires the campaign corpusCohort binding"
        : "campaign corpusCohort requires the frozen corpus wire config";
    }
    if (corpus !== undefined && cohort !== undefined) {
      const cohortError = corpusCohortFenceError(corpus, cohort);
      if (cohortError !== null) return cohortError;
    }
    if (authority.isCampaignPaused()) return "campaign is durably paused";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Optional per-run overrides (routing, seat, seed, budget dims, promotion rule) — the CLI flags cover the common ones. */
const ConfigOverrides = z
  .object({
    routing: ModelRouting.optional(),
    apply: ApplyMode.optional(),
    headless: z.boolean().optional(),
    improverSeat: z.boolean().optional(),
    seed: z.number().int().nonnegative().optional(),
    budget: BudgetEnvelope.partial().optional(),
    promotion: PromotionRule.optional(),
  })
  .strict();
type ConfigOverrides = z.infer<typeof ConfigOverrides>;

/** Structural check at the plugin boundary: anything with a callable start(ctx). */
function coerceBackend(candidate: unknown): RunnerBackend | null {
  if (candidate === null || typeof candidate !== "object" || !("start" in candidate)) return null;
  const start: unknown = candidate.start;
  if (typeof start !== "function") return null;
  // Runtime-verified callable; the parameter/return types are unknowable at the plugin boundary.
  const startFn = start as (ctx: RunnerBackendContext) => unknown;
  return {
    start: async (ctx: RunnerBackendContext): Promise<void> => {
      await startFn.call(candidate, ctx);
    },
  };
}

function loadBackendModule(mod: unknown, spec: string): RunnerBackend {
  if (mod !== null && typeof mod === "object") {
    if ("createBackend" in mod) {
      const factory: unknown = mod.createBackend;
      if (typeof factory === "function") {
        const backend = coerceBackend(factory.call(mod));
        if (backend !== null) return backend;
        throw new UsageError(`backend module ${spec}: createBackend() did not return a { start } object`);
      }
    }
    if ("default" in mod) {
      const backend = coerceBackend(mod.default);
      if (backend !== null) return backend;
    }
  }
  throw new UsageError(`backend module ${spec} must export createBackend() or a default { start } object`);
}

/** Backends compiled into the trusted CLI — selectable without any trust escape hatch. */
const BUILTIN_BACKENDS: Record<string, true> = { local: true, stub: true };

export const UNSAFE_BACKEND_REFUSAL =
  "--backend <module> loads arbitrary code into the trusted supervisor process and is a test-only seam; production runs use the built-in backends (local, stub). Set HONE_UNSAFE_BACKEND=1 to acknowledge the trust collapse in a development run.";

/** Checked BEFORE any run state exists — a refused spec never mints a run. */
export function backendSpecAllowed(spec: string, env: NodeJS.ProcessEnv): boolean {
  return BUILTIN_BACKENDS[spec] === true || env["HONE_UNSAFE_BACKEND"] === "1";
}

async function loadBackend(spec: string, root: string, env: NodeJS.ProcessEnv): Promise<RunnerBackend> {
  if (spec === "local") return createLocalBackend();
  if (spec === "stub") return createStubBackend();
  if (!backendSpecAllowed(spec, env)) throw new UsageError(UNSAFE_BACKEND_REFUSAL);
  const url = pathToFileURL(resolve(root, spec)).href;
  // Plugin boundary (dev/test only, gated above): the module is runtime-selected via --backend.
  const mod: unknown = await import(url);
  return loadBackendModule(mod, spec);
}

interface RunPlan {
  runId: string;
  runDir: string;
  config: RunConfig;
  resumed: boolean;
}

/** Default mutation model for a bare `hone run` (no --config): HONE_MODEL_ID or glm-5.2 via the standard upstream. */
const DEFAULT_MUTATION_MODEL = "glm-5.2";

function buildConfig(
  manifest: CapsuleManifest,
  overrides: ConfigOverrides,
  flags: { headless: boolean; apply: string | undefined; budgetUsd: number | undefined; backend: string },
  env: NodeJS.ProcessEnv,
): RunConfig {
  const routing: ModelRouting = { ...(overrides.routing ?? {}) };
  if (routing["mutation"] === undefined) {
    // Bare run: default the mutation route so `hone run <capsule>` works with
    // zero config. The upstream base URL stays the proxy's single configured
    // default (vibeproxy); only the model id is chosen here.
    routing["mutation"] = { model: env["HONE_MODEL_ID"] ?? DEFAULT_MUTATION_MODEL };
  }
  const config = RunConfig.parse({
    version: 1,
    capsuleId: manifest.id,
    objective: manifest.objective,
    budget: {
      ...manifest.budget,
      ...(overrides.budget ?? {}),
      ...(flags.budgetUsd !== undefined ? { maxUsd: flags.budgetUsd } : {}),
    },
    routing,
    apply: flags.apply ?? overrides.apply ?? "none",
    headless: flags.headless || overrides.headless === true,
    // Sealed at run creation: a resume with an absent --backend reuses it;
    // a conflicting flag refuses (see runCommand's resume branch).
    backend: flags.backend,
    improverSeat: overrides.improverSeat ?? false,
    seed: overrides.seed ?? 0,
    ...(overrides.promotion !== undefined ? { promotion: overrides.promotion } : {}),
  });
  // Hard upper envelope (same validator as interactive E-edits): a --config or
  // --budget-usd value above the frozen capsule manifest refuses HERE, before
  // any run state exists. Tightening (or exact-cap) always passes.
  const envelopeError = budgetEnvelopeError(config.budget, manifest.budget);
  if (envelopeError !== null) throw new UsageError(envelopeError);
  return config;
}

/**
 * Interactive approval loop. `E` opens $EDITOR on the contract; afterwards the
 * unique executable run-config block is parsed back, validated (frozen
 * capsule id, capsule budget envelope, ladder), and the WHOLE contract is
 * re-rendered from the approved config so no narrative goes stale. Any
 * revision that does not survive that pipeline fails closed: no run starts.
 * Returns the approved (possibly revised) config, or null when declined.
 */
export async function promptApproval(
  contractPath: string,
  seal: {
    runId: string;
    manifest: CapsuleManifest;
    capsuleDigest: string;
    optimizerDigest: string;
    orderingReport: DiagnosticOrderingReport;
    deliveryTarget: DeliveryTarget | null;
  },
  initial: RunConfig,
  io: CmdIo,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<RunConfig | null> {
  const rl = createInterface({ input: streams.input, output: streams.output });
  let config = initial;
  try {
    for (;;) {
      io.out("");
      io.out(readFileSync(contractPath, "utf8"));
      io.out(`(contract on disk: ${contractPath})`);
      const answer = (await rl.question("approve run contract? [y]es / [e]dit / [n]o: ")).trim().toLowerCase();
      // Explicit consent only: a bare Enter NEVER approves a run — reprompt.
      if (answer === "y" || answer === "yes") return config;
      if (answer === "n" || answer === "no") return null;
      if (answer === "e" || answer === "edit") {
        const editor = io.env["EDITOR"] ?? io.env["VISUAL"] ?? "vi";
        const before = readFileSync(contractPath, "utf8");
        spawnSync(editor, [contractPath], { stdio: "inherit" });
        const after = readFileSync(contractPath, "utf8");
        if (after === before) continue;
        const outcome = applyContractRevision({ preEdit: before, edited: after, original: config, manifest: seal.manifest, env: io.env });
        if (!outcome.ok) {
          io.err(`contract revision rejected (fail closed): ${outcome.error}`);
          return null;
        }
        config = outcome.config;
        writeFileDurable(contractPath, renderContract({ ...seal, config }));
        io.out("contract re-rendered from the revised run config — re-review before approving:");
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * M0 VI.4 headless probe policy: the probe is ONE paired eval + approval —
 * NOT the N≥2 statistical PromotionGate (that rule stays frozen in the
 * contract and governs the M1 outer champion decision; consulting it here
 * would make a one-eval probe mathematically impossible). Headless
 * auto-approves only a VALID completed pair whose broker-authored candidate
 * delta is strictly positive; anything else declines and the run stops.
 */
export function headlessProbeVerdict(report: ProbeReport): boolean {
  return report.promoted && report.candidate !== null && report.candidate.delta > 0;
}

/**
 * Interactive probe gate: print the trusted paired measurement, ask to
 * continue. Abort-aware (exported for the abort-during-probe regression): a
 * stop landing while the question is pending resolves false immediately —
 * the backend then observes the aborted signal and seals NO durable verdict,
 * so the run stays resumable and re-gates on the next resume. `streams` is a
 * DI seam for tests; production reads the real TTY.
 */
export async function promptProbe(
  report: ProbeReport,
  io: CmdIo,
  signal: AbortSignal,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<boolean> {
  if (signal.aborted) return false;
  io.out("");
  io.out("probe episode complete — trusted paired measurement (broker events, not optimizer claims):");
  io.out(`  baseline  ${report.baseline.artifact.hash}  aggregate ${report.baseline.aggregate}`);
  if (report.candidate !== null) {
    io.out(`  candidate ${report.candidate.artifact.hash}  aggregate ${report.candidate.aggregate} (Δ ${formatDelta(report.candidate.delta)})`);
  } else {
    io.out("  candidate: none produced by the probe episode");
  }
  io.out(`  measured on ${report.assetGroupId} (seed ${report.seed}) | ${formatSpend(report.budget)}`);
  if (!headlessProbeVerdict(report)) {
    io.out("  probe did not promote a strictly positive candidate; approval and delivery are unavailable.");
    return false;
  }
  io.out("  M0 policy: this is the only candidate; approval finalizes and delivers it (multi-episode search requires M1 cache isolation).");
  const rl = createInterface({ input: streams.input, output: streams.output });
  try {
    for (;;) {
      let answer: string;
      try {
        answer = (await rl.question("accept and finalize this M0 candidate? [y]es / [n]o: ", { signal })).trim().toLowerCase();
      } catch {
        return false; // aborted mid-question — no verdict
      }
      // Explicit consent only: a bare Enter NEVER approves — reprompt.
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  } finally {
    rl.close();
  }
}

/** Run-dir pin of the trusted runtime source that started the run. */
export const RUNTIME_PIN_FILE = ".hone-version";

// The trusted-runtime digest lives in dependency-free plain JS
// (runtime-digest.js) so bin/hone.js can SEAL the boot digest before tsx is
// registered or any trusted TypeScript (or zod/esbuild byte) is loaded; the
// supervisor recomputes through the very same module, so boot value and
// every later recheck come from identical code. Re-exported here for the
// existing test surface.
export { collectTsconfigClosure } from "./runtime-digest.js";
export type { TsconfigClosureFile } from "./runtime-digest.js";

/**
 * Deterministic digest of the trusted runtime closure as it sits on disk
 * RIGHT NOW (workspace source + tsconfig closure + installed production
 * dependency bytes). Kept as the historical export name; boot-bound checks
 * go through assertRuntimePinFresh / verifiedBootRuntimeDigest instead.
 */
export const trustedRuntimeDigest = computeTrustedRuntimeDigest;

/**
 * Boot-bound pin gate: recompute the complete trusted closure, refuse any
 * drift from the immutable boot seal, and require the run's durable
 * .hone-version pin to equal the BOOT digest — the digest of the source
 * that is actually executing, never a late disk state. Synchronous end to
 * end: callers persist or emit immediately after, with no await between
 * the comparison and the use of the returned value.
 */
function assertRuntimePinFresh(runDir: string, runId: string): string {
  const digest = verifiedBootRuntimeDigest();
  const pinPath = join(runDir, RUNTIME_PIN_FILE);
  const pinned = existsSync(pinPath) ? readFileSync(pinPath, "utf8").trim() : null;
  if (pinned !== digest) {
    throw new UsageError(
      pinned === null
        ? `run ${runId} has no trusted-runtime pin (${RUNTIME_PIN_FILE}) — refusing to resume (start a fresh run)`
        : `trusted-runtime drift since the run started: digest ${digest} != pinned ${pinned} — refusing to resume (start a fresh run)`,
    );
  }
  return digest;
}

/**
 * Durable optimizer-completion seal: written once the backend has settled
 * successfully and every registered resource is torn down — from that point
 * the event log is authoritative and only delivery/terminal work remains. A
 * resume that finds it never reruns the optimizer and spawns no backend
 * resource: it retries delivery exactly once from the sealed incumbent.
 */
export const OPTIMIZER_COMPLETE_FILE = "optimizer-complete.json";

const OptimizerCompleteSchema = z.object({ runId: z.string().min(1) }).passthrough();

/** True when the run carries a valid completion seal for THIS run id; throws (fail closed) on a corrupt or foreign seal. Shared with `hone stop`'s dead-stop gate. */
export function optimizerCompleteForRun(runDir: string, runId: string): boolean {
  const path = join(runDir, OPTIMIZER_COMPLETE_FILE);
  if (!existsSync(path)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${OPTIMIZER_COMPLETE_FILE} is unreadable — refusing to resume over a corrupt completion seal`);
  }
  const parsed = OptimizerCompleteSchema.safeParse(raw);
  if (!parsed.success || parsed.data.runId !== runId) {
    throw new Error(`${OPTIMIZER_COMPLETE_FILE} does not seal run ${runId} — refusing to resume over a foreign completion seal`);
  }
  return true;
}

/** Artifact-selected optimizers cannot coexist with either optimizer escape hatch. */
function assertCandidateOptimizerEnvironment(env: NodeJS.ProcessEnv, mergedDigest?: string): void {
  if (env["HONE_OPTIMIZER_ENTRY"] !== undefined) {
    throw new UsageError("HONE_OPTIMIZER_ENTRY is no longer supported: candidate optimizers execute only from a sealed containerized snapshot");
  }
  if (optimizerOverridden(env)) {
    throw new UsageError("--optimizer-artifact cannot be combined with HONE_OPTIMIZER_CMD — the selected captured snapshot must be the optimizer that executes");
  }
  const explicit = env["HONE_OPTIMIZER_DIGEST"];
  if (mergedDigest !== undefined && explicit !== undefined && explicit !== mergedDigest) {
    throw new UsageError(`HONE_OPTIMIZER_DIGEST ${explicit} does not match the selected merged optimizer digest ${mergedDigest} — refusing a misleading pin`);
  }
}

export interface TrustedRunOptions {
  /** Deterministic child/outer id from a durable meta receipt. */
  runId?: string | undefined;
  measurementEpoch?: string | undefined;
  evaluationStrategy?: TrustedEvaluationStrategy | undefined;
  optimizerEpisodesMax?: number | undefined;
  maxPublicCandidateEvaluations?: number | undefined;
  /** Trusted outer-only target of distinct valid non-baseline strategy results. */
  trustedValidPublicCandidateTarget?: number | undefined;
  /** Narrow holdout capability released only by terminal-latched meta orchestration. */
  terminalHoldoutAssetGroupIds?: readonly string[] | undefined;
  /** Internal campaign seed closure; never serialized or re-collected from repoRoot. */
  optimizerBaseSnapshot?: OptimizerSnapshot | undefined;
  /** Frozen model capability for this trusted session. Omit only on legacy M0/M1 runs. */
  proxyRole?: M2ProxyRole | undefined;
  /** Shared recursive-campaign provider pause authority. */
  campaignPauseAuthority?: CampaignPauseAuthority | undefined;
  /**
   * Review bypass for the trusted synthetic meta capsule only: its authoring
   * validation and later frozen-byte recheck precede/replace Gate 2.
   */
  admissionReview?: "required" | "off" | undefined;
  /** Trusted recursive launch receipt seal; never accepted from CLI flags/config. */
  campaignConfigHash?: `sha256:${string}` | undefined;
  /** Trusted recursive broker authority; optimizer/config values cannot supply it. */
  recursiveBroker?: BrokerRecursiveConfig | undefined;
  /** Frozen development-corpus wire config; trusted campaign orchestration only, never CLI flags/config. */
  corpus?: BrokerCorpusConfig | undefined;
  /** The frozen campaign config's corpusCohort block — fenced against the corpus wire config before supervision. */
  corpusCohort?: CorpusCohortBinding | undefined;
}

export async function runCommand(args: string[], io: CmdIo, trusted: TrustedRunOptions = {}): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "resume"],
    // --repo is REQUIRED when apply != none: it seals the exact delivery
    // target at run creation — automatic delivery never defaults to io.root.
    strings: ["budget-usd", "apply", "backend", "config", "repo", "optimizer-artifact"],
  });
  const capsuleArg = positionals[0];
  if (capsuleArg === undefined) throw new UsageError(RUN_USAGE);
  const capsuleDir = resolve(io.root, capsuleArg);

  const resumeRequested = boolFlag(flags, "resume");
  const configPath = strFlag(flags, "config");
  // Every run parameter is sealed at creation; a resume never re-reads a
  // --config file (its overrides were already merged and cannot be proven
  // equal), so the flag refuses outright instead of being silently ignored.
  if (resumeRequested && configPath !== undefined) {
    throw new UsageError("--config is sealed at run creation and cannot be re-specified on resume — the stored runconfig.json is authoritative; start a fresh run to change configuration");
  }
  const overrides: ConfigOverrides = configPath
    ? ConfigOverrides.parse(JSON.parse(readFileSync(resolve(io.root, configPath), "utf8")))
    : {};
  const budgetUsdRaw = strFlag(flags, "budget-usd");
  const budgetUsd = budgetUsdRaw !== undefined ? Number(budgetUsdRaw) : undefined;
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
    throw new UsageError("--budget-usd must be a nonnegative number");
  }
  const applyFlag = strFlag(flags, "apply");
  if (applyFlag !== undefined && !ApplyMode.safeParse(applyFlag).success) {
    throw new UsageError(`--apply must be one of ${ApplyMode.options.join("|")}`);
  }
  // Production default: the trusted local backend. Arbitrary module specs are
  // refused here, before a runId is minted or any run state touches disk.
  const backendFlag = strFlag(flags, "backend");
  if (backendFlag !== undefined && !backendSpecAllowed(backendFlag, io.env)) {
    io.err(UNSAFE_BACKEND_REFUSAL);
    return 2;
  }
  const optimizerArtifactFlag = strFlag(flags, "optimizer-artifact");
  if (optimizerArtifactFlag !== undefined && !OPTIMIZER_DIGEST_RE.test(optimizerArtifactFlag)) {
    throw new UsageError("--optimizer-artifact must be sha256:<64 lowercase hex>");
  }

  // Production intake always requires the exact Gate-2 receipt chain. The
  // sole bypass is an explicit trusted synthetic-meta authoring/recheck path.
  const admissionReview = trusted.admissionReview ?? "required";
  const admitted = admitCapsule(capsuleDir, { review: admissionReview });
  const manifest = admitted.manifest;
  if (
    admitted.provisional
    && (
      trusted.evaluationStrategy !== undefined
      || trusted.trustedValidPublicCandidateTarget !== undefined
      || trusted.terminalHoldoutAssetGroupIds !== undefined
      || trusted.corpus !== undefined
    )
  ) {
    throw new UsageError("provisional capsule quarantine forbids corpus evaluation, optimizer promotion, and terminal holdout workflows");
  }
  let optimizerDigest: string;
  let optimizerSnapshot: OptimizerSnapshot | undefined;
  let optimizerBaseSnapshot: OptimizerSnapshot | undefined = trusted.optimizerBaseSnapshot;
  let optimizerArtifactSeal: OptimizerArtifactSeal | null = null;

  const resolveDefaultOptimizerIdentity = (): string => {
    if (optimizerOverridden(io.env)) {
      if (trusted.optimizerBaseSnapshot !== undefined) {
        throw new UsageError("an internal optimizer base snapshot cannot be combined with HONE_OPTIMIZER_CMD");
      }
      return resolveOptimizerDigest(io.env, manifest.image);
    }
    optimizerBaseSnapshot = trusted.optimizerBaseSnapshot ?? collectOptimizerSnapshot();
    return resolveOptimizerSnapshotDigest(io.env, manifest.image, optimizerBaseSnapshot);
  };

  let plan: RunPlan;
  if (resumeRequested) {
    const found = trusted.runId === undefined
      ? findResumableRun(io.root, manifest.id)
      : (() => {
          if (!/^run_[a-zA-Z0-9_.-]+$/.test(trusted.runId)) throw new UsageError("trusted run id is invalid");
          const runDir = join(runsRoot(io.root), trusted.runId);
          if (!existsSync(runDir)) return null;
          const state = replayRun(runDir);
          if (state.runId !== trusted.runId || state.capsuleId !== manifest.id || state.finished !== null) return null;
          return { runDir, runId: trusted.runId, state };
        })();
    if (found === null) throw new UsageError(`nothing to resume: no unfinished run for capsule ${manifest.id} under ${runsRoot(io.root)}`);
    const started = readEvents(found.runDir)[0];
    const sealedCampaignHash = started?.type === "run.started" ? started.campaignConfigHash : undefined;
    if (sealedCampaignHash === undefined) {
      if (
        trusted.campaignConfigHash !== undefined
        || trusted.proxyRole !== undefined
        || trusted.campaignPauseAuthority !== undefined
        || trusted.corpus !== undefined
        || trusted.corpusCohort !== undefined
      ) {
        throw new UsageError("legacy run cannot acquire campaign authority, an M2 proxy role, or a frozen corpus on resume");
      }
    } else {
      if (trusted.campaignConfigHash !== sealedCampaignHash) {
        throw new UsageError("campaign-sealed run requires the exact trusted campaign config hash on resume");
      }
      assertCampaignAuthority(sealedCampaignHash, trusted.proxyRole, trusted.campaignPauseAuthority);
      const campaignSeal = readCampaignSessionSeal(found.runDir);
      if (
        campaignSeal.campaignConfigHash !== sealedCampaignHash
        || campaignSeal.proxyRole !== trusted.proxyRole
        || campaignSeal.authorityPath !== trusted.campaignPauseAuthority.path
      ) {
        throw new UsageError("campaign session role/config/authority seal changed since the run started");
      }
      if (trusted.corpus !== undefined && trusted.corpus.provenance.campaignConfigHash !== sealedCampaignHash) {
        throw new UsageError("frozen corpus provenance does not carry the run's sealed campaign config hash");
      }
      if (campaignSeal.corpusDigest !== (trusted.corpus === undefined ? undefined : brokerCorpusConfigDigest(trusted.corpus))) {
        throw new UsageError("campaign corpus seal changed since the run started — resume requires the exact frozen corpus");
      }
      if (trusted.campaignPauseAuthority.isCampaignPaused()) {
        throw new UsageError("campaign is durably paused; only the trusted campaign resume coordinator may reopen admission");
      }
      if ((trusted.corpus === undefined) !== (trusted.corpusCohort === undefined)) {
        throw new UsageError(trusted.corpusCohort === undefined
          ? "frozen corpus requires the campaign corpusCohort binding"
          : "campaign corpusCohort requires the frozen corpus wire config");
      }
      if (trusted.corpus !== undefined && trusted.corpusCohort !== undefined) {
        const cohortError = corpusCohortFenceError(trusted.corpus, trusted.corpusCohort);
        if (cohortError !== null) throw new UsageError(cohortError);
      }
    }
    // Resume replays Gate 2 again: revocation or a delegation change refuses
    // before the run lock, event append, backend spawn, or delivery.
    revalidateForResume(found.runDir, capsuleDir, { review: admissionReview });
    // The trusted runtime itself is sealed at run creation: a resume from
    // drifted (or partially rebuilt) trusted source refuses BEFORE any event
    // is appended or a backend launches — a run never mixes trusted source.
    // The comparison is BOOT-BOUND: the recompute must equal the digest
    // sealed before any trusted module was imported, and the pin must equal
    // that boot value.
    assertRuntimePinFresh(found.runDir, found.runId);
    const resumesArtifact = readOptimizerArtifactSeal(found.runDir) !== null;
    if (resumesArtifact || optimizerArtifactFlag !== undefined) assertCandidateOptimizerEnvironment(io.env);
    const selected = await resolveSealedCandidateOptimizer({
      runDir: found.runDir,
      runId: found.runId,
      ...(optimizerArtifactFlag !== undefined ? { artifactHash: optimizerArtifactFlag } : {}),
      casDir: casRoot(io.root),
      image: manifest.image,
      ...(trusted.optimizerBaseSnapshot !== undefined ? { baseSnapshot: trusted.optimizerBaseSnapshot } : {}),
    });
    if (selected === null) {
      optimizerDigest = resolveDefaultOptimizerIdentity();
    } else {
      assertCandidateOptimizerEnvironment(io.env, selected.mergedDigest);
      optimizerDigest = selected.mergedDigest;
      optimizerSnapshot = selected.snapshot;
      optimizerArtifactSeal = selected.seal;
    }
    if (found.state.optimizerDigest !== null && found.state.optimizerDigest !== optimizerDigest) {
      throw new UsageError(
        `optimizer drift since the run started: digest ${optimizerDigest} != sealed ${found.state.optimizerDigest} — refusing to resume (start a fresh run)`,
      );
    }
    const config = loadRunConfigFile(found.runDir);
    if (admitted.provisional) {
      const delegationBudget = admitted.approval?.receipt.delegation?.budgetUsd;
      if (delegationBudget === undefined || config.apply !== "none" || config.budget.maxUsd > delegationBudget) {
        throw new UsageError("provisional capsule resume violates its apply:none delegation budget quarantine");
      }
    }
    // Autonomy-ladder re-check (IV.2): the gate is re-evaluated against THIS
    // invocation's environment BEFORE any resume mutation, backend spawn, or
    // event append — a sealed apply:auto improver-seat run may not resume
    // without it. Refusal is nonterminal: the run stays resumable as-is.
    if (ladderLocked(config.apply, config.improverSeat, io.env)) {
      io.err(LADDER_REFUSAL);
      return 3;
    }
    // The delivery target is sealed at run creation; a resume can neither
    // change it nor proceed while it no longer validates exactly as sealed.
    if (strFlag(flags, "repo") !== undefined) {
      throw new UsageError("--repo is sealed at run creation and cannot change on resume — start a fresh run to deliver elsewhere");
    }
    // Sealed-config flags refuse on conflict instead of being silently
    // ignored: an equal restatement is harmless, a different value is a
    // contract change no resume may perform.
    if (applyFlag !== undefined && applyFlag !== config.apply) {
      throw new UsageError(`--apply ${applyFlag} conflicts with the run's sealed apply mode "${config.apply}" — resume without --apply, or start a fresh run`);
    }
    if (budgetUsd !== undefined && budgetUsd !== config.budget.maxUsd) {
      throw new UsageError(`--budget-usd ${budgetUsd} conflicts with the run's sealed budget (maxUsd ${config.budget.maxUsd}) — resume without --budget-usd, or start a fresh run`);
    }
    if (config.apply !== "none") {
      try {
        if (readSealedDeliveryTarget(io.root, found.runDir, config.apply) === null) {
          throw new Error(`run has no sealed ${DELIVERY_TARGET_FILE}`);
        }
      } catch (e) {
        throw new UsageError(
          `delivery target no longer validates: ${e instanceof Error ? e.message : String(e)} — refusing to resume`,
        );
      }
    }
    // The backend is sealed at run creation: an absent flag reuses it; a
    // conflicting flag refuses. The stored spec still passes the trust gate
    // (a module spec needs HONE_UNSAFE_BACKEND=1 on THIS invocation too).
    if (backendFlag !== undefined && backendFlag !== config.backend) {
      throw new UsageError(`--backend ${backendFlag} conflicts with the run's sealed backend "${config.backend}" — resume without --backend, or start a fresh run`);
    }
    if (!backendSpecAllowed(config.backend, io.env)) {
      io.err(UNSAFE_BACKEND_REFUSAL);
      return 2;
    }
    // Headless is sealed too: absence preserves the stored mode; --headless
    // on a run approved interactively (stored false) may NOT flip it — the
    // probe gate and stop semantics the owner approved would silently change.
    if (boolFlag(flags, "headless") && !config.headless) {
      throw new UsageError("--headless conflicts with the run's sealed interactive mode (headless=false) — resume without --headless, or start a fresh run");
    }
    plan = { runId: found.runId, runDir: found.runDir, config, resumed: true };
  } else {
    if (trusted.campaignConfigHash === undefined) {
      if (
        trusted.proxyRole !== undefined
        || trusted.campaignPauseAuthority !== undefined
        || trusted.corpus !== undefined
        || trusted.corpusCohort !== undefined
      ) {
        throw new UsageError("M2 proxy roles, campaign pause authority, and a frozen corpus require a trusted campaign config seal");
      }
    } else {
      assertCampaignAuthority(
        trusted.campaignConfigHash,
        trusted.proxyRole,
        trusted.campaignPauseAuthority,
      );
      if (trusted.corpus !== undefined && trusted.corpus.provenance.campaignConfigHash !== trusted.campaignConfigHash) {
        throw new UsageError("frozen corpus provenance does not carry the trusted campaign config hash");
      }
      if ((trusted.corpus === undefined) !== (trusted.corpusCohort === undefined)) {
        throw new UsageError(trusted.corpusCohort === undefined
          ? "frozen corpus requires the campaign corpusCohort binding"
          : "campaign corpusCohort requires the frozen corpus wire config");
      }
      if (trusted.corpus !== undefined && trusted.corpusCohort !== undefined) {
        const cohortError = corpusCohortFenceError(trusted.corpus, trusted.corpusCohort);
        if (cohortError !== null) throw new UsageError(cohortError);
      }
      if (trusted.campaignPauseAuthority.isCampaignPaused()) {
        throw new UsageError("campaign is durably paused; child/outer run admission remains closed");
      }
    }
    let config = buildConfig(
      manifest,
      overrides,
      {
        headless: boolFlag(flags, "headless"),
        apply: applyFlag,
        budgetUsd,
        backend: backendFlag ?? "local",
      },
      io.env,
    );
    if (admitted.provisional) {
      const delegationBudget = admitted.approval?.receipt.delegation?.budgetUsd;
      if (delegationBudget === undefined) {
        throw new UsageError("provisional capsule approval is missing its verified delegation budget");
      }
      config = RunConfig.parse({
        ...config,
        apply: "none",
        budget: {
          ...config.budget,
          maxUsd: Math.min(config.budget.maxUsd, delegationBudget),
        },
      });
    }

    // Autonomy-ladder lock (review IV.2): trusted-side, checked before ANY run state exists.
    if (ladderLocked(config.apply, config.improverSeat, io.env)) {
      io.err(LADDER_REFUSAL);
      return 3;
    }
    if (!config.headless && !io.isTTY) {
      io.err("interactive contract approval requires a TTY; re-run with --headless to auto-approve");
      return 2;
    }

    // Delivery-target refusals happen LOUDLY here, before any run state
    // exists — a run that will deliver must bind its exact target now, and
    // a CAS-baseline capsule binds no git target at all (no silent skip at
    // delivery time, which nothing could ever cure).
    const repoFlag = strFlag(flags, "repo");
    if (config.apply !== "none" && repoFlag === undefined) {
      throw new UsageError(`--apply ${config.apply} delivers into a repository — pass an explicit --repo DIR (delivery never defaults to the current root)`);
    }
    if (config.apply === "none" && repoFlag !== undefined) {
      throw new UsageError("--repo binds a delivery target and requires --apply branch|pr|auto");
    }
    if (config.apply !== "none" && manifest.baseline.kind !== "git") {
      throw new UsageError(`--apply ${config.apply} needs a git-baseline capsule — this capsule's baseline is a CAS artifact, which binds no delivery target`);
    }
    // Embedded capsule-baseline stores (.gitdir) carry no checkout for auto
    // to merge into — deliver() would refuse at run END. Refuse HERE,
    // during fresh preflight, before a runId is minted or any run state
    // touches disk (branch/pr remain supported on embedded stores).
    if (config.apply === "auto" && repoFlag !== undefined && isEmbeddedBaselineTarget(io.root, repoFlag)) {
      throw new UsageError(
        "--apply auto merges into a checked-out repository branch and cannot target an embedded capsule-baseline store (.gitdir) — use --apply branch or --apply pr, or target the real repository",
      );
    }

    let selectedCandidate: ResolvedCandidateOptimizer | null = null;
    if (optimizerArtifactFlag === undefined) {
      optimizerDigest = resolveDefaultOptimizerIdentity();
    } else {
      assertCandidateOptimizerEnvironment(io.env);
      selectedCandidate = await resolveCandidateOptimizer({
        casDir: casRoot(io.root),
        artifactHash: optimizerArtifactFlag,
        image: manifest.image,
        ...(trusted.optimizerBaseSnapshot !== undefined ? { baseSnapshot: trusted.optimizerBaseSnapshot } : {}),
      });
      assertCandidateOptimizerEnvironment(io.env, selectedCandidate.mergedDigest);
      optimizerDigest = selectedCandidate.mergedDigest;
      optimizerSnapshot = selectedCandidate.snapshot;
    }

    const runId = trusted.runId ?? mintRunId();
    if (!/^run_[a-zA-Z0-9_.-]+$/.test(runId)) throw new UsageError("trusted run id is invalid");
    if (existsSync(join(runsRoot(io.root), runId))) throw new UsageError(`run ${runId} already exists`);
    const runDir = mintRunDirDurable(io.root, runId);
    if (trusted.campaignConfigHash !== undefined) {
      writeFileDurable(join(runDir, CAMPAIGN_SESSION_FILE), `${JSON.stringify(CampaignSessionSealV1.parse({
        version: 1,
        campaignConfigHash: trusted.campaignConfigHash,
        authorityPath: trusted.campaignPauseAuthority?.path,
        proxyRole: trusted.proxyRole,
        ...(trusted.corpus !== undefined ? { corpusDigest: brokerCorpusConfigDigest(trusted.corpus) } : {}),
      }))}\n`);
    }
    // Snapshot the ADMITTED manifest: resume proves capsule identity against it.
    writeCapsuleSnapshot(runDir, manifest);
    try {
      freezeCapsuleAssets(runDir, capsuleDir, manifest);
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      throw error;
    }
    if (selectedCandidate !== null) {
      try {
        optimizerArtifactSeal = writeOptimizerArtifactSeal(runDir, runId, selectedCandidate);
      } catch (error) {
        rmSync(runDir, { recursive: true, force: true });
        throw error;
      }
    }
    let deliveryTarget: DeliveryTarget | null = null;
    if (config.apply !== "none" && repoFlag !== undefined) {
      // Seal the validated delivery target beside the snapshot (it reads the
      // snapshot's frozen baseline commit). A refused target unmints the run.
      try {
        deliveryTarget = sealDeliveryTarget(io.root, runDir, repoFlag, config.apply);
      } catch (e) {
        rmSync(runDir, { recursive: true, force: true });
        if (e instanceof UsageError) throw e;
        throw new UsageError(`delivery target refused: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Pin the trusted runtime that mints this run — resume recomputes and
    // refuses on drift. The persisted value is the BOOT-SEALED digest
    // (recomputed and compared right here, synchronously): what runs is
    // what is pinned, never a late disk state.
    writeFileDurable(join(runDir, RUNTIME_PIN_FILE), `${verifiedBootRuntimeDigest()}\n`);
    // The sealed delivery target is RENDERED into the owner-approved
    // contract, so the contract hash binds exactly where the run may
    // deliver; the resume re-render re-binds it (resume-seal.ts).
    const seal = { runId, manifest, capsuleDigest: admitted.digest, optimizerDigest, orderingReport: admitted.orderingReport, deliveryTarget };
    writeFileDurable(join(runDir, CONTRACT_FILE), renderContract({ ...seal, config }));
    if (!config.headless) {
      const approved = await promptApproval(join(runDir, CONTRACT_FILE), seal, config, io);
      if (approved === null) {
        rmSync(runDir, { recursive: true, force: true });
        io.err("contract declined — no run started");
        return 1;
      }
      config = approved;
    }
    // Persist the APPROVED config — the one the (possibly revised) contract renders.
    writeRunConfigFile(runDir, config);
    plan = { runId, runDir, config, resumed: false };
  }

  return superviseRun(
    plan,
    {
      manifest,
      capsuleDir,
      capsuleDigest: admitted.digest,
      optimizerDigest,
      orderingReport: admitted.orderingReport,
      ...(optimizerSnapshot !== undefined ? { optimizerSnapshot } : {}),
      ...(optimizerBaseSnapshot !== undefined ? { optimizerBaseSnapshot } : {}),
      optimizerArtifactSeal,
      ...(trusted.measurementEpoch !== undefined ? { measurementEpoch: trusted.measurementEpoch } : {}),
      ...(trusted.evaluationStrategy !== undefined ? { evaluationStrategy: trusted.evaluationStrategy } : {}),
      ...(trusted.optimizerEpisodesMax !== undefined ? { optimizerEpisodesMax: trusted.optimizerEpisodesMax } : {}),
      ...(trusted.maxPublicCandidateEvaluations !== undefined
        ? { maxPublicCandidateEvaluations: trusted.maxPublicCandidateEvaluations }
        : {}),
      ...(trusted.trustedValidPublicCandidateTarget !== undefined
        ? { trustedValidPublicCandidateTarget: trusted.trustedValidPublicCandidateTarget }
        : {}),
      ...(trusted.terminalHoldoutAssetGroupIds !== undefined
        ? { terminalHoldoutAssetGroupIds: trusted.terminalHoldoutAssetGroupIds }
        : {}),
      ...(trusted.proxyRole !== undefined ? { proxyRole: trusted.proxyRole } : {}),
      ...(trusted.campaignPauseAuthority !== undefined
        ? { campaignPauseAuthority: trusted.campaignPauseAuthority }
        : {}),
      ...(trusted.admissionReview !== undefined ? { admissionReview: trusted.admissionReview } : {}),
      ...(trusted.campaignConfigHash !== undefined ? { campaignConfigHash: trusted.campaignConfigHash } : {}),
      ...(trusted.recursiveBroker !== undefined ? { recursiveBroker: trusted.recursiveBroker } : {}),
      ...(trusted.corpus !== undefined ? { corpus: trusted.corpus } : {}),
      ...(trusted.corpusCohort !== undefined ? { corpusCohort: trusted.corpusCohort } : {}),
    },
    io,
  );
}

/**
 * Lock socket path: SHORT and deterministic. macOS truncates a unix bind
 * path silently at sun_path (~104 bytes) — a lock inside a deep runDir would
 * bind a DIFFERENT, truncated path (colliding with the run dir itself), so
 * the socket lives under tmpdir keyed by the runDir's real path.
 */
export function runLockPath(runDir: string): string {
  const key = createHash("sha256").update(realpathSync(runDir)).digest("hex").slice(0, 16);
  return join(tmpdir(), `hone-${key}.lck`);
}

/** Short path of the lock's identity metadata file, beside the socket. */
function runLockMetaPath(sockPath: string): string {
  return `${sockPath}.id`;
}

/**
 * Kernel-level connect probe. A unix connect to a bound, listening socket
 * completes in the KERNEL (backlog) — it succeeds even while the holder's JS
 * loop is blocked for seconds inside a synchronous delivery, and it fails
 * (ECONNREFUSED/ENOENT) on a crashed holder's leftover. `onTimeout` picks the
 * fail direction: the stale-arbitration probe fails CLOSED (treated as live,
 * never unlink a possibly-live lock); the identity probe fails OPEN to null
 * (never confirm without positive proof).
 */
function connectProbe(sockPath: string, onTimeout: boolean): Promise<boolean> {
  const { promise, resolve } = deferred<boolean>();
  const probe = net.connect(sockPath);
  const settle = (alive: boolean): void => {
    probe.destroy();
    resolve(alive);
  };
  probe.once("connect", () => settle(true));
  probe.once("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    // ECONNREFUSED/ENOENT: crashed owner's leftover. ENOTSOCK: junk file.
    settle(code !== "ECONNREFUSED" && code !== "ENOENT" && code !== "ENOTSOCK" && onTimeout);
  });
  probe.setTimeout(1000, () => settle(onTimeout));
  return promise;
}

/** Identity served by a supervisor's held run lock — binds a sentinel PID to THIS lock holder (PIDs recycle; nonces do not). */
export interface RunLockIdentity {
  pid: number;
  runId: string;
  nonce: string;
}

const RunLockIdentitySchema = z.object({
  pid: z.number().int().positive(),
  runId: z.string(),
  nonce: z.string().min(1),
});

/**
 * The on-disk metadata additionally pins the socket INCARNATION (dev:ino of
 * the bound inode). A bind mints a fresh inode, so metadata published by
 * holder A can never be vouched for by a successor B's socket at the same
 * path — the A-release/B-bind-before-B-publish window reads as a mismatch
 * instead of confirming a stale supervisor.
 */
const PublishedLockIdentitySchema = RunLockIdentitySchema.extend({ sock: z.string().min(1) });
type PublishedLockIdentity = z.infer<typeof PublishedLockIdentitySchema>;

/** dev:ino of the socket path right now, or null when absent/unstattable. */
function socketIncarnation(sockPath: string): string | null {
  try {
    const st = statSync(sockPath, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

function readLockMetadata(sockPath: string): PublishedLockIdentity | null {
  try {
    const parsed = PublishedLockIdentitySchema.safeParse(JSON.parse(readFileSync(runLockMetaPath(sockPath), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Atomic (write + rename) so a probe never reads a torn identity. */
function writeLockMetadata(sockPath: string, identity: PublishedLockIdentity): void {
  const metaPath = runLockMetaPath(sockPath);
  const tmpPath = `${metaPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(identity)}\n`);
  renameSync(tmpPath, metaPath);
}

/**
 * A held identification lease on the run lock: a live kernel connection to
 * the EXACT lock incarnation whose metadata proved `identity`. The holder
 * keeps accepted connections open and destroys them at release (a dead
 * holder's sockets close with it), so while `isReleased()` is false the
 * proven holder still owns the lock. The connection doubles as the STOP
 * COMMAND CHANNEL: requestStop() writes a byte the holder consumes as a
 * trusted stop request — no PID is ever signalled, so a recycled PID can
 * never be reached by mistake, and the byte queues in the kernel even while
 * the holder is blocked in a synchronous delivery. `released` resolves when
 * the connection closes: lock released, holder dead, or this side's own
 * close().
 */
export interface RunLockLease {
  readonly identity: RunLockIdentity;
  readonly released: Promise<void>;
  isReleased(): boolean;
  /** Request a trusted stop through the lease. False = lease already gone (re-observe). */
  requestStop(): boolean;
  /** Deterministically drops the lease connection (idempotent). */
  close(): void;
}

/**
 * Lease the current run-lock holder's identity. Proof deliberately requires
 * NO event-loop progress from the holder (FinalSecurityGate): a supervisor
 * blocked >5s in synchronous delivery must still be identifiable, or an
 * external stop could never reach it. Proof = durable metadata written by
 * the bind holder PLUS a kernel-level connect success on the socket (the
 * backlog completes it without an accept), with the metadata and the socket
 * incarnation (dev:ino) read on BOTH sides of the connect. Because a
 * filesystem may hand a fresh bind a just-freed inode number, inode
 * equality alone is not incarnation proof: every bind+publish runs under
 * the O_EXCL claim, and this probe resolves null whenever a LIVE claimant
 * exists — the claim check after the connect PRECEDES the second metadata
 * read, so any unlink/rebind that could have swapped the socket has either
 * finished publishing (the second read then sees the successor's metadata →
 * mismatch) or is still claimed (→ null). Callers re-observe on null; a
 * null lease NEVER licenses trusting a sentinel PID. Stale crash metadata
 * is harmless: the connect fails. An identity-less holder (stop's transient
 * lock) clears predecessor metadata at bind, so its live socket can never
 * vouch for a dead supervisor's identity.
 */
export async function leaseRunLockIdentity(runDir: string): Promise<RunLockLease | null> {
  const sockPath = runLockPath(runDir);
  const claimPath = `${sockPath}.claim`;
  if (liveClaimHolder(claimPath)) return null;
  const before = readLockMetadata(sockPath);
  if (before === null || before.sock !== socketIncarnation(sockPath)) return null;
  const conn = net.connect(sockPath);
  const connected = deferred<boolean>();
  conn.once("connect", () => connected.resolve(true));
  conn.on("error", () => connected.resolve(false)); // post-lease errors are release signals; 'close' follows
  conn.setTimeout(1000, () => connected.resolve(false));
  if (!(await connected.promise)) {
    conn.destroy();
    return null;
  }
  conn.setTimeout(0);
  conn.resume(); // the holder writes nothing; discard any bytes unbuffered
  if (liveClaimHolder(claimPath)) {
    conn.destroy();
    return null;
  }
  const after = readLockMetadata(sockPath);
  if (
    after === null ||
    after.pid !== before.pid ||
    after.nonce !== before.nonce ||
    after.runId !== before.runId ||
    after.sock !== before.sock ||
    socketIncarnation(sockPath) !== before.sock
  ) {
    conn.destroy();
    return null;
  }
  let closed = false;
  const release = deferred<void>();
  conn.once("close", () => {
    closed = true;
    release.resolve();
  });
  return {
    identity: { pid: after.pid, runId: after.runId, nonce: after.nonce },
    released: release.promise,
    isReleased: () => closed,
    requestStop: () => {
      if (closed || conn.destroyed) return false;
      try {
        conn.write("stop\n");
        return true;
      } catch {
        return false; // torn down under us — the close event follows
      }
    },
    close: () => conn.destroy(),
  };
}

/** One-shot identity read: a lease acquired and immediately closed. */
export async function probeRunLockIdentity(runDir: string): Promise<RunLockIdentity | null> {
  const lease = await leaseRunLockIdentity(runDir);
  if (lease === null) return null;
  lease.close();
  return lease.identity;
}

const DARWIN_O_EXLOCK = 0x20;

function darwinClaimHeld(claimPath: string): boolean {
  try {
    if (!lstatSync(claimPath).isFile()) return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  try {
    const fd = openSync(
      claimPath,
      fsConstants.O_RDWR | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW | DARWIN_O_EXLOCK,
    );
    closeSync(fd);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EAGAIN" || code === "EWOULDBLOCK" || code !== "ENOENT";
  }
}

/**
 * Is the bind/publication claim held by a LIVE process right now? Probers
 * exclude live-claim windows (and fail CLOSED on anything unprovable):
 * while a claimant is mid-(unlink/rebind/publish) no socket+metadata
 * observation is coherent. A dead claimant's leftover never blocks probing.
 */
function liveClaimHolder(claimPath: string): boolean {
  if (process.platform === "darwin") return darwinClaimHeld(claimPath);
  let raw: string;
  try {
    raw = readlinkSync(claimPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT"; // absent = no claim; unreadable = fail closed
  }
  let owner: z.infer<typeof RunLockClaim> | null = null;
  try {
    const parsed = RunLockClaim.safeParse(JSON.parse(raw));
    owner = parsed.success ? parsed.data : null;
  } catch {
    owner = null;
  }
  if (owner === null) return true; // unparseable claim: unprovable owner, fail closed
  if (!pidAlive(owner.pid)) return false;
  const birth = processBirthToken(owner.pid);
  return birth === null || birth === owner.birth;
}

const RunLockClaim = z.object({
  pid: z.number().int().positive(),
  birth: z.string().min(1),
  nonce: z.string().uuid(),
});

/** Linux/fallback process identity for the legacy non-Darwin claim path. */
export function processBirthToken(pid: number): string | null {
  if (!pidAlive(pid)) return null;
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const fields = close < 0 ? [] : raw.slice(close + 2).trim().split(/\s+/);
      const started = fields[19];
      if (started !== undefined && started !== "") return `linux:${started}`;
    } catch {
      // Fall through to ps; a lookup failure for a live PID fails closed.
    }
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value === "" ? null : `${process.platform}:${value}`;
}

/**
 * Atomic claim ownership is encoded in a symlink target—creation publishes
 * pid+birth+nonce in one syscall. A live/SIGSTOP'd owner is never expired.
 */
function tryAcquireRunLockClaim(claimPath: string): (() => void) | null {
  if (process.platform === "darwin") {
    try {
      if (lstatSync(claimPath).isFile() === false) return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    try {
      const fd = openSync(
        claimPath,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW | DARWIN_O_EXLOCK,
        0o600,
      );
      // The pathname deliberately persists. The advisory lock is tied to
      // this fd and released by the kernel on close/process death; unlinking
      // would let a successor lock a different inode concurrently.
      return () => closeSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return null;
      throw err;
    }
  }
  const birth = processBirthToken(process.pid);
  if (birth === null) throw new Error("cannot establish this process's run-lock claim identity");
  const payload = JSON.stringify({ pid: process.pid, birth, nonce: randomUUID() });
  try {
    symlinkSync(payload, claimPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let owner: z.infer<typeof RunLockClaim> | null = null;
    try {
      const parsed = RunLockClaim.safeParse(JSON.parse(readlinkSync(claimPath)));
      owner = parsed.success ? parsed.data : null;
    } catch {
      // A non-symlink claim may belong to an older live binary. Fail closed:
      // never age-expire an owner whose liveness cannot be proved.
      try {
        if (!lstatSync(claimPath).isSymbolicLink()) return null;
      } catch {
        return null;
      }
    }
    if (owner !== null && pidAlive(owner.pid)) {
      const currentBirth = processBirthToken(owner.pid);
      if (currentBirth === null || currentBirth === owner.birth) return null;
    }
    rmSync(claimPath, { force: true });
    return null;
  }
  return () => {
    try {
      if (readlinkSync(claimPath) === payload) rmSync(claimPath, { force: true });
    } catch {
      // Already removed only after this process died—which cannot resume.
    }
  };
}

/**
 * OS-enforced exclusive per-run lock (FinalSecurityGate finding 2): a bound
 * unix-domain socket. Liveness is the kernel accepting a connection — the
 * pid file is display metadata only (pids recycle). Bind is the atomic
 * arbiter, and EVERY bind + metadata publication runs under the O_EXCL
 * claim so identity probes can exclude in-flight publication windows
 * (dev:ino alone cannot prove incarnation — inode numbers may be reused).
 * A stale leftover may be unlinked ONLY under the claim and ONLY after a
 * re-probe under that claim; a socket can become live only by binding an
 * ABSENT path, and absence is only ever created by a claim holder, so no
 * contender can ever unlink a live lock. An identity-bearing holder
 * publishes {pid,runId,nonce,sock} beside the socket (see
 * probeRunLockIdentity) and treats any byte received on an accepted
 * connection as a trusted stop request (`onStopRequest`). Returned closure
 * releases and unlinks.
 */
export async function acquireRunLock(
  runDir: string,
  runId: string,
  identity?: RunLockIdentity,
  onStopRequest?: () => void,
): Promise<() => Promise<void>> {
  const sockPath = runLockPath(runDir);
  const metaPath = runLockMetaPath(sockPath);
  const claimPath = `${sockPath}.claim`;
  const alreadySupervised = (): UsageError =>
    new UsageError(`run ${runId} is already being supervised by a live process — \`hone stop\` it first`);
  for (let attempt = 0; attempt < 10; attempt++) {
    const releaseClaim = tryAcquireRunLockClaim(claimPath);
    if (releaseClaim === null) {
      await sleep(25);
      continue;
    }
    let acquired: (() => Promise<void>) | null = null;
    try {
      // Incoming probe/lease connections are HELD OPEN as leases: their
      // close is the holder's release/death signal (see RunLockLease), and
      // any byte received is a stop request — identification itself needs
      // no accept-handler progress (the kernel backlog completes the
      // connect). Every lease is destroyed at release and unref'd at
      // accept, so it can neither outlive the lock nor keep a finished
      // supervisor alive.
      let releasing = false;
      const leases = new Set<net.Socket>();
      const server = net.createServer((sock) => {
        if (releasing) {
          sock.destroy();
          return;
        }
        leases.add(sock);
        sock.once("close", () => leases.delete(sock));
        sock.on("error", () => {}); // a prober may reset mid-teardown
        sock.unref();
        // Stop command channel: consume (never buffer) incoming bytes; a
        // payload from a prober carries the same local same-user authority
        // a SIGTERM would — but reaches ONLY this holder, never a recycled
        // PID. Queued bytes survive a blocked event loop.
        sock.on("data", () => {
          if (onStopRequest !== undefined) onStopRequest();
        });
      });
      server.unref(); // the lock must never keep a finished supervisor alive
      const bound = deferred<boolean>();
      server.once("error", (err) => {
        if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") bound.resolve(false);
        else bound.reject(err);
      });
      server.listen(sockPath, () => bound.resolve(true));
      if (!(await bound.promise)) {
        // Occupied path, probed UNDER our claim: a live holder refuses; a
        // dead leftover is cleared (metadata FIRST — while the stale socket
        // path exists nobody can bind, so this can never delete a
        // successor's metadata), then the next attempt re-claims and binds.
        if (await connectProbe(sockPath, true)) throw alreadySupervised();
        rmSync(metaPath, { force: true });
        rmSync(sockPath, { force: true });
        continue;
      }
      // Ownership token for the path-CAS at release (server.close stops the
      // listener BEFORE its callback fires, so the callback may only ever
      // unlink THIS bind's inode, never whatever the path holds by then).
      const sockStat = statSync(sockPath, { bigint: true });
      // Publication happens UNDER the claim: probers treat a live claim as
      // "no coherent identity yet", which closes the bind-to-publish gap
      // even when the filesystem reuses a just-freed socket inode. An
      // identity-less holder (stop's transient lock) instead clears any
      // predecessor leftover — stale crash metadata plus OUR live socket
      // must never confirm a dead supervisor's (possibly recycled) PID.
      if (identity !== undefined) writeLockMetadata(sockPath, { ...identity, sock: `${sockStat.dev}:${sockStat.ino}` });
      else rmSync(metaPath, { force: true });
      acquired = () => {
        const closed = deferred<void>();
        releasing = true;
        server.close(() => {
          // Post-close cleanup runs under the SAME O_EXCL claim as
          // publication and stale arbitration. No claim (a live claimant is
          // mid-reclaim): remove NOTHING — the claimant owns clearing our
          // now-dead leftovers. Each removal is ownership-guarded on its
          // own: the socket only by dev+ino equality with OUR bind, the
          // metadata only by exact identity match — a successor's socket or
          // metadata is never removed.
          const releaseCleanupClaim = tryAcquireRunLockClaim(claimPath);
          if (releaseCleanupClaim === null) {
            closed.resolve();
            return;
          }
          try {
            if (identity !== undefined) {
              const current = readLockMetadata(sockPath);
              if (current !== null && current.pid === identity.pid && current.nonce === identity.nonce && current.runId === identity.runId) {
                rmSync(metaPath, { force: true });
              }
            }
            try {
              const now = statSync(sockPath, { bigint: true });
              if (now.dev === sockStat.dev && now.ino === sockStat.ino) rmSync(sockPath, { force: true });
            } catch {
              // already gone — a claimant cleared it before our claim
            }
          } finally {
            releaseCleanupClaim();
          }
          closed.resolve();
        });
        // Release/death signal for every held lease — server.close cannot
        // complete while any accepted connection remains open.
        for (const sock of leases) sock.destroy();
        return closed.promise;
      };
    } finally {
      releaseClaim();
    }
    if (acquired !== null) return acquired;
  }
  throw new Error(`run lock ${sockPath}: could not acquire after repeated stale-rebind attempts`);
}

function exhaustedBudgetDimension(budget: BudgetState): string | null {
  if (budget.spent.tokens >= budget.envelope.maxTokens) return "tokens";
  if (budget.spent.usd >= budget.envelope.maxUsd) return "usd";
  if (budget.spent.wallClockSec >= budget.envelope.maxWallClockSec) return "wallClockSec";
  if (budget.spent.evaluatorInvocations >= budget.envelope.maxEvaluatorInvocations) return "evaluatorInvocations";
  return null;
}

/** Wall budget is measured from run.started, including time spent offline between supervisors. */
export function remainingWallBudgetMs(
  maxWallClockSec: number,
  lastSpentWallSec: number,
  runStartedAt: string | undefined,
  nowMs: number = Date.now(),
): number {
  const parsedStart = runStartedAt === undefined ? Number.NaN : Date.parse(runStartedAt);
  const elapsedSinceStart = Number.isFinite(parsedStart) ? Math.max(0, (nowMs - parsedStart) / 1000) : 0;
  const spent = Math.max(lastSpentWallSec, elapsedSinceStart);
  return Math.max(0, (maxWallClockSec - spent) * 1000);
}

/** Frozen inputs superviseRun carries beside the plan (all admission-derived). */
export interface SuperviseExtra {
  manifest: CapsuleManifest;
  capsuleDir: string;
  capsuleDigest: string;
  optimizerDigest: string;
  orderingReport: DiagnosticOrderingReport;
  /** Candidate-selected merged captured closure. */
  optimizerSnapshot?: OptimizerSnapshot | undefined;
  /** Exact default/campaign seed closure captured during admission. */
  optimizerBaseSnapshot?: OptimizerSnapshot | undefined;
  /** Exact durable selection receipt, or null/absent for the M0 default optimizer. */
  optimizerArtifactSeal?: OptimizerArtifactSeal | null | undefined;
  measurementEpoch?: string | undefined;
  evaluationStrategy?: TrustedEvaluationStrategy | undefined;
  optimizerEpisodesMax?: number | undefined;
  maxPublicCandidateEvaluations?: number | undefined;
  campaignConfigHash?: `sha256:${string}` | undefined;
  trustedValidPublicCandidateTarget?: number | undefined;
  terminalHoldoutAssetGroupIds?: readonly string[] | undefined;
  recursiveBroker?: BrokerRecursiveConfig | undefined;
  corpus?: BrokerCorpusConfig | undefined;
  corpusCohort?: CorpusCohortBinding | undefined;
  proxyRole?: M2ProxyRole | undefined;
  campaignPauseAuthority?: CampaignPauseAuthority | undefined;
  admissionReview?: "required" | "off" | undefined;
}

/** Late-binding relay from the run lock's stop channel to the supervisor's signal handler. */
interface SupervisorStopChannel {
  bind(handler: () => void): void;
}

/** Exported for the late-contender lock regression only. */
export async function superviseRun(
  plan: RunPlan,
  extra: SuperviseExtra,
  io: CmdIo,
): Promise<number> {
  // The lock precedes ANY event append or docker sweep: a competing resume
  // must fail before it can touch the log or rm -f live containers. The
  // lock publishes this supervisor's identity metadata; the sentinel
  // repeats the nonce, so `stop` only ever trusts a PID the live lock
  // holder vouches for — and the lock's lease connections double as the
  // trusted stop channel (`stop` never signals a PID at all).
  const identity: RunLockIdentity = { pid: process.pid, runId: plan.runId, nonce: randomUUID() };
  // A stop request arriving before superviseLocked installs its handlers is
  // BUFFERED, never dropped: the relay replays a pending request at bind.
  let stopPending = false;
  let stopHandler: (() => void) | null = null;
  const stopChannel: SupervisorStopChannel = {
    bind: (handler) => {
      stopHandler = handler;
      if (stopPending) {
        stopPending = false;
        handler();
      }
    },
  };
  const releaseLock = await acquireRunLock(plan.runDir, plan.runId, identity, () => {
    if (stopHandler !== null) stopHandler();
    else stopPending = true;
  });
  try {
    // The resume plan was chosen BEFORE the lock: a contender that planned
    // against an unfinished log can acquire only after the winner released —
    // by then the run may have finished. Re-validate under the lock, before
    // any append or sweep, or a late contender re-runs a settled run.
    if (plan.resumed && replayRun(plan.runDir).finished !== null) {
      throw new UsageError(`run ${plan.runId} already finished — nothing to resume`);
    }
    return await superviseLocked(plan, extra, io, identity.nonce, stopChannel);
  } finally {
    await releaseLock();
  }
}

async function superviseLocked(
  plan: RunPlan,
  extra: SuperviseExtra,
  io: CmdIo,
  nonce: string,
  stopChannel: SupervisorStopChannel,
): Promise<number> {
  const { runId, runDir, config } = plan;
  const { manifest, capsuleDir, capsuleDigest, optimizerDigest } = extra;
  const headless = config.headless;
  const casDir = casRoot(io.root);
  mkdirSync(casDir, { recursive: true });
  // Durable last-supervisor metadata, written ONLY while holding the run
  // lock and NEVER unlinked — not even at exit. An exit-time unlink is a
  // path-CAS race: after this supervisor releases the lock, the next one
  // overwrites the file, and a late exit hook would delete the SUCCESSOR's
  // sentinel. A dead/stale sentinel is tiny and safe (same semantics as a
  // SIGKILL leftover); consumers gate on pidAlive AND the lock identity
  // probe (a bare PID is meaningless — PIDs recycle, nonces do not).
  writeFileSync(join(runDir, SUPERVISOR_FILE), `${JSON.stringify({ pid: process.pid, runId, nonce })}\n`);
  const initialReplay = replayRun(runDir);

  // Terminal-status flags, declared BEFORE the emit closure (TDZ) so it can
  // normalize a broker-authored budget.exhausted into the terminal status.
  let budgetDimension: string | null = initialReplay.budgetExhaustedDimension;
  let budgetEventLogged = budgetDimension !== null;
  let stopRequested = false;
  // Bound after the AbortController/termination barrier exist. Broker events
  // cannot arrive before backend.start, so this placeholder is never the
  // active path; it keeps event normalization linear during setup.
  let requestBudgetAbort = (dimension: string): void => {
    budgetDimension ??= dimension;
  };

  let liveBudget = initialReplay.lastBudget;
  const emit = (event: RunEvent): RunEvent => {
    const parsed = appendEvent(runDir, event);
    if (parsed.type === "budget.snapshot") {
      liveBudget = parsed.budget;
      const dimension = exhaustedBudgetDimension(parsed.budget);
      if (dimension !== null) requestBudgetAbort(dimension);
    }
    if (parsed.type === "budget.exhausted") {
      // Trusted broker budget authority: ANY logged exhaustion normalizes the
      // terminal/report status to "budget" and immediately aborts the whole
      // registered process tree. An explicit operator stop still wins status.
      budgetEventLogged = true;
      requestBudgetAbort(parsed.dimension);
    }
    if (headless) {
      io.out(JSON.stringify(parsed));
    } else if (parsed.type === "incumbent.new") {
      // Anytime surface: new-incumbent line with budget burn-down in the attached stream.
      io.out(`new incumbent ${parsed.artifact.hash} — aggregate ${parsed.aggregate} (Δ ${formatDelta(parsed.deltaVsBaseline)}) @ episode ${parsed.episode} | ${formatSpend(liveBudget)}`);
    } else if (parsed.type === "run.started") {
      io.out(`run ${runId} started (capsule ${parsed.capsuleId})`);
    } else if (parsed.type === "run.resumed") {
      io.out(`run ${runId} resumed from cursor ${parsed.fromCursor}`);
    } else if (parsed.type === "budget.exhausted") {
      io.out(`budget exhausted: ${parsed.dimension}`);
    }
    return parsed;
  };

  // Set under lock while validating a resume: a durably sealed optimizer
  // completion means this supervisor performs ONLY delivery/terminal work.
  let optimizerAlreadyComplete = false;
  try {
    assertOptimizerArtifactSeal(runDir, extra.optimizerArtifactSeal ?? null);
  } catch (error) {
    io.err(`${plan.resumed ? "resume seal" : "optimizer artifact seal"} violated: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (plan.resumed) {
    // Under-lock seal verification (the plan was chosen from PRE-lock
    // reads): runconfig.json, contract.md, the run.started contract hash,
    // the sealed delivery target, and the capsule/optimizer/backend/headless
    // seals must all still hold before run.resumed is appended or any
    // backend launches. Tamper refuses with NO event and NO terminal — the
    // run stays resumable as-is.
    const underLock = replayRun(runDir);
    let sealedTarget: DeliveryTarget | null = null;
    if (config.apply !== "none") {
      try {
        sealedTarget = readSealedDeliveryTarget(io.root, runDir, config.apply);
      } catch (e) {
        io.err(`resume seal violated: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      if (sealedTarget === null) {
        io.err(`resume seal violated: run delivers (apply=${config.apply}) but has no sealed ${DELIVERY_TARGET_FILE}`);
        return 1;
      }
    }
    const sealError = resumeSealError({
      runId,
      runDir,
      config,
      manifest,
      capsuleDigest,
      optimizerDigest,
      orderingReport: extra.orderingReport,
      deliveryTarget: sealedTarget,
      sealedContractHash: underLock.contractHash,
      sealedOptimizerDigest: underLock.optimizerDigest,
    });
    if (sealError !== null) {
      io.err(`resume seal violated: ${sealError}`);
      return 1;
    }
    try {
      optimizerAlreadyComplete = optimizerCompleteForRun(runDir, runId);
    } catch (e) {
      io.err(`resume seal violated: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    // The run-local asset tree is the only capsule asset authority accepted
    // after admission. Authenticate it while holding the run lock, after all
    // flag/config seals but before run.resumed or any backend work.
    authenticateFrozenCapsuleAssets(runDir, manifest);
    // Boot-bound runtime recheck IMMEDIATELY before the durable run event:
    // recompute the closure, compare against the boot seal and the run's
    // pin, then append — no await between the comparison and the append.
    const campaignFenceError = campaignSessionFenceError(
      runDir,
      extra.campaignConfigHash,
      extra.proxyRole,
      extra.campaignPauseAuthority,
      extra.corpus,
      extra.corpusCohort,
    );
    if (campaignFenceError !== null) {
      io.err(`resume campaign seal violated: ${campaignFenceError}`);
      return 1;
    }
    assertRuntimePinFresh(runDir, runId);
    emit({ runId, at: new Date().toISOString(), type: "run.resumed", fromCursor: underLock.cursor });
  } else {
    // Boot-bound runtime recheck immediately before the durable run.started
    // append (the pin was written from the same boot seal in runCommand; a
    // direct superviseRun caller may not have written one, so only drift
    // from the boot seal refuses here). No await before the append.
    const campaignFenceError = campaignSessionFenceError(
      runDir,
      extra.campaignConfigHash,
      extra.proxyRole,
      extra.campaignPauseAuthority,
      extra.corpus,
      extra.corpusCohort,
    );
    if (campaignFenceError !== null) {
      io.err(`campaign admission refused: ${campaignFenceError}`);
      return 1;
    }
    verifiedBootRuntimeDigest();
    emit({
      runId,
      at: new Date().toISOString(),
      type: "run.started",
      capsuleId: manifest.id,
      contractHash: contractHash(readFileSync(join(runDir, CONTRACT_FILE), "utf8")),
      ...(extra.campaignConfigHash !== undefined ? { campaignConfigHash: extra.campaignConfigHash } : {}),
      optimizerDigest,
    });
  }

  const replayed = replayRun(runDir);
  // The backend is the SEALED one from the run config — never a flag. A
  // durably sealed optimizer completion skips the backend outright: no
  // optimizer rerun, no container/broker/proxy resource is ever spawned.
  const backend = optimizerAlreadyComplete ? null : await loadBackend(config.backend, io.root, io.env);

  const abort = new AbortController();
  const children = new Set<ChildLike>();
  const timers: NodeJS.Timeout[] = [];
  const graceMs = Number(io.env["HONE_KILL_GRACE_MS"] ?? 5000);

  // Watchdog timers stay referenced (they must keep a headless process alive
  // while a listener-only backend waits); every one is cleared in the finally.
  const armTimer = (fn: () => void, ms: number): void => {
    timers.push(setTimeout(fn, ms));
  };
  /**
   * Idempotent termination barrier, deliberately OUTSIDE the generic timer
   * pool: SIGTERM every registered child group, wait the grace, SIGKILL,
   * then a short reap settle. A settling backend promise must NEVER cancel
   * the escalation — the optimizer leader exiting can leave a TERM-ignoring
   * descendant that only the delayed group SIGKILL removes. Any abort path
   * awaits this barrier before delivery and the terminal event.
   */
  let terminationBarrier: Promise<void> | null = null;
  const termThenKill = (): Promise<void> => {
    terminationBarrier ??= (async () => {
      for (const child of children) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      await sleep(graceMs);
      for (const child of children) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      // Confirm the leaders are reaped (descendants die with the group kill).
      const settleDeadline = Date.now() + 2000;
      while (Date.now() < settleDeadline && [...children].some((c) => typeof c.pid === "number" && pidAlive(c.pid))) {
        await sleep(50);
      }
    })();
    return terminationBarrier;
  };
  requestBudgetAbort = (dimension: string): void => {
    budgetDimension ??= dimension;
    if (!abort.signal.aborted) abort.abort(new Error(`budget exhausted: ${dimension}`));
    void termThenKill();
  };
  // A broker-authored exhaustion may have been public-log durable before a
  // crash. Re-latch the abort before backend.start, and remember that the
  // public event already exists so terminalization never emits a duplicate.
  if (budgetDimension !== null && !abort.signal.aborted) {
    abort.abort(new Error(`budget exhausted: ${budgetDimension}`));
  }

  // Wall clock is run lifetime, not supervisor uptime: resume includes the
  // offline interval since the durable run.started timestamp.
  const runStartedAt = readEvents(runDir).find((event) => event.type === "run.started")?.at;
  const spentWallSec = replayed.lastBudget?.spent.wallClockSec ?? 0;
  const remainMs = remainingWallBudgetMs(config.budget.maxWallClockSec, spentWallSec, runStartedAt);
  armTimer(() => requestBudgetAbort("wallClockSec"), remainMs);

  const onSignal = (): void => {
    stopRequested = true;
    abort.abort(new Error("stop requested"));
    void termThenKill();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  // The lock's lease connections carry trusted stop requests (`hone stop`
  // never signals a PID); a request buffered before this bind fires now.
  stopChannel.bind(onSignal);

  // Terminal-order fence: once the backend settled or the hard-stop deadline
  // passed, a late ctx.emit from an abort-ignoring backend (or a straggler
  // optimizer event) must never reach the log or stdout — run.finished is
  // the final event. The supervisor's own emit stays unfenced.
  let backendFenced = false;
  // Trusted-authority barrier: null = backend never registered = ready.
  let authorityBarrier: Promise<void> | null = null;
  // Full-teardown barrier: null = backend never registered = clean.
  let cleanupBarrier: Promise<void> | null = null;
  const ctx: RunnerBackendContext = {
    runId,
    root: io.root,
    runDir,
    casDir,
    capsuleDir,
    manifest,
    config,
    env: io.env,
    capsuleDigest,
    optimizerDigest,
    ...(extra.optimizerSnapshot !== undefined ? { optimizerSnapshot: extra.optimizerSnapshot } : {}),
    ...(extra.optimizerBaseSnapshot !== undefined ? { optimizerBaseSnapshot: extra.optimizerBaseSnapshot } : {}),
    ...(extra.measurementEpoch !== undefined ? { measurementEpoch: extra.measurementEpoch } : {}),
    ...(extra.evaluationStrategy !== undefined ? { evaluationStrategy: extra.evaluationStrategy } : {}),
    ...(extra.optimizerEpisodesMax !== undefined ? { optimizerEpisodesMax: extra.optimizerEpisodesMax } : {}),
    ...(extra.maxPublicCandidateEvaluations !== undefined
      ? { maxPublicCandidateEvaluations: extra.maxPublicCandidateEvaluations }
      : {}),
    ...(extra.trustedValidPublicCandidateTarget !== undefined
      ? { trustedValidPublicCandidateTarget: extra.trustedValidPublicCandidateTarget }
      : {}),
    ...(extra.terminalHoldoutAssetGroupIds !== undefined
      ? { terminalHoldoutAssetGroupIds: extra.terminalHoldoutAssetGroupIds }
      : {}),
    ...(extra.proxyRole !== undefined ? { proxyRole: extra.proxyRole } : {}),
    ...(extra.campaignPauseAuthority !== undefined ? { campaignPauseAuthority: extra.campaignPauseAuthority } : {}),
    ...(extra.admissionReview !== undefined ? { admissionReview: extra.admissionReview } : {}),
    ...(extra.recursiveBroker !== undefined ? { recursiveBroker: extra.recursiveBroker } : {}),
    ...(extra.corpus !== undefined ? { corpus: extra.corpus } : {}),
    replayed,
    signal: abort.signal,
    emit: (event) => (backendFenced ? RunEvent.parse(event) : emit(event)),
    registerChild: (child) => {
      children.add(child);
      return () => {
        children.delete(child);
      };
    },
    probeGate: (report) => (headless ? Promise.resolve(headlessProbeVerdict(report)) : promptProbe(report, io, abort.signal)),
    requestStop: () => onSignal(),
    registerAuthorityBarrier: (barrier) => {
      authorityBarrier = barrier;
      // A rejection may land before anything awaits it — keep it handled.
      void barrier.catch(() => {});
    },
    registerCleanupBarrier: (barrier) => {
      cleanupBarrier = barrier;
      void barrier.catch(() => {});
    },
  };

  let failure: Error | null = null;
  let authorityFailure: Error | null = null;
  try {
    if (backend !== null) {
      try {
        const settled = backend
          .start(ctx)
          .then(() => undefined)
          .catch((e: unknown) => {
            failure = e instanceof Error ? e : new Error(String(e));
          });
        // If the backend ignores the abort, proceed after the kill grace anyway.
        const hardStop = deferred<void>();
        abort.signal.addEventListener("abort", () => armTimer(hardStop.resolve, graceMs + 1000), { once: true });
        await Promise.race([settled, hardStop.promise]);
      } finally {
        // A hard-stopped backend may STILL be recovering durable authority
        // (slow pre-reconcile docker setup): the fence must stay open until
        // the barrier settles, or the recovered incumbent emit is dropped and
        // the terminal best seals stale state.
        try {
          if (authorityBarrier !== null) await authorityBarrier;
        } catch (e) {
          authorityFailure = e instanceof Error ? e : new Error(String(e));
        }
        backendFenced = true;
      }
    }

    // Termination is not only for aborts: a FAILED backend (or one whose
    // trusted authority could not be recovered) may have left process groups
    // behind — every registered child is TERM'd, KILL'd after grace, and
    // confirmed reaped before anything else happens. On the success path the
    // barrier still runs whenever an abort landed: a TERM-ignoring
    // descendant must never outlive delivery or the terminal event.
    if (abort.signal.aborted || failure !== null || authorityFailure !== null) await termThenKill();

    /**
     * Full-teardown gate: the supervisor never delivers, emits run.finished,
     * or returns while backend resources (optimizer/build containers,
     * broker, proxy, egress, temp snapshots) may still be open. A rejected
     * or timed-out barrier means cleanup is incomplete — the run is left
     * WITHOUT a terminal event, resumable after the operator intervenes.
     */
    const awaitCleanup = async (): Promise<Error | null> => {
      if (cleanupBarrier === null) return null;
      try {
        // The per-run lock remains held until teardown actually settles.
        // A local timeout would only release the lock while Docker work was
        // still mutating the same run, allowing a resumed supervisor to race.
        await cleanupBarrier;
        return null;
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    };

    if (authorityFailure !== null) {
      // Trusted authority could not be established: sealing the run now
      // would terminalize stale state. No delivery, no run.finished — the
      // run stays resumable.
      const cleanupFailure = await awaitCleanup();
      if (cleanupFailure !== null) io.err(`backend cleanup incomplete: ${cleanupFailure.message}`);
      io.err(`trusted authority recovery failed: ${authorityFailure.message} — run left unfinished (resume with \`hone run --resume\`)`);
      return 1;
    }

    const cleanupFailure = await awaitCleanup();
    if (cleanupFailure !== null) {
      io.err(`backend cleanup incomplete: ${cleanupFailure.message} — run left unfinished (resume with \`hone run --resume\`)`);
      return 1;
    }

    if (failure !== null) {
      const err: Error = failure;
      io.err(`backend failed: ${err.message}`);
    }

    const preFinish = replayRun(runDir);
    const best = preFinish.incumbent?.artifact ?? null;

    // Durable optimizer-completion seal: the backend settled successfully
    // and every registered resource is torn down — from here only delivery
    // and the terminal event remain. A later resume (delivery refused,
    // ladder re-locked, target temporarily invalid) skips the optimizer
    // entirely and retries delivery from the sealed incumbent.
    if (failure === null && !stopRequested && budgetDimension === null && config.apply !== "none" && best !== null && !existsSync(join(runDir, OPTIMIZER_COMPLETE_FILE))) {
      writeFileDurable(join(runDir, OPTIMIZER_COMPLETE_FILE), `${JSON.stringify({ runId, at: new Date().toISOString() })}\n`);
    }

    if (
      preFinish.delivery !== null
      && (preFinish.delivery.mode !== config.apply || best === null)
    ) {
      throw new Error(
        `durable delivery outcome is inconsistent with sealed apply mode ${config.apply} and incumbent state`,
      );
    }

    // Delivery policy is per-run and immutable once started (contract 5).
    // Delivery runs BEFORE run.finished so the terminal event is always the
    // log's final line. An explicit stop that already landed skips automatic
    // delivery (`stop --take-best` is the deliberate path); the SIGTERM/
    // SIGINT handlers are still installed here, so a stop arriving during
    // the synchronous delivery is queued and handled — never the OS default
    // that would kill the supervisor mid-delivery with no terminal event.
    if (!stopRequested && failure === null && config.apply !== "none" && best !== null && preFinish.delivery === null) {
      // Automatic delivery targets ONLY the repository sealed at run
      // creation (`hone run --repo DIR`), re-validated fail-closed at use —
      // never a default root, never a target guessed at delivery time.
      let target: DeliveryTarget | null = null;
      let targetFailure: string | null = null;
      try {
        target = readSealedDeliveryTarget(io.root, runDir, config.apply);
        if (target === null) targetFailure = `run has no sealed ${DELIVERY_TARGET_FILE} — cannot deliver`;
      } catch (e) {
        targetFailure = e instanceof Error ? e.message : String(e);
      }
      if (target === null || targetFailure !== null) {
        // Terminal state must imply delivery durably succeeded. A failed
        // delivery therefore seals NO terminal: the run stays unfinished and
        // resumable, and a resume (or `hone apply`) completes it later.
        io.err(
          `delivery (${config.apply}) failed: ${targetFailure ?? "unvalidated target"} — run left unfinished (resume with \`hone run --resume\`, or deliver via \`hone apply --repo\`)`,
        );
        return 1;
      }
      const sealedDelivery = target;
      try {
        const result = deliver({
          mode: config.apply,
          repo: sealedDelivery.repo,
          ...(sealedDelivery.gitDir !== undefined ? { gitDir: sealedDelivery.gitDir } : {}),
          ...(sealedDelivery.autoRef !== undefined ? { autoRef: sealedDelivery.autoRef } : {}),
          baselineCommit: sealedDelivery.baselineCommit,
          runId,
          runDir,
          artifact: best.hash,
          casDir,
          improverSeat: config.improverSeat,
          env: io.env,
          // Immediately before every ref update the target must STILL be
          // the sealed filesystem incarnation (dev:ino + in-store marker).
          verifyTarget: () => assertTargetIdentity(sealedDelivery),
        });
        emit({
          runId,
          at: new Date().toISOString(),
          type: "delivery.applied",
          mode: config.apply,
          ...(result.ref !== null ? { ref: result.ref } : {}),
        });
        for (const note of result.notes) io.err(note);
      } catch (e) {
        if (e instanceof LadderLockedError) {
          // The autonomy gate vanished between run approval and delivery:
          // refuse NONTERMINALLY — no ref moved, no terminal event. Restore
          // the gate and resume; delivery retries from the sealed incumbent
          // without rerunning the optimizer.
          io.err(
            `delivery (${config.apply}) refused: ${e.message} — run left unfinished (restore the autonomy gate and resume with \`hone run --resume\`)`,
          );
          return 3;
        } else {
          // Same rule as an unvalidatable target: no terminal on failure.
          io.err(
            `delivery (${config.apply}) failed: ${e instanceof Error ? e.message : String(e)} — run left unfinished (resume with \`hone run --resume\`, or deliver via \`hone apply --repo\`)`,
          );
          return 1;
        }
      }
    }

    // Drain the signal queue: a SIGTERM raised during the synchronous
    // delivery is only DISPATCHED in a later poll phase — a single
    // setImmediate can land in the same iteration's check phase and miss it
    // (verified empirically). A timer forces at least one full iteration
    // through poll, so the handler runs before the terminal status is
    // chosen: delivery finishes atomically, the run still stops.
    await sleep(25);

    // A signal that landed during delivery (or between backend settle and
    // the drain) started the barrier but nothing awaited it yet — the same
    // idempotent barrier guarantees children are reaped before the terminal.
    if (abort.signal.aborted) await termThenKill();

    if (extra.campaignPauseAuthority?.isCampaignPaused() === true) {
      io.err("campaign remains durably paused after backend teardown — run left unfinished for trusted resume");
      return 1;
    }
    let status: "completed" | "stopped" | "failed" | "budget";
    if (stopRequested) status = "stopped";
    else if (budgetDimension !== null) status = "budget";
    else if (failure !== null) status = "failed";
    else status = "completed";

    if (budgetDimension !== null && !budgetEventLogged) {
      emit({ runId, at: new Date().toISOString(), type: "budget.exhausted", dimension: budgetDimension });
    }

    emit({
      runId,
      at: new Date().toISOString(),
      type: "run.finished",
      ...(best !== null ? { best } : {}),
      status,
    });

    const report = exitReport(runId, replayRun(runDir));
    if (headless) {
      io.out(JSON.stringify(report));
    } else {
      for (const line of formatHumanReport(report, liveBudget)) io.out(line);
    }
    return status === "failed" ? 1 : 0;
  } finally {
    // Handlers and timers live through delivery, the terminal event, and the
    // report — removed only once no further trusted append can happen.
    for (const t of timers) clearTimeout(t);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    stopChannel.bind(() => {}); // late stop bytes after the terminal are inert
  }
}

export interface SupervisorSentinel {
  pid: number;
  /** Absent on legacy sentinels — such a PID can never be identity-confirmed. */
  nonce: string | undefined;
}

const SentinelSchema = z.object({ pid: z.number().int().positive(), nonce: z.string().min(1).optional() });

/** Durable last-supervisor metadata; a bare PID here is NEVER trusted without the lock-identity probe. */
export function readSupervisorSentinel(runDir: string): SupervisorSentinel | null {
  const path = join(runDir, SUPERVISOR_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = SentinelSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return { pid: parsed.pid, nonce: parsed.nonce };
  } catch {
    return null;
  }
}

/** Shared by `stop` and tests for pid-level checks. */
export function readSupervisorPid(runDir: string): number | null {
  return readSupervisorSentinel(runDir)?.pid ?? null;
}

/** True when `pid` names a live process (signal-0 probe) — shared by the stop and resume guards. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
