import { createHash } from "node:crypto";
import { join } from "node:path";
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

/** argv exec'd inside the mutation sandbox; the image bakes the worker at this path. */
export const WORKER_PATH = "/opt/hone-worker/mutate.ts";

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
  /** Test seam: uniform [0,1) draw per episode for the ε-restart decision. */
  rand?: (episode: number) => number;
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

    const baseline = task.baselineArtifact;
    let incumbent = opts.resume?.incumbent ?? null;
    const lineage: LineageEntry[] = [];
    /** Latest trusted baseline aggregate, refreshed whenever the baseline is this episode's parent. */
    let baselineAggregate: number | null = null;

    const evaluate = async (artifact: ArtifactRef, seed: number, episode: number): Promise<EvaluationRecord> => {
      const record = await broker.evaluate({ artifact, assetGroupId, seed });
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

    /** One mutation (or repair) session inside a fresh sandbox created from `from`. */
    const mutateOnce = async (from: ArtifactRef, context: EpisodeContext, episode: number): Promise<MutateAttempt> => {
      const { sandboxId } = await broker.createSandbox({ artifact: from, role: "mutation" });
      await broker.putFile({
        sandboxId,
        path: EPISODE_JSON_PATH,
        contentBase64: Buffer.from(JSON.stringify(context), "utf8").toString("base64"),
      });
      const deadlineMs = Math.max(60, mutationTimeoutSec - DEADLINE_MARGIN_SEC) * 1000;
      const exec = await broker.exec({
        sandboxId,
        argv: ["env", `HONE_DEADLINE_MS=${deadlineMs}`, "bun", WORKER_PATH],
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
        return {
          artifact,
          result: null,
          stdoutHash,
          failure: {
            reason: `mutation session failed (exit ${exec.exitCode}, episode ${episode})`,
            exitCode: exec.exitCode,
            stdoutTail: tail(exec.stdout),
            stderrTail: tail(exec.stderr),
          },
        };
      }
      const result = parseMutateStdout(exec.stdout);
      if (result === null) {
        return {
          artifact,
          result: null,
          stdoutHash,
          failure: {
            reason: "mutation session produced no parsable result",
            exitCode: exec.exitCode,
            stdoutTail: tail(exec.stdout),
            stderrTail: tail(exec.stderr),
          },
        };
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

      const parentRecord = await evaluate(parent, episode, episode);
      const parentAggregate = aggregateOf(parentRecord);
      if (parent.hash === baseline.hash) baselineAggregate = parentAggregate;

      const context = buildEpisodeContext({
        episode,
        objective: task.objective,
        parentEvaluation: parentRecord,
        lineage,
        budget,
      });

      let attempt = await mutateOnce(parent, context, episode);
      let candidate = attempt.artifact;
      let record: EvaluationRecord | null = null;

      if (candidate !== null && attempt.failure === null) {
        emit({ ...base, at: now(), type: "episode.candidate", episode, candidate, sessionTrace: attempt.stdoutHash });
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
        if (oneRepair) {
          const repairContext = buildEpisodeContext({
            episode,
            objective: task.objective,
            parentEvaluation: parentRecord,
            lineage,
            budget,
            failure: attempt.failure,
          });
          const repair = await mutateOnce(repairFrom, repairContext, episode);
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

      if (passed && (incumbent === null || childAggregate > incumbent.aggregate)) {
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
        ...(maxEpisodes !== undefined ? { maxEpisodes } : {}),
      });
    },
  };
}
