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

export interface BrokerServerOptions {
  socketPath: string;
  adminSocketPath: string;
  /** Max bytes per frame before the connection is rejected; default 1 MiB. */
  maxFrameBytes?: number | undefined;
}

export class BrokerServer {
  private readonly table: Map<string, MethodEntry>;
  private readonly servers: net.Server[] = [];
  private readonly connections = new Set<net.Socket>();
  private readonly maxFrameBytes: number;

  constructor(
    broker: Broker,
    private readonly opts: BrokerServerOptions,
  ) {
    this.table = buildMethodTable(broker);
    this.maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
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
    for (const sock of this.connections) sock.destroy();
    this.connections.clear();
    await Promise.all(
      this.servers.map((server) => {
        const { promise, resolve } = deferred<void>();
        server.close(() => resolve());
        return promise;
      }),
    );
    this.servers.length = 0;
  }

  /**
   * Byte-exact framing with a hard cap: the pending frame is bounded by
   * maxFrameBytes plus one kernel-sized chunk, so an adversarial client can
   * never make the broker buffer an unbounded line. An oversized frame —
   * complete or still fragmented — gets ONE parse-error response, then the
   * connection is torn down.
   */
  private onConnection(sock: net.Socket, privileged: boolean): void {
    this.connections.add(sock);
    sock.on("close", () => this.connections.delete(sock));
    sock.on("error", () => sock.destroy());
    let buf: Buffer = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let nl: number;
      while ((nl = buf.indexOf(0x0a)) >= 0) {
        if (nl > this.maxFrameBytes) return this.rejectOversizedFrame(sock);
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (line.trim().length === 0) continue;
        void this.handleLine(line, privileged)
          .then((resp) => {
            if (resp && !sock.destroyed) sock.write(`${JSON.stringify(resp)}\n`);
          })
          .catch(() => sock.destroy());
      }
      if (buf.length > this.maxFrameBytes) this.rejectOversizedFrame(sock);
    });
  }

  /** One safe error frame, then close — never buffer past the cap. */
  private rejectOversizedFrame(sock: net.Socket): void {
    sock.removeAllListeners("data");
    if (sock.destroyed) return;
    const resp: RpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: PARSE_ERROR, message: `frame exceeds ${this.maxFrameBytes} bytes` },
    };
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
