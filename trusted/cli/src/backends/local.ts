import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapsuleManifest } from "@hone/schema";
import { CasStore, packDirAsArtifact, runCommand, startBroker } from "@hone/broker";
import type { RunningBroker, SandboxNetworkMode } from "@hone/broker";
import { createProxy, DEFAULT_UPSTREAM } from "@hone/proxy";
import type { BudgetDecision, ProxyHandle } from "@hone/proxy";
import { deferred } from "../promise.js";
import type { RunnerBackend, RunnerBackendContext } from "../types.js";

/**
 * The real runner backend (WP7): composes broker + metering proxy + the
 * optimizer child process behind the same seam the stub implements.
 *
 * Egress topology (mutation sandboxes -> LLM):
 *   linux   proxy binds runDir/proxy.sock; the broker mounts it at
 *           /run/hone/proxy.sock and the in-sandbox worker bridges
 *           loopback -> unix itself. Sandboxes stay --network none.
 *   darwin  VirtioFS-mounted host unix sockets cannot accept container
 *           connections, so the proxy binds 127.0.0.1:<random> TCP and a
 *           relay container (hone-task image, node one-liner) joins BOTH a
 *           per-run `--internal` docker network (the sandboxes' only
 *           endpoint) AND the default bridge, piping :8080 to
 *           host.docker.internal:<port>. Chain:
 *           sandbox -> relay:8080 -> host proxy -> vibeproxy upstream.
 *   Override with HONE_EGRESS=socket|network.
 *
 * The optimizer runs as an unprivileged host child (node + tsx, override via
 * HONE_OPTIMIZER_CMD) with a minimal explicit env and NO event authority:
 * its stdout/stderr go verbatim to runDir/optimizer.log as opaque
 * diagnostics. Every RunEvent is derived trusted-side — runner lifecycle
 * here/in the supervisor, everything else by the broker from the method
 * calls it serves (see trusted/broker recordEvaluation/reportIncumbent).
 */

/** Entries never packed into the baseline artifact (mirrors capsules/tools/ordering-check.ts). */
const BASELINE_SKIP: Record<string, true> = { ".git": true, ".gitdir": true, __pycache__: true, ".pytest_cache": true };

const RELAY_PORT = 8080;
/** TCP relay run inside the hone-task image: 0.0.0.0:8080 -> host.docker.internal:$HONE_RELAY_PORT. */
const RELAY_JS = [
  "const net=require('net');",
  "const port=Number(process.env.HONE_RELAY_PORT);",
  "net.createServer(c=>{",
  "const u=net.connect(port,'host.docker.internal');",
  "c.pipe(u);u.pipe(c);",
  "const drop=()=>{c.destroy();u.destroy();};",
  "c.on('error',drop);u.on('error',drop);",
  `}).listen(${RELAY_PORT},'0.0.0.0');`,
].join("");

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/**
 * Trusted pre-flight: the manifest on disk must still describe the tree.
 * Asset hashes + baseline git HEAD are recomputed; a drifted capsule refuses
 * to run (re-scaffold with capsules/tools/scaffold.ts).
 */
export function validateCapsule(capsuleDir: string, manifest: CapsuleManifest): void {
  for (const [rel, expected] of Object.entries(manifest.contentHashes)) {
    const abs = resolve(capsuleDir, rel);
    if (!existsSync(abs)) throw new Error(`capsule drift: asset missing on disk: ${rel}`);
    const actual = sha256File(abs);
    if (actual !== expected) throw new Error(`capsule drift: ${rel} hash ${actual} != manifest ${expected} — re-run capsules/tools/scaffold.ts`);
  }
  if (manifest.baseline.kind === "git") {
    const baselineDir = join(capsuleDir, "baseline");
    const gitDir = existsSync(join(baselineDir, ".gitdir")) ? join(baselineDir, ".gitdir") : join(baselineDir, ".git");
    const head = execFileSync("git", ["--git-dir", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== manifest.baseline.commit) {
      throw new Error(`capsule drift: baseline HEAD ${head} != manifest commit ${manifest.baseline.commit} — re-run capsules/tools/scaffold.ts`);
    }
  }
}

/** Anti-sandbagging: the baseline artifact is measured (packed) by the trusted runner, never taken from capsule metadata. */
async function measureBaseline(capsuleDir: string, cas: CasStore): Promise<string> {
  const baselineDir = join(capsuleDir, "baseline");
  if (!existsSync(baselineDir)) throw new Error(`capsule has no baseline/ directory: ${capsuleDir}`);
  const staging = mkdtempSync(join(tmpdir(), "hone-baseline-"));
  try {
    for (const entry of readdirSync(baselineDir)) {
      if (BASELINE_SKIP[entry] === true) continue;
      cpSync(join(baselineDir, entry), join(staging, entry), { recursive: true });
    }
    return await packDirAsArtifact(staging, cas);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function mustRun(argv: string[], what: string): Promise<string> {
  const res = await runCommand(argv, { timeoutMs: 120_000 });
  if (res.exitCode !== 0) throw new Error(`${what} failed: ${res.stderr.toString("utf8").slice(0, 2000)}`);
  return res.stdout.toString("utf8").trim();
}

interface Egress {
  sandboxNetwork: SandboxNetworkMode;
  /** HONE_PROXY_BASE_URL for sandboxes; null on the unix-socket path (the worker bridges the mounted socket). */
  proxyBaseUrl: string | null;
  cleanup(): Promise<void>;
}

async function setupEgress(ctx: RunnerBackendContext, proxy: ProxyHandle, image: string): Promise<Egress> {
  const mode = ctx.env["HONE_EGRESS"] ?? (process.platform === "darwin" ? "network" : "socket");
  if (mode === "socket") {
    await proxy.listenUnix(join(ctx.runDir, "proxy.sock"));
    return { sandboxNetwork: { mode: "none" }, proxyBaseUrl: null, cleanup: async () => {} };
  }
  if (mode !== "network") throw new Error(`HONE_EGRESS must be "socket" or "network", got "${mode}"`);

  const safeRunId = ctx.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const network = `hone-${safeRunId}`;
  const relay = `hone-proxy-${safeRunId}`;
  const port = await proxy.listenTcp(0);
  await mustRun(["docker", "network", "create", "--internal", network], `docker network create ${network}`);
  const cleanup = async (): Promise<void> => {
    await runCommand(["docker", "rm", "-f", relay]);
    await runCommand(["docker", "network", "rm", network]);
  };
  try {
    await mustRun(
      [
        "docker", "run", "-d",
        "--name", relay,
        "--network", network,
        "--label", `hone.runId=${ctx.runId}`,
        "--add-host", "host.docker.internal:host-gateway",
        "-e", `HONE_RELAY_PORT=${port}`,
        image,
        "node", "-e", RELAY_JS,
      ],
      "docker run (proxy relay)",
    );
    // Second leg: bridge gives the relay (and ONLY the relay) a route to the host proxy.
    await mustRun(["docker", "network", "connect", "bridge", relay], "docker network connect bridge");
  } catch (err) {
    await cleanup();
    throw err;
  }
  return {
    sandboxNetwork: { mode: "internal", network },
    proxyBaseUrl: `http://${relay}:${RELAY_PORT}/v1`,
    cleanup,
  };
}

/** Spawn command for the optimizer child: HONE_OPTIMIZER_CMD override, else host node + the cli's own tsx. */
function optimizerCommand(env: NodeJS.ProcessEnv): string[] {
  const override = env["HONE_OPTIMIZER_CMD"];
  if (override !== undefined && override.trim().length > 0) return override.trim().split(/\s+/);
  const require = createRequire(import.meta.url);
  const tsxCli = join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs");
  return [process.execPath, tsxCli];
}

function runOptimizer(ctx: RunnerBackendContext, brokerSocket: string): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const entry = ctx.env["HONE_OPTIMIZER_ENTRY"] ?? join(repoRoot, "optimizer", "src", "main.ts");
  if (!existsSync(entry)) throw new Error(`optimizer entry not found: ${entry} (set HONE_OPTIMIZER_ENTRY)`);
  const [cmd, ...args] = optimizerCommand(ctx.env);
  if (cmd === undefined) throw new Error("empty HONE_OPTIMIZER_CMD");

  // Opaque diagnostics sink — NEVER parsed, NEVER an event source.
  const optLog = createWriteStream(join(ctx.runDir, "optimizer.log"), { flags: "a" });
  const scratch = join(ctx.runDir, "opt-scratch");
  mkdirSync(scratch, { recursive: true });

  // ACCEPTED RISK (M0 boundary ruling): this is a same-UID host process, so
  // OS-level containment (Docker socket, CAS, admin socket) is not enforced —
  // acceptable only because at M0 the loop binary is session-authored seed
  // code, never mutated output. M1 (first mutated optimizer) requires the
  // loop in a container + broker TCP relay (VirtioFS blocks unix-socket
  // mounts on macOS). Mitigations here: minimal explicit env (no inherited
  // shell env / credentials), cwd outside the repo, no event channel.
  const child = spawn(cmd, [...args, entry], {
    cwd: scratch,
    env: {
      ...(ctx.env["PATH"] !== undefined ? { PATH: ctx.env["PATH"] } : {}),
      HONE_BROKER_SOCK: brokerSocket,
      HONE_RUN_ID: ctx.runId,
      HONE_SEED: String(ctx.config.seed),
      HONE_RESUME: JSON.stringify({
        nextEpisode: ctx.replayed.nextEpisode,
        incumbent: ctx.replayed.incumbent === null ? null : { artifact: ctx.replayed.incumbent.artifact, aggregate: ctx.replayed.incumbent.aggregate },
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ctx.registerChild(child);
  child.stdout.pipe(optLog, { end: false });
  child.stderr.pipe(optLog, { end: false });

  const done = deferred<void>();
  child.on("error", (err) => done.reject(err));
  child.on("close", (code, signal) => {
    optLog.end();
    if (ctx.signal.aborted) return done.resolve(); // supervisor-initiated wind-down
    if (code === 0) return done.resolve();
    done.reject(new Error(`optimizer exited ${code ?? `signal ${signal ?? "?"}`} — see ${join(ctx.runDir, "optimizer.log")}`));
  });
  return done.promise;
}

export function createBackend(): RunnerBackend {
  return {
    async start(ctx: RunnerBackendContext): Promise<void> {
      if (ctx.signal.aborted) return;
      validateCapsule(ctx.capsuleDir, ctx.manifest);

      const route = ctx.config.routing["mutation"];
      if (route === undefined) {
        throw new Error('run config has no "mutation" model route — pass --config with {"routing":{"mutation":{"model":"…"}}}');
      }

      const cas = new CasStore(ctx.casDir);
      const baselineArtifactHash = await measureBaseline(ctx.capsuleDir, cas);

      // Broker + proxy are mutually referential (proxy meters INTO the broker,
      // broker env points sandboxes AT the proxy); the late-bound ref breaks the cycle.
      let running: RunningBroker | null = null;
      const checkBudget = (): BudgetDecision => {
        if (running === null) return { allowed: false, dimension: "wallClockSec", message: "broker not started" };
        const { envelope, spent } = running.broker.getBudget({ privileged: true });
        if (spent.tokens >= envelope.maxTokens) return { allowed: false, dimension: "tokens" };
        if (spent.usd >= envelope.maxUsd) return { allowed: false, dimension: "usd" };
        if (spent.wallClockSec >= envelope.maxWallClockSec) return { allowed: false, dimension: "wallClockSec" };
        if (spent.evaluatorInvocations >= envelope.maxEvaluatorInvocations) return { allowed: false, dimension: "evaluatorInvocations" };
        return { allowed: true };
      };

      const proxy = createProxy({
        runId: ctx.runId,
        routing: ctx.config.routing,
        runDir: ctx.runDir,
        casDir: ctx.casDir,
        upstreamBaseUrl: ctx.env["HONE_UPSTREAM_BASE_URL"] ?? DEFAULT_UPSTREAM,
        ...(ctx.env["HONE_UPSTREAM_API_KEY"] !== undefined ? { upstreamApiKey: ctx.env["HONE_UPSTREAM_API_KEY"] } : {}),
        checkBudget,
        recordSpend: (spend) => {
          running?.broker.recordSpend({ tokens: spend.tokens, usd: spend.usd }, { privileged: true });
        },
      });

      const image = ctx.env["HONE_MUTATION_IMAGE"] ?? "hone-mutation:latest";
      let egress: Egress | null = null;
      try {
        egress = await setupEgress(ctx, proxy, image);

        running = await startBroker({
          runId: ctx.runId,
          // The RUN envelope (config) is what the broker meters — it may tighten the capsule's.
          manifest: { ...ctx.manifest, budget: ctx.config.budget },
          capsuleRootDir: ctx.capsuleDir,
          baselineArtifactHash,
          image,
          runDir: ctx.runDir,
          casDir: ctx.casDir,
          onEvent: (event) => ctx.emit(event),
          sandboxNetwork: egress.sandboxNetwork,
          mutationEnv: {
            ...(egress.proxyBaseUrl !== null ? { HONE_PROXY_BASE_URL: egress.proxyBaseUrl } : {}),
            HONE_PROXY_TOKEN: proxy.tokenFor("mutation"),
            HONE_MODEL_ID: route.model,
          },
          episodeOrigin: ctx.replayed.nextEpisode,
        });

        await runOptimizer(ctx, running.socketPath);

        // Final trusted budget line so the exit report reflects total spend.
        ctx.emit({
          runId: ctx.runId,
          at: new Date().toISOString(),
          type: "budget.snapshot",
          budget: running.broker.getBudget({ privileged: true }),
        });
      } finally {
        await proxy.close().catch(() => {});
        if (running !== null) await running.close().catch(() => {});
        if (egress !== null) await egress.cleanup().catch(() => {});
      }
    },
  };
}
