import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@hone/broker";
import type { RunCommand } from "@hone/broker";
import { canonicalJson } from "@hone/schema";
import { UsageError } from "./args.js";
import {
  optimizerBuildArgs,
  optimizerBuildName,
  optimizerConformanceCreateArgs,
  optimizerRunName,
  optimizerStartArgs,
  sealOptimizerBundleDir,
  verifyOptimizerBundleSeal,
} from "./backends/optimizer-container.js";
import type { OptimizerBundleSeal } from "./backends/optimizer-container.js";
import type { ResolvedCandidateOptimizer } from "./optimizer-artifact.js";
import {
  OPTIMIZER_BUILD_CONTRACT,
  snapshotDigest,
  writeOptimizerStaging,
} from "./optimizer-digest.js";
import { sleep } from "./promise.js";

const CONFORMANCE_PORT = 46_017;
const DEFAULT_PROTOCOL_TIMEOUT_MS = 15_000;
const STUB_READY = "HONE_CONFORMANCE_READY";
const STUB_RESULT = "HONE_CONFORMANCE_RESULT ";
const BASELINE_HASH = `sha256:${"0".repeat(64)}`;
const EXPECTED_METHODS = ["getTask", "getBudget", "finish"] as const;
const MISSING_DOCKER_RESOURCE = /no such container|no such object|not found/i;

/**
 * Trusted, fixed broker stub. It exposes only the three calls needed for an
 * exhausted-budget handshake, so a conforming optimizer proves it can load,
 * authenticate, parse protocol results, and finish without creating a
 * sandbox, evaluating an artifact, reserving child work, or reaching a model.
 */
const CONFORMANCE_STUB_JS = String.raw`
const net = require("node:net");
const token = process.env.HONE_CONFORMANCE_TOKEN;
const baseline = "${BASELINE_HASH}";
const expected = ["getTask", "getBudget", "finish"];
const budget = {
  envelope: { maxTokens: 1, maxUsd: 1, maxWallClockSec: 60, maxEvaluatorInvocations: 1 },
  spent: { tokens: 1, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
};
let methods = [];
let terminal = false;
const server = net.createServer((socket) => {
  let buf = "";
  const finish = (ok, detail, response) => {
    if (terminal) return;
    terminal = true;
    socket.end(JSON.stringify(response) + "\n", () => {
      console.log("${STUB_RESULT}" + JSON.stringify({ ok, detail, methods, finished: ok && methods.at(-1) === "finish" }));
      server.close();
    });
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while (!terminal && (nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === "") continue;
      let req;
      try { req = JSON.parse(line); } catch { finish(false, "invalid JSON", { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
      const id = req && req.id;
      const method = req && req.method;
      if (!req || req.jsonrpc !== "2.0" || typeof id !== "number" || req.token !== token) {
        finish(false, "invalid or unauthenticated request", { jsonrpc: "2.0", id: typeof id === "number" ? id : null, error: { code: -32060, message: "unauthorized" } });
        return;
      }
      const wanted = expected[methods.length];
      methods.push(method);
      console.log("HONE_CONFORMANCE_METHOD " + method);
      if (method !== wanted || req.params === null || typeof req.params !== "object" || Array.isArray(req.params)) {
        finish(false, "unexpected protocol sequence", { jsonrpc: "2.0", id, error: { code: -32602, message: "unexpected protocol sequence" } });
        return;
      }
      if (method === "getTask") {
        socket.write(JSON.stringify({ jsonrpc: "2.0", id, result: {
          capsuleId: "cap_000000000000",
          objective: "candidate optimizer conformance handshake",
          baselineArtifact: { hash: baseline },
          visibleAssetGroups: ["train"],
          budget,
        } }) + "\n");
      } else if (method === "getBudget") {
        socket.write(JSON.stringify({ jsonrpc: "2.0", id, result: budget }) + "\n");
      } else if (!req.params.best || req.params.best.hash !== baseline) {
        finish(false, "finish did not preserve the baseline", { jsonrpc: "2.0", id, error: { code: -32602, message: "invalid finish" } });
      } else {
        finish(true, null, { jsonrpc: "2.0", id, result: {} });
      }
    }
  });
  socket.on("error", () => socket.destroy());
});
server.listen(${CONFORMANCE_PORT}, "0.0.0.0", () => console.log("${STUB_READY}"));
`;

export interface CandidateConformanceRuntimeIdentity {
  version: 1;
  image: string;
  optimizerDigest: string;
  buildContractDigest: string;
  bundleDigest: string;
  bundleFiles: Record<string, { sha256: string; size: number }>;
  runtimeArgv: readonly string[];
  runtimeDigest: string;
}

/** Digest-sealed evidence suitable for equality checks at a trusted gate. */
export interface CandidateConformanceReceipt {
  version: 1;
  sourceArtifact: string;
  baseDigest: string;
  mutablePaths: Record<string, string>;
  runtime: CandidateConformanceRuntimeIdentity;
  protocol: {
    version: "jsonrpc-2.0";
    methods: readonly ["getTask", "getBudget", "finish"];
    modelEgress: false;
    childReservations: 0;
  };
  receiptDigest: string;
}

export interface CandidateConformanceDeps {
  /** Injectable command seam; production uses the trusted broker RunCommand. */
  run?: RunCommand;
  /** Bounds only the candidate protocol process; build keeps its frozen 10-minute ceiling. */
  protocolTimeoutMs?: number;
  /** Injectable deterministic suffix for tests. */
  id?: string;
}

interface StubTranscript {
  ok: boolean;
  detail: string | null;
  methods: unknown[];
  finished: boolean;
}

function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hostIds(): { uid: number; gid: number } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error("candidate conformance requires POSIX numeric uid/gid");
  return { uid, gid };
}

function safeSuffix(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 32);
  if (safe.length === 0) throw new UsageError("candidate conformance id has no Docker-name-safe characters");
  return safe;
}

function stubArgs(name: string, network: string, image: string, token: string): string[] {
  return [
    "docker", "run", "-d", "--pull=never",
    "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=1", "--log-opt", "compress=false",
    "--name", name,
    "--network", network,
    "--read-only",
    "--tmpfs", "/tmp:rw,size=67108864",
    "-e", "HOME=/tmp",
    "-e", `HONE_CONFORMANCE_TOKEN=${token}`,
    "--user", "2000:2000",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "64",
    "--memory", "134217728",
    "--cpus", "1",
    image,
    "node", "-e", CONFORMANCE_STUB_JS,
  ];
}

async function waitForStub(run: RunCommand, name: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const logs = await run(["docker", "logs", name], { timeoutMs: 2_000 });
    if (logs.stdout.toString("utf8").includes(STUB_READY)) return;
    if (logs.exitCode !== 0 && !MISSING_DOCKER_RESOURCE.test(logs.stderr.toString("utf8"))) {
      throw new Error(`candidate conformance stub readiness failed: ${logs.stderr.toString("utf8").slice(0, 1_000)}`);
    }
    await sleep(50);
  }
  throw new Error("candidate conformance stub did not become ready within 2500ms");
}

function parseTranscript(stdout: string): StubTranscript | null {
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(STUB_RESULT));
  if (line === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(STUB_RESULT.length));
  } catch {
    throw new Error("candidate conformance stub emitted a malformed terminal receipt");
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("candidate conformance stub emitted an invalid terminal receipt");
  const record = parsed as { ok?: unknown; detail?: unknown; methods?: unknown; finished?: unknown };
  if (
    typeof record.ok !== "boolean"
    || (record.detail !== null && typeof record.detail !== "string")
    || !Array.isArray(record.methods)
    || typeof record.finished !== "boolean"
  ) {
    throw new Error("candidate conformance stub emitted an invalid terminal receipt");
  }
  return { ok: record.ok, detail: record.detail, methods: record.methods, finished: record.finished };
}

function runtimeIdentity(image: string, optimizerDigest: string, seal: OptimizerBundleSeal): CandidateConformanceRuntimeIdentity {
  const bundleFiles: Record<string, { sha256: string; size: number }> = {};
  for (const file of seal.files) bundleFiles[file.name] = { sha256: file.sha256, size: file.size };
  const buildContractDigest = sha256(canonicalJson(OPTIMIZER_BUILD_CONTRACT));
  const bundleDigest = sha256(canonicalJson(bundleFiles));
  const body = {
    version: 1 as const,
    image,
    optimizerDigest,
    buildContractDigest,
    bundleDigest,
    bundleFiles,
    runtimeArgv: [...OPTIMIZER_BUILD_CONTRACT.run],
  };
  return { ...body, runtimeDigest: sha256(canonicalJson(body)) };
}

async function removeDockerResource(run: RunCommand, argv: string[], what: string): Promise<string | null> {
  try {
    const result = await run(argv, { timeoutMs: 30_000 });
    if (result.exitCode === 0 || MISSING_DOCKER_RESOURCE.test(result.stderr.toString("utf8"))) return null;
    return `${what}: ${result.stderr.toString("utf8").trim() || `exit ${result.exitCode}`}`;
  } catch (error) {
    return `${what}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Build and protocol-check exactly one already-resolved candidate snapshot.
 * Structural/digest checks and staging finish before the first Docker call.
 * Both build and execution use the production frozen primitives; the only
 * peer on the --internal network is the fixed trusted stub above.
 */
export async function conformCandidateOptimizer(
  candidate: ResolvedCandidateOptimizer,
  image: string,
  deps: CandidateConformanceDeps = {},
): Promise<CandidateConformanceReceipt> {
  const actualDigest = snapshotDigest(image, candidate.snapshot);
  if (actualDigest !== candidate.mergedDigest) {
    throw new UsageError(`candidate conformance snapshot digest ${actualDigest} != resolved digest ${candidate.mergedDigest}`);
  }
  for (const required of ["optimizer/src/main.ts", "optimizer/worker/mutate.ts"] as const) {
    if (!candidate.snapshot.files.has(required)) throw new UsageError(`candidate conformance snapshot is missing ${required}`);
  }

  const suffix = safeSuffix(deps.id ?? randomBytes(12).toString("hex"));
  const runId = `conformance-${suffix}`;
  const safeRunId = runId;
  const network = `hone-conf-net-${suffix}`;
  const stubName = `hone-conf-stub-${suffix}`;
  const candidateName = optimizerRunName(safeRunId, 1);
  const buildName = optimizerBuildName(safeRunId);
  const token = randomBytes(32).toString("hex");
  const run = deps.run ?? runCommand;
  const protocolTimeoutMs = deps.protocolTimeoutMs ?? DEFAULT_PROTOCOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(protocolTimeoutMs) || protocolTimeoutMs <= 0 || protocolTimeoutMs > 60_000) {
    throw new UsageError("candidate conformance protocolTimeoutMs must be an integer in 1..60000");
  }

  const { uid, gid } = hostIds();
  const tempRoot = mkdtempSync(join(tmpdir(), "hone-optconformance-"));
  try {
    chmodSync(tempRoot, 0o700);
    const stagingDir = join(tempRoot, "src");
    const outRoot = join(tempRoot, "bundle-root");
    const outDir = join(outRoot, "out");
    mkdirSync(stagingDir, { mode: 0o700 });
    mkdirSync(outRoot, { mode: 0o700 });
    mkdirSync(outDir, { mode: 0o700 });
    // Exact captured buffers only. This also validates the sealed Pi topology.
    writeOptimizerStaging(candidate.snapshot, stagingDir);
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
  const stagingDir = join(tempRoot, "src");
  const outRoot = join(tempRoot, "bundle-root");
  const outDir = join(outRoot, "out");

  let bundleSeal: OptimizerBundleSeal | null = null;
  let receipt: CandidateConformanceReceipt | null = null;
  let primaryFailure: unknown = null;
  try {
    const createdNetwork = await run(["docker", "network", "create", "--internal", network], { timeoutMs: 30_000 });
    if (createdNetwork.timedOut || createdNetwork.exitCode !== 0) {
      throw new Error(`candidate conformance internal network create failed: ${createdNetwork.stderr.toString("utf8").slice(0, 1_000) || `exit ${createdNetwork.exitCode}`}`);
    }
    const startedStub = await run(stubArgs(stubName, network, image, token), { timeoutMs: 30_000 });
    if (startedStub.timedOut || startedStub.exitCode !== 0) {
      throw new Error(`candidate conformance stub start failed: ${startedStub.stderr.toString("utf8").slice(0, 1_000) || `exit ${startedStub.exitCode}`}`);
    }
    await waitForStub(run, stubName);

    const built = await run(optimizerBuildArgs({
      runId,
      safeRunId,
      image,
      stagingDir,
      outDir,
      // The trusted stub has no mounts or campaign authority; it supplies the
      // lease attachment required by the exact production build primitive.
      containerLease: stubName,
      hostUid: uid,
      hostGid: gid,
    }), { timeoutMs: 600_000 });
    if (built.timedOut) throw new Error("candidate optimizer conformance build timed out");
    if (built.exitCode !== 0) {
      throw new Error(`candidate optimizer conformance build failed (exit ${built.exitCode}): ${built.stderr.toString("utf8").slice(0, 2_000)}`);
    }
    bundleSeal = sealOptimizerBundleDir(outRoot, outDir, uid);
    verifyOptimizerBundleSeal({ bundleDir: outDir, bundleSeal });

    const endpoint = `tcp://${stubName}:${CONFORMANCE_PORT}`;
    const createdCandidate = await run(optimizerConformanceCreateArgs({
      name: candidateName,
      runId,
      image,
      transport: { kind: "tcp", endpoint, token, network },
      bundleDir: outDir,
      runArgv: [...OPTIMIZER_BUILD_CONTRACT.run],
      env: {
        HONE_BROKER_SOCK: endpoint,
        HONE_RUN_ID: runId,
        HONE_SEED: "0",
        HONE_RESUME: JSON.stringify({ nextEpisode: 0, incumbent: null }),
        HONE_MAX_EPISODES: "1",
      },
      containerLease: stubName,
    }, token), { timeoutMs: 30_000 });
    if (createdCandidate.timedOut || createdCandidate.exitCode !== 0) {
      throw new Error(`candidate optimizer conformance create failed: ${createdCandidate.stderr.toString("utf8").slice(0, 1_000) || `exit ${createdCandidate.exitCode}`}`);
    }

    // Re-verify immediately before execution, matching the production create gate.
    verifyOptimizerBundleSeal({ bundleDir: outDir, bundleSeal });
    const executed = await run(optimizerStartArgs(candidateName), { timeoutMs: protocolTimeoutMs });
    const stubLogs = await run(["docker", "logs", stubName], { timeoutMs: 2_000 });
    const transcript = parseTranscript(stubLogs.stdout.toString("utf8"));
    if (executed.timedOut) {
      const detail = [
        executed.stderr.toString("utf8").trim(),
        executed.stdout.toString("utf8").trim(),
        stubLogs.stderr.toString("utf8").trim(),
        stubLogs.stdout.toString("utf8").trim(),
      ].filter((part) => part.length > 0).join(" | ").slice(0, 2_000);
      throw new Error(`candidate optimizer conformance protocol timed out after ${protocolTimeoutMs}ms${detail === "" ? "" : `: ${detail}`}`);
    }
    if (transcript !== null && !transcript.ok) {
      throw new Error(`candidate optimizer conformance protocol failed: ${transcript.detail ?? "trusted stub refusal"}`);
    }
    if (executed.exitCode !== 0) {
      throw new Error(`candidate optimizer conformance runtime failed (exit ${executed.exitCode}): ${executed.stderr.toString("utf8").slice(0, 2_000)}`);
    }
    if (transcript === null || !transcript.finished) {
      throw new Error("candidate optimizer conformance ended without the required broker finish handshake");
    }
    if (canonicalJson(transcript.methods) !== canonicalJson(EXPECTED_METHODS)) {
      throw new Error(`candidate optimizer conformance used an invalid method sequence: ${canonicalJson(transcript.methods)}`);
    }

    const runtime = runtimeIdentity(image, actualDigest, bundleSeal);
    const body = {
      version: 1 as const,
      sourceArtifact: candidate.sourceArtifact,
      baseDigest: candidate.baseDigest,
      mutablePaths: candidate.mutablePaths,
      runtime,
      protocol: {
        version: "jsonrpc-2.0" as const,
        methods: EXPECTED_METHODS,
        modelEgress: false as const,
        childReservations: 0 as const,
      },
    };
    receipt = { ...body, receiptDigest: sha256(canonicalJson(body)) };
  } catch (error) {
    primaryFailure = error;
  }

  if (bundleSeal !== null) {
    try {
      chmodSync(bundleSeal.dir, 0o700);
    } catch {
      // rmSync and the cleanup failure below preserve fail-closed behavior.
    }
  }
  const cleanupFailures = (await Promise.all([
    removeDockerResource(run, ["docker", "rm", "-f", candidateName], `container ${candidateName}`),
    removeDockerResource(run, ["docker", "rm", "-f", buildName], `container ${buildName}`),
    removeDockerResource(run, ["docker", "rm", "-f", stubName], `container ${stubName}`),
  ])).filter((failure): failure is string => failure !== null);
  const networkFailure = await removeDockerResource(run, ["docker", "network", "rm", network], `network ${network}`);
  if (networkFailure !== null) cleanupFailures.push(networkFailure);
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(`temporary tree: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (primaryFailure !== null) {
    const message = primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure);
    if (cleanupFailures.length > 0) throw new Error(`${message}; conformance cleanup incomplete: ${cleanupFailures.join("; ")}`);
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) throw new Error(`candidate conformance cleanup incomplete: ${cleanupFailures.join("; ")}`);
  if (receipt === null) throw new Error("candidate conformance produced no receipt");
  return receipt;
}
