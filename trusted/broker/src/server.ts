import net from "node:net";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z, ZodError } from "zod";
import { BrokerMethods } from "@hone/schema";
import { Broker, RecordSpendParams, type BrokerConfig, type CallContext } from "./broker.js";
import { BROKER_ERROR_NUMBER, BrokerError } from "./errors.js";
import { deferred } from "./deferred.js";

/**
 * Newline-delimited JSON-RPC 2.0 over two unix sockets:
 *   broker.sock       — optimizer clients (unprivileged)
 *   broker-admin.sock — runner/meta/proxy (privileged: holdout, recordSpend)
 * Same protocol on both; privilege is a property of the CONNECTION, decided by
 * which socket file the peer could reach — filesystem permissions are the
 * authn boundary.
 */

const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

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

/** Server-defined JSON-RPC error for backlog overflow — distinct from every
 * BROKER_ERROR_NUMBER code (-32000..-32006). */
const OVERLOADED = -32050;

export interface BrokerServerOptions {
  socketPath: string;
  adminSocketPath: string;
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
}

/** Per-connection dispatch state: in-flight permits + bounded frame backlog. */
interface ConnState {
  sock: net.Socket;
  privileged: boolean;
  inFlight: number;
  queue: Array<{ line: string; bytes: number }>;
  /** Raw bytes of queued complete frames (incl. newline). */
  queuedBytes: number;
  /** Raw bytes RETAINED for this connection: pending fragment + queued frames. */
  bufferedBytes: number;
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
  private globalInFlight = 0;
  private globalBufferedBytes = 0;
  /** Connections with a non-empty backlog, FIFO by first queued frame. */
  private readonly waiting = new Set<ConnState>();

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
  }

  async listen(): Promise<void> {
    await mkdir(path.dirname(this.opts.socketPath), { recursive: true });
    await this.listenOne(this.opts.socketPath, false);
    await this.listenOne(this.opts.adminSocketPath, true);
  }

  private async listenOne(socketPath: string, privileged: boolean): Promise<void> {
    await rm(socketPath, { force: true });
    const server = net.createServer((sock) => this.onConnection(sock, privileged));
    const { promise, resolve, reject } = deferred<void>();
    server.once("error", reject);
    server.listen(socketPath, resolve);
    await promise;
    this.servers.push(server);
  }

  async close(): Promise<void> {
    this.waiting.clear();
    // Socket close events release each connection's byte accounting.
    for (const conn of this.conns) conn.sock.destroy();
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
  get stats(): { connections: number; inFlight: number; queuedBytes: number; bufferedBytes: number } {
    let queuedBytes = 0;
    for (const conn of this.waiting) queuedBytes += conn.queuedBytes;
    return {
      connections: this.conns.size,
      inFlight: this.globalInFlight,
      queuedBytes,
      bufferedBytes: this.globalBufferedBytes,
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
  private onConnection(sock: net.Socket, privileged: boolean): void {
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
    const conn: ConnState = { sock, privileged, inFlight: 0, queue: [], queuedBytes: 0, bufferedBytes: 0 };
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

  /** Start one handler under both permits; the finally NEVER leaks them —
   * resolve, reject, and write failure all release. */
  private run(conn: ConnState, line: string): void {
    conn.inFlight++;
    this.globalInFlight++;
    void this.handleLine(line, conn.privileged)
      .then((resp) => {
        if (resp && !conn.sock.destroyed) conn.sock.write(`${JSON.stringify(resp)}\n`);
      })
      .catch(() => conn.sock.destroy())
      .finally(() => {
        conn.inFlight--;
        this.globalInFlight--;
        this.pump();
      });
  }

  /**
   * Dispatch queued frames after a permit frees: waiting connections are
   * served in FIFO order, each in its own frame order; a connection whose
   * backlog drains resumes reading.
   */
  private pump(): void {
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

  private async handleLine(line: string, privileged: boolean): Promise<RpcResponse | undefined> {
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

    const entry = this.table.get(method);
    if (!entry || (entry.adminOnly && !privileged)) {
      return respond({ error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } });
    }
    try {
      const result = await entry.handler(params, { privileged });
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

/** A started broker: both sockets listening, reaper armed. */
export interface RunningBroker {
  broker: Broker;
  server: BrokerServer;
  socketPath: string;
  adminSocketPath: string;
  close(): Promise<void>;
}

export async function startBroker(config: BrokerConfig): Promise<RunningBroker> {
  const broker = new Broker(config);
  await broker.init();
  const socketPath = path.join(config.runDir, "broker.sock");
  const adminSocketPath = path.join(config.runDir, "broker-admin.sock");
  const server = new BrokerServer(broker, { socketPath, adminSocketPath });
  await server.listen();
  return {
    broker,
    server,
    socketPath,
    adminSocketPath,
    close: async () => {
      await server.close();
      await broker.close();
    },
  };
}
