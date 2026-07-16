import net from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import { BrokerMethods } from "@hone/schema";
import { Broker, RecordSpendParams, type BrokerConfig, type CallContext } from "./broker.js";
import { BROKER_ERROR_NUMBER, BrokerError } from "./errors.js";
import { deferred } from "./deferred.js";

/**
 * Newline-delimited JSON-RPC 2.0 over unix sockets:
 *   broker.sock       — optimizer clients (unprivileged), always present
 *   broker-admin.sock — OPT-IN privileged socket (holdout, recordSpend) for
 *                       trusted callers/tests only; production startBroker
 *                       creates none — the runner makes privileged calls
 *                       directly on the Broker instance, so a same-UID
 *                       optimizer process finds no privileged endpoint on
 *                       disk to escalate through.
 * Same protocol on both; privilege is a property of the CONNECTION, decided by
 * which socket file the peer could reach — filesystem permissions are the
 * authn boundary.
 */

const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
  /** Bearer for the opt-in public TCP listener; ignored on unix sockets. */
  token: z.string().optional(),
});

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
/** Server-defined JSON-RPC error: missing/wrong TCP auth token. */
const UNAUTHORIZED = -32060;

interface RpcErrorShape {
  code: number;
  message: string;
  data?: { code?: string; detail?: unknown };
}
type RpcId = string | number | null;
interface RpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: RpcErrorShape;
}

/** Params validation failure — maps to -32602 instead of a broker error. */
class InvalidParamsError extends Error {
  constructor(readonly issues: unknown) {
    super("invalid params");
  }
}

function parseParams<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new InvalidParamsError(parsed.error.issues);
  return parsed.data;
}

type MethodHandler = (raw: unknown, ctx: CallContext) => Promise<unknown>;
interface MethodEntry {
  adminOnly: boolean;
  handler: MethodHandler;
}

/**
 * Wire table: every entry parses params with the CONTRACT schema, invokes the
 * broker, and re-validates the result with the contract schema before it goes
 * back on the wire. `recordSpend` is internal (admin socket only) and is
 * invisible — method-not-found — on the client socket.
 */
function buildMethodTable(broker: Broker): Map<string, MethodEntry> {
  const m = BrokerMethods;
  const table = new Map<string, MethodEntry>();
  table.set("getTask", {
    adminOnly: false,
    handler: async (raw, ctx) => {
      parseParams(m.getTask.params, raw);
      return m.getTask.result.parse(broker.getTask(ctx));
    },
  });
  table.set("createSandbox", {
    adminOnly: false,
    handler: async (raw, ctx) =>
      m.createSandbox.result.parse(await broker.createSandbox(parseParams(m.createSandbox.params, raw), ctx)),
  });
  table.set("exec", {
    adminOnly: false,
    handler: async (raw, ctx) => m.exec.result.parse(await broker.exec(parseParams(m.exec.params, raw), ctx)),
  });
  table.set("putFile", {
    adminOnly: false,
    handler: async (raw, ctx) => m.putFile.result.parse(await broker.putFile(parseParams(m.putFile.params, raw), ctx)),
  });
  table.set("getFile", {
    adminOnly: false,
    handler: async (raw, ctx) => m.getFile.result.parse(await broker.getFile(parseParams(m.getFile.params, raw), ctx)),
  });
  table.set("saveArtifact", {
    adminOnly: false,
    handler: async (raw, ctx) =>
      m.saveArtifact.result.parse(await broker.saveArtifact(parseParams(m.saveArtifact.params, raw), ctx)),
  });
  table.set("evaluate", {
    adminOnly: false,
    handler: async (raw, ctx) => m.evaluate.result.parse(await broker.evaluate(parseParams(m.evaluate.params, raw), ctx)),
  });
  table.set("reportIncumbent", {
    adminOnly: false,
    handler: async (raw, ctx) =>
      m.reportIncumbent.result.parse(broker.reportIncumbent(parseParams(m.reportIncumbent.params, raw), ctx)),
  });
  table.set("getBudget", {
    adminOnly: false,
    handler: async (raw, ctx) => {
      parseParams(m.getBudget.params, raw);
      return m.getBudget.result.parse(broker.getBudget(ctx));
    },
  });
  table.set("finish", {
    adminOnly: false,
    handler: async (raw, ctx) => m.finish.result.parse(broker.finish(parseParams(m.finish.params, raw), ctx)),
  });
  table.set("spawnRun", {
    adminOnly: false,
    handler: async (raw, _ctx) => {
      parseParams(m.spawnRun.params, raw);
      return broker.notImplemented();
    },
  });
  table.set("queryCorpus", {
    adminOnly: false,
    handler: async (raw, _ctx) => {
      parseParams(m.queryCorpus.params, raw);
      return broker.notImplemented();
    },
  });
  table.set("recordSpend", {
    adminOnly: true,
    handler: async (raw, ctx) => broker.recordSpend(parseParams(RecordSpendParams, raw), ctx),
  });
  return table;
}

/** Hard cap on one newline-delimited JSON-RPC frame (adversarial clients). */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
/** Concurrency + backpressure defaults: bound aggregate RPC work so a client
 * cannot pipeline thousands of frames into untracked in-flight handlers. */
export const DEFAULT_MAX_CONCURRENT_PER_CONNECTION = 8;
export const DEFAULT_MAX_CONCURRENT_GLOBAL = 64;
export const DEFAULT_MAX_QUEUED_BYTES_PER_CONNECTION = 256 * 1024;
/** Hard cap on simultaneous connections across BOTH sockets. */
export const DEFAULT_MAX_CONNECTIONS = 64;
/** Global budget for RETAINED bytes — pending pre-newline fragments plus
 * queued complete frames, summed across all connections. Bounds broker
 * memory even when many connections each stay under their own caps. */
export const DEFAULT_MAX_BUFFERED_BYTES_GLOBAL = 8 * 1024 * 1024;
/** One serialized JSON response and all queued outbound socket bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
export const DEFAULT_MAX_OUTBOUND_BYTES_GLOBAL = 128 * 1024 * 1024;

/** Server-defined JSON-RPC error for backlog overflow — distinct from every
 * BROKER_ERROR_NUMBER code (-32000..-32006). */
const OVERLOADED = -32050;

export interface BrokerServerOptions {
  socketPath: string;
  /** Opt-in privileged socket; omitted = no admin endpoint exists at all. */
  adminSocketPath?: string | undefined;
  /**
   * Opt-in authenticated PUBLIC (unprivileged) TCP listener for containerized
   * optimizer clients that cannot reach the unix socket. `port: 0` binds an
   * ephemeral port — read the resolved address from `publicTcpAddress` after
   * listen(). Every JSON-RPC request on this listener must carry the exact
   * `token` (constant-time compare); anything else is rejected BEFORE method
   * dispatch. Unix-socket behavior is unchanged and never requires a token.
   */
  publicTcp?: { host: string; port: number; token: string } | undefined;
  /** Max bytes per frame before the connection is rejected; default 1 MiB. */
  maxFrameBytes?: number | undefined;
  /** Max handlers in flight per connection; default 8. */
  maxConcurrentPerConnection?: number | undefined;
  /** Max handlers in flight across ALL connections; default 64. */
  maxConcurrentGlobal?: number | undefined;
  /** Max bytes of complete frames queued behind the concurrency caps before
   * the connection is rejected; default 256 KiB. */
  maxQueuedBytesPerConnection?: number | undefined;
  /** Max simultaneous connections across both sockets; default 64. */
  maxConnections?: number | undefined;
  /** Global budget for retained bytes (fragments + queued frames) across all
   * connections; the largest holder is evicted on overflow. Default 8 MiB. */
  maxBufferedBytesGlobal?: number | undefined;
  /** Max serialized bytes in one RPC response. Default 96 MiB. */
  maxResponseBytes?: number | undefined;
  /** Aggregate serialized response bytes waiting on sockets. Default 128 MiB. */
  maxOutboundBytesGlobal?: number | undefined;
}

/** Per-connection dispatch state: in-flight permits + bounded frame backlog. */
interface ConnState {
  sock: net.Socket;
  privileged: boolean;
  /** True on the public TCP listener: every request must present the exact token. */
  tokenRequired: boolean;
  inFlight: number;
  queue: Array<{ line: string; bytes: number }>;
  /** Raw bytes of queued complete frames (incl. newline). */
  queuedBytes: number;
  /** Raw bytes RETAINED for this connection: pending fragment + queued frames. */
  bufferedBytes: number;
  /** Per-connection write serialization; socket backpressure is awaited. */
  writeTail: Promise<void>;
}

/** Constant-time token equality (length-safe via digest normalization). */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export class BrokerServer {
  private readonly table: Map<string, MethodEntry>;
  private readonly servers: net.Server[] = [];
  private readonly conns = new Set<ConnState>();
  private readonly maxFrameBytes: number;
  private readonly maxConcurrentPerConnection: number;
  private readonly maxConcurrentGlobal: number;
  private readonly maxQueuedBytesPerConnection: number;
  private readonly maxConnections: number;
  private readonly maxBufferedBytesGlobal: number;
  private readonly maxResponseBytes: number;
  private readonly maxOutboundBytesGlobal: number;
  private globalInFlight = 0;
  private globalBufferedBytes = 0;
  private globalOutboundBytes = 0;
  /** Connections with a non-empty backlog, FIFO by first queued frame. */
  private readonly waiting = new Set<ConnState>();
  /** Resolved address of the opt-in public TCP listener (after listen()). */
  private tcpAddress: { host: string; port: number } | undefined;
  /** Set once close() begins: no new connection, frame, or dispatch is admitted. */
  private closing = false;
  /** close() callers awaiting the in-flight handler count to reach zero. */
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    broker: Broker,
    private readonly opts: BrokerServerOptions,
  ) {
    this.table = buildMethodTable(broker);
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.maxConcurrentPerConnection = opts.maxConcurrentPerConnection ?? DEFAULT_MAX_CONCURRENT_PER_CONNECTION;
    this.maxConcurrentGlobal = opts.maxConcurrentGlobal ?? DEFAULT_MAX_CONCURRENT_GLOBAL;
    this.maxQueuedBytesPerConnection = opts.maxQueuedBytesPerConnection ?? DEFAULT_MAX_QUEUED_BYTES_PER_CONNECTION;
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxBufferedBytesGlobal = opts.maxBufferedBytesGlobal ?? DEFAULT_MAX_BUFFERED_BYTES_GLOBAL;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maxOutboundBytesGlobal = opts.maxOutboundBytesGlobal ?? DEFAULT_MAX_OUTBOUND_BYTES_GLOBAL;
  }

  async listen(): Promise<void> {
    await mkdir(path.dirname(this.opts.socketPath), { recursive: true });
    await this.listenOne(this.opts.socketPath, false);
    if (this.opts.adminSocketPath !== undefined) await this.listenOne(this.opts.adminSocketPath, true);
    const tcp = this.opts.publicTcp;
    if (tcp !== undefined) {
      // Capability floor: the bearer must carry >=256 bits — refuse to listen
      // behind a guessable token (generate with randomBytes(32).toString("hex")).
      if (Buffer.byteLength(tcp.token, "utf8") < 32) {
        throw new Error("publicTcp.token must be at least 32 bytes (a >=256-bit capability)");
      }
      const server = net.createServer((sock) => this.onConnection(sock, false, true));
      const { promise, resolve, reject } = deferred<void>();
      server.once("error", reject);
      server.listen(tcp.port, tcp.host, resolve);
      await promise;
      this.servers.push(server);
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("publicTcp listener has no resolved TCP address");
      this.tcpAddress = { host: addr.address, port: addr.port };
    }
  }

  /** Resolved host+port of the public TCP listener; undefined when not enabled. */
  get publicTcpAddress(): { host: string; port: number } | undefined {
    return this.tcpAddress;
  }

  private async listenOne(socketPath: string, privileged: boolean): Promise<void> {
    await rm(socketPath, { force: true });
    const server = net.createServer((sock) => this.onConnection(sock, privileged, false));
    const { promise, resolve, reject } = deferred<void>();
    server.once("error", reject);
    server.listen(socketPath, resolve);
    await promise;
    this.servers.push(server);
  }

  /**
   * Graceful close: new connections and frames are rejected immediately;
   * queued-but-unstarted frames are
   * dropped with their byte accounting released. Client sockets are then
   * destroyed to unblock stalled outbound writes, and every in-flight
   * handler is awaited before return — the caller can tear the Broker down
   * knowing no handler will emit, spend, or write against it.
   */
  async close(): Promise<void> {
    this.closing = true;
    // Drop unstarted backlogs; their retained bytes go back to the pool.
    for (const conn of this.waiting) {
      conn.queue.length = 0;
      conn.queuedBytes = 0;
    }
    this.waiting.clear();
    for (const conn of this.conns) this.release(conn, conn.bufferedBytes);
    // Cut clients now: a peer that stopped reading must not hold shutdown at
    // the outbound backpressure barrier forever. Handlers still drain below.
    for (const conn of this.conns) conn.sock.destroy();
    // Await every in-flight handler after their response path is unblocked.
    if (this.globalInFlight > 0) {
      const drained = deferred<void>();
      this.drainWaiters.push(drained.resolve);
      await drained.promise;
    }
    await Promise.all(
      this.servers.map((server) => {
        const { promise, resolve } = deferred<void>();
        server.close(() => resolve());
        return promise;
      }),
    );
    this.servers.length = 0;
  }

  /** Live dispatch counters — observability for callers and adversarial tests. */
  get stats(): { connections: number; inFlight: number; queuedBytes: number; bufferedBytes: number; outboundBytes: number } {
    let queuedBytes = 0;
    for (const conn of this.waiting) queuedBytes += conn.queuedBytes;
    return {
      connections: this.conns.size,
      inFlight: this.globalInFlight,
      queuedBytes,
      bufferedBytes: this.globalBufferedBytes,
      outboundBytes: this.globalOutboundBytes,
    };
  }

  /** Return `bytes` of a connection's retained budget to the global pool. */
  private release(conn: ConnState, bytes: number): void {
    conn.bufferedBytes -= bytes;
    this.globalBufferedBytes -= bytes;
  }

  /**
   * Byte-exact framing with hard caps: the pending fragment is bounded by
   * maxFrameBytes, complete frames run under per-connection and global
   * concurrency permits, and frames that cannot run yet queue up to
   * maxQueuedBytesPerConnection while the socket is paused (backpressure).
   * Retained bytes (fragment + queue) are additionally charged against a
   * GLOBAL budget so many connections cannot multiply the per-connection
   * caps into host memory exhaustion. A client that exceeds any cap gets
   * ONE error response, then the connection is torn down deterministically.
   */
  private onConnection(sock: net.Socket, privileged: boolean, tokenRequired: boolean): void {
    if (this.closing) {
      sock.on("error", () => sock.destroy());
      const resp: RpcResponse = { jsonrpc: "2.0", id: null, error: { code: OVERLOADED, message: "server closing" } };
      sock.write(`${JSON.stringify(resp)}\n`, () => sock.destroy());
      return;
    }
    if (this.conns.size >= this.maxConnections) {
      // Deterministic rejection of the excess socket: one error frame, close.
      sock.on("error", () => sock.destroy());
      const resp: RpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: OVERLOADED, message: `too many connections (max ${this.maxConnections})` },
      };
      sock.write(`${JSON.stringify(resp)}\n`, () => sock.destroy());
      return;
    }
    const conn: ConnState = {
      sock,
      privileged,
      tokenRequired,
      inFlight: 0,
      queue: [],
      queuedBytes: 0,
      bufferedBytes: 0,
      writeTail: Promise.resolve(),
    };
    this.conns.add(conn);
    sock.on("close", () => {
      this.conns.delete(conn);
      // Drop the dead client's backlog and return its retained bytes;
      // in-flight handlers release their permits in run()'s finally and
      // their writes are skipped.
      this.waiting.delete(conn);
      conn.queue.length = 0;
      conn.queuedBytes = 0;
      this.release(conn, conn.bufferedBytes);
    });
    sock.on("error", () => sock.destroy());
    let buf: Buffer = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      // Closing: reject instead of admitting new work behind the drain.
      if (this.closing) return this.rejectConnection(conn, OVERLOADED, "server closing");
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      conn.bufferedBytes += chunk.length;
      this.globalBufferedBytes += chunk.length;
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        if (nl > this.maxFrameBytes) {
          return this.rejectConnection(conn, PARSE_ERROR, `frame exceeds ${this.maxFrameBytes} bytes`);
        }
        const consumed = nl + 1; // line + newline, raw wire bytes
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(consumed);
        if (line.trim().length === 0) {
          this.release(conn, consumed);
          continue;
        }
        if (!this.admit(conn, line, consumed)) return; // backlog overflow — torn down
      }
      if (buf.length > this.maxFrameBytes) {
        return this.rejectConnection(conn, PARSE_ERROR, `frame exceeds ${this.maxFrameBytes} bytes`);
      }
      // Retained bytes settled for this chunk; if the global budget is now
      // exceeded, evict holders (largest first) until it fits again.
      while (this.globalBufferedBytes > this.maxBufferedBytesGlobal) {
        let victim: ConnState | undefined;
        for (const c of this.conns) {
          if (!victim || c.bufferedBytes > victim.bufferedBytes) victim = c;
        }
        if (!victim || victim.bufferedBytes === 0) break;
        this.rejectConnection(
          victim,
          OVERLOADED,
          `global buffered-byte budget exceeded (${this.maxBufferedBytesGlobal} bytes)`,
        );
      }
    });
  }

  /**
   * Admit one complete frame of `bytes` raw wire bytes: run immediately when
   * both permits are free and nothing is queued ahead of it (per-connection
   * FIFO order), otherwise queue it and pause reads. Returns false when the
   * backlog cap is exceeded and the connection has been rejected.
   */
  private admit(conn: ConnState, line: string, bytes: number): boolean {
    if (
      conn.queue.length === 0 &&
      conn.inFlight < this.maxConcurrentPerConnection &&
      this.globalInFlight < this.maxConcurrentGlobal
    ) {
      this.release(conn, bytes); // dispatched — no longer retained
      this.run(conn, line);
      return true;
    }
    if (conn.queuedBytes + bytes > this.maxQueuedBytesPerConnection) {
      this.rejectConnection(conn, OVERLOADED, `pipelined backlog exceeds ${this.maxQueuedBytesPerConnection} bytes`);
      return false;
    }
    conn.queue.push({ line, bytes });
    conn.queuedBytes += bytes;
    this.waiting.add(conn);
    conn.sock.pause(); // backpressure: stop reading until the backlog drains
    return true;
  }

  private async writeResponse(conn: ConnState, response: RpcResponse): Promise<void> {
    const payload = Buffer.from(`${JSON.stringify(response)}\n`);
    if (payload.length > this.maxResponseBytes) {
      throw new Error(`RPC response exceeds ${this.maxResponseBytes} bytes`);
    }
    if (this.globalOutboundBytes + payload.length > this.maxOutboundBytesGlobal) {
      throw new Error(`broker outbound backlog exceeds ${this.maxOutboundBytesGlobal} bytes`);
    }
    this.globalOutboundBytes += payload.length;
    const previous = conn.writeTail;
    const turn = deferred<void>();
    conn.writeTail = previous.then(() => turn.promise);
    await previous;
    try {
      if (conn.sock.destroyed) throw new Error("client socket closed");
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          conn.sock.off("drain", onDrain);
          conn.sock.off("close", onClose);
          conn.sock.off("error", onError);
        };
        const onDrain = (): void => {
          cleanup();
          resolve();
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error("client socket closed during response"));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        conn.sock.once("close", onClose);
        conn.sock.once("error", onError);
        if (conn.sock.write(payload)) {
          cleanup();
          resolve();
        } else {
          conn.sock.once("drain", onDrain);
        }
      });
    } finally {
      this.globalOutboundBytes -= payload.length;
      turn.resolve();
    }
  }

  /** Start one handler under both permits; the finally NEVER leaks them —
   * resolve, reject, and write failure all release. */
  private run(conn: ConnState, line: string): void {
    conn.inFlight++;
    this.globalInFlight++;
    void this.handleLine(line, conn)
      .then(async (resp) => {
        if (resp && !conn.sock.destroyed) await this.writeResponse(conn, resp);
      })
      .catch(() => conn.sock.destroy())
      .finally(() => {
        conn.inFlight--;
        this.globalInFlight--;
        this.pump();
        if (this.closing && this.globalInFlight === 0) {
          for (const waiter of this.drainWaiters.splice(0)) waiter();
        }
      });
  }

  /**
   * Dispatch queued frames after a permit frees: waiting connections are
   * served in FIFO order, each in its own frame order; a connection whose
   * backlog drains resumes reading.
   */
  private pump(): void {
    if (this.closing) return; // drained frames are dropped, never dispatched
    for (const conn of this.waiting) {
      if (this.globalInFlight >= this.maxConcurrentGlobal) return;
      if (conn.sock.destroyed) {
        this.waiting.delete(conn);
        continue;
      }
      while (conn.inFlight < this.maxConcurrentPerConnection && this.globalInFlight < this.maxConcurrentGlobal) {
        const entry = conn.queue.shift();
        if (entry === undefined) break;
        conn.queuedBytes -= entry.bytes;
        this.release(conn, entry.bytes); // dispatched — no longer retained
        this.run(conn, entry.line);
      }
      if (conn.queue.length === 0) {
        this.waiting.delete(conn);
        conn.sock.resume();
      }
    }
  }

  /** One safe error frame, then close — deterministic teardown for cap abuse.
   * Returns the connection's whole retained budget (fragment + backlog). */
  private rejectConnection(conn: ConnState, code: number, message: string): void {
    this.waiting.delete(conn);
    conn.queue.length = 0;
    conn.queuedBytes = 0;
    this.release(conn, conn.bufferedBytes);
    const { sock } = conn;
    sock.removeAllListeners("data");
    if (sock.destroyed) return;
    const resp: RpcResponse = { jsonrpc: "2.0", id: null, error: { code, message } };
    sock.write(`${JSON.stringify(resp)}\n`, () => sock.destroy());
  }

  private async handleLine(line: string, conn: { privileged: boolean; tokenRequired: boolean }): Promise<RpcResponse | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } };
    }
    const req = RpcRequest.safeParse(raw);
    if (!req.success) {
      return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "invalid request" } };
    }
    const { id, method, params } = req.data;
    const isNotification = id === undefined;
    const respond = (resp: Omit<RpcResponse, "jsonrpc" | "id">): RpcResponse | undefined =>
      isNotification ? undefined : { jsonrpc: "2.0", id: id ?? null, ...resp };

    // TCP auth precedes EVERYTHING method-shaped: a wrong or missing token
    // learns nothing about the method table, not even method-not-found.
    if (conn.tokenRequired && !tokenMatches(this.opts.publicTcp?.token ?? "", req.data.token)) {
      return respond({ error: { code: UNAUTHORIZED, message: "unauthorized" } });
    }

    const entry = this.table.get(method);
    if (!entry || (entry.adminOnly && !conn.privileged)) {
      return respond({ error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } });
    }
    try {
      const result = await entry.handler(params, { privileged: conn.privileged });
      return respond({ result });
    } catch (err) {
      if (err instanceof InvalidParamsError) {
        return respond({ error: { code: INVALID_PARAMS, message: "invalid params", data: { detail: err.issues } } });
      }
      if (err instanceof BrokerError) {
        return respond({
          error: {
            code: BROKER_ERROR_NUMBER[err.code],
            message: err.message,
            data: { code: err.code, ...(err.detail !== undefined ? { detail: err.detail } : {}) },
          },
        });
      }
      if (err instanceof ZodError) {
        // A result failed contract validation — internal bug, never the client's fault.
        return respond({
          error: { code: BROKER_ERROR_NUMBER.INTERNAL, message: "result validation failed", data: { code: "INTERNAL" } },
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return respond({ error: { code: BROKER_ERROR_NUMBER.INTERNAL, message, data: { code: "INTERNAL" } } });
    }
  }
}

/** A started broker: client socket listening, reaper armed. `adminSocketPath`
 * and `publicTcpAddress` are set only when those opt-ins were requested. */
export interface RunningBroker {
  broker: Broker;
  server: BrokerServer;
  socketPath: string;
  adminSocketPath: string | undefined;
  /** Resolved host+port of the opt-in authenticated public TCP listener. */
  publicTcpAddress: { host: string; port: number } | undefined;
  close(): Promise<void>;
}

/** Opt-in extras for trusted callers; production local runs pass nothing. */
export interface StartBrokerOptions {
  /**
   * Create the privileged admin socket at this path. The LOCAL runner MUST
   * NOT set this: it calls privileged broker methods in-process, and a
   * same-UID optimizer child must find no privileged RPC endpoint on disk.
   * (This removes only that gratuitous escalation path — it does not solve
   * the accepted M0 same-UID host-child isolation gate, which remains M1.)
   */
  adminSocketPath?: string | undefined;
  /**
   * Authenticated PUBLIC (unprivileged) TCP listener for a containerized
   * optimizer. `port: 0` binds an ephemeral port; the resolved address is
   * returned as `publicTcpAddress`. Every request must carry the exact
   * `token` or it is rejected before method dispatch.
   */
  publicTcp?: { host: string; port: number; token: string } | undefined;
}

export async function startBroker(config: BrokerConfig): Promise<RunningBroker & { adminSocketPath: undefined; publicTcpAddress: undefined }>;
export async function startBroker(
  config: BrokerConfig,
  opts: StartBrokerOptions & { adminSocketPath: string },
): Promise<RunningBroker & { adminSocketPath: string }>;
export async function startBroker(
  config: BrokerConfig,
  opts: StartBrokerOptions & { publicTcp: { host: string; port: number; token: string } },
): Promise<RunningBroker & { publicTcpAddress: { host: string; port: number } }>;
export async function startBroker(config: BrokerConfig, opts: StartBrokerOptions = {}): Promise<RunningBroker> {
  const broker = new Broker(config);
  const socketPath = path.join(config.runDir, "broker.sock");
  const adminSocketPath = opts.adminSocketPath;
  let server: BrokerServer | undefined;
  try {
    await broker.init();
    server = new BrokerServer(broker, {
      socketPath,
      ...(adminSocketPath !== undefined ? { adminSocketPath } : {}),
      ...(opts.publicTcp !== undefined ? { publicTcp: opts.publicTcp } : {}),
    });
    await server.listen();
  } catch (err) {
    // Constructor already opens the authority journal; init may open the
    // holdout ledger or uncertain-create a volume. Unwind every stage.
    const cleanup = await Promise.allSettled([server?.close(), broker.close()]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
        : [],
    );
    if (failures.length > 0) {
      throw new Error(`${err instanceof Error ? err.message : String(err)}; broker init cleanup incomplete: ${failures.join("; ")}`);
    }
    throw err;
  }
  return {
    broker,
    server,
    socketPath,
    adminSocketPath,
    publicTcpAddress: server.publicTcpAddress,
    close: async () => {
      // Stop admission first, then settle BOTH teardown paths even when one
      // fails. A leaked broker resource must reject the runner's cleanup
      // barrier instead of being hidden behind a successfully closed socket.
      const results = await Promise.allSettled([broker.close(), server.close()]);
      const failures = results.flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : [],
      );
      if (failures.length > 0) throw new Error(`broker server cleanup incomplete: ${failures.join("; ")}`);
    },
  };
}
