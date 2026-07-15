import http from "node:http";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetExceededError, ProxyTraceRecord } from "@hone/schema";
import {
  createProxy,
  type BudgetDecision,
  type ProxyConfig,
  type ProxyHandle,
  type SpendRecord,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// mock upstream (stands in for vibeproxy :8317)
// ---------------------------------------------------------------------------

const UPSTREAM_KEY = "sk-super-secret-upstream-credential";

interface UpstreamCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface MockUpstream {
  port: number;
  calls: UpstreamCall[];
  close(): Promise<void>;
}

const MOCK_USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const MOCK_STREAM_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

async function startMockUpstream(): Promise<MockUpstream> {
  const calls: UpstreamCall[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
        if (parsed.stream === true) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "Hel" } }], model: parsed.model })}\n\n`,
          );
          res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ delta: { content: "lo" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "c1", choices: [], usage: MOCK_STREAM_USAGE })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "c1",
              object: "chat.completion",
              model: parsed.model,
              choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
              usage: MOCK_USAGE,
            }),
          );
        }
      } else if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Ctx {
  proxy: ProxyHandle;
  port: number;
  runDir: string;
  casDir: string;
  spends: SpendRecord[];
  upstream: MockUpstream;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(overrides: Partial<ProxyConfig> = {}): Promise<Ctx> {
  const base = await mkdtemp(join(tmpdir(), "hone-proxy-"));
  const runDir = join(base, "run");
  const casDir = join(base, "cas");
  const upstream = await startMockUpstream();
  const spends: SpendRecord[] = [];
  const proxy = createProxy({
    runId: "run_test",
    routing: {
      mutation: { model: "routed-model" },
      evaluator: { model: "eval-model" },
    },
    runDir,
    casDir,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    upstreamApiKey: UPSTREAM_KEY,
    pricing: { "routed-model": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 } },
    checkBudget: () => ({ allowed: true }),
    recordSpend: (s) => {
      spends.push(s);
    },
    ...overrides,
  });
  const port = await proxy.listenTcp(0);
  cleanups.push(async () => {
    await proxy.close();
    await upstream.close();
  });
  return { proxy, port, runDir, casDir, spends, upstream };
}

async function postCompletions(
  ctx: Ctx,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function readTrace(runDir: string): Promise<ProxyTraceRecord[]> {
  const raw = await readFile(join(runDir, "proxy-trace.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => ProxyTraceRecord.parse(JSON.parse(l)));
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

async function casContent(casDir: string, hash: string): Promise<string> {
  const hex = hash.replace(/^sha256:/, "");
  return readFile(join(casDir, "sha256", hex.slice(0, 2), hex), "utf8");
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("auth", () => {
  it("rejects unknown bearer token with 401", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, "hone_not-a-real-token", { messages: [] });
    expect(res.status).toBe(401);
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it("rejects missing authorization header with 401", async () => {
    const ctx = await setup();
    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it("mints one token per configured role", async () => {
    const ctx = await setup();
    const roles = ctx.proxy.tokens.map((t) => t.role).sort();
    expect(roles).toEqual(["evaluator", "mutation"]);
    for (const t of ctx.proxy.tokens) {
      expect(t.runId).toBe("run_test");
      expect(t.token.length).toBeGreaterThanOrEqual(32);
    }
  });
});

describe("forwarding — non-streaming", () => {
  it("round-trips a completion, overwrites model, captures usage, meters spend", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    const res = await postCompletions(ctx, token, {
      model: "attacker-chosen-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("hello");

    // model overwritten: upstream saw the role's configured model, not the client's
    expect(ctx.upstream.calls).toHaveLength(1);
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as { model?: string };
    expect(seen.model).toBe("routed-model");

    // upstream key injected by the proxy, not the client's run token
    expect(ctx.upstream.calls[0]?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);

    // metering: usd = 100/1e6*3 + 20/1e6*15
    expect(ctx.spends).toHaveLength(1);
    expect(ctx.spends[0]?.tokens).toBe(120);
    expect(ctx.spends[0]?.usd).toBeCloseTo(0.0006, 10);

    // trace: schema-valid, correct usage, CAS bodies present
    const trace = await readTrace(ctx.runDir);
    expect(trace).toHaveLength(1);
    const rec = trace[0]!;
    expect(rec.runId).toBe("run_test");
    expect(rec.role).toBe("mutation");
    expect(rec.model).toBe("routed-model");
    expect(rec.status).toBe(200);
    expect(rec.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(rec.estimatedUsd).toBeCloseTo(0.0006, 10);
    const casReq = JSON.parse(await casContent(ctx.casDir, rec.requestBody)) as { model?: string };
    expect(casReq.model).toBe("routed-model");
    const casRes = JSON.parse(await casContent(ctx.casDir, rec.responseBody)) as {
      usage?: { total_tokens?: number };
    };
    expect(casRes.usage?.total_tokens).toBe(120);
  });

  it("routes each role to its own model", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("evaluator");
    const res = await postCompletions(ctx, token, { model: "whatever", messages: [] });
    expect(res.status).toBe(200);
    await res.text(); // consume: trace is appended before the body ends
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as { model?: string };
    expect(seen.model).toBe("eval-model");
    const trace = await readTrace(ctx.runDir);
    expect(trace[0]?.role).toBe("evaluator");
    expect(trace[0]?.model).toBe("eval-model");
    // eval-model has no pricing entry -> subscription upstream -> 0 usd
    expect(ctx.spends[0]?.usd).toBe(0);
  });

  it("prices unknown models at zero usd (subscription upstream)", async () => {
    const ctx = await setup({ pricing: {} });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), { messages: [] });
    expect(res.status).toBe(200);
    expect(ctx.spends[0]?.usd).toBe(0);
    expect(ctx.spends[0]?.tokens).toBe(120);
  });
});

describe("forwarding — streaming", () => {
  it("passes SSE through verbatim, injects stream_options, captures final usage", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    const res = await postCompletions(ctx, token, {
      model: "x",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain('"content":"lo"');
    expect(text).toContain("data: [DONE]");

    // stream_options injected — the sandbox cannot opt out of usage accounting
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as {
      stream_options?: { include_usage?: boolean };
    };
    expect(seen.stream_options?.include_usage).toBe(true);

    // usage came from the final SSE chunk
    expect(ctx.spends).toHaveLength(1);
    expect(ctx.spends[0]?.tokens).toBe(15);

    const trace = await readTrace(ctx.runDir);
    expect(trace[0]?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    // trace stores the concatenated stream
    const casRes = await casContent(ctx.casDir, trace[0]!.responseBody);
    expect(casRes).toBe(text);
  });

  it("merges include_usage into caller-supplied stream_options", async () => {
    const ctx = await setup();
    await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      stream: true,
      stream_options: { include_usage: false },
      messages: [],
    });
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as {
      stream_options?: { include_usage?: boolean };
    };
    expect(seen.stream_options?.include_usage).toBe(true);
  });
});

describe("budget enforcement", () => {
  it("returns 402 with schema-valid BudgetExceededError and never calls upstream", async () => {
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({ allowed: false, dimension: "tokens" }),
    });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), { messages: [] });
    expect(res.status).toBe(402);
    const body = BudgetExceededError.parse(await res.json());
    expect(body.error.dimension).toBe("tokens");
    expect(ctx.upstream.calls).toHaveLength(0);
    expect(ctx.spends).toHaveLength(0);
  });

  it("hard-stops mid-session: request N ok, request N+1 blocked", async () => {
    let exhausted = false;
    const ctx = await setup({
      checkBudget: (): BudgetDecision =>
        exhausted ? { allowed: false, dimension: "tokens", message: "cap hit" } : { allowed: true },
    });
    const token = ctx.proxy.tokenFor("mutation");

    const first = await postCompletions(ctx, token, { messages: [] });
    expect(first.status).toBe(200);
    await first.text(); // consume: spend + trace are recorded before the body ends
    exhausted = true;

    const second = await postCompletions(ctx, token, { messages: [] });
    expect(second.status).toBe(402);
    expect(BudgetExceededError.parse(await second.json()).error.message).toBe("cap hit");
    expect(ctx.upstream.calls).toHaveLength(1); // only the first reached upstream
    expect(ctx.spends).toHaveLength(1);

    // the rejection is still traced for audit
    const trace = await readTrace(ctx.runDir);
    expect(trace).toHaveLength(2);
    expect(trace[1]?.status).toBe(402);
    expect(trace[1]?.usage.totalTokens).toBe(0);
  });
});

describe("trace integrity", () => {
  it("trace token sums equal recordSpend totals across mixed traffic", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    await (await postCompletions(ctx, token, { messages: [] })).text();
    await (await postCompletions(ctx, token, { stream: true, messages: [] })).text();
    await (await postCompletions(ctx, token, { messages: [] })).text();

    const trace = await readTrace(ctx.runDir);
    const traceTokens = trace.reduce((sum, r) => sum + r.usage.totalTokens, 0);
    const traceUsd = trace.reduce((sum, r) => sum + r.estimatedUsd, 0);
    const spentTokens = ctx.spends.reduce((sum, s) => sum + s.tokens, 0);
    const spentUsd = ctx.spends.reduce((sum, s) => sum + s.usd, 0);
    expect(traceTokens).toBe(255); // 120 + 15 + 120
    expect(spentTokens).toBe(traceTokens);
    expect(spentUsd).toBeCloseTo(traceUsd, 10);
  });

  it("upstream credentials never appear in trace, CAS, or client-visible responses", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    const r1 = await postCompletions(ctx, token, { messages: [{ role: "user", content: "hi" }] });
    const r1Text = await r1.text();
    const r2 = await postCompletions(ctx, token, { stream: true, messages: [] });
    const r2Text = await r2.text();

    expect(r1Text).not.toContain(UPSTREAM_KEY);
    expect(r2Text).not.toContain(UPSTREAM_KEY);
    for (const [k, v] of r1.headers) expect(`${k}:${v}`).not.toContain(UPSTREAM_KEY);

    const traceRaw = await readFile(join(ctx.runDir, "proxy-trace.ndjson"), "utf8");
    expect(traceRaw).not.toContain(UPSTREAM_KEY);

    const casFiles = await walkFiles(ctx.casDir);
    expect(casFiles.length).toBeGreaterThan(0);
    for (const f of casFiles) {
      expect(await readFile(f, "utf8")).not.toContain(UPSTREAM_KEY);
    }
  });
});

describe("/v1/models passthrough", () => {
  it("forwards with injected upstream credentials, requires run token", async () => {
    const ctx = await setup();
    const unauth = await fetch(`http://127.0.0.1:${ctx.port}/v1/models`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`http://127.0.0.1:${ctx.port}/v1/models`, {
      headers: { authorization: `Bearer ${ctx.proxy.tokenFor("mutation")}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data[0]?.id).toBe("mock-model");
    const call = ctx.upstream.calls.find((c) => c.url === "/v1/models");
    expect(call?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
  });
});

describe("unix socket", () => {
  it("serves completions over proxy.sock", async () => {
    const base = await mkdtemp(join(tmpdir(), "hone-sock-"));
    const socketPath = join(base, "proxy.sock");
    const ctx = await setup();
    // second listener on the same proxy instance is not needed; spin a fresh one on the socket
    const upstream = ctx.upstream;
    const spends: SpendRecord[] = [];
    const proxy = createProxy({
      runId: "run_sock",
      routing: { mutation: { model: "routed-model" } },
      runDir: join(base, "run"),
      casDir: join(base, "cas"),
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      checkBudget: () => ({ allowed: true }),
      recordSpend: (s) => {
        spends.push(s);
      },
    });
    await proxy.listenUnix(socketPath);
    cleanups.push(() => proxy.close());

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${proxy.tokenFor("mutation")}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ messages: [] }));
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ object: "chat.completion" });
    expect(spends).toHaveLength(1);
  });
});

describe("live smoke (skip-if-unreachable)", () => {
  it("1-token completion against vibeproxy :8317 / glm-5.2", { timeout: 60_000 }, async (t) => {
    let reachable = true;
    try {
      await fetch("http://127.0.0.1:8317/v1/models", { signal: AbortSignal.timeout(2000) });
    } catch {
      reachable = false;
    }
    if (!reachable) {
      t.skip();
      return;
    }

    const base = await mkdtemp(join(tmpdir(), "hone-live-"));
    const spends: SpendRecord[] = [];
    const proxy = createProxy({
      runId: "run_live",
      routing: { mutation: { model: "glm-5.2" } },
      runDir: join(base, "run"),
      casDir: join(base, "cas"),
      upstreamBaseUrl: "http://127.0.0.1:8317",
      checkBudget: () => ({ allowed: true }),
      recordSpend: (s) => {
        spends.push(s);
      },
    });
    const port = await proxy.listenTcp(0);
    cleanups.push(() => proxy.close());

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.tokenFor("mutation")}`,
      },
      body: JSON.stringify({
        model: "ignored",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage?: { total_tokens?: number } };
    expect(body.usage?.total_tokens).toBeGreaterThan(0);
    expect(spends[0]?.tokens).toBeGreaterThan(0);

    const raw = await readFile(join(base, "run", "proxy-trace.ndjson"), "utf8");
    const rec = ProxyTraceRecord.parse(JSON.parse(raw.trim()));
    expect(rec.model).toBe("glm-5.2");
    expect(rec.usage.totalTokens).toBeGreaterThan(0);
  });
});
