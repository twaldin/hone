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
 *     HONE_SESSION_NO_YIELD_MAX_TOKENS (default 1,500,000);
 *     HONE_AGENT_DIR (default /scratch/omp-agent, ephemeral).
 *
 * Output: on success the LAST stdout line is the MutateResult JSON
 * ({ summary, approach, filesChanged }). Exit codes: 0 ok, 1 failure,
 * 2 bad input/env, 3 run budget exhausted (proxy 402 hone_budget_exceeded),
 * 4 session stopped at the no-yield token bound (structured stdout record).
 *
 * `--selftest` performs the no-LLM registry/settings/bridge smoke.
 * `--toolbelt-selftest` activates and executes bash+write+edit without
 * prompting a model, then prints a machine-readable zero-spend result.
 *
 * Delivery: this source is part of the sealed optimizer snapshot. The
 * no-network manifest-image build bundles it (with its captured Pi SDK
 * closure) into the self-contained /hone/out/worker.mjs; the loop putFiles
 * those exact bytes into every mutation sandbox and execs the sandbox-local
 * file under bun. The only image-provided piece is the platform-native
 * pi_natives addon baked next to bun (a .node binary cannot live in a JS
 * bundle).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";
import {
  SESSION_NO_YIELD_EXIT_CODE,
  SESSION_USAGE_ANOMALY_RECORD_TYPE,
  SessionNoYieldCounter,
  parseSessionNoYieldMaxTokens,
  type SessionNoYieldRecord,
} from "../src/session-yield-bound.js";

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
  noYieldMaxTokens: number;
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

const WORKER_SETTINGS_OVERRIDES = {
  "compaction.enabled": false,
  "retry.enabled": false,
  "dev.autoqa": false,
} as const;

/**
 * Pi still has legacy tool guards that dereference its global Settings proxy.
 * Initialize that singleton as file-blind, process-local defense in depth,
 * then return the separate isolated instance every worker session has always
 * received.
 */
async function workerSettings(env: Pick<SessionEnv, "agentDir">): Promise<Settings> {
  await Settings.init({
    cwd: env.agentDir,
    agentDir: env.agentDir,
    inMemory: true,
    overrides: WORKER_SETTINGS_OVERRIDES,
  });
  return Settings.isolated(WORKER_SETTINGS_OVERRIDES);
}

function assertNoAutoQa(): void {
  if (process.env.PI_AUTO_QA !== undefined) {
    throw new Error("PI_AUTO_QA must be unset inside mutation sandboxes");
  }
}

async function selftest(): Promise<void> {
  assertNoAutoQa();
  const agentDir = mkdtempSync(join(tmpdir(), "hone-selftest-"));
  await workerSettings({ agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  const registry = buildRegistry(
    {
      cwd: agentDir,
      agentDir,
      baseUrl: "http://127.0.0.1:9/v1",
      token: "selftest",
      modelId: "hone-selftest",
      deadline: Date.now() + 60_000,
      noYieldMaxTokens: parseSessionNoYieldMaxTokens(undefined),
    },
    authStorage,
  );
  const model = registry.find("hone-proxy", "hone-selftest");
  if (model === undefined) throw new Error("selftest: registered model not found in registry");
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

interface ToolbeltSelftestResult {
  type: "hone-mutation-toolbelt-selftest.v1";
  home: string;
  modelCalls: 0;
  tools: ["bash", "write", "edit"];
  outputs: {
    bash: string;
    write: string;
    edit: string;
  };
}

async function toolbeltSelftest(): Promise<void> {
  assertNoAutoQa();
  const cwd = process.env.HONE_WORKDIR ?? "/workspace";
  const agentDir = process.env.HONE_AGENT_DIR ?? "/scratch/omp-agent";
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const env: SessionEnv = {
    cwd,
    agentDir,
    baseUrl: "http://127.0.0.1:9/v1",
    token: "toolbelt-selftest",
    modelId: "hone-toolbelt-selftest",
    deadline: Date.now() + 60_000,
    noYieldMaxTokens: parseSessionNoYieldMaxTokens(undefined),
  };
  const authStorage = await discoverAuthStorage(agentDir);
  const registry = buildRegistry(env, authStorage);
  const model = registry.find("hone-proxy", env.modelId);
  if (model === undefined) throw new Error("toolbelt selftest: registered model not found");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry: registry,
    model,
    systemPrompt: "Offline worker toolbelt selftest. No model prompt is permitted.",
    deadline: env.deadline,
    sessionManager: SessionManager.inMemory(cwd),
    settings: await workerSettings(env),
    toolNames: ["read", "bash", "write", "edit"],
    requireYieldTool: false,
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
  const failures: string[] = [];
  const capture = async (name: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const bashPath = join(cwd, ".hone-toolbelt-bash");
  const writePath = join(cwd, ".hone-toolbelt-write");
  const editPath = join(cwd, ".hone-toolbelt-edit");
  writeFileSync(writePath, "before\n", "utf8");
  writeFileSync(editPath, "before\n", "utf8");
  try {
    await session.setActiveToolsByName(["read", "bash", "write", "edit"]);
    const active = session.getActiveToolNames();
    for (const name of ["read", "bash", "write", "edit"]) {
      if (!active.includes(name)) failures.push(`${name}: missing from active tool set`);
    }
    await capture("bash", async () => {
      const tool = session.getToolByName("bash");
      if (tool === undefined) throw new Error("not registered");
      await tool.execute(
        "toolbelt-bash",
        { command: "printf 'bash-ok\\n' > .hone-toolbelt-bash", cwd },
        undefined,
      );
    });
    await capture("write", async () => {
      const tool = session.getToolByName("write");
      if (tool === undefined) throw new Error("not registered");
      await tool.execute(
        "toolbelt-write",
        { path: writePath, content: "write-ok\n" },
        undefined,
      );
    });
    await capture("edit", async () => {
      const readTool = session.getToolByName("read");
      const editTool = session.getToolByName("edit");
      if (readTool === undefined || editTool === undefined) throw new Error("read/edit not registered");
      const readResult = await readTool.execute("toolbelt-read", { path: editPath }, undefined);
      const rendered = readResult.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      const tag = /\[[^\]\r\n]+#([0-9A-Fa-f]{4})\]/.exec(rendered)?.[1];
      if (tag === undefined) throw new Error(`read returned no hashline tag: ${rendered}`);
      await editTool.execute(
        "toolbelt-edit",
        {
          input:
            `*** Begin Patch\n[${editPath}#${tag}]\nSWAP 1.=1:\n+edit-ok\n*** End Patch\n`,
        },
        undefined,
      );
    });
    if (failures.length > 0) throw new Error(`toolbelt selftest failed: ${failures.join("; ")}`);
    const result: ToolbeltSelftestResult = {
      type: "hone-mutation-toolbelt-selftest.v1",
      home: process.env.HOME ?? "",
      modelCalls: 0,
      tools: ["bash", "write", "edit"],
      outputs: {
        bash: readFileSync(bashPath, "utf8"),
        write: readFileSync(writePath, "utf8"),
        edit: readFileSync(editPath, "utf8"),
      },
    };
    if (
      result.outputs.bash !== "bash-ok\n"
      || result.outputs.write !== "write-ok\n"
      || result.outputs.edit !== "edit-ok\n"
    ) {
      throw new Error(`toolbelt selftest output mismatch: ${JSON.stringify(result.outputs)}`);
    }
    console.log(JSON.stringify(result));
  } finally {
    await session.dispose();
  }
}

function cooldownSeconds(message: string): number | null {
  if (!/429|cooldown|rate.?limit/i.test(message)) return null;
  const match = /reset_seconds["\s:=]+([0-9.]+)/.exec(message);
  if (match?.[1] !== undefined) return Math.min(300, Number(match[1]));
  return -1; // cooldown without a hint: caller applies exponential backoff
}
class SessionNoYieldBoundExceeded extends Error {
  constructor(readonly record: SessionNoYieldRecord) {
    super(
      `mutation session exceeded the no-yield token bound: ` +
      `${record.consumedTokens} tokens across ${record.modelCalls} model calls (limit ${record.limitTokens})`,
    );
    this.name = "SessionNoYieldBoundExceeded";
  }
}


interface SessionCheckpoint {
  dir: string;
  resultPath: string;
  sessionDir: string;
  workspacePath: string;
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncPath(dir);
}

function checkpointFor(env: SessionEnv, episode: EpisodeFile): SessionCheckpoint {
  const identity = createHash("sha256").update(JSON.stringify(episode)).digest("hex");
  const dir = join(env.agentDir, "checkpoints", identity);
  return {
    dir,
    resultPath: join(dir, "result.json"),
    sessionDir: join(dir, "sessions"),
    workspacePath: join(dir, "workspace.tar"),
  };
}

function syncSession(manager: SessionManager): void {
  manager.flushSync();
  const sessionFile = manager.getSessionFile();
  if (sessionFile === undefined || !existsSync(sessionFile)) return;
  syncPath(sessionFile);
  syncPath(dirname(sessionFile));
}

function saveWorkspace(checkpoint: SessionCheckpoint, cwd: string): void {
  mkdirSync(checkpoint.dir, { recursive: true });
  const tmp = `${checkpoint.workspacePath}.${process.pid}.tmp`;
  const packed = spawnSync("tar", ["-c", "-f", tmp, "-C", cwd, "."]);
  if (packed.status !== 0) {
    throw new Error(`workspace checkpoint failed: ${packed.stderr.toString().slice(-2000)}`);
  }
  syncPath(tmp);
  renameSync(tmp, checkpoint.workspacePath);
  syncPath(checkpoint.dir);
}

function restoreWorkspace(checkpoint: SessionCheckpoint, cwd: string): boolean {
  if (!existsSync(checkpoint.workspacePath)) return false;
  const restored = spawnSync(
    "sh",
    [
      "-c",
      "find \"$1\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -x -f \"$2\" -C \"$1\"",
      "sh",
      cwd,
      checkpoint.workspacePath,
    ],
  );
  if (restored.status !== 0) {
    throw new Error(`workspace checkpoint restore failed: ${restored.stderr.toString().slice(-2000)}`);
  }
  return true;
}

async function runSession(env: SessionEnv, episode: EpisodeFile): Promise<Record<string, unknown>> {
  const checkpoint = checkpointFor(env, episode);
  const manager = await SessionManager.continueRecent(env.cwd, checkpoint.sessionDir);
  const hadSession = manager.getEntries().length > 0;
  const restored = restoreWorkspace(checkpoint, env.cwd);
  if (hadSession !== restored) {
    throw new Error(
      "session checkpoint is incomplete: conversation and workspace must become durable together",
    );
  }
  if (existsSync(checkpoint.resultPath)) {
    const result = objectRecord(JSON.parse(readFileSync(checkpoint.resultPath, "utf8")));
    if (result === null) throw new Error("session checkpoint result is malformed");
    return result;
  }

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
    sessionManager: manager,
    settings: await workerSettings(env),
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
  let zeroUsageTurns = 0;
  let normalizedUsageTurns = 0;

  let checkpointFailure: Error | undefined;
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
    let bounded: SessionNoYieldRecord | null = null;
    let abortPromise: Promise<void> | undefined;
    const counter = new SessionNoYieldCounter(
      env.noYieldMaxTokens,
      (kind) => {
        if (kind === "zero-usage") zeroUsageTurns += 1;
        else normalizedUsageTurns += 1;
      },
    );
    session.subscribe((event) => {
      if (checkpointFailure !== undefined) return;
      try {
        if (event.type === "tool_execution_end" && event.isError !== true) {
          // Publish workspace bytes before the transcript acknowledges the
          // completed tool. A kill can leave workspace ahead of conversation,
          // never conversation describing effects absent from the restore.
          saveWorkspace(checkpoint, env.cwd);
        }
        syncSession(manager);
        if (event.type === "tool_execution_end" && event.toolName === "yield" && event.isError !== true) {
          const details: unknown = event.result?.details;
          if (typeof details === "object" && details !== null) {
            const rec = details as Record<string, unknown>;
            if (rec.status === "success" && typeof rec.data === "object" && rec.data !== null) {
              final = rec.data as Record<string, unknown>;
              durableJson(checkpoint.resultPath, final);
            }
          }
        }
        if (event.type !== "turn_end" || event.message.role !== "assistant") return;
        bounded = counter.observe(
          {
            promptTokens: event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite,
            completionTokens: event.message.usage.output,
            totalTokens: event.message.usage.totalTokens,
          },
          final !== undefined,
        );
        if (bounded !== null && abortPromise === undefined) {
          abortPromise = session.abort({ reason: "hone mutation session no-yield token bound" });
          // The prompt catch below awaits and rethrows this result. Attach an
          // immediate handler so a fast abort failure is never unhandled.
          void abortPromise.catch(() => {});
        }
      } catch (error) {
        checkpointFailure = error instanceof Error ? error : new Error(String(error));
        void session.abort({ reason: "durable session checkpoint failed" }).catch(() => {});
      }
    });

    const prompt = hadSession
      ? "Continue the interrupted task from the durable transcript. Do not repeat completed tool work."
      : episode.userPrompt;
    for (let attempt = 0; ; attempt++) {
      try {
        await session.prompt(prompt);
        break;
      } catch (err) {
        if (checkpointFailure !== undefined) throw checkpointFailure;
        if (bounded !== null) {
          await abortPromise?.catch(() => {});
          throw new SessionNoYieldBoundExceeded(bounded);
        }
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

    if (checkpointFailure !== undefined) throw checkpointFailure;
    if (bounded !== null) {
      await abortPromise?.catch(() => {});
      throw new SessionNoYieldBoundExceeded(bounded);
    }
    if (final === undefined) throw new Error("session ended without a successful yield");
    return final;
  } finally {
    syncSession(manager);
    if (zeroUsageTurns > 0 || normalizedUsageTurns > 0) {
      console.error(JSON.stringify({
        type: SESSION_USAGE_ANOMALY_RECORD_TYPE,
        zeroUsageTurns,
        normalizedUsageTurns,
      }));
    }
    await session.dispose();
  }
}

class BudgetExhausted extends Error {}

async function main(): Promise<number> {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return 0;
  }
  if (process.argv.includes("--toolbelt-selftest")) {
    await toolbeltSelftest();
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
    noYieldMaxTokens: parseSessionNoYieldMaxTokens(process.env.HONE_SESSION_NO_YIELD_MAX_TOKENS),
  };

  try {
    const result = await runSession(env, episode);
    console.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    if (err instanceof SessionNoYieldBoundExceeded) {
      console.log(JSON.stringify(err.record));
      console.error(err.message);
      return SESSION_NO_YIELD_EXIT_CODE;
    }
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
