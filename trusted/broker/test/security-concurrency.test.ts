import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { BrokerServer, type BrokerServerOptions } from "../src/server.js";
import { deferred } from "../src/deferred.js";
import { buildTestCapsule, TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST } from "./helpers.js";

// ---------------------------------------------------------------------------
// Review finding 7 — aggregate RPC work must be bounded. An adversarial client
// that pipelines thousands of small frames must NOT be able to start an
// unbounded number of concurrent handlers or make the broker queue unbounded
// bytes. These tests drive the real unix-socket wire with a Broker whose
// `exec` handler is replaced by a gated mock, so handler concurrency is
// observable without Docker. All synchronization is event-driven (admission /
// completion waiters), never wall-clock sleeps.
// ---------------------------------------------------------------------------

const MAX_FRAME = 4096;
/** Per-broker public bearer (>=32 bytes) — required on every public-socket request. */
const PUBLIC_TOKEN = "concurrency-test-public-token-".padEnd(64, "c");

interface LineSock {
  write(data: string | Buffer): void;
  nextLine(): Promise<string>;
  closed: Promise<void>;
  destroy(): void;
}

function connectLines(socketPath: string): Promise<LineSock> {
  const conn = deferred<LineSock>();
  const sock = net.connect(socketPath);
  const closed = deferred<void>();
  let buf = "";
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  sock.on("close", () => closed.resolve());
  sock.on("error", () => {}); // EPIPE after server-side teardown is expected
  sock.once("connect", () =>
    conn.resolve({
      write: (data) => sock.write(data),
      nextLine: () => {
        const head = lines.shift();
        if (head !== undefined) return Promise.resolve(head);
        const { promise, resolve } = deferred<string>();
        waiters.push(resolve);
        return promise;
      },
      closed: closed.promise,
      destroy: () => sock.destroy(),
    }),
  );
  sock.once("error", conn.reject);
  return conn.promise;
}

function execFrame(id: number): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "exec", params: { sandboxId: "sb", argv: ["true"] }, token: PUBLIC_TOKEN })}\n`;
}

async function collectResponses(c: LineSock, n: number): Promise<Array<{ id: unknown; error?: { code: number } }>> {
  const out: Array<{ id: unknown; error?: { code: number } }> = [];
  for (let i = 0; i < n; i++) out.push(JSON.parse(await c.nextLine()));
  return out;
}

/**
 * Event-loop-driven wait, no wall-clock timers: each setImmediate turn lets
 * pending I/O callbacks (e.g. the server observing a broken pipe) run. Bounded
 * so a wrong implementation fails instead of hanging.
 */
async function eventually(cond: () => boolean, what: string): Promise<void> {
  for (let turns = 0; turns < 100_000; turns++) {
    if (cond()) return;
    const { promise, resolve } = deferred<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error(`not observed within bounded event-loop turns: ${what}`);
}

interface ExecGate {
  /** Handlers currently blocked inside the mock. */
  readonly active: () => number;
  /** High-water mark of concurrently active handlers. */
  readonly peak: () => number;
  /** Total handlers ever admitted into the mock. */
  readonly admittedCount: () => number;
  /** Resolves once at least `n` handlers have been admitted. */
  admitted(n: number): Promise<void>;
  /** Resolves once at least `n` handlers have completed. */
  completed(n: number): Promise<void>;
  /** Release the currently blocked handlers (new ones keep blocking). */
  releaseBlocked(): void;
  /** Release everything now and auto-release all future admissions. */
  drain(): void;
}

/** Gated mock over broker.exec: counts active handlers, blocks until released. */
function gateExec(broker: Broker): ExecGate {
  let active = 0;
  let peak = 0;
  let admitted = 0;
  let completed = 0;
  let draining = false;
  const gates: Array<() => void> = [];
  const admitWaiters: Array<{ n: number; resolve: () => void }> = [];
  const doneWaiters: Array<{ n: number; resolve: () => void }> = [];
  const notify = (list: Array<{ n: number; resolve: () => void }>, count: number) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const w = list[i];
      if (w && count >= w.n) {
        list.splice(i, 1);
        w.resolve();
      }
    }
  };
  vi.spyOn(broker, "exec").mockImplementation(async () => {
    active++;
    admitted++;
    peak = Math.max(peak, active);
    notify(admitWaiters, admitted);
    const { promise, resolve } = deferred<void>();
    if (draining) resolve();
    else gates.push(resolve);
    await promise;
    active--;
    completed++;
    notify(doneWaiters, completed);
    return { exitCode: 0, stdout: "", stderr: "", truncated: false };
  });
  const waitFor = (list: Array<{ n: number; resolve: () => void }>, current: () => number, n: number) => {
    if (current() >= n) return Promise.resolve();
    const { promise, resolve } = deferred<void>();
    list.push({ n, resolve });
    return promise;
  };
  return {
    active: () => active,
    peak: () => peak,
    admittedCount: () => admitted,
    admitted: (n) => waitFor(admitWaiters, () => admitted, n),
    completed: (n) => waitFor(doneWaiters, () => completed, n),
    releaseBlocked: () => {
      for (const gate of gates.splice(0)) gate();
    },
    drain: () => {
      draining = true;
      for (const gate of gates.splice(0)) gate();
    },
  };
}

describe("bounded JSON-RPC concurrency", () => {
  let base: string;
  let broker: Broker;
  let servers: BrokerServer[];
  let sockN = 0;

  async function makeServer(
    opts: Omit<BrokerServerOptions, "socketPath" | "adminSocketPath" | "publicToken">,
  ): Promise<{ server: BrokerServer; socketPath: string }> {
    sockN++;
    const socketPath = path.join(base, "run", `s${sockN}.sock`);
    const adminSocketPath = path.join(base, "run", `s${sockN}a.sock`);
    const server = new BrokerServer(broker, { socketPath, adminSocketPath, publicToken: PUBLIC_TOKEN, ...opts });
    await server.listen();
    servers.push(server);
    return { server, socketPath };
  }

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "hone-conc-"));
    const capsule = await buildTestCapsule(base, {
      maxTokens: 1_000_000,
      maxUsd: 100,
      maxWallClockSec: 3600,
      maxEvaluatorInvocations: 100,
    });
    broker = new Broker({
      runId: "run_conc_test",
      manifest: capsule.manifest,
      capsuleRootDir: capsule.capsuleRootDir,
      baselineArtifactHash: `sha256:${"0".repeat(64)}`,
      capsuleDigest: TEST_CAPSULE_DIGEST,
      optimizerDigest: TEST_OPTIMIZER_DIGEST,
      holdoutLedgerPath: path.join(base, "run", "holdout-ledger.ndjson"),
      image: TEST_IMAGE,
      runDir: path.join(base, "run"),
      casDir: path.join(base, "cas"),
      onEvent: () => {},
    });
    servers = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.map((s) => s.close()));
    servers.length = 0;
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("caps in-flight handlers per connection and preserves every response id under a pipelined burst", async () => {
    const g = gateExec(broker);
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConcurrentPerConnection: 4,
      maxConcurrentGlobal: 8,
      maxQueuedBytesPerConnection: 8192,
    });
    const c = await connectLines(socketPath);

    // 20 pipelined frames, written fragmented at boundaries that split frames
    // mid-JSON — the server must reassemble, admit at most 4, queue the rest.
    const burst = Array.from({ length: 20 }, (_, i) => execFrame(i + 1)).join("");
    for (let off = 0; off < burst.length; off += 33) c.write(burst.slice(off, off + 33));

    await g.admitted(4);
    expect(g.active()).toBe(4);
    expect(server.stats.inFlight).toBe(4); // active handlers pinned at the cap
    expect(server.stats.queuedBytes).toBeGreaterThan(0); // backlog queued, not running
    expect(server.stats.queuedBytes).toBeLessThanOrEqual(8192); // and bounded

    // Drain: releasing gates admits queued frames, still never above the cap.
    g.drain();
    const resps = await collectResponses(c, 20);

    // If a 5th handler had EVER started while 4 were blocked, peak would be 5.
    expect(g.peak()).toBe(4);
    expect(g.admittedCount()).toBe(20);
    expect(resps.map((r) => r.id).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    for (const r of resps) expect(r.error).toBeUndefined();
    c.destroy();
  });

  it("enforces the global cap while still serving a second client concurrently", async () => {
    const g = gateExec(broker);
    const { socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConcurrentPerConnection: 4,
      maxConcurrentGlobal: 6,
      maxQueuedBytesPerConnection: 8192,
    });
    const c1 = await connectLines(socketPath);
    const c2 = await connectLines(socketPath);

    for (let i = 1; i <= 6; i++) c1.write(execFrame(i));
    await g.admitted(4); // client 1 saturates its per-connection cap

    // A second client is NOT starved by client 1's backlog: it gets the two
    // remaining global permits.
    for (let i = 101; i <= 106; i++) c2.write(execFrame(i));
    await g.admitted(6);
    expect(g.active()).toBe(6);

    g.drain();
    const [r1, r2] = await Promise.all([collectResponses(c1, 6), collectResponses(c2, 6)]);

    expect(g.peak()).toBe(6); // global cap never exceeded, even while draining
    expect(new Set(r1.map((r) => r.id))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(new Set(r2.map((r) => r.id))).toEqual(new Set([101, 102, 103, 104, 105, 106]));
    c1.destroy();
    c2.destroy();
  });

  it("closes deterministically with one error frame when the pipelined backlog exceeds the byte cap", async () => {
    const g = gateExec(broker);
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConcurrentPerConnection: 1,
      maxConcurrentGlobal: 8,
      maxQueuedBytesPerConnection: 512,
    });
    const c1 = await connectLines(socketPath);
    c1.write(execFrame(1));
    await g.admitted(1); // first handler blocked in flight

    // One burst of small frames (~1.7 KiB, written in one chunk) — queued
    // bytes pass the 512-byte cap, so the server answers ONE overload error
    // and closes; it never buffers or dispatches the whole backlog.
    let burst = "";
    for (let i = 2; i <= 21; i++) burst += execFrame(i);
    c1.write(burst);
    const resp = JSON.parse(await c1.nextLine());
    expect(resp.id).toBeNull();
    expect(resp.error.code).toBe(-32050);
    expect(resp.error.message).toMatch(/backlog exceeds 512 bytes/);
    await c1.closed;
    // The rejected backlog is dropped, never held: only the one in-flight
    // handler's permit remains.
    expect(server.stats.queuedBytes).toBe(0);
    expect(server.stats.inFlight).toBe(1);

    // The server stays live for other clients while the abusive connection's
    // in-flight handler is still running.
    const c2 = await connectLines(socketPath);
    c2.write(execFrame(500));
    await g.admitted(2);
    g.releaseBlocked();
    const r2 = JSON.parse(await c2.nextLine());
    expect(r2.id).toBe(500);
    expect(r2.error).toBeUndefined();
    await g.completed(2);
    // Nothing from the rejected backlog was ever dispatched.
    expect(g.admittedCount()).toBe(2);
    c2.destroy();
  });

  it("releases permits when handlers reject, so rejection cannot wedge the connection", async () => {
    const boom = vi.spyOn(broker, "exec").mockRejectedValue(new Error("boom"));
    const { socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConcurrentPerConnection: 4,
      maxConcurrentGlobal: 8,
      maxQueuedBytesPerConnection: 8192,
    });
    const c = await connectLines(socketPath);

    // 12 pipelined frames against a 4-permit connection: if a rejecting
    // handler leaked its permit, frames 5..12 would never be answered.
    for (let i = 1; i <= 12; i++) c.write(execFrame(i));
    const resps = await collectResponses(c, 12);
    expect(new Set(resps.map((r) => r.id))).toEqual(new Set(Array.from({ length: 12 }, (_, i) => i + 1)));
    for (const r of resps) expect(r.error?.code).toBe(-32006); // INTERNAL, id preserved
    boom.mockRestore();

    // Permits were released: the same connection still reaches full concurrency.
    const g = gateExec(broker);
    for (let i = 21; i <= 24; i++) c.write(execFrame(i));
    await g.admitted(4);
    expect(g.active()).toBe(4);
    g.drain();
    const more = await collectResponses(c, 4);
    expect(new Set(more.map((r) => r.id))).toEqual(new Set([21, 22, 23, 24]));
    c.destroy();
  });

  it("cancels a disconnected client's backlog and leaks no permits", async () => {
    const g = gateExec(broker);
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConcurrentPerConnection: 2,
      maxConcurrentGlobal: 8,
      maxQueuedBytesPerConnection: 8192,
    });
    const c1 = await connectLines(socketPath);
    for (let i = 1; i <= 6; i++) c1.write(execFrame(i));
    await g.admitted(2); // two in flight, four queued behind the paused socket
    c1.destroy();
    await c1.closed;

    // A FIN can race the two handler completions. At most one already-
    // permitted wave may start before the server observes the dead peer; the
    // remaining backlog must then be cancelled.
    g.releaseBlocked();
    await eventually(
      () => server.stats.connections === 0 || g.admittedCount() === 4,
      "disconnect observed or one admitted wave",
    );
    g.releaseBlocked();
    await eventually(() => server.stats.connections === 0, "server observes the dead client");
    g.drain();
    await eventually(() => server.stats.inFlight === 0, "all permits released");
    expect(server.stats.queuedBytes).toBe(0);
    expect(g.admittedCount()).toBeLessThanOrEqual(4); // frames 5-6 never start

    // Server remains live for a fresh client after the mess.
    const beforeFresh = g.admittedCount();
    const c2 = await connectLines(socketPath);
    c2.write(execFrame(7));
    await g.admitted(beforeFresh + 1);
    g.releaseBlocked();
    const r = JSON.parse(await c2.nextLine());
    expect(r.id).toBe(7);
    expect(r.error).toBeUndefined();
    c2.destroy();
  });

  it("caps AUTHENTICATED connections at promotion, frees the slot on disconnect, and never counts pre-auth sockets against it", async () => {
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConnections: 2,
    });
    const authFrame = (id: number): string => `${JSON.stringify({ jsonrpc: "2.0", id, method: "noSuchMethod", token: PUBLIC_TOKEN })}\n`;
    // Two clients authenticate via their first valid-token frame (-32601 is a
    // full request/response round trip) and fill the protected capacity.
    const c1 = await connectLines(socketPath);
    const c2 = await connectLines(socketPath);
    c1.write(authFrame(1));
    c2.write(authFrame(2));
    expect(JSON.parse(await c1.nextLine()).error.code).toBe(-32601);
    expect(JSON.parse(await c2.nextLine()).error.code).toBe(-32601);
    expect(server.stats.authenticated).toBe(2);

    // A third token-holder connects fine (pre-auth pool) but is rejected
    // deterministically at PROMOTION: one overload frame, then close.
    const c3 = await connectLines(socketPath);
    c3.write(authFrame(3));
    const rejected = JSON.parse(await c3.nextLine());
    expect(rejected.id).toBeNull();
    expect(rejected.error.code).toBe(-32050);
    expect(rejected.error.message).toMatch(/too many connections \(max 2\)/);
    await c3.closed;
    expect(server.stats.authenticated).toBe(2);

    // The two admitted connections still work.
    c1.write(authFrame(4));
    expect(JSON.parse(await c1.nextLine()).error.code).toBe(-32601);

    // Disconnecting frees the slot for a new client.
    c2.destroy();
    await eventually(() => server.stats.authenticated === 1, "slot freed on disconnect");
    const c4 = await connectLines(socketPath);
    c4.write(authFrame(5));
    expect(JSON.parse(await c4.nextLine()).error.code).toBe(-32601);
    c1.destroy();
    c4.destroy();
  });

  it("held-idle flood: squatters churn the bounded pre-auth pool, a token-holder still gets in, and authenticated peers are never evicted", async () => {
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConnections: 8,
      maxUnauthenticatedConnections: 3,
    });
    const authFrame = (id: number): string => `${JSON.stringify({ jsonrpc: "2.0", id, method: "noSuchMethod", token: PUBLIC_TOKEN })}\n`;

    // A legitimate client authenticates first — it must survive everything below.
    const legit = await connectLines(socketPath);
    legit.write(authFrame(1));
    expect(JSON.parse(await legit.nextLine()).error.code).toBe(-32601);
    expect(server.stats.authenticated).toBe(1);

    // An unrelated-UID squatter opens idle sockets (never a byte) up to the
    // pre-auth cap. They hold NO authenticated capacity.
    const squatters: LineSock[] = [];
    for (let i = 0; i < 3; i++) {
      squatters.push(await connectLines(socketPath));
      await eventually(() => server.stats.unauthenticated === i + 1, `squatter ${i + 1} pooled`);
    }
    expect(server.stats.authenticated).toBe(1);

    // Sustained churn: each further connect displaces the OLDEST squatter
    // with one -32060 eviction frame; total sockets stay bounded.
    const churn: LineSock[] = [];
    for (let i = 0; i < 3; i++) {
      churn.push(await connectLines(socketPath));
      const evicted = JSON.parse(await (squatters[i] as LineSock).nextLine());
      expect(evicted.id).toBeNull();
      expect(evicted.error.code).toBe(-32060);
      expect(evicted.error.message).toMatch(/displaced by a newer connect/);
      await (squatters[i] as LineSock).closed;
      expect(server.stats.connections).toBeLessThanOrEqual(8 + 3); // FD bound: authed cap + pre-auth pool
    }

    // A correct-token client arriving mid-flood is admitted (evicting a
    // squatter, never an authenticated peer) and authenticates first try.
    const arriving = await connectLines(socketPath);
    arriving.write(authFrame(2));
    expect(JSON.parse(await arriving.nextLine()).error.code).toBe(-32601);
    expect(server.stats.authenticated).toBe(2);

    // The original authenticated connection survived the entire churn.
    legit.write(authFrame(3));
    expect(JSON.parse(await legit.nextLine()).error.code).toBe(-32601);

    legit.destroy();
    arriving.destroy();
    for (const c of churn) c.destroy();
  });

  it("closes a public socket that does not authenticate within the deadline — wrong tokens do not extend it", async () => {
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      authWindowMs: 25,
    });
    // Idle squatter: evicted at the deadline with one -32060 frame.
    const idle = await connectLines(socketPath);
    const idleEvicted = JSON.parse(await idle.nextLine());
    expect(idleEvicted.id).toBeNull();
    expect(idleEvicted.error.code).toBe(-32060);
    expect(idleEvicted.error.message).toMatch(/not authenticated within 25ms/);
    await idle.closed;

    // Wrong-token requester: each frame is answered -32060 but the deadline
    // still fires — partial/wrong auth never holds the FD open.
    const wrong = await connectLines(socketPath);
    wrong.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBudget", token: "nope" })}\n`);
    expect(JSON.parse(await wrong.nextLine()).error.code).toBe(-32060);
    await wrong.closed; // deadline eviction, not client action
    await eventually(() => server.stats.connections === 0, "all pre-auth sockets released");
    expect(server.stats.unauthenticated).toBe(0);
  });

  it("evicts the largest holder when pre-newline fragments exceed the global byte budget", async () => {
    const { server, socketPath } = await makeServer({
      maxFrameBytes: 8192,
      maxQueuedBytesPerConnection: 8192,
      maxBufferedBytesGlobal: 10_000,
    });
    // Three clients hold incomplete frames (no newline): 2000 + 3000 bytes
    // fit the 10_000 budget, the 6000-byte holder pushes it to 11_000 and,
    // as the largest holder, is evicted; the smaller two are untouched.
    const frag = (id: number, size: number): string => {
      const req = { jsonrpc: "2.0", id, method: "noSuchMethod", params: { pad: "" }, token: PUBLIC_TOKEN };
      req.params.pad = "p".repeat(size - JSON.stringify(req).length);
      return JSON.stringify(req); // exactly `size` bytes, NO trailing newline
    };
    const c1 = await connectLines(socketPath);
    const c2 = await connectLines(socketPath);
    const c3 = await connectLines(socketPath);
    c1.write(frag(1, 2000));
    c2.write(frag(2, 3000));
    await eventually(() => server.stats.bufferedBytes === 5000, "two fragments retained");

    c3.write(frag(3, 6000));
    const evicted = JSON.parse(await c3.nextLine());
    expect(evicted.id).toBeNull();
    expect(evicted.error.code).toBe(-32050);
    expect(evicted.error.message).toMatch(/global buffered-byte budget exceeded \(10000 bytes\)/);
    await c3.closed;
    expect(server.stats.bufferedBytes).toBe(5000); // eviction returned its bytes
    expect(server.stats.bufferedBytes).toBeLessThanOrEqual(10_000);

    // Survivors complete their frames and get real responses; dispatch
    // releases the retained bytes.
    c1.write("\n");
    c2.write("\n");
    expect(JSON.parse(await c1.nextLine()).id).toBe(1);
    expect(JSON.parse(await c2.nextLine()).id).toBe(2);
    await eventually(() => server.stats.bufferedBytes === 0, "all retained bytes released");
    c1.destroy();
    c2.destroy();
  });

  it("counts queued complete frames against the global budget and releases on dispatch and close", async () => {
    const g = gateExec(broker);
    // Per-connection queue caps (4096) would allow far more than the global
    // budget across connections — the budget must bind first.
    const c1Burst = Array.from({ length: 13 }, (_, i) => execFrame(i + 1)).join("");
    const c2Burst = Array.from({ length: 11 }, (_, i) => execFrame(i + 101)).join("");
    const c1First = execFrame(1);
    const c2First = execFrame(101);
    const c1Retained = Buffer.byteLength(c1Burst) - Buffer.byteLength(c1First); // 12 queued frames
    const c2Retained = Buffer.byteLength(c2Burst) - Buffer.byteLength(c2First); // 10 queued frames
    const budget = c1Retained + c2Retained + 100;
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxConcurrentPerConnection: 1,
      maxConcurrentGlobal: 8,
      maxQueuedBytesPerConnection: 4096,
      maxBufferedBytesGlobal: budget,
    });

    const c1 = await connectLines(socketPath);
    c1.write(c1Burst); // frame 1 runs (blocked), 12 frames queue
    await g.admitted(1);
    const c2 = await connectLines(socketPath);
    c2.write(c2Burst); // frame 101 runs (blocked), 10 frames queue
    await g.admitted(2);
    await eventually(() => server.stats.bufferedBytes === c1Retained + c2Retained, "both backlogs retained");

    // A third connection's 200-byte fragment pushes the total 100 bytes over
    // budget; the LARGEST holder (c1's backlog) is evicted, not the sender.
    const c3 = await connectLines(socketPath);
    c3.write("x".repeat(200)); // incomplete frame, no newline
    const evicted = JSON.parse(await c1.nextLine());
    expect(evicted.id).toBeNull();
    expect(evicted.error.code).toBe(-32050);
    expect(evicted.error.message).toMatch(/global buffered-byte budget exceeded/);
    await c1.closed;
    await eventually(() => server.stats.bufferedBytes === c2Retained + 200, "c1 backlog returned to the pool");

    // c2's queued frames still dispatch to completion and release their bytes.
    g.drain();
    const r2 = await collectResponses(c2, 11);
    expect(new Set(r2.map((r) => r.id))).toEqual(new Set(Array.from({ length: 11 }, (_, i) => i + 101)));
    await eventually(() => server.stats.bufferedBytes === 200, "only c3's fragment retained");

    // Closing c3 returns its fragment bytes.
    c3.destroy();
    await eventually(() => server.stats.bufferedBytes === 0, "fragment released on close");
    expect(server.stats.inFlight).toBe(0);
    c2.destroy();
  });
  it("caps aggregate outbound responses and returns the reservation after rejection", async () => {
    vi.spyOn(broker, "exec")
      .mockResolvedValueOnce({ exitCode: 0, stdout: "x".repeat(512), stderr: "", truncated: false })
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", truncated: false });
    const { server, socketPath } = await makeServer({
      maxFrameBytes: MAX_FRAME,
      maxResponseBytes: 1024,
      maxOutboundBytesGlobal: 256,
    });

    const oversized = await connectLines(socketPath);
    oversized.write(execFrame(1));
    await oversized.closed;
    await eventually(
      () => server.stats.inFlight === 0 && server.stats.outboundBytes === 0,
      "oversized response reservation released",
    );

    // The offending connection dies, not the server; a bounded response on a
    // fresh connection still succeeds.
    const bounded = await connectLines(socketPath);
    bounded.write(execFrame(2));
    expect(JSON.parse(await bounded.nextLine()).id).toBe(2);
    bounded.destroy();
  });

});
