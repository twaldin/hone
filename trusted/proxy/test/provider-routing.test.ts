import http from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  ProxyTraceRecord,
} from "@hone/schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProxy,
  DISPATCH_JOURNAL_FILE,
  readDispatchJournalState,
  type DispatchIntentRecord,
  type DispatchSettleRecord,
  type ProxyHandle,
  type SpendRecord,
} from "../src/index.js";

interface UpstreamRequest {
  model: string;
  role: string | undefined;
  route: string | undefined;
}

interface UpstreamReply {
  status: number;
  model?: string;
  totalTokens?: number;
  malformed?: boolean;
  failover?: boolean;
}

interface ScriptedUpstream {
  port: number;
  calls: UpstreamRequest[];
  setResponder(responder: (request: UpstreamRequest, index: number) => UpstreamReply): void;
  close(): Promise<void>;
}

async function startUpstream(
  initial: (request: UpstreamRequest, index: number) => UpstreamReply,
): Promise<ScriptedUpstream> {
  const calls: UpstreamRequest[] = [];
  let responder = initial;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
      const request: UpstreamRequest = {
        model: parsed.model ?? "",
        role: typeof req.headers["x-hone-requested-role"] === "string"
          ? req.headers["x-hone-requested-role"]
          : undefined,
        route: typeof req.headers["x-hone-requested-route"] === "string"
          ? req.headers["x-hone-requested-route"]
          : undefined,
      };
      calls.push(request);
      const reply = responder(request, calls.length - 1);
      res.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.failover ? { "x-vibeproxy-failover": "true" } : {}),
      });
      const total = reply.totalTokens ?? 10;
      res.end(JSON.stringify({
        id: `c${calls.length}`,
        object: "chat.completion",
        model: reply.model ?? request.model,
        choices: reply.malformed
          ? { invalid: true }
          : [{ index: 0, message: { role: "assistant", content: "HONE_PREFLIGHT_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.max(1, total - 1), completion_tokens: 1, total_tokens: total },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    calls,
    setResponder(next) {
      responder = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

interface Harness {
  proxy: ProxyHandle;
  port: number;
  runDir: string;
  spends: SpendRecord[];
  upstream: ScriptedUpstream;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(
  responder: (request: UpstreamRequest, index: number) => UpstreamReply,
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hone-provider-policy-"));
  const runDir = join(root, "run");
  const upstream = await startUpstream(responder);
  const spends: SpendRecord[] = [];
  const proxy = createProxy({
    runId: "run_provider_policy",
    routing: {
      "outer-optimizer": { model: "optimizer-selected-route" },
      "inner-capsule-improvement": { model: "optimizer-selected-route" },
    },
    runDir,
    casDir: join(root, "cas"),
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    checkBudget: () => ({ allowed: true, remaining: { tokens: 1_000_000_000, usd: 1_000_000 } }),
    recordSpend(spend) {
      spends.push(spend);
    },
    retryRandom: () => 0,
  });
  const port = await proxy.listenTcp(0);
  cleanups.push(async () => {
    await proxy.close().catch(() => undefined);
    await upstream.close();
  });
  return { proxy, port, runDir, spends, upstream };
}

function completion(harness: Harness, role = "outer-optimizer"): Promise<Response> {
  return fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${harness.proxy.tokenFor(role)}`,
    },
    body: JSON.stringify({ model: "optimizer-selected-route", messages: [], max_tokens: 8 }),
  });
}

async function traces(runDir: string): Promise<ProxyTraceRecord[]> {
  const raw = await readFile(join(runDir, "proxy-trace.ndjson"), "utf8");
  return raw.trim().split("\n").map((line) => ProxyTraceRecord.parse(JSON.parse(line)));
}

describe("frozen provider failure policy", () => {
  it.each([
    [401, "provider-auth"],
    [402, "provider-payment"],
    [403, "provider-auth"],
    [429, "provider-rate-limit"],
  ] as const)("HTTP %i immediately pauses with %s", async (status, reason) => {
    const harness = await setup(() => ({ status }));
    const response = await completion(harness);
    expect(response.status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe(reason);
    expect(harness.spends).toEqual([{ tokens: 10, usd: 0 }]);
  });

  it("an explicit proxy failover sentinel pauses immediately", async () => {
    const harness = await setup(() => ({ status: 200, failover: true }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe("proxy-failover");
  });

  it("one 5xx is retried, both attempt usages are charged and journaled, then success returns", async () => {
    const harness = await setup((_request, index) =>
      index === 0 ? { status: 500, totalTokens: 11 } : { status: 200, totalTokens: 22 },
    );
    const response = await completion(harness);
    await response.text();
    expect(response.status).toBe(200);
    expect(harness.upstream.calls).toHaveLength(2);
    expect(harness.spends).toEqual([{ tokens: 11, usd: 0 }, { tokens: 22, usd: 0 }]);
    expect(await harness.proxy.campaignPause()).toBeUndefined();

    const journal = await readDispatchJournalState(join(harness.runDir, DISPATCH_JOURNAL_FILE));
    const settlements = journal.records.filter(
      (record): record is DispatchSettleRecord => record.kind === "settle",
    );
    expect(settlements.map((record) => [record.tokens, record.classification])).toEqual([
      [11, "retry"],
      [22, "success"],
    ]);
  });

  it("four 5xx attempts each remain charged, then the campaign pauses", async () => {
    const harness = await setup((_request, index) => ({ status: 503, totalTokens: index + 10 }));
    const response = await completion(harness);
    expect(response.status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect(harness.spends.map((spend) => spend.tokens)).toEqual([10, 11, 12, 13]);
    expect((await harness.proxy.campaignPause())?.reason).toBe("provider-5xx");
  });

  it("returned-model drift records requested and returned identities, then pauses closed", async () => {
    const harness = await setup(() => ({ status: 200, model: M2_INNER_MODEL_ROUTE }));
    expect((await completion(harness)).status).toBe(503);
    expect((await harness.proxy.campaignPause())?.reason).toBe("returned-model-drift");
    const journal = await readDispatchJournalState(join(harness.runDir, DISPATCH_JOURNAL_FILE));
    const intent = journal.records.find(
      (record): record is DispatchIntentRecord => record.kind === "intent",
    );
    const settlement = journal.records.find(
      (record): record is DispatchSettleRecord => record.kind === "settle",
    );
    expect(intent?.requestedRoute).toBe(M2_OUTER_MODEL_ROUTE);
    expect(settlement?.returnedModel).toBe(M2_INNER_MODEL_ROUTE);
    const trace = await traces(harness.runDir);
    expect(trace[0]).toMatchObject({
      version: 2,
      requestedRoute: M2_OUTER_MODEL_ROUTE,
      returnedModel: M2_INNER_MODEL_ROUTE,
      classification: "campaign-pause",
    });
  });

  it("malformed successful agent output is candidate invalidity and never pauses", async () => {
    const harness = await setup(() => ({ status: 200, malformed: true }));
    const response = await completion(harness);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-hone-attempt-classification")).toBe("candidate-invalidity");
    expect(await harness.proxy.campaignPause()).toBeUndefined();
    expect(harness.spends).toEqual([{ tokens: 10, usd: 0 }]);
  });
});

describe("M2 route preflight and frozen role routing", () => {
  it("overwrites optimizer-selected routes and carries trusted role/route identity", async () => {
    const harness = await setup(() => ({ status: 200 }));
    expect((await completion(harness)).status).toBe(200);
    expect(harness.upstream.calls[0]).toEqual({
      model: M2_OUTER_MODEL_ROUTE,
      role: "outer-optimizer",
      route: M2_OUTER_MODEL_ROUTE,
    });
    expect((await completion(harness, "inner-capsule-improvement")).status).toBe(200);
    expect(harness.upstream.calls[1]?.model).toBe(M2_INNER_MODEL_ROUTE);
  });

  it("preflight passes only when both frozen routes return their exact identities", async () => {
    const harness = await setup(() => ({ status: 200 }));
    const passed = await harness.proxy.preflight();
    expect(passed.passed).toBe(true);
    expect(passed.observations.map((observation) => observation.returnedModel)).toEqual([
      M2_OUTER_MODEL_ROUTE,
      M2_INNER_MODEL_ROUTE,
    ]);

    harness.upstream.setResponder((request) => ({
      status: 200,
      model: request.model === M2_INNER_MODEL_ROUTE ? M2_OUTER_MODEL_ROUTE : request.model,
    }));
    const failed = await harness.proxy.preflight();
    expect(failed.passed).toBe(false);
    expect(failed.observations[0]?.passed).toBe(true);
    expect(failed.observations[1]?.passed).toBe(false);
    expect((await harness.proxy.campaignPause())?.reason).toBe("returned-model-drift");
  });
});
