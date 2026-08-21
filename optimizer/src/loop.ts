import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactRef, BudgetState, EvaluationRecord, RunEvent } from "@hone/schema";
import { buildEpisodeContext, type FailureEvidence, type LineageEntry } from "../assets/context.js";
import { epsilonRestart, mutationTimeoutSec, oneRepair, trainAssetGroupId } from "../assets/policy.js";
import { BrokerClient, BrokerRpcError } from "./client.js";
import { EPISODE_JSON_PATH, parseMutateStdout, type EpisodeContext, type MutateResult } from "./episode.js";

/**
 * The seed episode loop: greedy incumbent + ε-restart + one-repair, driven
 * entirely through the broker wire protocol. This code is MUTABLE and
 * disposable by design — strategy constants live in assets/policy.ts, the
 * prompt surface in assets/prompts.ts + assets/context.ts.
 */

/**
 * Sandbox-local worker path: /scratch is the run's shared writable mount, so
 * the sealed bundle never touches /workspace (the artifact) and survives for
 * later sandboxes of the same run — each sandbox still hash-verifies before
 * exec and re-transfers on any mismatch.
 */
export const SANDBOX_WORKER_PATH = "/scratch/hone-worker.mjs";
/** Chunk staging dir inside the sandbox; removed by the assembly step. */
export const WORKER_PART_DIR = "/scratch/.hone-worker-parts";
/**
 * Raw bytes per putFile chunk: base64 (4/3 expansion) plus the JSON-RPC
 * envelope stays comfortably under the broker's 1 MiB frame cap.
 */
export const WORKER_CHUNK_BYTES = 512 * 1024;

/** Runtime directory is shared by the run's mutation sandboxes, never mounted into evaluators. */
export const SANDBOX_RUNTIME_DIR = "/scratch/.hone-runtime";
export const SANDBOX_BUN_PATH = `${SANDBOX_RUNTIME_DIR}/bun`;
/** Artifact-specific chunk staging lives outside the executable runtime directory. */
export const RUNTIME_PART_DIR = "/scratch/.hone-runtime-parts";
const MUTATION_RUNTIME_MANIFEST_FILE = "mutation-runtime.json";
const PI_RUNTIME_VERSION = "16.5.2";
export const PI_NATIVE_VARIANT = "baseline";

interface RuntimeManifestFile {
  sourceName: string;
  bundleName: string;
  sandboxName: string;
  sha256: string;
  mode: number;
}

interface MutationRuntimeManifest {
  version: 1;
  bun: RuntimeManifestFile & { version: string };
  pi: { version: string; files: RuntimeManifestFile[] };
}

function parseRuntimeManifest(bytes: Buffer): MutationRuntimeManifest {
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (parsed === null || typeof parsed !== "object") throw new Error("mutation runtime manifest is not an object");
  const manifest = parsed as Partial<MutationRuntimeManifest>;
  const validFile = (file: unknown, mode: number, sandboxName: RegExp): file is RuntimeManifestFile => {
    if (file === null || typeof file !== "object") return false;
    const candidate = file as Partial<RuntimeManifestFile>;
    return (
      typeof candidate.sourceName === "string" &&
      /^[A-Za-z0-9._-]+$/.test(candidate.sourceName) &&
      typeof candidate.bundleName === "string" &&
      /^[A-Za-z0-9._-]+\.gz$/.test(candidate.bundleName) &&
      typeof candidate.sandboxName === "string" &&
      sandboxName.test(candidate.sandboxName) &&
      typeof candidate.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(candidate.sha256) &&
      candidate.mode === mode
    );
  };
  if (
    manifest.version !== 1 ||
    manifest.bun?.version !== "1.3.14" ||
    !validFile(manifest.bun, 0o500, /^bun$/) ||
    manifest.pi?.version !== PI_RUNTIME_VERSION ||
    !Array.isArray(manifest.pi.files) ||
    manifest.pi.files.length !== 1 ||
    !validFile(manifest.pi.files[0], 0o400, /^pi_natives\.linux-x64-baseline\.node$/)
  ) {
    throw new Error("mutation runtime manifest does not match Bun 1.3.14 + Pi 16.5.2 linux/x64 baseline");
  }
  return manifest as MutationRuntimeManifest;
}

/** Margin subtracted from the exec timeout so the session yields before the broker kills it. */
const DEADLINE_MARGIN_SEC = 120;

export interface EpisodeLoopOptions {
  brokerSocket: string;
  runId: string;
  /** Validate + append to the run's event log (contract 4). */
  emit: (event: RunEvent) => RunEvent;
  /** Aborted on stop request; the loop winds down at the next checkpoint. */
  signal?: AbortSignal;
  /** Base seed for the ε-restart draw (NOT the evaluation seed, which is the episode number). */
  seed?: number;
  /** Resume state replayed from the event log; episodes below nextEpisode are never re-run. */
  resume?: {
    nextEpisode: number;
    incumbent: { artifact: ArtifactRef; aggregate: number } | null;
  };
  /**
   * Hard cap on outer episodes ATTEMPTED by this invocation, counted from the
   * resume ordinal: at most maxEpisodes loop iterations ever start, including
   * episodes discarded through an invalid `continue`. A resumed run always
   * gets its full allowance (crash-after-start resumes still probe once).
   * Must be a positive integer when present; anything else fails closed.
   */
  maxEpisodes?: number;
  /** M0 cache-safe mode: after one candidate evaluator admission, never repair/evaluate another candidate. */
  oneShotCandidate?: boolean;
  /** Test seam: uniform [0,1) draw per episode for the ε-restart decision. */
  rand?: (episode: number) => number;
  /**
   * Path of the sealed self-contained worker bundle. Defaults to worker.mjs
   * next to THIS module — inside the run container that is the sibling of
   * /hone/bundle/optimizer.mjs, i.e. the exact bytes the sealed build
   * emitted. Test seam only; nothing trusted ever picks a different worker.
   */
  workerBundlePath?: string;
  /** Directory containing the sealed compressed runtime artifacts; defaults beside workerBundlePath. */
  runtimeBundleDir?: string;
}

/** Mean of objective values — the same default scalarization as trusted/scoring. */
export function aggregateOf(record: EvaluationRecord): number {
  const values = Object.values(record.output.objectives);
  if (!record.output.valid || values.length === 0) return Number.NEGATIVE_INFINITY;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Deterministic uniform [0,1) keyed on (seed, episode) — mulberry32, one draw. */
export function episodeRand(seed: number, episode: number): number {
  let t = (seed * 0x9e3779b9 + (episode + 1) * 0x85ebca6b) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function exhaustedDimension(budget: BudgetState): string | null {
  const { envelope, spent } = budget;
  if (spent.tokens >= envelope.maxTokens) return "tokens";
  if (spent.usd >= envelope.maxUsd) return "usd";
  if (spent.wallClockSec >= envelope.maxWallClockSec) return "wallClockSec";
  if (spent.evaluatorInvocations >= envelope.maxEvaluatorInvocations) return "evaluatorInvocations";
  return null;
}

function tail(text: string, chars = 2000): string {
  return text.length > chars ? text.slice(text.length - chars) : text;
}

interface MutateAttempt {
  artifact: ArtifactRef | null;
  result: MutateResult | null;
  stdoutHash: string;
  failure: FailureEvidence | null;
}

export async function runEpisodeLoop(opts: EpisodeLoopOptions): Promise<void> {
  const maxEpisodes = opts.maxEpisodes;
  if (maxEpisodes !== undefined && (!Number.isSafeInteger(maxEpisodes) || maxEpisodes <= 0)) {
    throw new Error(`maxEpisodes must be a positive integer, got ${String(maxEpisodes)}`);
  }
  // The sealed built worker + platform-runtime bytes, shipped from THIS
  // invocation's bundle dir into mutation sandboxes. Read before anything
  // touches the broker so any missing or mismatched artifact fails closed.
  const workerBundlePath = opts.workerBundlePath ?? fileURLToPath(new URL("worker.mjs", import.meta.url));
  const runtimeBundleDir = opts.runtimeBundleDir ?? dirname(workerBundlePath);
  const workerBundle = readFileSync(workerBundlePath);
  const workerSha256 = createHash("sha256").update(workerBundle).digest("hex");
  const runtimeManifest = parseRuntimeManifest(readFileSync(join(runtimeBundleDir, MUTATION_RUNTIME_MANIFEST_FILE)));
  const compressedRuntime = [runtimeManifest.bun, ...runtimeManifest.pi.files].map((file) => {
    const bytes = readFileSync(join(runtimeBundleDir, file.bundleName));
    return {
      ...file,
      bytes,
      compressedSha256: createHash("sha256").update(bytes).digest("hex"),
      sandboxPath: `${SANDBOX_RUNTIME_DIR}/${file.sandboxName}`,
      partDir: `${RUNTIME_PART_DIR}/${file.sandboxName}`,
    };
  });
  console.error(
    JSON.stringify({
      type: "mutation.runtime",
      runId: opts.runId,
      worker: { path: SANDBOX_WORKER_PATH, sha256: workerSha256 },
      bun: {
        version: runtimeManifest.bun.version,
        path: SANDBOX_BUN_PATH,
        sha256: runtimeManifest.bun.sha256,
        compressedSha256: compressedRuntime[0]?.compressedSha256,
      },
      pi: {
        version: runtimeManifest.pi.version,
        variant: PI_NATIVE_VARIANT,
        files: compressedRuntime.slice(1).map((file) => ({
          path: file.sandboxPath,
          sha256: file.sha256,
          compressedSha256: file.compressedSha256,
        })),
      },
    }),
  );
  const broker = await BrokerClient.connect(opts.brokerSocket);
  const baseSeed = opts.seed ?? 0;
  const rand = opts.rand ?? ((episode: number) => episodeRand(baseSeed, episode));
  const emit = opts.emit;
  const now = () => new Date().toISOString();
  const base = { runId: opts.runId };

  try {
    const task = await broker.getTask();
    const assetGroupId = task.visibleAssetGroups.includes(trainAssetGroupId)
      ? trainAssetGroupId
      : task.visibleAssetGroups[0];
    if (assetGroupId === undefined) throw new Error("broker reported no visible asset groups");
    const recursiveTask = task.recursiveTask;
    if (recursiveTask !== undefined && recursiveTask.depth !== 0) {
      throw new Error(`seed recursive evaluation policy requires a depth-0 task, got depth ${recursiveTask.depth}`);
    }
    const recursivePlan = recursiveTask === undefined
      ? undefined
      : {
          allocations: recursiveTask.members.map((member, allocationOrdinal) => ({
            capsuleId: member.capsuleId,
            allocationOrdinal,
            innerEpisodesMax: recursiveTask.innerEpisodesMax,
            reservation: member.calibratedInnerCeiling,
          })),
        };

    const baseline = task.baselineArtifact;
    let incumbent = opts.resume?.incumbent ?? null;
    const lineage: LineageEntry[] = [];
    /** Latest trusted baseline aggregate, refreshed whenever the baseline is measured as parent or paired comparator. */
    let baselineAggregate: number | null = null;

    const evaluate = async (artifact: ArtifactRef, seed: number, episode: number): Promise<EvaluationRecord> => {
      const record = await broker.evaluate({
        artifact,
        assetGroupId,
        seed,
        ...(recursivePlan === undefined ? {} : { recursivePlan }),
      });
      emit({
        ...base,
        at: now(),
        type: "eval.completed",
        episode,
        artifact,
        assetGroupId,
        seed,
        aggregate: aggregateOf(record),
        cached: record.cached,
      });
      return record;
    };

    /**
     * Guarantee the sandbox holds the EXACT sealed worker and platform
     * runtime bytes before exec. /scratch is shared by every mutation sandbox
     * in the run, so hash-verified hits skip the large transfer; evaluators do
     * not mount this volume.
     */
    const ensureArtifact = async (
      sandboxId: string,
      artifact: {
        bytes: Buffer;
        sha256: string;
        sandboxPath: string;
        partDir: string;
        mode: number;
        compressed: boolean;
      },
    ): Promise<void> => {
      const probe = await broker.exec({ sandboxId, argv: ["sha256sum", artifact.sandboxPath], timeoutSec: 120 });
      if (probe.exitCode === 0 && probe.stdout.trimStart().startsWith(`${artifact.sha256}  ${artifact.sandboxPath}`)) return;
      const parts: string[] = [];
      for (let offset = 0, i = 0; offset < artifact.bytes.length; offset += WORKER_CHUNK_BYTES, i++) {
        const part = `${artifact.partDir}/${String(i).padStart(8, "0")}`;
        parts.push(part);
        await broker.putFile({
          sandboxId,
          path: part,
          contentBase64: artifact.bytes.subarray(offset, offset + WORKER_CHUNK_BYTES).toString("base64"),
        });
      }
      // Explicit part list (not a glob): stale parts from an interrupted
      // transfer can never leak into the assembled file.
      const materialize = artifact.compressed
        ? `(cat ${parts.join(" ")} | gzip -dc) > ${artifact.sandboxPath}`
        : `cat ${parts.join(" ")} > ${artifact.sandboxPath}`;
      const assemble = await broker.exec({
        sandboxId,
        argv: [
          "sh",
          "-c",
          `mkdir -p ${dirname(artifact.sandboxPath)} && ${materialize} && chmod ${artifact.mode.toString(8)} ${artifact.sandboxPath} && chmod 700 ${dirname(artifact.sandboxPath)} && rm -rf ${artifact.partDir} && sha256sum ${artifact.sandboxPath}`,
        ],
        timeoutSec: 300,
      });
      if (
        assemble.exitCode !== 0 ||
        !assemble.stdout.trimStart().startsWith(`${artifact.sha256}  ${artifact.sandboxPath}`)
      ) {
        throw new Error(
          `runtime artifact transfer to sandbox ${sandboxId} failed (exit ${assemble.exitCode}): expected ${artifact.sandboxPath} sha256 ${artifact.sha256}`,
        );
      }
    };

    const ensureWorker = async (sandboxId: string): Promise<void> => {
      await ensureArtifact(sandboxId, {
        bytes: workerBundle,
        sha256: workerSha256,
        sandboxPath: SANDBOX_WORKER_PATH,
        partDir: WORKER_PART_DIR,
        mode: 0o400,
        compressed: false,
      });
      for (const artifact of compressedRuntime) {
        await ensureArtifact(sandboxId, { ...artifact, compressed: true });
      }
    };

    /**
     * One mutation (or repair) session. The episode's FIRST attempt runs in
     * the pre-created sandbox (created BEFORE the parent evaluation — the
     * broker's pairing epoch increments on create, so the parent and child
     * evaluations share the episode's exact epoch). The repair attempt
     * creates its own sandbox from the failed snapshot; the broker maps that
     * snapshot back to the SAME episode.
     */
    const mutateOnce = async (
      sandbox: { sandboxId: string } | { from: ArtifactRef },
      context: EpisodeContext,
      episode: number,
    ): Promise<MutateAttempt> => {
      const sandboxId =
        "sandboxId" in sandbox
          ? sandbox.sandboxId
          : (await broker.createSandbox({ artifact: sandbox.from, role: "mutation" })).sandboxId;
      await ensureWorker(sandboxId);
      await broker.putFile({
        sandboxId,
        path: EPISODE_JSON_PATH,
        contentBase64: Buffer.from(JSON.stringify(context), "utf8").toString("base64"),
      });
      const deadlineMs = Math.max(60, mutationTimeoutSec - DEADLINE_MARGIN_SEC) * 1000;
      const exec = await broker.exec({
        sandboxId,
        argv: ["env", `HONE_DEADLINE_MS=${deadlineMs}`, `PI_NATIVE_VARIANT=${PI_NATIVE_VARIANT}`, SANDBOX_BUN_PATH, SANDBOX_WORKER_PATH],
        cwd: "/workspace",
        timeoutSec: mutationTimeoutSec,
      });
      const stdoutHash = `sha256:${createHash("sha256").update(exec.stdout).digest("hex")}`;

      // Snapshot the workspace even on failure: the repair session starts from it.
      let artifact: ArtifactRef | null = null;
      try {
        artifact = await broker.saveArtifact({ sandboxId });
      } catch (err) {
        if (err instanceof BrokerRpcError && err.brokerCode === "BUDGET_EXCEEDED") throw err;
      }

      if (exec.exitCode !== 0) {
        const failure: FailureEvidence = {
          reason: `mutation session failed (exit ${exec.exitCode}, episode ${episode})`,
          exitCode: exec.exitCode,
          stdoutTail: tail(exec.stdout),
          stderrTail: tail(exec.stderr),
        };
        // stderr is the optimizer's trusted-side diagnostic channel; stdout
        // remains schema-only RunEvent NDJSON. Preserve worker evidence here
        // so a failed remote campaign is diagnosable after sandboxes are reaped.
        console.error(JSON.stringify({ type: "mutation.failure", episode, failure }));
        return { artifact, result: null, stdoutHash, failure };
      }
      const result = parseMutateStdout(exec.stdout);
      if (result === null) {
        const failure: FailureEvidence = {
          reason: "mutation session produced no parsable result",
          exitCode: exec.exitCode,
          stdoutTail: tail(exec.stdout),
          stderrTail: tail(exec.stderr),
        };
        console.error(JSON.stringify({ type: "mutation.failure", episode, failure }));
        return { artifact, result: null, stdoutHash, failure };
      }
      return { artifact, result, stdoutHash, failure: null };
    };

    const startEpisode = opts.resume?.nextEpisode ?? 0;
    let episode = startEpisode;
    for (; ; episode++) {
      if (opts.signal?.aborted) return;
      // Attempted-count cap: ordinals [startEpisode, startEpisode + maxEpisodes).
      if (maxEpisodes !== undefined && episode - startEpisode >= maxEpisodes) break;
      const budget = await broker.getBudget();
      const exhausted = exhaustedDimension(budget);
      if (exhausted !== null) {
        emit({ ...base, at: now(), type: "budget.exhausted", dimension: exhausted });
        break;
      }

      // ε-restart: with probability epsilonRestart mutate the baseline, else the incumbent.
      const restart = incumbent !== null && rand(episode) < epsilonRestart;
      const parent = restart || incumbent === null ? baseline : incumbent.artifact;
      emit({ ...base, at: now(), type: "episode.started", episode, parent });

      // The episode's mutation sandbox is created BEFORE any of the episode's
      // evaluations: sandbox creation advances the broker's pairing epoch, so
      // creating first puts the parent and child evals on the same epoch.
      const { sandboxId } = await broker.createSandbox({ artifact: parent, role: "mutation" });

      const parentRecord = await evaluate(parent, episode, episode);
      // An evaluation can outlive a stop request; never start a fresh model
      // mutation after the trusted score returns.
      if (opts.signal?.aborted) return;
      const parentAggregate = aggregateOf(parentRecord);
      if (parent.hash === baseline.hash) baselineAggregate = parentAggregate;

      const context = buildEpisodeContext({
        episode,
        objective: task.objective,
        parentEvaluation: parentRecord,
        lineage,
        budget,
      });

      let attempt = await mutateOnce({ sandboxId }, context, episode);
      let candidate = attempt.artifact;
      let record: EvaluationRecord | null = null;
      let candidateEvaluationConsumed = false;

      if (candidate !== null && attempt.failure === null) {
        emit({ ...base, at: now(), type: "episode.candidate", episode, candidate, sessionTrace: attempt.stdoutHash });
        candidateEvaluationConsumed = true;
        record = await evaluate(candidate, episode, episode);
        if (!record.output.valid) {
          attempt = {
            ...attempt,
            failure: {
              reason: "evaluator rejected the candidate as invalid",
              exitCode: null,
              stdoutTail: "",
              stderrTail: "",
              ...(record.output.diagnostics?.summary !== undefined
                ? { evaluatorSummary: record.output.diagnostics.summary }
                : {}),
            },
          };
          record = null;
        }
      }

      if (attempt.failure !== null) {
        const reason = attempt.failure.reason;
        const repairFrom = candidate ?? parent;
        let repaired = false;
        if (oneRepair && !(opts.oneShotCandidate === true && candidateEvaluationConsumed)) {
          const repairContext = buildEpisodeContext({
            episode,
            objective: task.objective,
            parentEvaluation: parentRecord,
            lineage,
            budget,
            failure: attempt.failure,
          });
          const repair = await mutateOnce({ from: repairFrom }, repairContext, episode);
          if (repair.artifact !== null && repair.failure === null) {
            emit({
              ...base,
              at: now(),
              type: "episode.candidate",
              episode,
              candidate: repair.artifact,
              sessionTrace: repair.stdoutHash,
            });
            const repairRecord = await evaluate(repair.artifact, episode, episode);
            if (repairRecord.output.valid) {
              candidate = repair.artifact;
              record = repairRecord;
              attempt = repair;
              repaired = true;
            }
          }
        }
        emit({ ...base, at: now(), type: "episode.invalid", episode, reason, repaired });
        if (!repaired) {
          emit({ ...base, at: now(), type: "budget.snapshot", budget: await broker.getBudget() });
          continue; // discard the episode
        }
      }

      if (candidate === null || record === null || attempt.result === null) continue;

      const childAggregate = aggregateOf(record);
      const passed = childAggregate > parentAggregate;
      emit({
        ...base,
        at: now(),
        type: "gate.paired",
        episode,
        parentScore: parentAggregate,
        childScore: childAggregate,
        passed,
      });
      lineage.push({ episode, approach: attempt.result.approach, delta: childAggregate - parentAggregate });

      if (passed) {
        // Same-coordinate comparator evidence (this assetGroupId + this
        // episode's seed). The broker is the final incumbent authority and
        // requires paired candidate↔parent, candidate↔baseline, and (when it
        // differs) candidate↔current-incumbent records; the local
        // keep-if-better hint must never compare aggregates measured on
        // different seeds. The parent is already measured on this coordinate;
        // coinciding hashes reuse it, and memo hits keep re-asks free while
        // still minting evidence.
        let incumbentPairAggregate: number | null = null;
        if (incumbent !== null) {
          incumbentPairAggregate =
            incumbent.artifact.hash === parent.hash
              ? parentAggregate
              : aggregateOf(await evaluate(incumbent.artifact, episode, episode));
          if (incumbent.artifact.hash === baseline.hash) baselineAggregate = incumbentPairAggregate;
        }
        if (incumbentPairAggregate === null || childAggregate > incumbentPairAggregate) {
          // Candidate beats parent AND current incumbent on this coordinate:
          // complete the evidence set with the paired baseline before reporting.
          if (parent.hash !== baseline.hash && incumbent?.artifact.hash !== baseline.hash) {
            baselineAggregate = aggregateOf(await evaluate(baseline, episode, episode));
          }
          incumbent = { artifact: candidate, aggregate: childAggregate };
          emit({
            ...base,
            at: now(),
            type: "incumbent.new",
            artifact: candidate,
            aggregate: childAggregate,
            deltaVsBaseline: baselineAggregate === null ? childAggregate : childAggregate - baselineAggregate,
            episode,
          });
          await broker.reportIncumbent({ artifact: candidate, claimed: { aggregate: childAggregate } });
        }
      }

      emit({ ...base, at: now(), type: "budget.snapshot", budget: await broker.getBudget() });
    }

    await broker.finish({ best: incumbent?.artifact ?? baseline });
  } catch (err) {
    if (err instanceof BrokerRpcError && err.brokerCode === "BUDGET_EXCEEDED") {
      emit({ ...base, at: now(), type: "budget.exhausted", dimension: "unknown" });
      return;
    }
    throw err;
  } finally {
    broker.close();
  }
}

/**
 * Structural mirror of trusted/cli/src/types.ts `RunnerBackendContext` /
 * `RunnerBackend` — the optimizer MUST NOT import trusted internals, so the
 * shape is duplicated here (only the fields the loop consumes). Keep in sync
 * with trusted/cli; flagged to Main as an accepted duplication.
 */
export interface OptimizerBackendContext {
  runId: string;
  runDir: string;
  config: { seed: number };
  env: NodeJS.ProcessEnv;
  replayed: {
    nextEpisode: number;
    incumbent: { artifact: ArtifactRef; aggregate: number } | null;
  };
  signal: AbortSignal;
  emit(event: RunEvent): RunEvent;
}

export interface OptimizerRunnerBackend {
  start(ctx: OptimizerBackendContext): Promise<void>;
}

/**
 * Parse the HONE_MAX_EPISODES wire value: unset means unbounded; anything set
 * that is not a positive integer fails closed (including empty strings).
 */
export function parseMaxEpisodes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim().length === 0 || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`HONE_MAX_EPISODES must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** RunnerBackend-shaped factory so WP4's supervisor can host the loop directly. */
export function createBackend(): OptimizerRunnerBackend {
  return {
    async start(ctx: OptimizerBackendContext): Promise<void> {
      const maxEpisodes = parseMaxEpisodes(ctx.env["HONE_MAX_EPISODES"]);
      const oneShotCandidate = ctx.env["HONE_ONE_SHOT_CANDIDATE"] === "1";
      await runEpisodeLoop({
        brokerSocket: join(ctx.runDir, "broker.sock"),
        runId: ctx.runId,
        emit: (event) => ctx.emit(event),
        signal: ctx.signal,
        seed: ctx.config.seed,
        resume: {
          nextEpisode: ctx.replayed.nextEpisode,
          incumbent: ctx.replayed.incumbent,
        },
        ...(oneShotCandidate ? { oneShotCandidate: true } : {}),
        ...(maxEpisodes !== undefined ? { maxEpisodes } : {}),
      });
    },
  };
}
