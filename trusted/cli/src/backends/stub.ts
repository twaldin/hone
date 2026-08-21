import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEvent } from "@hone/schema";
import { DISPATCH_JOURNAL_FILE, DISPATCH_JOURNAL_VERSION } from "@hone/proxy";
import { sleep } from "../promise.js";
import type { RunnerBackend, RunnerBackendContext } from "../types.js";

/**
 * Built-in scripted backend: emits a deterministic episode schedule so the
 * supervisor, event log, resume, and delivery paths can be exercised without
 * broker/proxy/optimizer. It remains a built-in trusted test and recovery backend.
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
      const checkpointDelayMs = Number(ctx.env["HONE_STUB_CHECKPOINT_DELAY_MS"] ?? 0);
      const startedAt = Date.now();
      const baseWallSec = ctx.replayed.lastBudget?.spent.wallClockSec ?? 0;
      const now = (): string => new Date().toISOString();
      const base = { runId: ctx.runId };
      let parent = ctx.replayed.incumbent?.artifact ?? fakeArtifact(0xb);
      let spentTokens = ctx.replayed.lastBudget?.spent.tokens ?? 0;
      let spentUsd = ctx.replayed.lastBudget?.spent.usd ?? 0;
      let evaluatorInvocations = ctx.replayed.lastBudget?.spent.evaluatorInvocations ?? 0;

      for (let episode = ctx.replayed.nextEpisode; episode < total; episode++) {
        const active = ctx.replayed.activeEpisode?.episode === episode
          ? ctx.replayed.activeEpisode
          : null;
        if (delayMs > 0) await sleep(delayMs);
        if (ctx.signal.aborted) return;
        if (active !== null) parent = active.parent;
        else ctx.emit({ ...base, at: now(), type: "episode.started", episode, parent });

        const candidate = active?.candidate?.artifact ?? fakeArtifact(0x100 + episode);
        const aggregate = 0.5 + 0.01 * (episode + 1);
        if (active?.candidate === null || active === null) {
          // Simulate the proxy/evaluator authority before publishing the
          // candidate result. A kill after eval.completed therefore resumes
          // without a second dispatch or a second evaluator charge.
          const dispatchId = `d_stub_${episode}_${randomBytes(4).toString("hex")}`;
          appendFileSync(
            join(ctx.runDir, DISPATCH_JOURNAL_FILE),
            `${JSON.stringify({
              v: DISPATCH_JOURNAL_VERSION,
              kind: "intent",
              id: dispatchId,
              runId: ctx.runId,
              role: "mutation",
              model: "stub",
              requestAt: now(),
              requestSha256: "0".repeat(64),
              promptTokens: 800,
              completionTokens: 200,
              ceilTokens: 1000,
              ceilUsd: 0.05,
            })}\n${JSON.stringify({
              v: DISPATCH_JOURNAL_VERSION,
              kind: "settle",
              id: dispatchId,
              tokens: 1000,
              usd: 0.05,
              outcome: "usage",
              traced: true,
            })}\n`,
          );
          spentTokens += 1000;
          spentUsd += 0.05;
          evaluatorInvocations += 1;
          ctx.emit({
            ...base,
            at: now(),
            type: "budget.snapshot",
            budget: {
              envelope: ctx.config.budget,
              spent: {
                tokens: spentTokens,
                usd: spentUsd,
                wallClockSec: baseWallSec + (Date.now() - startedAt) / 1000,
                evaluatorInvocations,
              },
            },
          });
          ctx.emit({
            ...base,
            at: now(),
            type: "episode.candidate",
            episode,
            candidate,
            sessionTrace: fakeArtifact(0xe).hash,
          });
          ctx.emit({
            ...base,
            at: now(),
            type: "eval.completed",
            episode,
            artifact: candidate,
            assetGroupId: "validation",
            seed: ctx.config.seed,
            aggregate,
            cached: false,
          });
        }

        if (checkpointDelayMs > 0) await sleep(checkpointDelayMs);
        if (ctx.signal.aborted) return;
        if (ctx.replayed.incumbent?.episode !== episode) {
          ctx.emit({
            ...base,
            at: now(),
            type: "gate.paired",
            episode,
            parentScore: aggregate - 0.01,
            childScore: aggregate,
            passed: true,
          });
          ctx.emit({
            ...base,
            at: now(),
            type: "incumbent.new",
            artifact: candidate,
            aggregate,
            deltaVsBaseline: aggregate - 0.5,
            episode,
          });
        }
        ctx.emit({ ...base, at: now(), type: "episode.completed", episode });
        parent = candidate;
      }
    },
  };
}
