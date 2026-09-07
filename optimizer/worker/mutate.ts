/**
 * hone mutation worker — runs INSIDE a mutation sandbox under Bun (>= 1.3.14).
 *
 * One invocation = one Pi coding-agent session mutating /workspace. Inputs:
 *   - /scratch/episode.json (EpisodeContext; prompts pre-rendered host-side
 *     by optimizer/assets/context.ts — keep the validation here in sync)
 *   - env: HONE_PROXY_BASE_URL (include /v1) + HONE_PROXY_TOKEN injected by
 *     the trusted broker at createSandbox(role=mutation); HONE_MODEL_ID is a
 *     display label (the proxy overwrites the model per role); HONE_WORKDIR
 *     (default /workspace); HONE_DEADLINE_MS (session duration budget, ms);
 *     HONE_AGENT_DIR (default /scratch/omp-agent, ephemeral).
 *
 * Output: on success the LAST stdout line is the MutateResult JSON
 * ({ summary, approach, filesChanged }). Exit codes: 0 ok, 1 failure,
 * 2 bad input/env, 3 run budget exhausted (proxy 402 hone_budget_exceeded).
 *
 * `--selftest` performs the no-LLM smoke: registry + settings constructed
 * offline, sample episode.json parsed, prints "hone-mutation selftest ok".
 *
 * Delivery: this source is part of the sealed optimizer snapshot. The
 * no-network manifest-image build bundles it (with its captured Pi SDK
 * closure) into the self-contained /hone/out/worker.mjs; the loop putFiles
 * those exact bytes into every mutation sandbox and execs the sandbox-local
 * file under bun. The only image-provided piece is the platform-native
 * pi_natives addon baked next to bun (a .node binary cannot live in a JS
 * bundle).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";

/**
 * `Promise.withResolvers()` ponyfill — this worker must stay a single
 * self-contained file, so the shared helper cannot be imported. The Promise
 * executor form is permitted here only because the constructor API requires
 * it to obtain the resolver functions.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const MAX_BRIDGE_REQUEST_BYTES = 4 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface UnixFetchInit extends RequestInit {
  unix: string;
}

class BridgeRequestTooLarge extends Error {}

const SAFE_TOOLS = new Set(["read", "bash", "write", "edit"]);
const SESSION_ROLES = new Set([
  "capsule-author",
  "evaluator-author",
  "adversarial-validator",
  "inner-improver",
  "outer-improver",
  "repair",
]);

interface YieldSchema {
  type: "object";
  additionalProperties: boolean;
  required?: string[];
  properties: Record<string, unknown>;
}

interface EpisodeFile {
  version: 2;
  episode: number;
  mode: "mutation" | "repair";
  role:
    | "capsule-author"
    | "evaluator-author"
    | "adversarial-validator"
    | "inner-improver"
    | "outer-improver"
    | "repair";
  systemPrompt: string;
  userPrompt: string;
  tools: string[];
  outputSchema: YieldSchema;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseOutputSchema(value: unknown): YieldSchema {
  const rec = objectRecord(value);
  if (rec === null || rec.type !== "object" || typeof rec.additionalProperties !== "boolean") {
    throw new Error("episode.json: outputSchema must describe an object");
  }
  const properties = objectRecord(rec.properties);
  if (properties === null) throw new Error("episode.json: outputSchema.properties must be an object");
  const required = rec.required;
  if (
    required !== undefined
    && (!Array.isArray(required) || required.some((item) => typeof item !== "string"))
  ) {
    throw new Error("episode.json: outputSchema.required must contain strings");
  }
  return {
    type: "object",
    additionalProperties: rec.additionalProperties,
    ...(required === undefined ? {} : { required: required as string[] }),
    properties,
  };
}

/** Hand-rolled validation — keep in sync with optimizer/src/episode.ts (no zod in the image). */
function parseEpisode(raw: string): EpisodeFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`episode.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rec = objectRecord(value);
  if (rec === null) throw new Error("episode.json: not an object");
  if (rec.version !== 2) throw new Error(`episode.json: unsupported version ${String(rec.version)}`);
  if (typeof rec.episode !== "number" || !Number.isInteger(rec.episode) || rec.episode < 0) {
    throw new Error("episode.json: episode must be a nonnegative integer");
  }
  if (rec.mode !== "mutation" && rec.mode !== "repair") throw new Error("episode.json: mode must be mutation|repair");
  if (typeof rec.role !== "string" || !SESSION_ROLES.has(rec.role)) {
    throw new Error("episode.json: unsupported coding-session role");
  }
  if (typeof rec.systemPrompt !== "string" || rec.systemPrompt.length === 0) {
    throw new Error("episode.json: systemPrompt must be a non-empty string");
  }
  if (typeof rec.userPrompt !== "string" || rec.userPrompt.length === 0) {
    throw new Error("episode.json: userPrompt must be a non-empty string");
  }
  if (
    !Array.isArray(rec.tools)
    || rec.tools.length === 0
    || rec.tools.some((tool) => typeof tool !== "string" || !SAFE_TOOLS.has(tool))
  ) {
    throw new Error("episode.json: tools must be a non-empty safe-tool subset");
  }
  return {
    version: 2,
    episode: rec.episode,
    mode: rec.mode,
    role: rec.role as EpisodeFile["role"],
    systemPrompt: rec.systemPrompt,
    userPrompt: rec.userPrompt,
    tools: rec.tools as string[],
    outputSchema: parseOutputSchema(rec.outputSchema),
  };
}

/**
 * The broker mounts the trusted proxy as a Unix socket (/run/hone/proxy.sock;
 * sandbox network is otherwise none). Pi speaks HTTP to a baseUrl, so when no
 * HTTP HONE_PROXY_BASE_URL is provided we bridge loopback -> Unix.
 *
 * Bun's node:http client does not implement socketPath on Linux arm64. Use
 * Bun's fetch `unix` transport for the outbound leg; the node:http server is
 * only the loopback listener Pi talks to.
 */
function readBridgeRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const result = deferred<Buffer>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const reject = (reason: unknown): void => {
    if (settled) return;
    settled = true;
    result.reject(reason);
  };
  req.on("data", (chunk: Buffer) => {
    if (settled) return;
    bytes += chunk.byteLength;
    if (bytes > MAX_BRIDGE_REQUEST_BYTES) {
      req.pause();
      reject(new BridgeRequestTooLarge(`bridge request exceeds ${MAX_BRIDGE_REQUEST_BYTES} bytes`));
      return;
    }
    chunks.push(chunk);
  });
  req.once("end", () => {
    if (settled) return;
    settled = true;
    result.resolve(Buffer.concat(chunks, bytes));
  });
  req.once("aborted", () => reject(new Error("bridge client aborted request")));
  req.once("error", reject);
  return result.promise;
}

async function waitForDrain(res: http.ServerResponse): Promise<void> {
  const drained = deferred<void>();
  const onDrain = (): void => {
    res.off("close", onClose);
    drained.resolve();
  };
  const onClose = (): void => {
    res.off("drain", onDrain);
    drained.reject(new Error("bridge client closed during response"));
  };
  res.once("drain", onDrain);
  res.once("close", onClose);
  await drained.promise;
}

async function forwardUnixRequest(socketPath: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBridgeRequestBody(req);
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  headers.delete("host");
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);

  const abort = new AbortController();
  const abortUpstream = (): void => abort.abort();
  res.once("close", abortUpstream);
  try {
    const init: UnixFetchInit = {
      unix: socketPath,
      method,
      headers,
      redirect: "manual",
      signal: abort.signal,
    };
    if (method !== "GET" && method !== "HEAD") {
      const payload = new ArrayBuffer(body.byteLength);
      new Uint8Array(payload).set(body);
      init.body = payload;
    }
    const upstream = await fetch(`http://localhost${req.url ?? "/"}`, init);
    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) responseHeaders[name] = value;
    });
    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body !== null) {
      const reader = upstream.body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (res.destroyed) {
          await reader.cancel();
          return;
        }
        if (!res.write(next.value)) await waitForDrain(res);
      }
    }
    res.end();
  } finally {
    res.off("close", abortUpstream);
  }
}

async function startUnixBridge(socketPath: string): Promise<string> {
  const server = http.createServer((req, res) => {
    void forwardUnixRequest(socketPath, req, res).catch((err: unknown) => {
      if (res.destroyed) return;
      if (err instanceof BridgeRequestTooLarge) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: { type: "hone_bridge_request_too_large", message: err.message } }), () => req.destroy());
        return;
      }
      const failure = err instanceof Error ? err : new Error(String(err));
      if (res.headersSent) {
        res.destroy(failure);
        return;
      }
      res.writeHead(502, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: { type: "hone_bridge_error", message: failure.message } }));
    });
  });
  const listening = deferred<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("bridge failed to bind");
  server.unref();
  return `http://127.0.0.1:${address.port}/v1`;
}

async function resolveProxyBaseUrl(): Promise<string> {
  const explicit = process.env.HONE_PROXY_BASE_URL;
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const sock = process.env.HONE_PROXY_SOCK ?? "/run/hone/proxy.sock";
  if (existsSync(sock) && statSync(sock).isSocket()) return startUnixBridge(sock);
  throw new Error("no proxy egress: set HONE_PROXY_BASE_URL or mount a proxy socket");
}

interface SessionEnv {
  cwd: string;
  agentDir: string;
  baseUrl: string;
  token: string;
  modelId: string;
  deadline: number;
}

function buildRegistry(env: SessionEnv, authStorage: AuthStorage): ModelRegistry {
  const registry = new ModelRegistry(authStorage);
  registry.registerProvider("hone-proxy", {
    baseUrl: env.baseUrl,
    apiKey: env.token,
    api: "openai-completions",
    models: [
      {
        id: env.modelId,
        name: env.modelId,
        reasoning: false,
        input: ["text"],
        supportsTools: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 65_536,
      },
    ],
  });
  return registry;
}

function isolatedSettings(): Settings {
  return Settings.isolated({
    "compaction.enabled": false,
    "retry.enabled": false,
    "dev.autoqa": false,
  });
}

function assertNoAutoQa(): void {
  if (process.env.PI_AUTO_QA !== undefined) {
    throw new Error("PI_AUTO_QA must be unset inside mutation sandboxes");
  }
}

async function selftest(): Promise<void> {
  assertNoAutoQa();
  const agentDir = mkdtempSync(join(tmpdir(), "hone-selftest-"));
  const authStorage = await discoverAuthStorage(agentDir);
  const registry = buildRegistry(
    {
      cwd: agentDir,
      agentDir,
      baseUrl: "http://127.0.0.1:9/v1",
      token: "selftest",
      modelId: "hone-selftest",
      deadline: Date.now() + 60_000,
    },
    authStorage,
  );
  const model = registry.find("hone-proxy", "hone-selftest");
  if (model === undefined) throw new Error("selftest: registered model not found in registry");
  isolatedSettings();
  const sample = parseEpisode(
    JSON.stringify({
      version: 2,
      episode: 0,
      mode: "mutation",
      role: "capsule-author",
      systemPrompt: "s",
      userPrompt: "u",
      tools: ["read"],
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
    }),
  );
  if (sample.episode !== 0 || sample.role !== "capsule-author" || sample.tools[0] !== "read") {
    throw new Error("selftest: coding-session request parse mismatch");
  }

  const targetSocket = join(agentDir, "proxy.sock");
  const target = http.createServer((req, res) => {
    void readBridgeRequestBody(req).then(
      (body) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`${req.method ?? "GET"} ${req.url ?? "/"} ${body.toString("utf8")}`);
      },
      (err: unknown) => res.destroy(err instanceof Error ? err : new Error(String(err))),
    );
  });
  const targetListening = deferred<void>();
  target.once("error", targetListening.reject);
  target.listen(targetSocket, targetListening.resolve);
  await targetListening.promise;
  try {
    const bridge = await startUnixBridge(targetSocket);
    const response = await fetch(`${bridge}/selftest`, { method: "POST", body: "ping" });
    const echoed = await response.text();
    if (response.status !== 200 || echoed !== "POST /v1/selftest ping") {
      throw new Error(`selftest: Unix bridge mismatch (${response.status} ${echoed})`);
    }
  } finally {
    const closed = deferred<void>();
    target.close((err) => (err === undefined ? closed.resolve() : closed.reject(err)));
    await closed.promise;
  }
  console.log("hone-mutation selftest ok");
}

function cooldownSeconds(message: string): number | null {
  if (!/429|cooldown|rate.?limit/i.test(message)) return null;
  const match = /reset_seconds["\s:=]+([0-9.]+)/.exec(message);
  if (match?.[1] !== undefined) return Math.min(300, Number(match[1]));
  return -1; // cooldown without a hint: caller applies exponential backoff
}

async function runSession(env: SessionEnv, episode: EpisodeFile): Promise<Record<string, unknown>> {
  const authStorage = await discoverAuthStorage(env.agentDir);
  const registry = buildRegistry(env, authStorage);
  const model = registry.find("hone-proxy", env.modelId);
  if (model === undefined) throw new Error(`model ${env.modelId} not found after registration`);

  const { session } = await createAgentSession({
    cwd: env.cwd,
    agentDir: env.agentDir,
    authStorage,
    modelRegistry: registry,
    model,
    systemPrompt: episode.systemPrompt,
    deadline: env.deadline,
    sessionManager: SessionManager.inMemory(env.cwd),
    settings: isolatedSettings(),
    toolNames: episode.tools,
    requireYieldTool: true,
    outputSchema: episode.outputSchema,
    disableExtensionDiscovery: true,
    preloadedCustomToolPaths: [],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
  });

  try {
    const expected = [...episode.tools, "yield"];
    await session.setActiveToolsByName(expected);
    const active = new Set(session.getActiveToolNames());
    for (const tool of expected) {
      if (!active.has(tool)) throw new Error(`tool ${tool} missing from active set: ${[...active].join(",")}`);
    }
    for (const tool of active) {
      // The session factory injects "resolve"; anything else unexpected is a hard error.
      if (!expected.includes(tool) && tool !== "resolve") throw new Error(`unexpected active tool: ${tool}`);
    }

    let final: Record<string, unknown> | undefined;
    session.subscribe((event) => {
      if (event.type !== "tool_execution_end" || event.toolName !== "yield" || event.isError === true) return;
      const details: unknown = event.result?.details;
      if (typeof details !== "object" || details === null) return;
      const rec = details as Record<string, unknown>;
      if (rec.status === "success" && typeof rec.data === "object" && rec.data !== null) {
        final = rec.data as Record<string, unknown>;
      }
    });

    for (let attempt = 0; ; attempt++) {
      try {
        await session.prompt(episode.userPrompt);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/402|hone_budget_exceeded/i.test(message)) {
          throw new BudgetExhausted(message);
        }
        const cooldown = cooldownSeconds(message);
        if (cooldown === null || attempt >= 2) throw err;
        const waitSec = cooldown > 0 ? cooldown : Math.min(120, 5 * 2 ** attempt);
        console.error(`model cooldown (attempt ${attempt + 1}/3), retrying in ${waitSec}s: ${message}`);
        const pause = deferred<void>();
        setTimeout(() => pause.resolve(), waitSec * 1000);
        await pause.promise;
      }
    }

    if (final === undefined) throw new Error("session ended without a successful yield");
    return final;
  } finally {
    await session.dispose();
  }
}

class BudgetExhausted extends Error {}

async function main(): Promise<number> {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return 0;
  }

  assertNoAutoQa();
  const token = process.env.HONE_PROXY_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("HONE_PROXY_TOKEN is not set");
    return 2;
  }

  const episodePath = process.env.HONE_EPISODE_JSON ?? "/scratch/episode.json";
  let episode: EpisodeFile;
  try {
    episode = parseEpisode(readFileSync(episodePath, "utf8"));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const agentDir = process.env.HONE_AGENT_DIR ?? "/scratch/omp-agent";
  mkdirSync(agentDir, { recursive: true });
  const env: SessionEnv = {
    cwd: process.env.HONE_WORKDIR ?? "/workspace",
    agentDir,
    baseUrl: await resolveProxyBaseUrl(),
    token,
    modelId: process.env.HONE_MODEL_ID ?? "hone-mutation",
    deadline: Date.now() + Number(process.env.HONE_DEADLINE_MS ?? 1_500_000),
  };

  try {
    const result = await runSession(env, episode);
    console.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return err instanceof BudgetExhausted ? 3 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
