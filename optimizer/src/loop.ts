import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactRef, BudgetState, EvaluationRecord, RunEvent } from "@hone/schema";
import { buildEpisodeContext, type FailureEvidence, type LineageEntry } from "../assets/context.js";
import { epsilonRestart, mutationTimeoutSec, oneRepair, trainAssetGroupId } from "../assets/policy.js";
import { BrokerClient, BrokerRpcError } from "./client.js";
import { EPISODE_JSON_PATH, EpisodeContext, parseMutateStdout, type MutateResult } from "./episode.js";

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
  /** Resume state replayed from durable broker/public journals. */
  resume?: {
    /** First episode without an episode.completed commit boundary. */
    nextEpisode: number;
    incumbent: { artifact: ArtifactRef; aggregate: number } | null;
    activeEpisode?: {
      episode: number;
      parent: ArtifactRef;
      candidate: {
        artifact: ArtifactRef;
        sessionTrace: string;
        result: MutateResult;
      } | null;
      invalid?: { reason: string; repaired: boolean };
    };
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
  // The sealed built worker bytes, shipped from THIS invocation's bundle dir
  // into every mutation sandbox. Read before anything touches the broker —
  // a missing bundle fails the invocation closed.
  const workerBundle = readFileSync(opts.workerBundlePath ?? fileURLToPath(new URL("worker.mjs", import.meta.url)));
  const workerSha256 = createHash("sha256").update(workerBundle).digest("hex");
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

    const evaluate = async (
      artifact: ArtifactRef,
      seed: number,
      episode: number,
      resume: boolean,
    ): Promise<EvaluationRecord> => {
      const record = await broker.evaluate({
        artifact,
        assetGroupId,
        seed,
        ...(recursivePlan === undefined ? {} : { recursivePlan }),
        ...(resume ? { resume: true } : {}),
      });
      // A replay hit was already fsynced with its public event and evaluator
      // charge. Unit/in-process backends consume emit directly; avoid making
      // their append-only stream claim that the old invocation happened twice.
      if (!(resume && record.cached)) {
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
      }
      return record;
    };

    /**
     * Guarantee the sandbox holds the EXACT sealed worker bytes at
     * SANDBOX_WORKER_PATH before exec. /scratch is shared across the run's
     * sandboxes, so a hash-verified hit skips the transfer; any miss or
     * mismatch re-ships the bundle in frame-sized putFile chunks and
     * re-verifies the assembled file.
     */
    const ensureWorker = async (sandboxId: string): Promise<void> => {
      const probe = await broker.exec({ sandboxId, argv: ["sha256sum", SANDBOX_WORKER_PATH], timeoutSec: 120 });
      if (probe.exitCode === 0 && probe.stdout.trimStart().startsWith(workerSha256)) return;
      const parts: string[] = [];
      for (let offset = 0, i = 0; offset < workerBundle.length; offset += WORKER_CHUNK_BYTES, i++) {
        const part = `${WORKER_PART_DIR}/${String(i).padStart(8, "0")}`;
        parts.push(part);
        await broker.putFile({
          sandboxId,
          path: part,
          contentBase64: workerBundle.subarray(offset, offset + WORKER_CHUNK_BYTES).toString("base64"),
        });
      }
      // Explicit part list (not a glob): stale parts from an interrupted
      // transfer can never leak into the assembled file.
      const assemble = await broker.exec({
        sandboxId,
        argv: ["sh", "-c", `cat ${parts.join(" ")} > ${SANDBOX_WORKER_PATH} && rm -rf ${WORKER_PART_DIR} && sha256sum ${SANDBOX_WORKER_PATH}`],
        timeoutSec: 300,
      });
      if (assemble.exitCode !== 0 || !assemble.stdout.trimStart().startsWith(workerSha256)) {
        throw new Error(
          `worker bundle transfer to sandbox ${sandboxId} failed (exit ${assemble.exitCode}): expected sha256 ${workerSha256}`,
        );
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
      sandbox: { sandboxId: string } | { from: ArtifactRef; continueEpisode?: number },
      context: EpisodeContext,
      episode: number,
    ): Promise<MutateAttempt> => {
      const sandboxId =
        "sandboxId" in sandbox
          ? sandbox.sandboxId
          : (
              await broker.createSandbox({
                artifact: sandbox.from,
                role: "mutation",
                ...(sandbox.continueEpisode === undefined ? {} : { continueEpisode: sandbox.continueEpisode }),
              })
            ).sandboxId;
      await ensureWorker(sandboxId);
      let staged = false;
      try {
        const prior = await broker.getFile({ sandboxId, path: EPISODE_JSON_PATH });
        const decoded = Buffer.from(prior.contentBase64, "base64");
        const parsed = EpisodeContext.safeParse(JSON.parse(decoded.toString("utf8")));
        // Preserve the exact prompt/budget snapshot that created a durable
        // session transcript. A later wall-clock value must not fork the
        // checkpoint identity on resume.
        staged =
          parsed.success
          && parsed.data.episode === context.episode
          && parsed.data.mode === context.mode;
      } catch {
        // No prior complete context (fresh episode or killed putFile).
      }
      if (!staged) {
        await broker.putFile({
          sandboxId,
          path: EPISODE_JSON_PATH,
          contentBase64: Buffer.from(JSON.stringify(context), "utf8").toString("base64"),
        });
      }
      const deadlineMs = Math.max(60, mutationTimeoutSec - DEADLINE_MARGIN_SEC) * 1000;
      const exec = await broker.exec({
        sandboxId,
        argv: ["env", `HONE_DEADLINE_MS=${deadlineMs}`, "bun", SANDBOX_WORKER_PATH],
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
    const activeResume = opts.resume?.activeEpisode;
    if (activeResume !== undefined && activeResume.episode !== startEpisode) {
      throw new Error(
        `resume checkpoint episode ${activeResume.episode} does not match next episode ${startEpisode}`,
      );
    }
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

      const resuming = activeResume?.episode === episode;
      // The persisted parent is authoritative for a partial episode. Recomputing
      // ε-restart after a crash could select a different candidate lineage.
      const restart = !resuming && incumbent !== null && rand(episode) < epsilonRestart;
      const parent = resuming
        ? activeResume.parent
        : restart || incumbent === null
          ? baseline
          : incumbent.artifact;
      if (!resuming) emit({ ...base, at: now(), type: "episode.started", episode, parent });
      // A fsynced unrepaired invalid event is the durable terminal decision
      // for this episode. A crash before completeEpisode may replay only the
      // cheap completion boundary, never another repair/evaluator attempt.
      if (resuming && activeResume.invalid?.repaired === false) {
        emit({ ...base, at: now(), type: "budget.snapshot", budget });
        await broker.completeEpisode({ episode });
        continue;
      }

      // The episode's mutation sandbox is created BEFORE any of the episode's
      // evaluations. On resume the broker assigns the exact old episode and
      // measurement generation instead of minting a new boundary.
      const { sandboxId } = await broker.createSandbox({
        artifact: parent,
        role: "mutation",
        ...(resuming ? { continueEpisode: episode } : {}),
      });

      const parentRecord = await evaluate(parent, episode, episode, resuming);
      // An evaluation can outlive a stop/pause request; never start fresh paid
      // work after the trusted score returns.
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

      const savedCandidate = resuming ? activeResume.candidate : null;
      const completeClaimedEpisode = async (): Promise<void> => {
        await broker.completeEpisode({
          episode,
          ...(savedCandidate === null ? {} : { releaseSandboxId: sandboxId }),
        });
      };
      let attempt: MutateAttempt =
        savedCandidate === null
          ? await mutateOnce({ sandboxId }, context, episode)
          : {
              artifact: savedCandidate.artifact,
              result: savedCandidate.result,
              stdoutHash: savedCandidate.sessionTrace,
              failure: null,
            };
      if (opts.signal?.aborted) return;
      let candidate = attempt.artifact;
      let record: EvaluationRecord | null = null;
      let candidateEvaluationConsumed = false;

      if (candidate !== null && attempt.failure === null) {
        if (savedCandidate === null) {
          emit({ ...base, at: now(), type: "episode.candidate", episode, candidate, sessionTrace: attempt.stdoutHash });
        }
        candidateEvaluationConsumed = true;
        record = await evaluate(candidate, episode, episode, resuming);
        if (opts.signal?.aborted) return;
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
          const repair = await mutateOnce({ from: repairFrom, continueEpisode: episode }, repairContext, episode);
          if (opts.signal?.aborted) return;
          if (repair.artifact !== null && repair.failure === null) {
            emit({
              ...base,
              at: now(),
              type: "episode.candidate",
              episode,
              candidate: repair.artifact,
              sessionTrace: repair.stdoutHash,
            });
            const repairRecord = await evaluate(repair.artifact, episode, episode, resuming);
            if (opts.signal?.aborted) return;
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
          await completeClaimedEpisode();
          continue;
        }
      }

      if (candidate === null || record === null || attempt.result === null) {
        await completeClaimedEpisode();
        continue;
      }

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
        // episode's seed). Exact replay hits carry no second invocation charge.
        let incumbentPairAggregate: number | null = null;
        if (incumbent !== null) {
          incumbentPairAggregate =
            incumbent.artifact.hash === parent.hash
              ? parentAggregate
              : aggregateOf(await evaluate(incumbent.artifact, episode, episode, resuming));
          if (incumbent.artifact.hash === baseline.hash) baselineAggregate = incumbentPairAggregate;
        }
        if (incumbentPairAggregate === null || childAggregate > incumbentPairAggregate) {
          if (parent.hash !== baseline.hash && incumbent?.artifact.hash !== baseline.hash) {
            baselineAggregate = aggregateOf(await evaluate(baseline, episode, episode, resuming));
          }
          if (opts.signal?.aborted) return;
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
      await completeClaimedEpisode();
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
    activeEpisode?: NonNullable<EpisodeLoopOptions["resume"]>["activeEpisode"];
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
          ...(ctx.replayed.activeEpisode === undefined
            ? {}
            : { activeEpisode: ctx.replayed.activeEpisode }),
        },
        ...(oneShotCandidate ? { oneShotCandidate: true } : {}),
        ...(maxEpisodes !== undefined ? { maxEpisodes } : {}),
      });
    },
  };
}
