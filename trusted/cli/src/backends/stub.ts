import type { RunEvent } from "@hone/schema";
import { sleep } from "../promise.js";
import type { RunnerBackend, RunnerBackendContext } from "../types.js";

/**
 * Built-in scripted backend: emits a deterministic episode schedule so the
 * supervisor, event log, resume, and delivery paths can be exercised without
 * broker/proxy/optimizer. WP7 replaces it via --backend.
 *
 * Env knobs: HONE_STUB_EPISODES (default 4), HONE_STUB_DELAY_MS (default 0).
 */

function fakeArtifact(n: number): { hash: string } {
  return { hash: `sha256:${n.toString(16).padStart(64, "0")}` };
}

export function createBackend(): RunnerBackend {
  return {
    async start(ctx: RunnerBackendContext): Promise<void> {
      const total = Number(ctx.env["HONE_STUB_EPISODES"] ?? 4);
      const delayMs = Number(ctx.env["HONE_STUB_DELAY_MS"] ?? 0);
      const startedAt = Date.now();
      const baseWallSec = ctx.replayed.lastBudget?.spent.wallClockSec ?? 0;
      const now = (): string => new Date().toISOString();
      const base = { runId: ctx.runId };
      let parent = ctx.replayed.incumbent?.artifact ?? fakeArtifact(0xb);

      // Resume dedupe: episodes already in the log are never re-run.
      for (let episode = ctx.replayed.nextEpisode; episode < total; episode++) {
        if (delayMs > 0) await sleep(delayMs);
        if (ctx.signal.aborted) return;
        ctx.emit({ ...base, at: now(), type: "episode.started", episode, parent });
        const candidate = fakeArtifact(0x100 + episode);
        const aggregate = 0.5 + 0.01 * (episode + 1);
        ctx.emit({ ...base, at: now(), type: "episode.candidate", episode, candidate, sessionTrace: fakeArtifact(0xe).hash });
        ctx.emit({ ...base, at: now(), type: "eval.completed", episode, artifact: candidate, assetGroupId: "validation", seed: ctx.config.seed, aggregate, cached: false });
        ctx.emit({ ...base, at: now(), type: "gate.paired", episode, parentScore: aggregate - 0.01, childScore: aggregate, passed: true });
        ctx.emit({ ...base, at: now(), type: "incumbent.new", artifact: candidate, aggregate, deltaVsBaseline: aggregate - 0.5, episode });
        const snapshot: RunEvent = {
          ...base,
          at: now(),
          type: "budget.snapshot",
          budget: {
            envelope: ctx.config.budget,
            spent: {
              tokens: 1000 * (episode + 1),
              usd: 0.05 * (episode + 1),
              wallClockSec: baseWallSec + (Date.now() - startedAt) / 1000,
              evaluatorInvocations: episode + 1,
            },
          },
        };
        ctx.emit(snapshot);
        parent = candidate;
      }
    },
  };
}
