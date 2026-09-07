import http from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  ProxyTraceRecord,
  type CampaignPauseSignal,
  type CampaignResumeSignal,
} from "@hone/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProxy,
  DISPATCH_JOURNAL_FILE,
  readDispatchJournalState,
  type DispatchIntentRecord,
  type DispatchSettleRecord,
  type DurablePauseProxyHandle,
  type ProxyConfig,
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
  emptyChoices?: boolean;
  nullChoice?: boolean;
  location?: string;
  paddingBytes?: number;
  sseDriftReset?: boolean;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
  incomplete?: boolean;
  trailingBytes?: number;
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
      if (reply.sseDriftReset) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({
            model: reply.model ?? "drifted-model",
            choices: [{ index: 0, delta: { content: "partial" } }],
          })}\n\n`,
          () => res.destroy(),
        );
        return;
      }
      res.writeHead(reply.status, {
        "content-type": reply.contentType ?? "application/json",
        ...(reply.failover ? { "x-vibeproxy-failover": "true" } : {}),
        ...(reply.location !== undefined ? { location: reply.location } : {}),
      });
      if (reply.rawBody !== undefined) {
        res.write(reply.rawBody, () => {
          setImmediate(() => {
            if (reply.incomplete) res.destroy();
            else res.end(" ".repeat(reply.trailingBytes ?? 0));
          });
        });
        return;
      }
      const total = reply.totalTokens ?? 10;
      res.end(reply.body !== undefined ? JSON.stringify(reply.body) : JSON.stringify({
        id: `c${calls.length}`,
        object: "chat.completion",
        model: reply.model ?? request.model,
        choices: reply.malformed
          ? { invalid: true }
          : reply.emptyChoices
            ? []
            : reply.nullChoice
              ? [null]
              : [{ index: 0, message: { role: "assistant", content: "HONE_PREFLIGHT_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.max(1, total - 1), completion_tokens: 1, total_tokens: total },
        ...(reply.paddingBytes === undefined ? {} : { padding: "x".repeat(reply.paddingBytes) }),
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
  proxy: DurablePauseProxyHandle;
  port: number;
  runDir: string;
  spends: SpendRecord[];
  upstream: ScriptedUpstream;
  pauses: CampaignPauseSignal[];
  resumes: CampaignResumeSignal[];
  restart(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type HarnessOptions = { maxResponseBytes?: number } & Partial<
  Pick<
    ProxyConfig,
    "captureCampaignDispatchFence" |
    "validateCampaignDispatchFence" |
    "checkBudget"
  >
>;

async function setup(
  responder: (request: UpstreamRequest, index: number) => UpstreamReply,
  options: HarnessOptions = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "hone-provider-policy-"));
  const runDir = join(root, "run");
  const upstream = await startUpstream(responder);
  const spends: SpendRecord[] = [];
  const pauses: CampaignPauseSignal[] = [];
  const resumes: CampaignResumeSignal[] = [];
  const config: ProxyConfig = {
    runId: "run_provider_policy",
    routing: {
      "outer-optimizer": { model: "optimizer-selected-route" },
      "inner-capsule-improvement": { model: "optimizer-selected-route" },
    },
    runDir,
    casDir: join(root, "cas"),
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    checkBudget:
      options.checkBudget ??
      (() => ({ allowed: true, remaining: { tokens: 1_000_000_000, usd: 1_000_000 } })),
    recordSpend(spend) {
      spends.push(spend);
    },
    recordCampaignPause: (signal) => {
      pauses.push(signal);
    },
    recordCampaignResume: (signal) => {
      resumes.push(signal);
    },
    captureCampaignDispatchFence:
      options.captureCampaignDispatchFence ?? (() => ({ epoch: "0", paused: false })),
    validateCampaignDispatchFence:
      options.validateCampaignDispatchFence ?? (() => true),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { limits: { maxResponseBytes: options.maxResponseBytes } }),
    retryRandom: () => 0,
  };
  const proxy = createProxy(config);
  const port = await proxy.listenTcp(0);
  const harness: Harness = {
    proxy, port, runDir, spends, upstream, pauses, resumes,
    async restart() {
      await harness.proxy.close();
      harness.proxy = createProxy(config);
      harness.port = await harness.proxy.listenTcp(0);
    },
  };
  cleanups.push(async () => {
    await harness.proxy.close().catch(() => undefined);
    await upstream.close();
  });
  return harness;
}

function completion(harness: Harness, role = "outer-optimizer", stream = false): Promise<Response> {
  return fetch(`http://127.0.0.1:${harness.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${harness.proxy.tokenFor(role)}`,
    },
    body: JSON.stringify({ model: "optimizer-selected-route", messages: [], max_tokens: 8, stream }),
  });
}

async function traces(runDir: string): Promise<ProxyTraceRecord[]> {
  const raw = await readFile(join(runDir, "proxy-trace.ndjson"), "utf8");
  return raw.trim().split("\n").map((line) => ProxyTraceRecord.parse(JSON.parse(line)));
}

function ssePrefix(model: string, totalTokens = 10): string {
  return `data: ${JSON.stringify({
    model,
    choices: [{ delta: { content: "partial" } }],
    usage: { prompt_tokens: totalTokens - 1, completion_tokens: 1, total_tokens: totalTokens },
  })}\n\n`;
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
    expect(harness.pauses).toHaveLength(1);
    expect(harness.pauses[0]?.reason).toBe(reason);
  });

  it("a successful SSE prefix followed by an unknown upstream error never scores a candidate", async () => {
    const harness = await setup((request) => ({
      status: 200,
      contentType: "text/event-stream",
      rawBody:
        ssePrefix(request.model) +
        'data: {"error":{"message":"upstream failed","type":"upstream_error"}}\n\n',
    }));
    const response = await completion(harness, "outer-optimizer", true);
    expect(response.headers.get("x-hone-attempt-classification")).not.toBe("candidate-invalidity");
    expect(response.status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect(await harness.proxy.campaignPause()).toMatchObject({
      reason: "provider-transport", status: null, attempt: 4,
    });
    expect(harness.spends).toEqual(Array(4).fill({ tokens: 10, usd: 0 }));
    const pause = await harness.proxy.campaignPause();
    const state = await readDispatchJournalState(join(harness.runDir, DISPATCH_JOURNAL_FILE));
    expect(state.poisoned).toBeUndefined();
    expect(state.unmatched).toEqual([]);
    expect(state.pause).toEqual(pause);
    expect(state.records.filter((record) => record.kind === "settle")).toMatchObject([
      { classification: "retry", outcome: "usage" },
      { classification: "retry", outcome: "usage" },
      { classification: "retry", outcome: "usage" },
      { classification: "campaign-pause", outcome: "usage" },
    ]);
    expect(await traces(harness.runDir)).toMatchObject([
      { status: 200, classification: "retry" },
      { status: 200, classification: "retry" },
      { status: 200, classification: "retry" },
      { status: 200, classification: "campaign-pause" },
    ]);
    harness.upstream.setResponder(() => ({ status: 200 }));
    await harness.restart();
    expect(await harness.proxy.campaignPause()).toEqual(pause);
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect((await harness.proxy.preflight()).passed).toBe(true);
    expect(await harness.proxy.campaignPause()).toEqual(pause);
    expect((await harness.proxy.resume()).passed).toBe(true);
    expect(harness.resumes).toMatchObject([{ pauseId: pause?.pauseId }]);
    await harness.restart();
    expect(await harness.proxy.campaignPause()).toBeUndefined();
    expect((await completion(harness)).status).toBe(200);
  });

  it.each([
    [{ error: { status: 401 } }, 401, "provider-auth", 1],
    [{ error: { status_code: 403 } }, 403, "provider-auth", 1],
    [{ error: { code: 402 } }, 402, "provider-payment", 1],
    [{ status: 429, error: { type: "upstream_error" } }, 429, "provider-rate-limit", 1],
    [{ status_code: 503, error: { type: "upstream_error" } }, 503, "provider-5xx", 4],
    [{ error: { status: 500 } }, 500, "provider-5xx", 4],
  ] as const)("a streamed error %j preserves status and provider policy", async (error, status, reason, attempts) => {
    const harness = await setup((request, index) => ({
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(request.model, index + 10) + `data: ${JSON.stringify(error)}\n\n`,
    }));
    const preflight = await harness.proxy.preflight();
    expect(preflight.passed).toBe(false);
    expect(preflight.observations[0]).toMatchObject({ status, passed: false });
    expect(harness.upstream.calls).toHaveLength(attempts);
    expect(await harness.proxy.campaignPause()).toMatchObject({ status, reason, attempt: attempts });
    expect(harness.spends.map((spend) => spend.tokens)).toEqual(
      Array.from({ length: attempts }, (_, index) => index + 10),
    );
  });

  it("a streamed 5xx retries without leaking partial output, then returns success", async () => {
    const harness = await setup((request, index) => index === 0 ? {
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(request.model, 11) + 'data: {"error":{"status":502}}\n\n',
    } : { status: 200, totalTokens: 22 });
    const response = await completion(harness, "outer-optimizer", true);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("partial");
    expect(harness.spends).toEqual([{ tokens: 11, usd: 0 }, { tokens: 22, usd: 0 }]);
    expect(await harness.proxy.campaignPause()).toBeUndefined();
    const state = await readDispatchJournalState(join(harness.runDir, DISPATCH_JOURNAL_FILE));
    expect(state.records.filter((record) => record.kind === "settle")).toMatchObject([
      { classification: "retry", tokens: 11 },
      { classification: "success", tokens: 22 },
    ]);
  });

  it.each([
    ['data: {"error":{"type":"authentication_error","message":"HTTP 401 payment 402 rate 429 server 503"}}\n\n', null],
    ['data: {"error":{"status":"401","status_code":200,"code":500.5}}\n\n', null],
    ['data: {"error":{"status":600}}\n\n', null],
    ['data: {"error":{"status":418}}\n\n', 418],
    ['event: error\ndata: {"message":"unknown failure"}\n\n', null],
    ['event: error\ndata: not-json\n\n', null],
    ['data: {"error":"unknown failure"}\n\n', null],
  ] as const)("unknown streamed failures never infer status from text: %s", async (terminal, status) => {
    const harness = await setup((request) => ({
      status: 200, contentType: "text/event-stream", rawBody: ssePrefix(request.model) + terminal,
    }));
    expect((await completion(harness, "outer-optimizer", true)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect(await harness.proxy.campaignPause()).toMatchObject({
      reason: "provider-transport", status, attempt: 4,
    });
  });

  it("reads a complete multiline CRLF error event", async () => {
    const harness = await setup((request) => ({
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(request.model) +
        'event: error\r\ndata: {"error":\r\ndata: {"status":429}}\r\n\r\n',
    }));
    expect((await completion(harness, "outer-optimizer", true)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect(await harness.proxy.campaignPause()).toMatchObject({ reason: "provider-rate-limit", status: 429 });
  });

  it.each([
    ["reset", { incomplete: true }],
    ["response cap", { trailingBytes: 4096 }],
  ] as const)("a complete streamed auth error survives a later %s", async (_label, shape) => {
    const harness = await setup((request) => ({
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(request.model) + 'data: {"error":{"status":401}}\n\n',
      ...shape,
    }), { maxResponseBytes: 512 });
    expect((await completion(harness, "outer-optimizer", true)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect(await harness.proxy.campaignPause()).toMatchObject({ reason: "provider-auth", status: 401 });
  });

  it("preserves a complete provider error inside an oversized network chunk", async () => {
    const harness = await setup((request) => ({
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(request.model) + 'data: {"error":{"status":401}}\n\n' + " ".repeat(4096),
    }), { maxResponseBytes: 512 });
    const originalFetch = globalThis.fetch;
    const controlledFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      if (input.toString() !== `http://127.0.0.1:${harness.upstream.port}/v1/chat/completions`) {
        return response;
      }
      // Preserve the real upstream exchange, but remove TCP chunking from this
      // regression: the proxy must consume the error and excess in one read.
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }), { status: response.status, headers: response.headers });
    });
    try {
      const response = await completion(harness, "outer-optimizer", true);
      expect(response.status).toBe(503);
      expect(harness.upstream.calls).toHaveLength(1);
      expect(await harness.proxy.campaignPause()).toMatchObject({ reason: "provider-auth", status: 401 });
      expect(harness.spends).toEqual([{ tokens: 10, usd: 0 }]);
    } finally {
      controlledFetch.mockRestore();
    }
  });

  it("an unterminated error frame cannot manufacture an auth status", async () => {
    const harness = await setup((request) => ({
      status: 200, contentType: "text/event-stream", incomplete: true,
      rawBody: ssePrefix(request.model) + 'data: {"error":{"status":401}}',
    }));
    expect((await completion(harness, "outer-optimizer", true)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect((await harness.proxy.campaignPause())?.reason).toBe("provider-transport");
  });

  it("model drift keeps precedence over unknown streamed failure", async () => {
    const harness = await setup(() => ({
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(M2_INNER_MODEL_ROUTE) + 'data: {"error":{"type":"upstream_error"}}\n\n',
    }));
    expect((await completion(harness, "outer-optimizer", true)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe("returned-model-drift");
  });

  it("normal streams keep agent-authored error text opaque", async () => {
    const rawBody = ssePrefix(M2_OUTER_MODEL_ROUTE) +
      `data: ${JSON.stringify({ choices: [{ delta: { content: '{"error":{"status":401}}' } }] })}\n\n` +
      "data: [DONE]\n\n";
    const harness = await setup(() => ({ status: 200, contentType: "text/event-stream", rawBody }));
    const response = await completion(harness, "outer-optimizer", true);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-hone-attempt-classification")).toBe("success");
    expect(await response.text()).toBe(rawBody);
    expect(harness.spends).toEqual([{ tokens: 10, usd: 0 }]);
    expect(await harness.proxy.campaignPause()).toBeUndefined();
  });

  it("malformed SSE output remains candidate invalidity without a provider error", async () => {
    const harness = await setup((request) => ({
      status: 200, contentType: "text/event-stream",
      rawBody: ssePrefix(request.model) + 'data: {"choices":[null]}\n\ndata: [DONE]\n\n',
    }));
    const response = await completion(harness, "outer-optimizer", true);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-hone-attempt-classification")).toBe("candidate-invalidity");
    expect(harness.upstream.calls).toHaveLength(1);
    expect(await harness.proxy.campaignPause()).toBeUndefined();
  });

  it("an explicit proxy failover sentinel pauses immediately", async () => {
    const harness = await setup(() => ({ status: 200, failover: true }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe("proxy-failover");
  });

  it("never follows a provider-directed redirect", async () => {
    const fallbackCalls = { count: 0 };
    const fallback = http.createServer((req, res) => {
      fallbackCalls.count += 1;
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => fallback.listen(0, "127.0.0.1", resolve));
    const address = fallback.address();
    const fallbackPort = typeof address === "object" && address !== null ? address.port : 0;
    cleanups.push(() => new Promise<void>((resolve) => {
      fallback.close(() => resolve());
      fallback.closeAllConnections();
    }));
    const harness = await setup(() => ({
      status: 307,
      location: `http://127.0.0.1:${fallbackPort}/paid-fallback`,
    }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect(fallbackCalls.count).toBe(0);
    expect((await harness.proxy.campaignPause())?.reason).toBe("proxy-failover");
  });

  it("observed SSE model drift pauses immediately even when the stream resets", async () => {
    const harness = await setup((_request, index) =>
      index === 0
        ? { status: 200, model: M2_INNER_MODEL_ROUTE, sseDriftReset: true }
        : { status: 200 },
    );
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe("returned-model-drift");
  });

  it("an oversized 429 retains status-based pause classification", async () => {
    const harness = await setup(
      () => ({ status: 429, paddingBytes: 4096 }),
      { maxResponseBytes: 128 },
    );
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe("provider-rate-limit");
  });

  it("NO_QUOTA pauses after one attempt and survives restart until explicit resume", async () => {
    const harness = await setup(() => ({
      status: 503,
      body: {
        error: {
          code: "NO_QUOTA",
          type: "quota_exhausted",
          message: "no quota is available for provider scripted",
          provider: "scripted",
          retry_after_ms: null,
        },
      },
    }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    const pause = await harness.proxy.campaignPause();
    expect(pause).toMatchObject({ reason: "provider-rate-limit", status: 503, attempt: 1 });
    expect(harness.pauses).toEqual([pause]);
    expect(harness.spends).toHaveLength(1);
    const state = await readDispatchJournalState(join(harness.runDir, DISPATCH_JOURNAL_FILE));
    expect(state.poisoned).toBeUndefined();
    expect(state.unmatched).toEqual([]);
    expect(state.pause).toEqual(pause);
    expect(state.records.filter((record) => record.kind === "settle")).toMatchObject([
      { classification: "campaign-pause", outcome: "ceiling" },
    ]);

    harness.upstream.setResponder(() => ({ status: 200 }));
    expect((await completion(harness)).status).toBe(503);
    await harness.restart();
    expect(await harness.proxy.campaignPause()).toEqual(pause);
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect(harness.spends).toHaveLength(1);

    // Healthy upstreams and read-only preflight do not authorize resumption.
    expect((await harness.proxy.preflight()).passed).toBe(true);
    expect(await harness.proxy.campaignPause()).toEqual(pause);
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(3);
    expect((await harness.proxy.resume()).passed).toBe(true);
    expect(harness.resumes).toMatchObject([{ pauseId: pause?.pauseId }]);
    expect((await completion(harness)).status).toBe(200);
    expect(harness.upstream.calls).toHaveLength(6);
    await harness.restart();
    expect(await harness.proxy.campaignPause()).toBeUndefined();
    expect((await completion(harness)).status).toBe(200);
  });

  it.each([
    ["malformed JSON", '{"error":{"code":"NO_QUOTA"}'],
    ["wrong code", '{"error":{"code":"OTHER","message":"NO_QUOTA"}}'],
    ["wrong location", '{"code":"NO_QUOTA"}'],
    ["array envelope", '[{"error":{"code":"NO_QUOTA"}}]'],
    ["null error", '{"error":null}'],
    ["array error", '{"error":[{"code":"NO_QUOTA"}]}'],
  ])("%s retains bounded 503 retries", async (_label, rawBody) => {
    const harness = await setup(() => ({ status: 503, rawBody }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect((await harness.proxy.campaignPause())?.reason).toBe("provider-5xx");
  });

  it.each([
    ["reset", { incomplete: true }, "provider-transport"],
    ["response cap", { trailingBytes: 4096 }, "provider-5xx"],
  ] as const)("a valid NO_QUOTA prefix followed by %s never selects quota policy", async (_label, shape, reason) => {
    const harness = await setup(() => ({
      status: 503, rawBody: '{"error":{"code":"NO_QUOTA"}}', ...shape,
    }), { maxResponseBytes: 128 });
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect((await harness.proxy.campaignPause())?.reason).toBe(reason);
    // The prefix really reached the proxy; rejection is not just JSON parse failure.
    const trace = await traces(harness.runDir);
    for (const record of trace) {
      const hash = record.responseBody.slice("sha256:".length);
      const body = await readFile(join(harness.runDir, "..", "cas", "sha256", hash.slice(0, 2), hash), "utf8");
      expect(JSON.parse(body)).toEqual({ error: { code: "NO_QUOTA" } });
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(128);
    }
  });

  it("SSE error content does not select the JSON quota policy", async () => {
    const harness = await setup(() => ({
      status: 503, contentType: "text/event-stream",
      rawBody: 'data: {"error":{"code":"NO_QUOTA"}}\n\n',
    }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(4);
    expect((await harness.proxy.campaignPause())?.reason).toBe("provider-5xx");
  });

  it("successful content cannot select NO_QUOTA policy", async () => {
    const harness = await setup((request) => ({
      status: 200,
      body: {
        model: request.model,
        choices: [{ message: { content: '{"error":{"code":"NO_QUOTA"}}' } }],
        error: { code: "NO_QUOTA" },
      },
    }));
    const response = await completion(harness);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-hone-attempt-classification")).toBe("success");
    expect(await harness.proxy.campaignPause()).toBeUndefined();
    expect(harness.upstream.calls).toHaveLength(1);
  });

  it.each([
    [503, true, undefined, "proxy-failover"],
    [401, false, undefined, "provider-auth"],
    [503, false, M2_INNER_MODEL_ROUTE, "returned-model-drift"],
  ] as const)("NO_QUOTA preserves existing priority %s/%s/%s", async (status, failover, model, reason) => {
    const harness = await setup(() => ({
      status, failover, body: { model, error: { code: "NO_QUOTA" } },
    }));
    expect((await completion(harness)).status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(1);
    expect((await harness.proxy.campaignPause())?.reason).toBe(reason);
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

  it.each([
    ["empty", { emptyChoices: true }],
    ["null", { nullChoice: true }],
  ] as const)("a successful response with %s choices is candidate invalidity", async (_label, shape) => {
    const harness = await setup(() => ({ status: 200, ...shape }));
    const response = await completion(harness);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-hone-attempt-classification")).toBe("candidate-invalidity");
    expect(await harness.proxy.campaignPause()).toBeUndefined();
  });

  it("rechecks the shared pause epoch after intent durability and before fetch", async () => {
    const sharedFence = { epoch: "0", paused: false };
    const harness = await setup(
      () => ({ status: 200 }),
      {
        captureCampaignDispatchFence: () => ({ ...sharedFence }),
        validateCampaignDispatchFence: (epoch, options) =>
          epoch === sharedFence.epoch && (options.allowPaused || !sharedFence.paused),
        checkBudget: () => {
          queueMicrotask(() => {
            sharedFence.epoch = "1";
            sharedFence.paused = true;
          });
          return {
            allowed: true,
            remaining: { tokens: 1_000_000_000, usd: 1_000_000 },
          };
        },
      },
    );

    const response = await completion(harness);
    expect(response.status).toBe(503);
    expect(harness.upstream.calls).toHaveLength(0);
    expect(harness.spends).toHaveLength(0);
    const state = await readDispatchJournalState(
      join(harness.runDir, DISPATCH_JOURNAL_FILE),
    );
    expect(state.records.map((record) => record.kind)).toEqual(["intent", "settle"]);
    expect(state.unmatched).toHaveLength(0);
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
    expect((await completion(harness, "capsule-author")).status).toBe(200);
    expect(harness.upstream.calls[1]).toMatchObject({
      model: M2_OUTER_MODEL_ROUTE,
      role: "capsule-author",
      route: M2_OUTER_MODEL_ROUTE,
    });
    expect((await completion(harness, "inner-capsule-improvement")).status).toBe(200);
    expect(harness.upstream.calls[2]?.model).toBe(M2_INNER_MODEL_ROUTE);
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

  it("stops preflight immediately when the first frozen route confirms a pause", async () => {
    const harness = await setup(() => ({ status: 429 }));
    const result = await harness.proxy.preflight();
    expect(result.passed).toBe(false);
    expect(harness.upstream.calls).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      role: "outer-optimizer",
      passed: false,
    });
    expect(result.observations[1]).toEqual({
      role: "inner-capsule-improvement",
      dispatchId: null,
      requestedRoute: M2_INNER_MODEL_ROUTE,
      returnedModel: null,
      status: null,
      passed: false,
    });
  });

  it("single-flights concurrent resume and binds its receipt to both preflight dispatches", async () => {
    const harness = await setup(() => ({ status: 429 }));
    expect((await completion(harness)).status).toBe(503);
    harness.upstream.setResponder(() => ({ status: 200 }));

    const [first, second] = await Promise.all([
      harness.proxy.resume(),
      harness.proxy.resume(),
    ]);
    expect(first.passed).toBe(true);
    expect(second).toEqual(first);
    expect(harness.upstream.calls).toHaveLength(3);
    expect(harness.resumes).toHaveLength(1);
    expect(harness.resumes[0]?.observations.every(
      (observation) => observation.dispatchId !== null,
    )).toBe(true);

    const state = await readDispatchJournalState(
      join(harness.runDir, DISPATCH_JOURNAL_FILE),
    );
    expect(state.poisoned).toBeUndefined();
    expect(state.pause).toBeUndefined();
    expect(state.records.filter((record) => record.kind === "resume")).toHaveLength(1);
  });
});
