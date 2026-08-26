/**
 * Optimizer child entry (WP7): the trusted runner executes this as a bundled,
 * unprivileged CONTAINER process with env pointing at the run's broker
 * endpoint. It never sees the host repo, run dir, CAS, or credentials.
 *
 * Wire contract with the runner:
 *   env  HONE_BROKER_SOCK   broker endpoint — a unix socket path (Linux
 *                           bind-mount) or `tcp://host:port` (macOS
 *                           authenticated public TCP listener)   (required)
 *   env  HONE_BROKER_TOKEN  per-broker capability required by BOTH public
 *                           transports (unix socket and TCP); attached to
 *                           every request by BrokerClient, never logged
 *   env  HONE_RUN_ID        run id stamped into every event       (required)
 *   env  HONE_SEED          base seed for the ε-restart draw      (default 0)
 *   env  HONE_MAX_EPISODES  positive-integer cap on outer episodes attempted
 *                           this invocation, counted from HONE_RESUME.nextEpisode;
 *                           unset = unbounded, anything else fails closed
 *   env  HONE_SESSION_NO_YIELD_MAX_TOKENS
 *                           positive-integer per-session no-yield token bound
 *                           (default 1,500,000)
 *   env  HONE_ONE_SHOT_CANDIDATE
 *                           `1` disables a second candidate evaluation after
 *                           the M0 probe consumes its cache-safe authority
 *   env  HONE_RESUME        durable episode/incumbent checkpoint JSON (default fresh)
 *   stdout                  one RunEvent as JSON per line, NOTHING else
 *   stderr                  free-form diagnostics
 *
 * SIGTERM/SIGINT abort the loop at its next checkpoint; the runner escalates
 * to SIGKILL after its grace window.
 */
import { ArtifactRef, type RunEvent } from "@hone/schema";
import { brokerControlExitCode, BrokerRpcError } from "./client.js";
import { MutateResult, type MutateResult as MutateResultRecord } from "./episode.js";
import { parseMaxEpisodes, runEpisodeLoop } from "./loop.js";
import { parseSessionNoYieldMaxTokens } from "./session-yield-bound.js";

interface ResumeState {
  nextEpisode: number;
  incumbent: { artifact: ArtifactRef; aggregate: number } | null;
  activeEpisode?: {
    episode: number;
    parent: ArtifactRef;
    candidate: {
      artifact: ArtifactRef;
      sessionTrace: string;
      result: MutateResultRecord;
    } | null;
    invalid?: { reason: string; repaired: boolean };
  };
}

/** Hand-rolled parse: the resume blob comes from the trusted runner's own replay. */
function parseResume(raw: string | undefined): ResumeState {
  if (raw === undefined || raw.length === 0) return { nextEpisode: 0, incumbent: null };
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") throw new Error("HONE_RESUME must be a JSON object");
  const obj = parsed as { nextEpisode?: unknown; incumbent?: unknown; activeEpisode?: unknown };
  const nextEpisode = typeof obj.nextEpisode === "number" && Number.isInteger(obj.nextEpisode) && obj.nextEpisode >= 0 ? obj.nextEpisode : 0;
  let incumbent: ResumeState["incumbent"] = null;
  if (obj.incumbent !== null && typeof obj.incumbent === "object" && obj.incumbent !== undefined) {
    const inc = obj.incumbent as { artifact?: unknown; aggregate?: unknown };
    const artifact = ArtifactRef.safeParse(inc.artifact);
    if (artifact.success && typeof inc.aggregate === "number") {
      incumbent = { artifact: artifact.data, aggregate: inc.aggregate };
    }
  }
  if (obj.activeEpisode === undefined) return { nextEpisode, incumbent };
  if (obj.activeEpisode === null || typeof obj.activeEpisode !== "object") {
    throw new Error("HONE_RESUME.activeEpisode must be an object");
  }
  const active = obj.activeEpisode as {
    episode?: unknown;
    parent?: unknown;
    candidate?: unknown;
    invalid?: unknown;
  };
  const parent = ArtifactRef.safeParse(active.parent);
  if (
    typeof active.episode !== "number"
    || !Number.isInteger(active.episode)
    || active.episode < 0
    || !parent.success
  ) {
    throw new Error("HONE_RESUME.activeEpisode is malformed");
  }
  let candidate: NonNullable<ResumeState["activeEpisode"]>["candidate"] = null;
  if (active.candidate !== null && active.candidate !== undefined) {
    if (typeof active.candidate !== "object") throw new Error("HONE_RESUME active candidate is malformed");
    const rawCandidate = active.candidate as {
      artifact?: unknown;
      sessionTrace?: unknown;
      result?: unknown;
    };
    const artifact = ArtifactRef.safeParse(rawCandidate.artifact);
    const result = MutateResult.safeParse(rawCandidate.result);
    if (!artifact.success || typeof rawCandidate.sessionTrace !== "string" || !result.success) {
      throw new Error("HONE_RESUME active candidate is malformed");
    }
    candidate = {
      artifact: artifact.data,
      sessionTrace: rawCandidate.sessionTrace,
      result: result.data,
    };
  }
  let invalid: NonNullable<ResumeState["activeEpisode"]>["invalid"];
  if (active.invalid !== undefined) {
    if (active.invalid === null || typeof active.invalid !== "object") {
      throw new Error("HONE_RESUME active invalid checkpoint is malformed");
    }
    const rawInvalid = active.invalid as { reason?: unknown; repaired?: unknown };
    if (typeof rawInvalid.reason !== "string" || typeof rawInvalid.repaired !== "boolean") {
      throw new Error("HONE_RESUME active invalid checkpoint is malformed");
    }
    invalid = { reason: rawInvalid.reason, repaired: rawInvalid.repaired };
  }
  return {
    nextEpisode,
    incumbent,
    activeEpisode: {
      episode: active.episode,
      parent: parent.data,
      candidate,
      ...(invalid === undefined ? {} : { invalid }),
    },
  };
}

async function main(): Promise<number> {
  const brokerSocket = process.env["HONE_BROKER_SOCK"];
  const runId = process.env["HONE_RUN_ID"];
  if (brokerSocket === undefined || brokerSocket.length === 0) throw new Error("HONE_BROKER_SOCK is not set");
  if (runId === undefined || runId.length === 0) throw new Error("HONE_RUN_ID is not set");
  const seed = Number(process.env["HONE_SEED"] ?? 0);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("HONE_SEED must be a nonnegative integer");
  const resume = parseResume(process.env["HONE_RESUME"]);
  const maxEpisodes = parseMaxEpisodes(process.env["HONE_MAX_EPISODES"]);
  const sessionNoYieldMaxTokens = parseSessionNoYieldMaxTokens(process.env["HONE_SESSION_NO_YIELD_MAX_TOKENS"]);
  const oneShotCandidate = process.env["HONE_ONE_SHOT_CANDIDATE"] === "1";

  const abort = new AbortController();
  const onSignal = (): void => abort.abort(new Error("runner requested stop"));
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const emit = (event: RunEvent): RunEvent => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return event;
  };

  try {
    try {
      await runEpisodeLoop({
        brokerSocket,
        runId,
        emit,
        signal: abort.signal,
        seed,
        resume,
        sessionNoYieldMaxTokens,
        ...(oneShotCandidate ? { oneShotCandidate: true } : {}),
        ...(maxEpisodes !== undefined ? { maxEpisodes } : {}),
      });
      return 0;
    } catch (error) {
      const controlExit = brokerControlExitCode(error);
      if (controlExit === undefined) throw error;
      console.error(JSON.stringify({
        type: "optimizer.control-exit",
        brokerCode: (error as BrokerRpcError).brokerCode,
        message: error instanceof Error ? error.message : String(error),
      }));
      return controlExit;
    }
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  },
);
