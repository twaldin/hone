import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  PROXY_TRACE_VERSION,
  ProxyTraceRecord,
  type BudgetExceededError,
  type ModelRouting,
} from "@hone/schema";
import { casWrite } from "./cas.js";
import { extractSseUsage, normalizeUsage, ZERO_USAGE, type Usage } from "./sse.js";

export const DEFAULT_UPSTREAM = "http://127.0.0.1:8317";

/** Per-run bearer identity handed to a sandbox. Never contains upstream credentials. */
export interface ProxyAuthToken {
  token: string;
  runId: string;
  role: string;
}

/** Static pricing entry, USD per million tokens. Models absent from the table cost 0 (subscription upstream). */
export interface PricingEntry {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}
export type PricingTable = Record<string, PricingEntry>;

export type BudgetDimension = BudgetExceededError["error"]["dimension"];

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; dimension: BudgetDimension; message?: string };

export interface SpendRecord {
  tokens: number;
  usd: number;
}

/**
 * Config in, callbacks out — no global state. The runner (WP7) wires
 * `checkBudget`/`recordSpend` to the broker admin socket; tests inject stubs.
 */
export interface ProxyConfig {
  runId: string;
  /** Per-role model routing (@hone/schema). The proxy OVERWRITES the request's model field. */
  routing: ModelRouting;
  /** Per-run dir (`.hone-runs/<runId>`); `proxy-trace.ndjson` is appended here. */
  runDir: string;
  /** CAS root (the `.hone-cas` directory): `sha256/<first2>/<fullhash>`. */
  casDir: string;
  /** Default vibeproxy at :8317. Sandboxes never see this URL or the key. */
  upstreamBaseUrl?: string;
  /** Injected as `Authorization: Bearer <key>` upstream; never surfaces client-side. */
  upstreamApiKey?: string;
  pricing?: PricingTable;
  /** Consulted before every completion forward; denial → 402, no upstream call. */
  checkBudget: () => BudgetDecision | Promise<BudgetDecision>;
  /** Called after every upstream completion response with metered totals. */
  recordSpend: (spend: SpendRecord) => void | Promise<void>;
}

export interface ProxyHandle {
  /** Tokens minted at construction, one per role in the routing table. */
  readonly tokens: readonly ProxyAuthToken[];
  /** Bearer token for a role; throws on unknown role. */
  tokenFor(role: string): string;
  /** Bind the unix socket (`proxy.sock`). Removes a stale socket file first. */
  listenUnix(socketPath: string): Promise<void>;
  /** Bind 127.0.0.1 TCP (tests); returns the bound port. */
  listenTcp(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

interface TraceInput {
  role: string;
  model: string;
  requestAt: string;
  startedAt: number;
  status: number;
  usage: Usage;
  estimatedUsd: number;
  requestText: string;
  responseText: string;
}

export function createProxy(config: ProxyConfig): ProxyHandle {
  const tokens: ProxyAuthToken[] = Object.keys(config.routing).map((role) => ({
    token: `hone_${randomBytes(24).toString("hex")}`,
    runId: config.runId,
    role,
  }));
  const byToken = new Map(tokens.map((t) => [t.token, t]));

  async function trace(t: TraceInput): Promise<void> {
    const [requestBody, responseBody] = await Promise.all([
      casWrite(config.casDir, t.requestText),
      casWrite(config.casDir, t.responseText),
    ]);
    const record = ProxyTraceRecord.parse({
      version: PROXY_TRACE_VERSION,
      runId: config.runId,
      role: t.role,
      model: t.model,
      requestAt: t.requestAt,
      durationMs: Date.now() - t.startedAt,
      status: t.status,
      usage: t.usage,
      estimatedUsd: t.estimatedUsd,
      requestBody,
      responseBody,
    });
    await mkdir(config.runDir, { recursive: true });
    await appendFile(join(config.runDir, "proxy-trace.ndjson"), `${JSON.stringify(record)}\n`);
  }

  function upstreamHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.upstreamApiKey !== undefined) {
      headers["authorization"] = `Bearer ${config.upstreamApiKey}`;
    }
    return headers;
  }

  function sendJson(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  async function handleCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    identity: ProxyAuthToken,
  ): Promise<void> {
    const requestAt = new Date().toISOString();
    const startedAt = Date.now();

    const route = config.routing[identity.role];
    if (route === undefined) {
      sendJson(res, 403, JSON.stringify({ error: { type: "hone_no_route", message: `no routing for role "${identity.role}"` } }));
      return;
    }

    const bodyText = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText === "" ? "{}" : bodyText);
    } catch {
      sendJson(res, 400, JSON.stringify({ error: { type: "hone_bad_request", message: "request body is not valid JSON" } }));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, JSON.stringify({ error: { type: "hone_bad_request", message: "request body must be a JSON object" } }));
      return;
    }

    // The mutable side cannot choose its own model: overwrite with the role's route.
    const forward: Record<string, unknown> = { ...(parsed as Record<string, unknown>), model: route.model };
    if (forward["stream"] === true) {
      const supplied = forward["stream_options"];
      forward["stream_options"] = {
        ...(typeof supplied === "object" && supplied !== null ? (supplied as Record<string, unknown>) : {}),
        include_usage: true,
      };
    }
    const forwardText = JSON.stringify(forward);

    // Recursion guard: hard budget stop BEFORE any upstream call.
    const decision = await config.checkBudget();
    if (!decision.allowed) {
      const errBody: BudgetExceededError = {
        error: {
          type: "hone_budget_exceeded",
          message: decision.message ?? `run budget exceeded (${decision.dimension})`,
          dimension: decision.dimension,
        },
      };
      const errText = JSON.stringify(errBody);
      await trace({
        role: identity.role,
        model: route.model,
        requestAt,
        startedAt,
        status: 402,
        usage: ZERO_USAGE,
        estimatedUsd: 0,
        requestText: forwardText,
        responseText: errText,
      });
      sendJson(res, 402, errText);
      return;
    }

    const base = route.upstreamBaseUrl ?? config.upstreamBaseUrl ?? DEFAULT_UPSTREAM;
    let upstream: Response;
    try {
      upstream = await fetch(new URL("/v1/chat/completions", base), {
        method: "POST",
        headers: upstreamHeaders(),
        body: forwardText,
      });
    } catch (err) {
      const errText = JSON.stringify({
        error: { type: "hone_upstream_unreachable", message: err instanceof Error ? err.message : String(err) },
      });
      await trace({
        role: identity.role,
        model: route.model,
        requestAt,
        startedAt,
        status: 502,
        usage: ZERO_USAGE,
        estimatedUsd: 0,
        requestText: forwardText,
        responseText: errText,
      });
      sendJson(res, 502, errText);
      return;
    }

    // Pass the body through (SSE chunks flush as they arrive) while
    // accumulating the concatenated stream for usage capture + trace.
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    const chunks: Buffer[] = [];
    if (upstream.body !== null) {
      for await (const chunk of upstream.body) {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        res.write(buf);
      }
    }
    const responseText = Buffer.concat(chunks).toString("utf8");

    let usage: Usage = ZERO_USAGE;
    if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      usage = extractSseUsage(responseText) ?? ZERO_USAGE;
    } else {
      try {
        const responseJson: unknown = JSON.parse(responseText);
        if (typeof responseJson === "object" && responseJson !== null) {
          usage = normalizeUsage((responseJson as Record<string, unknown>)["usage"]) ?? ZERO_USAGE;
        }
      } catch {
        // non-JSON upstream response: metered as zero, still traced
      }
    }

    const pricing = config.pricing?.[route.model];
    const estimatedUsd =
      pricing === undefined
        ? 0
        : (usage.promptTokens / 1e6) * pricing.inputUsdPerMTok +
          (usage.completionTokens / 1e6) * pricing.outputUsdPerMTok;

    // Account + trace BEFORE ending the client response, so a client that has
    // consumed the full body observes fully-recorded spend.
    await config.recordSpend({ tokens: usage.totalTokens, usd: estimatedUsd });
    await trace({
      role: identity.role,
      model: route.model,
      requestAt,
      startedAt,
      status: upstream.status,
      usage,
      estimatedUsd,
      requestText: forwardText,
      responseText,
    });
    res.end();
  }

  async function handleModels(res: ServerResponse, identity: ProxyAuthToken): Promise<void> {
    const requestAt = new Date().toISOString();
    const startedAt = Date.now();
    const base = config.upstreamBaseUrl ?? DEFAULT_UPSTREAM;
    let upstream: Response;
    try {
      upstream = await fetch(new URL("/v1/models", base), { headers: upstreamHeaders() });
    } catch (err) {
      sendJson(res, 502, JSON.stringify({
        error: { type: "hone_upstream_unreachable", message: err instanceof Error ? err.message : String(err) },
      }));
      return;
    }
    const responseText = await upstream.text();
    await trace({
      role: identity.role,
      model: "",
      requestAt,
      startedAt,
      status: upstream.status,
      usage: ZERO_USAGE,
      estimatedUsd: 0,
      requestText: "",
      responseText,
    });
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(responseText);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") === true ? auth.slice("Bearer ".length) : undefined;
    const identity = bearer !== undefined ? byToken.get(bearer) : undefined;
    if (identity === undefined) {
      sendJson(res, 401, JSON.stringify({ error: { type: "hone_unauthorized", message: "unknown or missing bearer token" } }));
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    if (req.method === "POST" && path === "/v1/chat/completions") {
      await handleCompletions(req, res, identity);
    } else if (req.method === "GET" && path === "/v1/models") {
      await handleModels(res, identity);
    } else {
      sendJson(res, 404, JSON.stringify({ error: { type: "hone_not_found", message: `no route: ${req.method} ${path}` } }));
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, JSON.stringify({ error: { type: "hone_internal", message } }));
      } else {
        res.end();
      }
    });
  });

  function bound(listenArgs: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      listenArgs();
      server.once("listening", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  return {
    tokens,
    tokenFor(role: string): string {
      const found = tokens.find((t) => t.role === role);
      if (found === undefined) throw new Error(`no token minted for role "${role}"`);
      return found.token;
    },
    async listenUnix(socketPath: string): Promise<void> {
      await rm(socketPath, { force: true });
      await bound(() => server.listen(socketPath));
    },
    async listenTcp(port: number, host = "127.0.0.1"): Promise<number> {
      await bound(() => server.listen(port, host));
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) return addr.port;
      throw new Error("tcp listen did not yield an address");
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
