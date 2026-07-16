import http from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyTraceRecord } from "@hone/schema";
import {
  createProxy,
  DEFAULT_DURABLE_IO,
  DurableLineLog,
  type DurableIo,
  type ProxyHandle,
  type SpendRecord,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** `Promise.withResolvers` ponyfill — the workspace engine floor is Node 18,
 * so this is the single sanctioned use of the executor form in this file. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** "done" if `p` settles within `ms`, else "pending" — never throws. */
async function raced(p: Promise<unknown>, ms = 80): Promise<"done" | "pending"> {
  return Promise.race([
    p.then(
      () => "done" as const,
      () => "done" as const,
    ),
    sleep(ms).then(() => "pending" as const),
  ]);
}

async function tempLogPath(...segments: string[]): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "hone-tracelog-"));
  return join(base, ...segments, "proxy-trace.ndjson");
}

async function rawLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// DurableLineLog unit tests
// ---------------------------------------------------------------------------

describe("DurableLineLog", () => {
  it("loops short writes until the full line is on disk", async () => {
    const path = await tempLogPath();
    let writeCalls = 0;
    const log = new DurableLineLog(path, {
      // 1 byte per attempt: every line requires length(line)+1 loop turns.
      async write(handle, buf, offset, length) {
        writeCalls += 1;
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
      },
    });
    await log.append('{"n":1}');
    await log.append('{"n":22}');
    await log.close();
    expect(await rawLog(path)).toBe('{"n":1}\n{"n":22}\n');
    expect(writeCalls).toBe(8 + 9); // proves the loop actually retried the remainder
  });

  it("first append fsyncs every directory that gained an entry, exactly once", async () => {
    const path = await tempLogPath("a", "b"); // <base>/a/b/proxy-trace.ndjson — a and b do not exist yet
    const dir = dirname(path); // <base>/a/b
    const synced: string[] = [];
    let firstAppendResolved = false;
    const log = new DurableLineLog(path, {
      async syncDir(p) {
        expect(firstAppendResolved).toBe(false); // dir durability precedes append resolution
        synced.push(p);
        return DEFAULT_DURABLE_IO.syncDir(p);
      },
    });
    await log.append('{"n":1}');
    firstAppendResolved = true;
    // Every directory that gained a new entry: the file's dir (new file),
    // <base>/a (new child b), and <base> (new child a).
    expect([...synced].sort()).toEqual([dirname(dirname(dir)), dirname(dir), dir].sort());
    await log.append('{"n":2}');
    expect(synced).toHaveLength(3); // second append syncs the file only, no dirs
    await log.close();
    expect(await rawLog(path)).toBe('{"n":1}\n{"n":2}\n');
  });

  it("an fsync failure poisons the log: the append rejects and later appends fail closed without writing", async () => {
    const path = await tempLogPath();
    let writeCalls = 0;
    let failSync = true;
    const log = new DurableLineLog(path, {
      async write(handle, buf, offset, length) {
        writeCalls += 1;
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, length);
      },
      async syncFile(handle) {
        if (failSync) throw new Error("EIO: simulated fsync failure");
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
    });
    await expect(log.append('{"n":1}')).rejects.toThrow(/simulated fsync failure/);
    const writesAfterFailure = writeCalls;
    failSync = false; // even a now-healthy disk must not resurrect the log
    await expect(log.append('{"n":2}')).rejects.toThrow(/poisoned/);
    await expect(log.append('{"n":3}')).rejects.toThrow(/poisoned/);
    expect(writeCalls).toBe(writesAfterFailure); // poisoned appends never touch the file
    // A poisoned log has no clean shutdown: close rejects, idempotently.
    const closed = log.close();
    expect(log.close()).toBe(closed); // every closer observes the same rejection
    await expect(closed).rejects.toThrow(/poisoned.*simulated fsync failure/);
  });

  it("a mid-line write failure leaves a torn tail but no resolved append, and poisons the log", async () => {
    const path = await tempLogPath();
    let attempts = 0;
    const log = new DurableLineLog(path, {
      async write(handle, buf, offset, length) {
        attempts += 1;
        if (attempts > 3) throw new Error("ENOSPC: simulated");
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
      },
    });
    await expect(log.append('{"n":1}')).rejects.toThrow(/ENOSPC/);
    await expect(log.append('{"n":2}')).rejects.toThrow(/poisoned/);
    await expect(log.close()).rejects.toThrow(/poisoned/);
    expect(await rawLog(path)).toBe('{"n'); // torn tail, and nothing after it
  });

  it("treats a zero-progress write as a failure instead of looping forever", async () => {
    const path = await tempLogPath();
    const log = new DurableLineLog(path, {
      async write() {
        return 0;
      },
    });
    await expect(log.append('{"n":1}')).rejects.toThrow(/no progress/);
    await expect(log.append('{"n":2}')).rejects.toThrow(/poisoned/);
    await expect(log.close()).rejects.toThrow(/poisoned/);
  });

  it("concurrent appends never interleave and land in call order", async () => {
    const path = await tempLogPath();
    const log = new DurableLineLog(path, {
      // 1-byte writes maximize the interleaving window a broken writer would hit.
      async write(handle, buf, offset, length) {
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
      },
    });
    const lines = Array.from({ length: 20 }, (_, i) => JSON.stringify({ seq: i, pad: "x".repeat(i) }));
    await Promise.all(lines.map((l) => log.append(l)));
    await log.close();
    const got = (await rawLog(path)).split("\n").filter((l) => l !== "");
    expect(got).toEqual(lines); // complete, parseable, in call order
    for (const line of got) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toBeTypeOf("object");
    }
  });

  it("close drains queued appends, then refuses new ones; idempotent", async () => {
    const path = await tempLogPath();
    const gate = deferred<void>();
    const log = new DurableLineLog(path, {
      async syncFile(handle) {
        await gate.promise;
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
    });
    const a1 = log.append('{"n":1}');
    const a2 = log.append('{"n":2}');
    const closed = log.close();
    expect(log.close()).toBe(closed); // idempotent: same promise
    await expect(log.append('{"n":3}')).rejects.toThrow(/closed/);
    expect(await raced(closed)).toBe("pending"); // close cannot resolve past queued appends
    gate.resolve();
    await a1;
    await a2;
    await closed;
    expect(await rawLog(path)).toBe('{"n":1}\n{"n":2}\n'); // drained, nothing more
  });

  it("fail() poisons the log externally: first error wins, appends and close reject", async () => {
    const path = await tempLogPath();
    const log = new DurableLineLog(path);
    await log.append('{"n":1}');
    log.fail(new Error("cas publication exploded"));
    log.fail(new Error("a later, irrelevant error")); // first error wins
    expect(log.poisoned?.message).toBe("cas publication exploded");
    await expect(log.append('{"n":2}')).rejects.toThrow(/cas publication exploded/);
    await expect(log.close()).rejects.toThrow(/poisoned.*cas publication exploded/);
    expect(await rawLog(path)).toBe('{"n":1}\n'); // nothing appended behind the poison
  });

  it("reopen after a crash truncates a torn tail back to the last newline before appending", async () => {
    const path = await tempLogPath();
    // Simulate a crashed writer: two complete lines, then a torn fragment
    // spanning MULTIPLE scan chunks (>4096 bytes, no newline).
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `{"n":1}\n{"n":2}\n` + `{"torn":"${"x".repeat(5000)}`);
    const log = new DurableLineLog(path);
    await log.append('{"n":3}');
    await log.close();
    expect(await rawLog(path)).toBe('{"n":1}\n{"n":2}\n{"n":3}\n'); // torn tail gone, never concatenated
  });

  it("reopen of a file with no newline at all recovers to empty", async () => {
    const path = await tempLogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"torn-only-fragment');
    const log = new DurableLineLog(path);
    await log.append('{"n":1}');
    await log.close();
    expect(await rawLog(path)).toBe('{"n":1}\n');
  });

  it("a recovery fsync failure poisons the log and close rejects", async () => {
    const path = await tempLogPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"n":1}\n{"torn'); // truncation (and its fsync) required on open
    const log = new DurableLineLog(path, {
      async syncFile() {
        throw new Error("EIO: recovery fsync failed");
      },
    });
    await expect(log.append('{"n":2}')).rejects.toThrow(/recovery fsync failed/);
    await expect(log.append('{"n":3}')).rejects.toThrow(/poisoned/);
    await expect(log.close()).rejects.toThrow(/poisoned.*recovery fsync failed/);
  });
});

// ---------------------------------------------------------------------------
// proxy integration: trace durability end to end
// ---------------------------------------------------------------------------

interface Ctx {
  proxy: ProxyHandle;
  port: number;
  runDir: string;
  casDir: string;
  spends: SpendRecord[];
  upstreamCalls: { count: number };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startUpstream(): Promise<{
  port: number;
  calls: { count: number };
  close: () => Promise<void>;
}> {
  const calls = { count: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.count += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
  });
  const listening = deferred<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    port,
    calls,
    close: () => {
      const done = deferred<void>();
      server.close(() => done.resolve());
      server.closeAllConnections();
      return done.promise;
    },
  };
}

async function setup(traceIo?: Partial<DurableIo>, casIo?: Partial<DurableIo>): Promise<Ctx> {
  const base = await mkdtemp(join(tmpdir(), "hone-tracedur-"));
  const runDir = join(base, "run");
  const casDir = join(base, "cas");
  const upstream = await startUpstream();
  const spends: SpendRecord[] = [];
  const proxy = createProxy({
    runId: "run_trace",
    routing: { mutation: { model: "routed-model" } },
    runDir,
    casDir,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
    checkBudget: () => ({ allowed: true, remaining: { tokens: 1_000_000_000, usd: 1_000_000 } }),
    recordSpend: (s) => {
      spends.push(s);
    },
    ...(traceIo === undefined ? {} : { traceIo }),
    ...(casIo === undefined ? {} : { casIo }),
  });
  const port = await proxy.listenTcp(0);
  cleanups.push(async () => {
    // Poison-injection tests assert close() rejection explicitly in-test;
    // cleanup only guarantees teardown.
    await proxy.close().catch(() => undefined);
    await upstream.close();
  });
  return { proxy, port, runDir, casDir, spends, upstreamCalls: upstream.calls };
}

function postCompletions(ctx: Ctx, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.proxy.tokenFor("mutation")}`,
    },
    body: JSON.stringify(body),
  });
}

function tracePath(ctx: Ctx): string {
  return join(ctx.runDir, "proxy-trace.ndjson");
}

describe("proxy trace durability", () => {
  it("a trace fsync failure fails the response closed, and the NEXT request also fails closed", async () => {
    const ctx = await setup({
      async syncFile() {
        throw new Error("EIO: simulated fsync failure");
      },
    });

    // First request: upstream succeeded and spend settled, but the trace
    // line never became durable — the response must not complete cleanly.
    const first = await postCompletions(ctx, { messages: [], max_tokens: 5 });
    await expect(first.text()).rejects.toThrow();
    expect(ctx.spends).toHaveLength(1); // settle precedes trace; spend is never lost

    // Second request: the corpus-authority gate refuses it BEFORE any body
    // buffering, budget check, or upstream dispatch — deterministic 503,
    // connection close, no new spend, upstream never sees it.
    const second = await postCompletions(ctx, { messages: [], max_tokens: 5 });
    expect(second.status).toBe(503);
    const secondBody: unknown = await second.json();
    expect(secondBody).toMatchObject({ error: { type: "hone_trace_authority_failed" } });
    expect(ctx.upstreamCalls.count).toBe(1); // only the first request reached upstream
    expect(ctx.spends).toHaveLength(1); // the refused request consumed no budget

    // Exactly one (unsynced) line was ever written; the poisoned append
    // added nothing for the second request.
    const raw = await rawLog(tracePath(ctx));
    expect(raw.split("\n").filter((l) => l !== "")).toHaveLength(1);

    // Poison surfaces at shutdown: close() still quiesces fully but REJECTS
    // (idempotently), so a supervisor can never record a clean run over a
    // corpus whose trace authority failed.
    await expect(ctx.proxy.close()).rejects.toThrow(/poisoned.*simulated fsync failure/);
    await expect(ctx.proxy.close()).rejects.toThrow(/poisoned/); // same rejection on every call
  });

  it("a CAS publication failure poisons the authority: next request is refused pre-upstream and close rejects", async () => {
    let failCas = true;
    const ctx = await setup(undefined, {
      async syncFile(handle) {
        if (failCas) throw new Error("EIO: simulated cas fsync failure");
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
    });

    // First request: upstream succeeded and spend settled, but the request/
    // response bodies never became durable — no line may reference them, the
    // response must not complete cleanly, and the authority is poisoned.
    const first = await postCompletions(ctx, { messages: [], max_tokens: 5 });
    await expect(first.text()).rejects.toThrow();
    expect(ctx.spends).toHaveLength(1);
    expect(await rawLog(tracePath(ctx))).toBe(""); // CAS failed BEFORE line publication

    // Second request: refused at admission even though CAS is healthy again —
    // no upstream dispatch, no budget consumption, no trace line.
    failCas = false;
    const second = await postCompletions(ctx, { messages: [], max_tokens: 5 });
    expect(second.status).toBe(503);
    const secondBody: unknown = await second.json();
    expect(secondBody).toMatchObject({ error: { type: "hone_trace_authority_failed" } });
    expect(ctx.upstreamCalls.count).toBe(1);
    expect(ctx.spends).toHaveLength(1);
    expect(await rawLog(tracePath(ctx))).toBe("");

    // The failed corpus authority is close-visible, idempotently.
    await expect(ctx.proxy.close()).rejects.toThrow(/poisoned.*cas fsync failure/);
    await expect(ctx.proxy.close()).rejects.toThrow(/poisoned/);
  });

  it("the response completes only after the CAS bodies exist and the trace line is fsynced", async () => {
    const gate = deferred<void>();
    const sawSync = deferred<void>();
    let synced = 0;
    const ctx = await setup({
      async syncFile(handle) {
        synced += 1;
        sawSync.resolve();
        await gate.promise;
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
    });

    const res = await postCompletions(ctx, { messages: [], max_tokens: 5 });
    expect(res.status).toBe(200);
    const bodyDone = res.text();
    await sawSync.promise;

    // At fsync time the COMPLETE line is already written and both CAS bodies
    // it references already exist — content publication precedes the index.
    const lines = (await rawLog(tracePath(ctx))).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    const rec = ProxyTraceRecord.parse(JSON.parse(lines[0]!));
    for (const ref of [rec.requestBody, rec.responseBody]) {
      const hex = ref.replace(/^sha256:/, "");
      await expect(readFile(join(ctx.casDir, "sha256", hex.slice(0, 2), hex), "utf8")).resolves.toBeTypeOf("string");
    }

    // ...and the client response cannot complete until the fsync resolves.
    expect(await raced(bodyDone)).toBe("pending");
    gate.resolve();
    await expect(bodyDone).resolves.toContain("hello");
    expect(synced).toBe(1);
  });

  it("concurrent requests produce complete, non-interleaved, schema-valid trace lines", async () => {
    const ctx = await setup({
      // 1-byte writes make any missing serialization interleave the lines.
      async write(handle, buf, offset, length) {
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        postCompletions(ctx, { messages: [{ role: "user", content: `req-${i}` }], max_tokens: 5 }),
      ),
    );
    await Promise.all(responses.map((r) => r.text()));
    const lines = (await rawLog(tracePath(ctx))).split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      const rec = ProxyTraceRecord.parse(JSON.parse(line)); // throws on any torn/interleaved line
      expect(rec.runId).toBe("run_trace");
      expect(rec.usage.totalTokens).toBe(120);
    }
  });

  it("close drains an in-flight trace before resolving; nothing appends afterwards", async () => {
    const gate = deferred<void>();
    const sawSync = deferred<void>();
    const ctx = await setup({
      async syncFile(handle) {
        sawSync.resolve();
        await gate.promise;
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
    });

    const res = await postCompletions(ctx, { messages: [], max_tokens: 5 });
    const bodyDone = res.text().catch(() => "");
    await sawSync.promise;

    // Close while the trace fsync is still pending: it must wait for the line.
    const closed = ctx.proxy.close();
    expect(await raced(closed)).toBe("pending");
    gate.resolve();
    await closed;
    await bodyDone;

    // The drained line is complete and parseable; the file never grows again.
    const raw = await rawLog(tracePath(ctx));
    const lines = raw.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(1);
    ProxyTraceRecord.parse(JSON.parse(lines[0]!));
    await sleep(150);
    expect(await rawLog(tracePath(ctx))).toBe(raw);
  });
});
