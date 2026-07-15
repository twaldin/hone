import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { BrokerServer, type BrokerServerOptions } from "../src/server.js";
import { deferred } from "../src/deferred.js";
import { buildTestCapsule, TEST_IMAGE } from "./helpers.js";

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
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "exec", params: { sandboxId: "sb", argv: ["true"] } })}\n`;
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
    opts: Omit<BrokerServerOptions, "socketPath" | "adminSocketPath">,
  ): Promise<{ server: BrokerServer; socketPath: string }> {
    sockN++;
    const socketPath = path.join(base, "run", `s${sockN}.sock`);
    const adminSocketPath = path.join(base, "run", `s${sockN}a.sock`);
    const server = new BrokerServer(broker, { socketPath, adminSocketPath, ...opts });
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

    // Release the in-flight pair: their responses hit a dead peer. pump()
    // runs synchronously when each permit frees, so frames 3-4 are admitted
    // before the broken pipe can be observed; once it IS observed the
    // connection is torn down and the remaining backlog (5-6) is cancelled.
    g.releaseBlocked();
    await g.admitted(4);
    await eventually(() => server.stats.connections === 0, "server observes the dead client");
    expect(server.stats.queuedBytes).toBe(0); // backlog dropped, not dispatched

    g.releaseBlocked(); // frames 3-4 finish; their writes are skipped
    await g.completed(4);
    expect(g.admittedCount()).toBe(4); // frames 5 and 6 never started
    // Permit release happens in the dispatcher's finally, a microtask after
    // the handler resolves — wait for it rather than sampling mid-release.
    await eventually(() => server.stats.inFlight === 0, "all permits released");

    // Server remains live for a fresh client after the mess.
    const c2 = await connectLines(socketPath);
    c2.write(execFrame(7));
    await g.admitted(5);
    g.releaseBlocked();
    const r = JSON.parse(await c2.nextLine());
    expect(r.id).toBe(7);
    expect(r.error).toBeUndefined();
    c2.destroy();
  });
});
