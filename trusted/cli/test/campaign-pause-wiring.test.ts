import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy } from "@hone/proxy";
import { describe, expect, it } from "vitest";
import {
  DurableCampaignPauseAuthorityV1,
  campaignChildAdmissionAllowed,
} from "../src/commands/hone.js";

const CONFIG_HASH = `sha256:${"c".repeat(64)}` as const;

describe("campaign-wide proxy pause wiring", () => {
  it("delivers a proxy pause to durable campaign authority and fences child admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "hone-campaign-pause-"));
    const upstream = createServer((_request, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "subscription exhausted" } }));
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (address === null || typeof address === "string") throw new Error("upstream did not bind TCP");

    const authorityPath = join(root, "campaign-pause.v1.json");
    const authority = DurableCampaignPauseAuthorityV1.open(authorityPath, CONFIG_HASH);
    const proxy = createProxy({
      runId: "run_recursive_pause",
      routing: {},
      runDir: root,
      casDir: join(root, "cas"),
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      checkBudget: () => ({ allowed: true, remaining: { tokens: 10_000, usd: 10 } }),
      recordSpend: () => {},
      recordCampaignPause: (signal) => authority.recordCampaignPause(signal),
      recordCampaignResume: (signal) => authority.recordCampaignResume(signal),
      captureCampaignDispatchFence: () => authority.captureCampaignDispatchFence(),
      validateCampaignDispatchFence: (epoch, validation) =>
        authority.validateCampaignDispatchFence(epoch, validation),
    });
    const port = await proxy.listenTcp(0);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${proxy.tokenFor("outer-optimizer")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "optimizer-chosen-route-is-ignored",
          messages: [{ role: "user", content: "probe" }],
          max_tokens: 1,
        }),
      });
      expect(response.status).toBe(503);
      expect(await proxy.campaignPause()).toBeDefined();
      expect(authority.isCampaignPaused()).toBe(true);
      expect(campaignChildAdmissionAllowed(authority)).toBe(false);
      const replayed = DurableCampaignPauseAuthorityV1.open(authorityPath, CONFIG_HASH);
      expect(replayed.isCampaignPaused()).toBe(true);
      expect(campaignChildAdmissionAllowed(replayed)).toBe(false);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });
  it("does not clear the live fence when durable resume persistence fails", () => {
    const root = mkdtempSync(join(tmpdir(), "hone-campaign-resume-failure-"));
    const path = join(root, "campaign-pause.v1.json");
    const authority = DurableCampaignPauseAuthorityV1.open(path, CONFIG_HASH);
    authority.recordCampaignPause({
      version: 1,
      pauseId: "pause-failure",
      runId: "run-child",
      reason: "provider-5xx",
      at: "2026-07-18T00:00:00.000Z",
      role: "inner-capsule-improvement",
      requestedRoute: "gpt-5.2",
      returnedModel: null,
      status: 503,
      attempt: 1,
    });
    chmodSync(root, 0o500);
    try {
      expect(() => authority.recordCampaignResume({
        version: 1,
        pauseId: "pause-failure",
        runId: "run-child",
        at: "2026-07-18T00:01:00.000Z",
        observations: [
          {
            role: "outer-optimizer",
            dispatchId: "dispatch-outer",
            requestedRoute: "gpt-5.6-sol",
            returnedModel: "gpt-5.6-sol",
            status: 200,
            passed: true,
          },
          {
            role: "inner-capsule-improvement",
            dispatchId: "dispatch-inner",
            requestedRoute: "gpt-5.2",
            returnedModel: "gpt-5.2",
            status: 200,
            passed: true,
          },
        ],
      })).toThrow();
      expect(authority.isCampaignPaused()).toBe(true);
    } finally {
      chmodSync(root, 0o700);
    }
  });
  it("fails closed on an orphaned mutation lock instead of racing stale reclamation", () => {
    const root = mkdtempSync(join(tmpdir(), "hone-campaign-stale-lock-"));
    const path = join(root, "campaign-pause.v1.json");
    const authority = DurableCampaignPauseAuthorityV1.open(path, CONFIG_HASH);
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath, { mode: 0o700 });
    writeFileSync(join(lockPath, "owner.json"), `${JSON.stringify({
      pid: 999_999_999,
      createdAtMs: Date.now(),
      nonce: "00000000-0000-4000-8000-000000000001",
    })}\n`);
    expect(() => authority.recordCampaignPause({
      version: 1,
      pauseId: "pause-stale-lock",
      runId: "run-child",
      reason: "provider-5xx",
      at: "2026-07-18T00:00:00.000Z",
      role: "inner-capsule-improvement",
      requestedRoute: "gpt-5.2",
      returnedModel: null,
      status: 503,
      attempt: 1,
    })).toThrow(/stale mutation lock/);
    expect(existsSync(lockPath)).toBe(true);
    expect(authority.isCampaignPaused()).toBe(false);
  });
});
