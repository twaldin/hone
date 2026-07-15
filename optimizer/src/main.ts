/**
 * Optimizer child entry (WP7): the trusted runner executes this as a bundled,
 * unprivileged CONTAINER process with env pointing at the run's broker
 * endpoint. It never sees the host repo, run dir, CAS, or credentials.
 *
 * Wire contract with the runner:
 *   env  HONE_BROKER_SOCK   broker endpoint — a unix socket path (Linux
 *                           bind-mount) or `tcp://host:port` (macOS
 *                           authenticated public TCP listener)   (required)
 *   env  HONE_BROKER_TOKEN  capability for the TCP listener; attached to
 *                           every request by BrokerClient, never logged
 *   env  HONE_RUN_ID        run id stamped into every event       (required)
 *   env  HONE_SEED          base seed for the ε-restart draw      (default 0)
 *   env  HONE_MAX_EPISODES  positive-integer cap on outer episodes attempted
 *                           this invocation, counted from HONE_RESUME.nextEpisode;
 *                           unset = unbounded, anything else fails closed
 *   env  HONE_RESUME        JSON {nextEpisode, incumbent}         (default fresh)
 *   stdout                  one RunEvent as JSON per line, NOTHING else
 *   stderr                  free-form diagnostics
 *
 * SIGTERM/SIGINT abort the loop at its next checkpoint; the runner escalates
 * to SIGKILL after its grace window.
 */
import type { ArtifactRef, RunEvent } from "@hone/schema";
import { parseMaxEpisodes, runEpisodeLoop } from "./loop.js";

interface ResumeState {
  nextEpisode: number;
  incumbent: { artifact: ArtifactRef; aggregate: number } | null;
}

/** Hand-rolled parse: the resume blob comes from the trusted runner's own replay. */
function parseResume(raw: string | undefined): ResumeState {
  if (raw === undefined || raw.length === 0) return { nextEpisode: 0, incumbent: null };
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object") throw new Error("HONE_RESUME must be a JSON object");
  const obj = parsed as { nextEpisode?: unknown; incumbent?: unknown };
  const nextEpisode = typeof obj.nextEpisode === "number" && Number.isInteger(obj.nextEpisode) && obj.nextEpisode >= 0 ? obj.nextEpisode : 0;
  let incumbent: ResumeState["incumbent"] = null;
  if (obj.incumbent !== null && typeof obj.incumbent === "object" && obj.incumbent !== undefined) {
    const inc = obj.incumbent as { artifact?: { hash?: unknown }; aggregate?: unknown };
    if (typeof inc.artifact?.hash === "string" && typeof inc.aggregate === "number") {
      incumbent = { artifact: { hash: inc.artifact.hash }, aggregate: inc.aggregate };
    }
  }
  return { nextEpisode, incumbent };
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

  const abort = new AbortController();
  const onSignal = (): void => abort.abort(new Error("runner requested stop"));
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const emit = (event: RunEvent): RunEvent => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
    return event;
  };

  try {
    await runEpisodeLoop({
      brokerSocket,
      runId,
      emit,
      signal: abort.signal,
      seed,
      resume,
      ...(maxEpisodes !== undefined ? { maxEpisodes } : {}),
    });
    return 0;
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
