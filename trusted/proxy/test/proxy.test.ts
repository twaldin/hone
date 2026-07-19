import http from "node:http";
import net from "node:net";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetExceededError, ProxyTraceRecord } from "@hone/schema";
import {
  createProxy,
  promptTokenUpperBound,
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
  /** Set when a completions response was closed by the PROXY before the mock finished writing. */
  flags: { closedEarly: boolean };
  /** "slow"-mode completions held open; invoke an entry to release its response. */
  slow: Array<() => void>;
  /** "stall"-mode completions: headers + partial body flushed, then hung; invoke to release. */
  stalled: Array<() => void>;
  close(): Promise<void>;
}

const MOCK_USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const MOCK_STREAM_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

/** Generous quantitative headroom for tests that are not about reservations. */
const GENEROUS_REMAINING = { tokens: 1_000_000_000, usd: 1_000_000 };

/** Shape authored by this file's own tests — the mock parses its own traffic. */
interface MockCompletionBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ content?: unknown }>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const calls: UpstreamCall[] = [];
  const flags = { closedEarly: false };
  const slow: Array<() => void> = [];
  const stalled: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        const parsed = JSON.parse(body) as MockCompletionBody;
        const first = parsed.messages?.[0]?.content;
        const mode = typeof first === "string" ? first : "";
        const jsonCompletion = (usage: unknown): string =>
          JSON.stringify({
            id: "c1",
            object: "chat.completion",
            model: parsed.model,
            choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
            ...(usage === undefined ? {} : { usage }),
          });
        if (mode === "no-usage") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonCompletion(undefined));
          return;
        }
        if (mode === "zero-usage") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonCompletion({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }));
          return;
        }
        if (mode === "bad-usage") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jsonCompletion({ prompt_tokens: -5, completion_tokens: "many", total_tokens: 1e30 }));
          return;
        }
        if (mode === "slow") {
          // Hold the response open until the test releases it — lets tests
          // pin proxy request slots deterministically.
          slow.push(() => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(jsonCompletion(MOCK_USAGE));
          });
          return;
        }
        if (mode === "reset") {
          // Accept the request, start a body, then kill the socket mid-flight.
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"partial":');
          setTimeout(() => res.destroy(), 10);
          return;
        }
        if (mode === "stall") {
          // Headers plus a partial SSE body flushed, then the response hangs
          // forever unless the test releases it (quiescence tests never do).
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "par" } }] })}\n\n`);
          stalled.push(() => res.end());
          return;
        }
        if (mode === "flood") {
          // Rogue provider: streams far more than any sane completion.
          res.writeHead(200, { "content-type": "text/event-stream" });
          const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(900) } }] })}\n\n`;
          let sent = 0;
          const timer = setInterval(() => {
            if (sent >= 200) {
              clearInterval(timer);
              res.end();
              return;
            }
            sent += 1;
            res.write(payload);
          }, 5);
          res.on("close", () => {
            clearInterval(timer);
            if (sent < 200) flags.closedEarly = true;
          });
          return;
        }
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
          res.end(jsonCompletion(MOCK_USAGE));
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
    flags,
    slow,
    stalled,
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
    checkBudget: () => ({ allowed: true, remaining: GENEROUS_REMAINING }),
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
  let raw: string;
  try {
    raw = await readFile(join(runDir, "proxy-trace.ndjson"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
        exhausted
          ? { allowed: false, dimension: "tokens", message: "cap hit" }
          : { allowed: true, remaining: GENEROUS_REMAINING },
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

    // A refused request never reached upstream and is not a session trace.
    // Persisting attacker-controlled denied bodies would create an unmetered
    // CAS/disk-growth path behind one held reservation.
    const trace = await readTrace(ctx.runDir);
    expect(trace).toHaveLength(1);
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
    await Promise.all([
      fetch(`http://127.0.0.1:${ctx.port}/v1/models`, {
        headers: { authorization: `Bearer ${ctx.proxy.tokenFor("mutation")}` },
      }),
      fetch(`http://127.0.0.1:${ctx.port}/v1/models`, {
        headers: { authorization: `Bearer ${ctx.proxy.tokenFor("mutation")}` },
      }),
    ]);
    expect(ctx.upstream.calls.filter((c) => c.url === "/v1/models")).toHaveLength(1);
    expect(await readTrace(ctx.runDir)).toHaveLength(0);
    expect(await walkFiles(ctx.casDir)).toHaveLength(0);
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
      checkBudget: () => ({ allowed: true, remaining: GENEROUS_REMAINING }),
      recordSpend: (s) => {
        spends.push(s);
      },
    });
    await proxy.listenUnix(socketPath);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o666);
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
      checkBudget: () => ({ allowed: true, remaining: GENEROUS_REMAINING }),
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

// ---------------------------------------------------------------------------
// adversarial: atomic admission reservations + fail-closed reconciliation
// ---------------------------------------------------------------------------

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

describe("admission reservations", () => {
  it("transient reservation pressure returns retryable 429 without exhausting the run", async () => {
    const spends: SpendRecord[] = [];
    const exhausted: string[] = [];
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({
        allowed: true,
        remaining: { tokens: 1300 - spends.reduce((a, s) => a + s.tokens, 0), usd: 1000 },
      }),
      recordSpend: (s) => {
        spends.push(s);
      },
      recordBudgetExhaustion: (dimension) => {
        exhausted.push(dimension);
      },
    });
    const token = ctx.proxy.tokenFor("mutation");
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 1000 };
    const [a, b] = await Promise.all([
      postCompletions(ctx, token, body),
      postCompletions(ctx, token, body),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 429]);
    const denied = a.status === 429 ? a : b;
    expect(BudgetExceededError.parse(await denied.json()).error.dimension).toBe("tokens");
    // exactly one request reached upstream, exactly one settlement
    expect(ctx.upstream.calls.filter((c) => c.url === "/v1/chat/completions")).toHaveLength(1);
    await (a.status === 200 ? a : b).text();
    expect(spends).toHaveLength(1);
    expect(spends[0]?.tokens).toBe(120);
    expect(exhausted).toEqual([]); // reservation pressure is transient, not a run-wide terminal
    const traces = await readTrace(ctx.runDir);
    expect(traces).toHaveLength(1);
  });

  it("reservations release after settlement — no leak across sequential requests", async () => {
    const spends: SpendRecord[] = [];
    const ctx = await setup({
      // constant headroom that fits exactly ONE worst-case reservation:
      // any leaked reservation would 402 the next request
      checkBudget: (): BudgetDecision => ({ allowed: true, remaining: { tokens: 1300, usd: 1000 } }),
      recordSpend: (s) => {
        spends.push(s);
      },
    });
    const token = ctx.proxy.tokenFor("mutation");
    for (let i = 0; i < 3; i += 1) {
      const res = await postCompletions(ctx, token, {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1000,
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(spends).toHaveLength(3);
  });

  it("streaming settlements charge actual usage and release the reservation", async () => {
    const spends: SpendRecord[] = [];
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({ allowed: true, remaining: { tokens: 1300, usd: 1000 } }),
      recordSpend: (s) => {
        spends.push(s);
      },
    });
    const token = ctx.proxy.tokenFor("mutation");
    for (let i = 0; i < 2; i += 1) {
      const res = await postCompletions(ctx, token, {
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1000,
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(spends.map((s) => s.tokens)).toEqual([15, 15]);
  });

  it("402 records trusted exhaustion before any upstream call when nothing fits", async () => {
    const exhausted: string[] = [];
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({ allowed: true, remaining: { tokens: 5, usd: 1000 } }),
      recordBudgetExhaustion: (dimension) => {
        exhausted.push(dimension);
      },
    });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      max_tokens: 1000,
    });
    expect(res.status).toBe(402);
    expect(BudgetExceededError.parse(await res.json()).error.dimension).toBe("tokens");
    expect(ctx.upstream.calls).toHaveLength(0);
    expect(ctx.spends).toHaveLength(0);
    expect(exhausted).toEqual(["tokens"]);
  });

  it("usd headroom gates admission independently of tokens", async () => {
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({
        allowed: true,
        remaining: { tokens: 1_000_000_000, usd: 0.0001 },
      }),
    });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      max_tokens: 32_768,
    });
    expect(res.status).toBe(402);
    expect(BudgetExceededError.parse(await res.json()).error.dimension).toBe("usd");
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it("derives the completion ceiling from remaining headroom when the client omits one", async () => {
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({ allowed: true, remaining: { tokens: 5000, usd: 1_000_000 } }),
    });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    await res.text();
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as { max_tokens?: number };
    // ceiling = headroom - prompt estimate: strictly below 5000, near it
    expect(seen.max_tokens).toBeGreaterThan(4800);
    expect(seen.max_tokens).toBeLessThan(5000);
  });
});

describe("completion multiplicity and token ceilings", () => {
  it("rejects n != 1 — multi-choice output cannot multiply admitted budget", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), { messages: [], n: 3 });
    expect(res.status).toBe(400);
    expect(ctx.upstream.calls).toHaveLength(0);
    expect(ctx.spends).toHaveLength(0);
  });

  it("allows an explicit n === 1", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), { messages: [], n: 1 });
    expect(res.status).toBe(200);
  });

  it("rejects best_of outright", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      best_of: 4,
    });
    expect(res.status).toBe(400);
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it("rejects conflicting max_tokens / max_completion_tokens", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      max_tokens: 5,
      max_completion_tokens: 6,
    });
    expect(res.status).toBe(400);
    expect(ctx.upstream.calls).toHaveLength(0);
  });

  it("collapses equal duplicate ceilings to one canonical field", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      max_tokens: 5,
      max_completion_tokens: 5,
    });
    expect(res.status).toBe(200);
    await res.text();
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(seen["max_tokens"]).toBe(5);
    expect("max_completion_tokens" in seen).toBe(false);
  });

  it("preserves max_completion_tokens when it is the client's field", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      max_completion_tokens: 7,
    });
    expect(res.status).toBe(200);
    await res.text();
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(seen["max_completion_tokens"]).toBe(7);
    expect("max_tokens" in seen).toBe(false);
  });

  it("clamps client ceilings to the hard cap", async () => {
    const ctx = await setup({ limits: { maxCompletionTokens: 1000 } });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [],
      max_tokens: 10_000_000,
    });
    expect(res.status).toBe(200);
    await res.text();
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as { max_tokens?: number };
    expect(seen.max_tokens).toBe(1000);
  });

  it("injects the default hard cap when the client omits a ceiling", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), { messages: [] });
    expect(res.status).toBe(200);
    await res.text();
    const seen = JSON.parse(ctx.upstream.calls[0]?.body ?? "{}") as { max_tokens?: number };
    expect(seen.max_tokens).toBe(32_768);
  });

  it("rejects non-positive-integer ceilings", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    for (const bad of ["lots", 0, -1, 1.5]) {
      const res = await postCompletions(ctx, token, { messages: [], max_tokens: bad });
      expect(res.status).toBe(400);
    }
    expect(ctx.upstream.calls).toHaveLength(0);
  });
});

describe("fail-closed usage reconciliation", () => {
  async function assertCeilingCharged(mode: string): Promise<void> {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [{ role: "user", content: mode }],
      max_tokens: 100,
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(ctx.spends).toHaveLength(1);
    const trace = await readTrace(ctx.runDir);
    // charged at the admitted ceiling: prompt estimate + full completion cap
    expect(trace[0]?.usage.completionTokens).toBe(100);
    expect(trace[0]?.usage.promptTokens).toBeGreaterThan(0);
    expect(ctx.spends[0]?.tokens).toBe(trace[0]?.usage.totalTokens);
    expect(ctx.spends[0]?.tokens).toBeGreaterThanOrEqual(101);
    expect(ctx.spends[0]?.usd).toBeGreaterThan(0);
    expect(trace[0]?.estimatedUsd).toBeCloseTo(ctx.spends[0]?.usd ?? -1, 10);
  }

  it("missing usage charges the full reservation ceiling, never zero", async () => {
    await assertCeilingCharged("no-usage");
  });

  it("all-zero usage is untrustworthy and charges the ceiling", async () => {
    await assertCeilingCharged("zero-usage");
  });

  it("malformed usage (negative / non-numeric counts) charges the ceiling", async () => {
    await assertCeilingCharged("bad-usage");
  });
});

describe("body and response caps", () => {
  it("rejects oversized request bodies with 413 before upstream", async () => {
    const ctx = await setup({ limits: { maxRequestBytes: 1024 } });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [{ role: "user", content: "y".repeat(4096) }],
    });
    expect(res.status).toBe(413);
    const parsed: unknown = await res.json();
    expect(parsed).toMatchObject({ error: { type: "hone_request_too_large" } });
    expect(ctx.upstream.calls).toHaveLength(0);
    expect(ctx.spends).toHaveLength(0);
  });

  it("aborts a flooding upstream at the response cap and charges the ceiling", async () => {
    const ctx = await setup({ limits: { maxResponseBytes: 2048 } });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      stream: true,
      messages: [{ role: "user", content: "flood" }],
      max_tokens: 50,
    });
    expect(res.status).toBe(200);
    let text = "";
    try {
      text = await res.text();
    } catch {
      // proxy destroys the truncated response: a client-side error is the contract
    }
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2048);
    // the upstream connection was ABORTED mid-flood, not drained
    await until(() => ctx.upstream.flags.closedEarly);
    await until(() => ctx.spends.length === 1);
    const trace = await readTrace(ctx.runDir);
    expect(trace[0]?.usage.completionTokens).toBe(50);
    expect(ctx.spends[0]?.tokens).toBeGreaterThanOrEqual(51);
  });
});

describe("transport failure reconciliation", () => {
  it("connection-refused retries are zero-charged, then durably pause new dispatch", async () => {
    const spends: SpendRecord[] = [];
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({ allowed: true, remaining: { tokens: 1300, usd: 1000 } }),
      recordSpend: (s) => {
        spends.push(s);
      },
    });
    await ctx.upstream.close();
    const token = ctx.proxy.tokenFor("mutation");
    const first = await postCompletions(ctx, token, { messages: [], max_tokens: 1000 });
    expect(first.status).toBe(503);
    expect(spends).toHaveLength(0);
    expect((await ctx.proxy.campaignPause())?.reason).toBe("provider-transport");
    const second = await postCompletions(ctx, token, { messages: [], max_tokens: 1000 });
    expect(second.status).toBe(503);
    expect(await readTrace(ctx.runDir)).toHaveLength(0);
    expect(await walkFiles(ctx.casDir)).toHaveLength(0);
  });

  it("four ambiguous connection resets are each ceiling-charged before pause", async () => {
    const ctx = await setup();
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [{ role: "user", content: "reset" }],
      max_tokens: 100,
    });
    expect(res.status).toBe(503);
    await res.text();
    await until(() => ctx.spends.length === 4);
    const traces = await readTrace(ctx.runDir);
    expect(traces).toHaveLength(4);
    for (const [index, trace] of traces.entries()) {
      expect(trace.usage.completionTokens).toBe(100);
      expect(ctx.spends[index]?.tokens).toBe(trace.usage.totalTokens);
      expect(ctx.spends[index]?.tokens).toBeGreaterThanOrEqual(101);
    }
    expect((await ctx.proxy.campaignPause())?.reason).toBe("provider-transport");
  });
});

// ---------------------------------------------------------------------------
// adversarial: byte-level prompt reservation upper bound (review finding 6)
// ---------------------------------------------------------------------------

describe("prompt reservation upper bound", () => {
  it("honest worst-case usage above the old bytes/4 estimate cannot cross the envelope", async () => {
    // ~4KiB prompt: the old bytes/4 estimate (~1030 tokens) + max_tokens 1
    // fits a 3000-token envelope, but a byte-level tokenizer can honestly
    // report ~4100 prompt tokens and blow through it. The reservation must
    // therefore reject this request outright — before any upstream call.
    const ctx = await setup({
      checkBudget: (): BudgetDecision => ({ allowed: true, remaining: { tokens: 3000, usd: 1000 } }),
    });
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), {
      messages: [{ role: "user", content: "z".repeat(4000) }],
      max_tokens: 1,
    });
    expect(res.status).toBe(402);
    expect(BudgetExceededError.parse(await res.json()).error.dimension).toBe("tokens");
    expect(ctx.upstream.calls).toHaveLength(0);
    expect(ctx.spends).toHaveLength(0);
  });

  it("missing-usage settlement charges exactly the byte-level bound plus the completion ceiling", async () => {
    const ctx = await setup();
    const body = { messages: [{ role: "user", content: "no-usage" }], max_tokens: 100 };
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), body);
    expect(res.status).toBe(200);
    await res.text();
    // Replicate the forwarded payload: model overwritten, ceiling fields
    // stripped before the bound is taken (framing allowance covers the
    // re-injected admitted ceiling).
    const raw = JSON.stringify(body);
    const forward = JSON.stringify({ messages: body.messages, model: "routed-model" });
    const expected =
      promptTokenUpperBound(Buffer.byteLength(raw, "utf8"), Buffer.byteLength(forward, "utf8"), 1) + 100;
    expect(ctx.spends).toHaveLength(1);
    expect(ctx.spends[0]?.tokens).toBe(expected);
    // the bound is at least one token per raw request byte
    expect(ctx.spends[0]?.tokens).toBeGreaterThanOrEqual(Buffer.byteLength(raw, "utf8") + 100);
  });

  it("unicode prompts reserve on UTF-8 bytes, not UTF-16 string length", async () => {
    const ctx = await setup();
    // 4 UTF-8 bytes per rocket, 2 UTF-16 code units: a length-based bound
    // would undercount by half the emoji payload.
    const emoji = "\u{1F680}".repeat(256);
    const body = {
      messages: [
        { role: "user", content: "no-usage" },
        { role: "user", content: emoji },
      ],
      max_tokens: 1,
    };
    const res = await postCompletions(ctx, ctx.proxy.tokenFor("mutation"), body);
    expect(res.status).toBe(200);
    await res.text();
    const raw = JSON.stringify(body);
    const rawBytes = Buffer.byteLength(raw, "utf8");
    expect(rawBytes).toBeGreaterThan(raw.length); // multi-byte payload is real
    const forward = JSON.stringify({ messages: body.messages, model: "routed-model" });
    const expected =
      promptTokenUpperBound(rawBytes, Buffer.byteLength(forward, "utf8"), 2) + 1;
    expect(ctx.spends[0]?.tokens).toBe(expected);
    // strictly larger than any UTF-16-length-based reservation could be
    expect(ctx.spends[0]?.tokens).toBeGreaterThan(raw.length + 1);
  });
});

// ---------------------------------------------------------------------------
// adversarial: bounded active-request slots (review finding 8)
// ---------------------------------------------------------------------------

describe("active request slots", () => {
  it("excess parallel large-body completions get deterministic 503 + connection close and never reach upstream", async () => {
    const ctx = await setup({ limits: { maxActiveRequests: 2 } });
    const token = ctx.proxy.tokenFor("mutation");
    // pin both slots with held upstream responses
    const held = [1, 2].map(() =>
      postCompletions(ctx, token, { messages: [{ role: "user", content: "slow" }], max_tokens: 5 }),
    );
    await until(() => ctx.upstream.slow.length === 2);
    // saturate: six more requests, each carrying a ~4MiB body — none may be
    // buffered or forwarded; aggregate proxy buffering stays at 2 requests
    const big = "b".repeat(4 * 1024 * 1024 - 4096);
    const rejected = await Promise.all(
      Array.from({ length: 6 }, () =>
        postCompletions(ctx, token, {
          messages: [{ role: "user", content: big }],
          max_tokens: 5,
        }),
      ),
    );
    for (const res of rejected) {
      expect(res.status).toBe(503);
      expect(res.headers.get("connection")).toBe("close");
      const parsed = (await res.json()) as { error: { type: string } };
      expect(parsed.error.type).toBe("hone_overloaded");
    }
    expect(ctx.upstream.calls.filter((c) => c.url === "/v1/chat/completions")).toHaveLength(2);
    // release the pinned pair: they complete normally, slots free up
    for (const release of ctx.upstream.slow.splice(0)) release();
    for (const res of await Promise.all(held)) {
      expect(res.status).toBe(200);
      await res.text();
    }
    const after = await postCompletions(ctx, token, { messages: [] });
    expect(after.status).toBe(200);
    await after.text();
  });

  it("/v1/models occupies a slot and is rejected when saturated — no upstream fetch", async () => {
    const ctx = await setup({ limits: { maxActiveRequests: 1 } });
    const token = ctx.proxy.tokenFor("mutation");
    const held = postCompletions(ctx, token, {
      messages: [{ role: "user", content: "slow" }],
      max_tokens: 5,
    });
    await until(() => ctx.upstream.slow.length === 1);
    const models = await fetch(`http://127.0.0.1:${ctx.port}/v1/models`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(models.status).toBe(503);
    expect(models.headers.get("connection")).toBe("close");
    expect(ctx.upstream.calls.filter((c) => c.url === "/v1/models")).toHaveLength(0);
    for (const release of ctx.upstream.slow.splice(0)) release();
    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    await heldRes.text();
  });

  it("slot releases after retried transport resets and durable resume", async () => {
    const ctx = await setup({ limits: { maxActiveRequests: 1 } });
    const token = ctx.proxy.tokenFor("mutation");
    const res = await postCompletions(ctx, token, {
      messages: [{ role: "user", content: "reset" }],
      max_tokens: 5,
    });
    expect(res.status).toBe(503);
    await res.text();
    await until(() => ctx.spends.length === 4);
    expect((await ctx.proxy.resume()).passed).toBe(true);
    const next = await postCompletions(ctx, token, { messages: [] });
    expect(next.status).toBe(200);
    await next.text();
  });

  it("slot releases when the client aborts mid-body upload", async () => {
    const ctx = await setup({ limits: { maxActiveRequests: 1 } });
    const token = ctx.proxy.tokenFor("mutation");
    // half-sent body over a raw socket, then hard-destroy the connection
    await new Promise<void>((resolve) => {
      const sock = net.connect(ctx.port, "127.0.0.1", () => {
        sock.write(
          "POST /v1/chat/completions HTTP/1.1\r\n" +
            "host: 127.0.0.1\r\n" +
            `authorization: Bearer ${token}\r\n` +
            "content-type: application/json\r\n" +
            "content-length: 100000\r\n\r\n" +
            '{"messages":[',
          () => {
            // headers + partial body flushed: kill the connection mid-upload
            sock.destroy();
            resolve();
          },
        );
      });
    });
    // Slot release is driven by the proxy-side socket close, which has no
    // client-visible signal — poll the observable behavior (admission) itself.
    let ok = false;
    for (let i = 0; i < 100 && !ok; i += 1) {
      const res = await postCompletions(ctx, token, { messages: [] });
      if (res.status === 200) {
        await res.text();
        ok = true;
      } else {
        await res.text();
        await sleep(20);
      }
    }
    expect(ok).toBe(true);
    expect(ctx.upstream.calls.filter((c) => c.url === "/v1/chat/completions")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// adversarial: close() is a true handler-quiescence barrier
// ---------------------------------------------------------------------------

describe("close() quiescence barrier", () => {
  it("close during an upstream that never responds completes boundedly, settles fail-closed, and stays byte-stable", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    // Two requests hang before the upstream sends ANY response bytes.
    const hung = [1, 2].map(() =>
      postCompletions(ctx, token, {
        messages: [{ role: "user", content: "slow" }],
        max_tokens: 7,
      }).catch(() => undefined),
    );
    await until(() => ctx.upstream.slow.length === 2);
    expect(ctx.spends).toHaveLength(0);

    const begun = Date.now();
    await ctx.proxy.close();
    // Bounded: the hung upstream never responds; close must not wait on it.
    expect(Date.now() - begun).toBeLessThan(2000);

    // Both admitted requests settled BEFORE close resolved. The abort is an
    // ambiguous transport failure (the upstream accepted the connection), so
    // the conservative policy charges the full reservation ceiling — never
    // zero, never fabricated usage.
    expect(ctx.spends).toHaveLength(2);
    const traces = await readTrace(ctx.runDir);
    expect(traces).toHaveLength(2);
    for (const [i, t] of traces.entries()) {
      expect(t.status).toBe(502);
      expect(t.usage.completionTokens).toBe(7);
      expect(t.usage.totalTokens).toBe(t.usage.promptTokens + 7);
      expect(ctx.spends[i]?.tokens).toBe(t.usage.totalTokens);
      expect(ctx.spends[i]?.usd).toBeGreaterThan(0);
    }

    // Post-close quiescence: no late spend, trace append, or CAS write.
    const traceSize = (await stat(join(ctx.runDir, "proxy-trace.ndjson"))).size;
    const casFiles = (await walkFiles(ctx.casDir)).sort();
    await sleep(200);
    expect(ctx.spends).toHaveLength(2);
    expect((await stat(join(ctx.runDir, "proxy-trace.ndjson"))).size).toBe(traceSize);
    expect((await walkFiles(ctx.casDir)).sort()).toEqual(casFiles);

    // Closed means closed: new connections are refused; close is idempotent.
    await expect(postCompletions(ctx, token, { messages: [] })).rejects.toThrow();
    await ctx.proxy.close();
    await Promise.all(hung);
  });

  it("close mid-stream (headers sent, body stalled) aborts the upstream and finalizes ceiling accounting", async () => {
    const ctx = await setup();
    const token = ctx.proxy.tokenFor("mutation");
    const hung = postCompletions(ctx, token, {
      messages: [{ role: "user", content: "stall" }],
      max_tokens: 3,
      stream: true,
    }).then(
      // Headers may already have arrived; drain the truncated body quietly.
      async (res) => {
        await res.text().catch(() => undefined);
      },
      () => undefined,
    );
    await until(() => ctx.upstream.stalled.length === 1);

    const begun = Date.now();
    await ctx.proxy.close();
    expect(Date.now() - begun).toBeLessThan(2000);

    // The partial SSE body carries no usage record → not trustworthy → the
    // full reservation ceiling is charged, exactly once.
    expect(ctx.spends).toHaveLength(1);
    const traces = await readTrace(ctx.runDir);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.status).toBe(200);
    expect(traces[0]?.usage.completionTokens).toBe(3);
    expect(ctx.spends[0]?.tokens).toBe(traces[0]?.usage.totalTokens);
    // The trace captured exactly the partial body that crossed the proxy.
    expect(await casContent(ctx.casDir, traces[0]?.responseBody ?? "")).toContain("par");

    // Post-close quiescence: byte/count stable after a delay.
    const traceSize = (await stat(join(ctx.runDir, "proxy-trace.ndjson"))).size;
    const casFiles = (await walkFiles(ctx.casDir)).sort();
    await sleep(200);
    expect(ctx.spends).toHaveLength(1);
    expect((await stat(join(ctx.runDir, "proxy-trace.ndjson"))).size).toBe(traceSize);
    expect((await walkFiles(ctx.casDir)).sort()).toEqual(casFiles);
    await hung;
  });
});
