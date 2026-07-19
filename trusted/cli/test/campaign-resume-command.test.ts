import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProxyPreflightResult, RunConfig } from "@hone/schema";
import { describe, expect, it } from "vitest";
import { DurableCampaignPauseAuthorityV1 } from "../src/commands/hone.js";
import { resumeCampaignCommand, type TrustedCampaignResumeOptions } from "../src/commands/resume.js";
import { replayRun } from "../src/eventlog.js";
import { statusCommand } from "../src/commands/status.js";
import { writeRunConfigFile } from "../src/runs.js";
import {
  CAP_ID,
  fakeHash,
  fixtureEvents,
  makeIo,
  makeRoot,
  manifestObject,
  writeEvents,
} from "./helpers.js";

const CONFIG_HASH = `sha256:${"a".repeat(64)}` as const;
const PAUSE = {
  version: 1 as const,
  pauseId: "pause_provider_route",
  runId: "run_campaign_pause",
  reason: "provider-auth" as const,
  at: "2026-07-18T12:00:00.000Z",
  role: "outer-optimizer" as const,
  requestedRoute: "anthropic/claude-opus-4-6",
  returnedModel: null,
  status: 401,
  attempt: 1,
};

function runConfig(): RunConfig {
  const manifest = manifestObject();
  return RunConfig.parse({
    version: 1,
    capsuleId: CAP_ID,
    objective: manifest.objective,
    budget: manifest.budget,
    routing: { mutation: { model: "openai/gpt-5.3-codex" } },
    apply: "none",
    headless: true,
    improverSeat: false,
    seed: 7,
    backend: "stub",
  });
}

function pausedCampaign(root: string, withRun: boolean, finished = false): string {
  if (withRun) {
    const runDir = writeEvents(root, PAUSE.runId, fixtureEvents({
      runId: PAUSE.runId,
      baselineHash: fakeHash("b"),
      bestHash: fakeHash("c"),
      finished,
    }));
    writeRunConfigFile(runDir, runConfig());
  }
  const campaignDir = join(root, ".hone-runs", "recursive-cell-pause-fixture");
  mkdirSync(campaignDir, { recursive: true });
  const authority = DurableCampaignPauseAuthorityV1.open(join(campaignDir, "campaign-pause.v1.json"), CONFIG_HASH);
  authority.recordCampaignPause(PAUSE);
  return campaignDir;
}

function proxyOptions(passes: boolean): TrustedCampaignResumeOptions {
  return {
    createProxy: (config) => {
      const preflight = ProxyPreflightResult.parse({
        passed: passes,
        observations: [
          {
            role: "outer-optimizer",
            dispatchId: passes ? "dispatch-outer" : null,
            requestedRoute: "anthropic/claude-opus-4-6",
            returnedModel: passes ? "anthropic/claude-opus-4-6" : null,
            status: passes ? 200 : 401,
            passed: passes,
          },
          {
            role: "inner-capsule-improvement",
            dispatchId: passes ? "dispatch-inner" : null,
            requestedRoute: "openai/gpt-5.3-codex",
            returnedModel: passes ? "openai/gpt-5.3-codex" : null,
            status: passes ? 200 : 401,
            passed: passes,
          },
        ],
      });
      return {
        dispatchRecovery: () => Promise.resolve({
          poisoned: undefined,
          recovered: [],
          chargedTotals: { tokens: 0, usd: 0 },
          pause: PAUSE,
        }),
        campaignPause: () => Promise.resolve(PAUSE),
        resume: async () => {
          if (preflight.passed) {
            await config.recordCampaignResume({
              version: 1,
              pauseId: PAUSE.pauseId,
              runId: PAUSE.runId,
              at: "2026-07-18T12:05:00.000Z",
              observations: preflight.observations,
            });
          }
          return preflight;
        },
        close: () => Promise.resolve(),
      };
    },
  };
}

describe("campaign pause status and trusted resume", () => {
  it("surfaces active durable pause identity and reason even without an ordinary run", async () => {
    const root = makeRoot();
    const campaignDir = pausedCampaign(root, false);
    const captured = makeIo(root);
    expect(await statusCommand([], captured.io)).toBe(0);
    expect(captured.out.join("\n")).toContain(`campaign pause: ${PAUSE.pauseId}`);
    expect(captured.out.join("\n")).toContain(`pause reason: ${PAUSE.reason}`);
    expect(captured.out.join("\n")).toContain(`campaign state: ${campaignDir}`);
  });

  it("keeps the campaign paused on failed preflight and resumes only after both frozen routes pass", async () => {
    const root = makeRoot();
    const campaignDir = pausedCampaign(root, true);
    const captured = makeIo(root);

    expect(await resumeCampaignCommand(["--campaign", campaignDir], captured.io, proxyOptions(false))).toBe(1);
    expect(DurableCampaignPauseAuthorityV1.openExisting(join(campaignDir, "campaign-pause.v1.json")).isCampaignPaused()).toBe(true);
    expect(captured.err.join("\n")).toContain("frozen-route preflight failed");

    expect(await resumeCampaignCommand(["--campaign", campaignDir], captured.io, proxyOptions(true))).toBe(0);
    expect(DurableCampaignPauseAuthorityV1.openExisting(join(campaignDir, "campaign-pause.v1.json")).isCampaignPaused()).toBe(false);
    expect(captured.out.join("\n")).toContain(`campaign resumed: ${PAUSE.pauseId}`);
  });

  it("charges recovered deficit and route 1 before admitting route 2", async () => {
    const root = makeRoot();
    const campaignDir = pausedCampaign(root, true);
    const runDir = join(root, ".hone-runs", PAUSE.runId);
    const state = replayRun(runDir);
    const budget = state.lastBudget;
    if (budget === null) throw new Error("fixture is missing a budget snapshot");
    let firstRemaining = -1;
    let secondRemaining = -1;
    let route2Dispatched = false;
    const options: TrustedCampaignResumeOptions = {
      createProxy: (config) => ({
        dispatchRecovery: () => Promise.resolve({
          poisoned: undefined,
          recovered: [],
          chargedTotals: {
            tokens: budget.spent.tokens + 3,
            usd: budget.spent.usd,
          },
          pause: PAUSE,
        }),
        campaignPause: () => Promise.resolve(PAUSE),
        resume: async () => {
          const first = await config.checkBudget();
          if (!first.allowed) throw new Error("route 1 was unexpectedly denied");
          firstRemaining = first.remaining.tokens;
          await config.recordSpend({ tokens: first.remaining.tokens, usd: 0 });
          const second = await config.checkBudget();
          if (!second.allowed) throw new Error("coordinator budget callback must return remaining headroom");
          secondRemaining = second.remaining.tokens;
          route2Dispatched = second.remaining.tokens > 0;
          return ProxyPreflightResult.parse({
            passed: false,
            observations: [
              {
                role: "outer-optimizer",
                dispatchId: "dispatch-route-1",
                requestedRoute: "anthropic/claude-opus-4-6",
                returnedModel: "anthropic/claude-opus-4-6",
                status: 200,
                passed: true,
              },
              {
                role: "inner-capsule-improvement",
                dispatchId: null,
                requestedRoute: "openai/gpt-5.3-codex",
                returnedModel: null,
                status: null,
                passed: false,
              },
            ],
          });
        },
        close: () => Promise.resolve(),
      }),
    };
    const captured = makeIo(root);
    expect(await resumeCampaignCommand(["--campaign", campaignDir], captured.io, options)).toBe(1);
    expect(firstRemaining).toBe(budget.envelope.maxTokens - budget.spent.tokens - 3);
    expect(secondRemaining).toBe(0);
    expect(route2Dispatched).toBe(false);
  });



  it("refuses terminal-origin preflight whose charges could never reconcile on restart", async () => {
    const root = makeRoot();
    const campaignDir = pausedCampaign(root, true, true);
    const captured = makeIo(root);
    await expect(
      resumeCampaignCommand(["--campaign", campaignDir], captured.io, proxyOptions(true)),
    ).rejects.toThrow(/unavailable run/);
    expect(
      DurableCampaignPauseAuthorityV1.openExisting(
        join(campaignDir, "campaign-pause.v1.json"),
      ).isCampaignPaused(),
    ).toBe(true);
  });
});
