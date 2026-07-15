import net from "node:net";
import { z } from "zod";
import { BrokerErrorCode, BrokerMethods, EvaluationRecord } from "@hone/schema";
import { deferred } from "./deferred.js";

/**
 * Newline-delimited JSON-RPC 2.0 client for runDir/broker.sock — the
 * optimizer's ONLY window into the trusted runtime. Every result is
 * re-validated against the contract schema client-side: a malformed broker
 * reply is a bug we refuse to propagate into search state.
 */

type MethodName = keyof typeof BrokerMethods;
type ParamsOf<M extends MethodName> = z.infer<(typeof BrokerMethods)[M]["params"]>;
type ResultOf<M extends MethodName> = z.infer<(typeof BrokerMethods)[M]["result"]>;

const RpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.object({ code: z.string().optional(), detail: z.unknown().optional() }).optional(),
    })
    .optional(),
});

export class BrokerRpcError extends Error {
  /** Contract error code when the server sent one (e.g. BUDGET_EXCEEDED). */
  readonly brokerCode: BrokerErrorCode | undefined;

  constructor(
    readonly rpcCode: number,
    message: string,
    brokerCode?: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "BrokerRpcError";
    const parsed = BrokerErrorCode.safeParse(brokerCode);
    this.brokerCode = parsed.success ? parsed.data : undefined;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Broker endpoint forms the trusted runner hands the optimizer:
 *   unix   a filesystem socket path (mounted into the container on Linux)
 *   tcp    `tcp://host:port` (the runner's authenticated public listener on
 *          macOS, where VirtioFS blocks mounted unix sockets)
 */
export type BrokerEndpoint = { kind: "unix"; path: string } | { kind: "tcp"; host: string; port: number };

export function parseBrokerEndpoint(endpoint: string): BrokerEndpoint {
  if (!endpoint.startsWith("tcp://")) return { kind: "unix", path: endpoint };
  const rest = endpoint.slice("tcp://".length);
  const colon = rest.lastIndexOf(":");
  const host = colon > 0 ? rest.slice(0, colon) : "";
  const port = colon > 0 ? Number(rest.slice(colon + 1)) : Number.NaN;
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid tcp broker endpoint: ${endpoint} (expected tcp://host:port)`);
  }
  return { kind: "tcp", host, port };
}

export class BrokerClient {
  private nextId = 1;
  private buf = "";
  private readonly pending = new Map<number, Pending>();

  private constructor(
    private readonly sock: net.Socket,
    /** Capability for the authenticated TCP listener; sent per request, never logged. */
    private readonly token: string | undefined,
  ) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    const fail = (err: Error) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    sock.on("error", (err) => fail(err));
    sock.on("close", () => fail(new Error("broker connection closed")));
  }

  static async connect(endpoint: string, opts: { token?: string | undefined } = {}): Promise<BrokerClient> {
    const parsed = parseBrokerEndpoint(endpoint);
    // The trusted runner injects HONE_BROKER_TOKEN into the container env for
    // the authenticated TCP transport; the loop's connect call stays
    // transport-agnostic. The token is attached per request and never logged.
    const token = opts.token ?? process.env["HONE_BROKER_TOKEN"];
    const sock = parsed.kind === "tcp" ? net.connect(parsed.port, parsed.host) : net.connect(parsed.path);
    const ready = deferred<void>();
    sock.once("connect", () => ready.resolve());
    sock.once("error", ready.reject);
    await ready.promise;
    return new BrokerClient(sock, token);
  }

  close(): void {
    this.sock.destroy();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim().length === 0) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // torn or garbage line: the pending call times out at the caller's level
    }
    const parsed = RpcResponse.safeParse(raw);
    if (!parsed.success || typeof parsed.data.id !== "number") return;
    const entry = this.pending.get(parsed.data.id);
    if (entry === undefined) return;
    this.pending.delete(parsed.data.id);
    const { result, error } = parsed.data;
    if (error !== undefined) {
      entry.reject(new BrokerRpcError(error.code, error.message, error.data?.code, error.data?.detail));
    } else {
      entry.resolve(result);
    }
  }

  private async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = this.nextId++;
    const { promise, resolve, reject } = deferred<unknown>();
    this.pending.set(id, { resolve, reject });
    this.sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(this.token !== undefined ? { token: this.token } : {}) })}\n`);
    const raw = await promise;
    return BrokerMethods[method].result.parse(raw) as ResultOf<M>;
  }

  async getTask(): Promise<ResultOf<"getTask">> {
    return this.call("getTask", {});
  }

  async createSandbox(params: ParamsOf<"createSandbox">): Promise<ResultOf<"createSandbox">> {
    return this.call("createSandbox", params);
  }

  async exec(params: ParamsOf<"exec">): Promise<ResultOf<"exec">> {
    return this.call("exec", params);
  }

  async putFile(params: ParamsOf<"putFile">): Promise<void> {
    await this.call("putFile", params);
  }

  async saveArtifact(params: ParamsOf<"saveArtifact">): Promise<ResultOf<"saveArtifact">> {
    return this.call("saveArtifact", params);
  }

  /** The wire schema is passthrough; re-validate as a full EvaluationRecord here. */
  async evaluate(params: ParamsOf<"evaluate">): Promise<EvaluationRecord> {
    return EvaluationRecord.parse(await this.call("evaluate", params));
  }

  async reportIncumbent(params: ParamsOf<"reportIncumbent">): Promise<void> {
    await this.call("reportIncumbent", params);
  }

  async getBudget(): Promise<ResultOf<"getBudget">> {
    return this.call("getBudget", {});
  }

  async finish(params: ParamsOf<"finish">): Promise<void> {
    await this.call("finish", params);
  }
}
