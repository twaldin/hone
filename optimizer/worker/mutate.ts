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
 * The image bakes this file at /opt/hone-worker/mutate.ts with its own
 * node_modules; it must stay a single self-contained program.
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
const TOOLS = ["read", "bash", "write", "edit"];

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "approach", "filesChanged"],
  properties: {
    summary: { type: "string", description: "What you changed and why, one paragraph." },
    approach: { type: "string", description: "Short strategy label for the lineage record." },
    filesChanged: { type: "array", items: { type: "string" }, description: "Paths you touched." },
  },
} as const;

interface EpisodeFile {
  version: 1;
  episode: number;
  mode: "mutation" | "repair";
  systemPrompt: string;
  userPrompt: string;
}

/** Hand-rolled validation — keep in sync with optimizer/src/episode.ts (no zod in the image). */
function parseEpisode(raw: string): EpisodeFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`episode.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof value !== "object" || value === null) throw new Error("episode.json: not an object");
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) throw new Error(`episode.json: unsupported version ${String(rec.version)}`);
  if (typeof rec.episode !== "number" || !Number.isInteger(rec.episode) || rec.episode < 0) {
    throw new Error("episode.json: episode must be a nonnegative integer");
  }
  if (rec.mode !== "mutation" && rec.mode !== "repair") throw new Error("episode.json: mode must be mutation|repair");
  if (typeof rec.systemPrompt !== "string" || rec.systemPrompt.length === 0) {
    throw new Error("episode.json: systemPrompt must be a non-empty string");
  }
  if (typeof rec.userPrompt !== "string" || rec.userPrompt.length === 0) {
    throw new Error("episode.json: userPrompt must be a non-empty string");
  }
  return {
    version: 1,
    episode: rec.episode,
    mode: rec.mode,
    systemPrompt: rec.systemPrompt,
    userPrompt: rec.userPrompt,
  };
}

/**
 * The broker mounts the trusted proxy as a unix socket (/run/hone/proxy.sock;
 * sandbox network is otherwise none). The Pi SDK speaks HTTP to a baseUrl, so
 * when no HTTP HONE_PROXY_BASE_URL is provided we bridge loopback -> unix.
 */
async function startUnixBridge(socketPath: string): Promise<string> {
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      { socketPath, path: req.url ?? "/", method: req.method, headers: req.headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "hone_bridge_error", message: err.message } }));
    });
    req.pipe(upstream);
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
        maxTokens: 16_384,
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
    JSON.stringify({ version: 1, episode: 0, mode: "mutation", systemPrompt: "s", userPrompt: "u" }),
  );
  if (sample.episode !== 0 || sample.mode !== "mutation") throw new Error("selftest: episode parse mismatch");
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
    toolNames: TOOLS,
    requireYieldTool: true,
    outputSchema: OUTPUT_SCHEMA,
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
    const expected = [...TOOLS, "yield"];
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
