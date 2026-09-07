import type { RunCommand } from "@hone/broker";

const MISSING_CONTAINER = /no such container|no such object|not found/i;

export interface DockerRunLease {
  /** Deterministic stopped donor container used as a daemon-side create capability. */
  name: string;
  /** Add to every per-run `docker run` before the image. */
  attachArgs: readonly ["--volumes-from", string];
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Per-ATTEMPT stopped donor: every executable per-run container declares
 * `--volumes-from` this donor, and the donor's name embeds a monotonic epoch
 * that is NEVER minted again (source: the docker-create gate's write-ahead
 * journal). Live creates are joined to a definitive daemon response by the
 * gate, so the donor is not the primary fence anymore — its role is the
 * causal anchor for CRASH-window proofs: a create request that survived a
 * dead supervisor references a donor epoch that no longer exists and is
 * never re-minted, so once the daemon's name reservation is proven free
 * (gate claim), the request can never register. The donor itself never
 * starts or executes.
 */
export function makeDockerRunLease(runId: string, image: string, run: RunCommand, epoch: number): DockerRunLease {
  if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error(`docker run lease epoch must be a positive integer, got ${epoch}`);
  const safeRunId = runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const name = `hone-lease-${safeRunId}-e${epoch}`;
  let attempted = false;
  let uncertain = false;

  return {
    name,
    attachArgs: ["--volumes-from", `${name}:ro`],
    async start(): Promise<void> {
      if (attempted) throw new Error(`docker run lease ${name} was already started`);
      attempted = true;
      let result;
      try {
        // JOINED: no client timeout — the daemon's response is definitive
        // (registration happens-before the client returns). A wedged daemon
        // blocks startup rather than minting an uncertain outcome.
        result = await run([
          "docker", "create",
          "--name", name,
          "--label", `hone.runId=${runId}`,
          "--network", "none",
          "--pull=never",
          "--read-only",
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--pids-limit", "8",
          "--memory", "16777216",
          "--memory-swap", "16777216",
          "--cpus", "0.1",
          "--log-driver", "none",
          image,
          "true",
        ]);
      } catch (error) {
        uncertain = true;
        throw error;
      }
      if (result.timedOut) uncertain = true;
      if (result.exitCode !== 0 || result.timedOut || result.stdout.toString("utf8").trim() === "") {
        throw new Error(
          `docker run lease create failed: ${result.stderr.toString("utf8").slice(0, 2000) || `exit ${result.exitCode}`}`,
        );
      }
    },
    async close(): Promise<void> {
      if (!attempted) return;
      const result = await run(["docker", "rm", "-f", name], { timeoutMs: 30_000 });
      const stderr = result.stderr.toString("utf8");
      if (result.exitCode !== 0 && !MISSING_CONTAINER.test(stderr)) {
        throw new Error(`docker run lease cleanup failed: ${stderr.slice(0, 2000) || `exit ${result.exitCode}`}`);
      }
      if (uncertain) {
        throw new Error(
          `docker run lease creation outcome was uncertain; refusing terminal completion until a strict resume sweep`,
        );
      }
    },
  };
}
