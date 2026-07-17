import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, link, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapsuleManifest, RunEvent } from "@hone/schema";
import { Broker, type BrokerConfig, type CallContext } from "../src/broker.js";
import { packDirAsArtifact } from "../src/artifact.js";
import { CasStore } from "../src/cas.js";
import { runCommand, type CmdResult, type RunCommand } from "../src/command.js";
import { BrokerError } from "../src/errors.js";
import { deferred } from "../src/deferred.js";
import { WORKSPACE_TMPFS_INODES } from "../src/broker.js";
import { MANIFEST_IMAGE, TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST, ensureImage, waitForDocker } from "./helpers.js";
import { SCRATCH_SNAPSHOT_SCRIPT } from "../src/broker.js";

/**
 * Security / authority / lifecycle hardening tests. Everything except the
 * final live-docker smoke runs against a FAKE docker CLI — the broker's
 * behavior at its trust boundaries is what is under test, not docker.
 */

const CLIENT: CallContext = { privileged: false };
const ADMIN: CallContext = { privileged: true };

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpBase = path.join(pkgDir, ".test-tmp", `authority-${randomBytes(4).toString("hex")}`);

const GENEROUS_BUDGET = { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 3_600, maxEvaluatorInvocations: 100 };

// ---------- fixtures ----------

let capsuleRootDir: string;
let baselineTar: Buffer;
let baselineHash: string;
let candidateTar: Buffer;
let candidateHash: string;
let candidate2Tar: Buffer;
let candidate2Hash: string;

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function makeManifest(over: Partial<CapsuleManifest> = {}): CapsuleManifest {
  return {
    schemaVersion: 2,
    id: "cap_0123456789ab",
    objective: "make the answer bigger",
    baseline: { kind: "cas", hash: `sha256:${"0".repeat(64)}` },
    image: MANIFEST_IMAGE,
    evalEntrypoint: [
      "sh",
      "-c",
      'S="$(cat /workspace/answer.txt 2>/dev/null || echo 0)"; printf \'{"valid":true,"objectives":{"score":%s}}\' "$S"',
    ],
    protectedPaths: [],
    diagnosticOrdering: { path: "diagnostics/ordering.json", hash: `sha256:${"e".repeat(64)}` },
    assetGroups: [
      { id: "train", visibility: "public", paths: ["train"] },
      { id: "secret", visibility: "protected", paths: ["protected"] },
      { id: "holdout", visibility: "holdout", paths: ["holdout"] },
    ],
    budget: GENEROUS_BUDGET,
    contentHashes: {
      "train/data.txt": sha256("train-data"),
      "protected/secret.txt": sha256("TOP-SECRET-FIXTURE"),
      "holdout/holdout.txt": sha256("holdout-data"),
    },
    ...over,
  };
}

// ---------- minimal ustar builder (hostile-archive fixtures) ----------

function tarHeader(
  name: string,
  size: number,
  typeflag: string,
  linkname: string,
  opts: { mode?: string; mtime?: number } = {},
): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(`${opts.mode ?? "0000755"}\0`, 100, 8, "utf8");
  h.write("0000000\0", 108, 8, "utf8");
  h.write("0000000\0", 116, 8, "utf8");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  h.write(`${(opts.mtime ?? 0).toString(8).padStart(11, "0")}\0`, 136, 12, "utf8");
  h.write("        ", 148, 8, "utf8");
  h.write(typeflag, 156, 1, "utf8");
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "utf8");
  h.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return h;
}

function makeTar(
  entries: ReadonlyArray<{ name: string; type: string; content?: string; linkname?: string; mode?: string; mtime?: number }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content ?? "");
    parts.push(
      tarHeader(e.name, e.type === "0" ? body.length : 0, e.type, e.linkname ?? "", { ...(e.mode !== undefined ? { mode: e.mode } : {}), ...(e.mtime !== undefined ? { mtime: e.mtime } : {}) }),
    );
    if (e.type === "0" && body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---------- fake docker harness ----------

interface FakeCtl {
  /** Exit code for client execs; "timeout" simulates a hung exec. */
  execExit: number | "timeout";
  /** Stdout bytes client execs produce — session-trace fixture material. */
  execStdout: Buffer;
  /** When true, client execs report output hit the size cap (truncated capture). */
  execTruncated: boolean;
  /** Tar bytes in-container `tar -c /workspace` returns for saveArtifact. */
  saveTar: Buffer;
  /** artifactHash -> EvaluatorOutput JSON for eval containers (matched via the /workspace mount). */
  evalOutputs: Map<string, unknown>;
  /** When "timeout", eval containers simulate a hang. */
  evalMode: "normal" | "timeout";
  /** When set, client execs signal entry then block until `gate` resolves (in-flight exec simulation). */
  execBarrier: { entered: () => void; gate: Promise<void> } | null;
  /** Inspection hook invoked with the eval `docker run` argv while the staged assets still exist on disk. */
  evalInspect: ((argv: readonly string[]) => Promise<void> | void) | null;
  /** When set, eval containers block until `docker rm -f <name>` reaps them (simulates the CLI dying with its container). */
  evalHangsUntilReaped: boolean;
  /** Container ids whose `docker rm -f` fails (terminal-save fail-closed simulation). */
  rmFailFor: Set<string>;
  /** Exact run-labeled container ids returned to evaluator quiescence scans. */
  quiesceContainers: string[];
  pauseFailFor: Set<string>;
  unpauseFailFor: Set<string>;
}

interface Booted {
  broker: Broker;
  events: RunEvent[];
  log: string[][];
  ctl: FakeCtl;
  runDir: string;
  casDir: string;
  runId: string;
}

const booted: Booted[] = [];

function fakeResult(over: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...over };
}

async function boot(
  opts: {
    manifest?: CapsuleManifest;
    capsuleRootDir?: string;
    runDir?: string;
    casDir?: string;
    holdoutBudget?: number;
    capsuleDigest?: string;
    optimizerDigest?: string;
    holdoutLedgerPath?: string;
    maxActiveSandboxes?: number;
    scratchQuotaBytes?: number;
    scratchVolume?: boolean;
    sessionTraceQuotaBytes?: number;
    volumeCreateFails?: boolean;
    evalTimeoutSec?: number;
    runId?: string;
    measurementEpoch?: string;
    /** M0 cap tests use one episode; other unit cases may exercise M1-sized broker mechanics. */
    probeBound?: boolean;
  } = {},
): Promise<Booted> {
  const id = randomBytes(4).toString("hex");
  const runId = opts.runId ?? `run-${id}`;
  const runDir = opts.runDir ?? path.join(tmpBase, "runs", id);
  const casDir = opts.casDir ?? path.join(tmpBase, "cas", id);
  await mkdir(runDir, { recursive: true });

  const ctl: FakeCtl = {
    execExit: 0,
    execStdout: Buffer.alloc(0),
    execTruncated: false,
    saveTar: candidateTar,
    evalOutputs: new Map(),
    evalMode: "normal",
    execBarrier: null,
    evalInspect: null,
    evalHangsUntilReaped: false,
    rmFailFor: new Set(),
    quiesceContainers: [],
    pauseFailFor: new Set(),
    unpauseFailFor: new Set(),
  };
  const log: string[][] = [];
  const events: RunEvent[] = [];
  let containerSeq = 0;

  /** Eval containers blocked awaiting their `docker rm -f` (evalHangsUntilReaped). */
  const reapGates = new Map<string, () => void>();
  const run: RunCommand = async (argv, cmdOpts) => {
    if (argv[0] !== "docker") return runCommand(argv, cmdOpts);
    log.push([...argv]);
    const sub = argv[1];
    if (sub === "ps") return fakeResult({ stdout: Buffer.from(`${ctl.quiesceContainers.join("\n")}\n`) });
    if (sub === "pause") {
      const ref = argv[2] ?? "";
      return ctl.pauseFailFor.has(ref)
        ? fakeResult({ exitCode: 1, stderr: Buffer.from(`cannot pause ${ref}`) })
        : fakeResult();
    }
    if (sub === "unpause") {
      const ref = argv[2] ?? "";
      return ctl.unpauseFailFor.has(ref)
        ? fakeResult({ exitCode: 1, stderr: Buffer.from(`cannot unpause ${ref}`) })
        : fakeResult();
    }
    if (sub === "run" && argv.includes("-d")) return fakeResult({ stdout: Buffer.from(`c_${containerSeq++}\n`) });
    if (sub === "run") {
      // eval container
      if (ctl.evalHangsUntilReaped) {
        const nameIdx = argv.indexOf("--name");
        const name = argv[nameIdx + 1] ?? "";
        // Block like a live `docker run` CLI: resolves only when close()'s
        // `docker rm -f <name>` kills the container out from under it. The
        // gate is registered BEFORE the inspect hook signals the test, so a
        // close() racing in can always find it.
        const reaped = deferred<void>();
        reapGates.set(name, reaped.resolve);
        if (ctl.evalInspect) await ctl.evalInspect(argv);
        await reaped.promise;
        return fakeResult({ exitCode: 137, stderr: Buffer.from("container removed") });
      }
      if (ctl.evalInspect) await ctl.evalInspect(argv);
      if (ctl.evalMode === "timeout") return fakeResult({ exitCode: -1, timedOut: true });
      const wsMount = argv.find((a) => a.endsWith(":/workspace:ro")) ?? "";
      let output: unknown = { valid: true, objectives: { score: 0 } };
      for (const [hash, out] of ctl.evalOutputs) {
        if (wsMount.includes(hash.replace(":", "-"))) output = out;
      }
      return fakeResult({ stdout: Buffer.from(JSON.stringify(output)) });
    }
    if (sub === "exec") {
      if (argv.includes(SCRATCH_SNAPSHOT_SCRIPT)) {
        // The in-container script only produces the per-attempt temp named
        // by the exec's HONE_SCRATCH_SNAPSHOT_OUT; the trusted HOST publishes
        // exactly it (fsync → rename → fsync dir) after the exec.
        const outEnv = argv.find((a) => a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
        const attemptName = outEnv?.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length) ?? "";
        if (attemptName.length === 0) {
          return fakeResult({ exitCode: 1, stderr: Buffer.from("HONE_SCRATCH_SNAPSHOT_OUT: parameter not set") });
        }
        await writeFile(path.join(runDir, "scratch-snapshot", attemptName), "fake-scratch-tar");
        return fakeResult();
      }
      if (argv.includes("/bin/tar") && argv.includes("-x")) return fakeResult();
      if (argv.includes("/bin/tar") && argv.includes("-c")) return fakeResult({ stdout: ctl.saveTar });
      const joined = argv.join(" ");
      if (joined.includes('echo "$(id -u):$(id -g)"')) return fakeResult({ stdout: Buffer.from("0:0\n") });
      if (argv[2] === "-u") return fakeResult(); // chown fixup
      if (ctl.execBarrier) {
        const barrier = ctl.execBarrier;
        ctl.execBarrier = null;
        barrier.entered();
        await barrier.gate;
      }
      if (ctl.execExit === "timeout") return fakeResult({ exitCode: -1, timedOut: true });
      return fakeResult({ exitCode: ctl.execExit, stdout: Buffer.from(ctl.execStdout), truncated: ctl.execTruncated });
    }
    if (sub === "volume" && argv[2] === "create") {
      return opts.volumeCreateFails === true
        ? fakeResult({ exitCode: 1, stderr: Buffer.from("volume driver does not support tmpfs") })
        : fakeResult({ stdout: Buffer.from("ok\n") });
    }
    if (sub === "rm") {
      for (const target of argv.slice(2)) {
        reapGates.get(target)?.();
        reapGates.delete(target);
        if (ctl.rmFailFor.has(target)) {
          return fakeResult({ exitCode: 1, stderr: Buffer.from(`cannot remove container ${target}: driver busy`) });
        }
      }
      return fakeResult();
    }
    return fakeResult(); // volume rm, ...
  };

  const config: BrokerConfig = {
    runId,
    manifest: opts.manifest ?? makeManifest(),
    capsuleRootDir: opts.capsuleRootDir ?? capsuleRootDir,
    baselineArtifactHash: baselineHash,
    capsuleDigest: opts.capsuleDigest ?? TEST_CAPSULE_DIGEST,
    optimizerDigest: opts.optimizerDigest ?? TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: opts.holdoutLedgerPath ?? path.join(runDir, "holdout-ledger.ndjson"),
    image: TEST_IMAGE,
    runDir,
    casDir,
    onEvent: (e) => events.push(e),
    runCommand: run,
    ...(opts.holdoutBudget !== undefined ? { holdoutBudget: opts.holdoutBudget } : {}),
    ...(opts.maxActiveSandboxes !== undefined ? { maxActiveSandboxes: opts.maxActiveSandboxes } : {}),
    ...(opts.scratchQuotaBytes !== undefined ? { scratchQuotaBytes: opts.scratchQuotaBytes } : {}),
    ...(opts.scratchVolume !== undefined ? { scratchVolume: opts.scratchVolume } : {}),
    ...(opts.sessionTraceQuotaBytes !== undefined ? { sessionTraceQuotaBytes: opts.sessionTraceQuotaBytes } : {}),
    ...(opts.evalTimeoutSec !== undefined ? { evalTimeoutSec: opts.evalTimeoutSec } : {}),
    ...(opts.measurementEpoch !== undefined ? { measurementEpoch: opts.measurementEpoch } : {}),
    maxMutationEpisodes: opts.probeBound === true ? 1 : 64,
  };
  const broker = new Broker(config);
  await broker.init();
  // Seed the (fresh) CAS with the shared fixture artifacts.
  await broker.cas.putBuffer(baselineTar);
  await broker.cas.putBuffer(candidateTar);
  await broker.cas.putBuffer(candidate2Tar);
  const b: Booted = { broker, events, log, ctl, runDir, casDir, runId };
  booted.push(b);
  return b;
}

/** Full happy-path episode: sandbox from `parent`, exec 0, save `tar` → candidate hash. */
async function saveCandidate(b: Booted, tar: Buffer, parent: string = baselineHash): Promise<string> {
  b.ctl.execExit = 0;
  b.ctl.saveTar = tar;
  const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: parent }, role: "mutation" }, CLIENT);
  await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
  const ref = await b.broker.saveArtifact({ sandboxId }, CLIENT);
  return ref.hash;
}

function score(n: number): unknown {
  return { valid: true, objectives: { score: n } };
}

async function stateLines(b: Booted): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path.join(b.runDir, "broker-state.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
  await mkdir(tmpBase, { recursive: true });
  // Capsule root with one fixture per visibility class.
  capsuleRootDir = path.join(tmpBase, "capsule");
  for (const [rel, content] of Object.entries({
    "train/data.txt": "train-data",
    "protected/secret.txt": "TOP-SECRET-FIXTURE",
    "holdout/holdout.txt": "holdout-data",
  })) {
    const p = path.join(capsuleRootDir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  // Fixture artifacts (real tars via the tar CLI so validation passes).
  const scratchCas = new CasStore(path.join(tmpBase, "cas", "fixtures"));
  const mk = async (answer: string): Promise<[Buffer, string]> => {
    const dir = path.join(tmpBase, `tree-${answer}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "answer.txt"), answer);
    const hash = await packDirAsArtifact(dir, scratchCas);
    return [await scratchCas.readBuffer(hash), hash];
  };
  [baselineTar, baselineHash] = await mk("1");
  [candidateTar, candidateHash] = await mk("2");
  [candidate2Tar, candidate2Hash] = await mk("3");
});

afterEach(async () => {
  for (const b of booted.splice(0)) await b.broker.close();
});

afterAll(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ---------- durable run state ----------

describe("durable run state (resume cannot reset authority or budgets)", () => {
  it("replays spend, evaluator invocations, holdout charges, and episode numbering across restarts", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "resume-a"), casDir: path.join(tmpBase, "cas", "resume-a"), runId: "run-resume-a" };
    const a = await boot({ ...shared, holdoutBudget: 1 });
    a.broker.recordSpend({ tokens: 100, usd: 5 }, ADMIN);
    a.ctl.evalOutputs.set(baselineHash, score(1));
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 0 }, ADMIN);
    await a.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT); // episode 0
    await a.broker.close();

    const b = await boot({ ...shared, holdoutBudget: 1 });
    const budget = b.broker.getBudget(ADMIN);
    expect(budget.spent.tokens).toBe(100);
    expect(budget.spent.usd).toBe(5);
    expect(budget.spent.evaluatorInvocations).toBe(2);

    // Holdout ledger is exhausted forever — a restart grants nothing back.
    await expect(
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 99 }, ADMIN),
    ).rejects.toThrow(/holdout ledger budget exhausted/);

    // Episode numbering continues; it never restarts at 0.
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const started = b.events.filter((e) => e.type === "episode.started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ episode: 1 });
  });

  it("persists a trusted proxy admission refusal and blocks retries after restart", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "resume-proxy-cap"),
      casDir: path.join(tmpBase, "cas", "resume-proxy-cap"),
      runId: "run-resume-proxy-cap",
    };
    const a = await boot(shared);
    expect(() => a.broker.recordBudgetExhaustion("tokens", CLIENT)).toThrow(/admin socket/);
    expect(a.broker.recordBudgetExhaustion("tokens", ADMIN)).toEqual({});
    expect(a.events.filter((event) => event.type === "budget.exhausted")).toHaveLength(1);
    expect(a.broker.getBudgetExhaustion(ADMIN)).toBe("tokens");
    expect(() => a.broker.getBudgetExhaustion(CLIENT)).toThrow(/admin socket/);
    expect(() => a.broker.getTask(CLIENT)).toThrow(/budget dimension exhausted: tokens/);
    await a.broker.close();

    const b = await boot(shared);
    expect(() => b.broker.getTask(CLIENT)).toThrow(/budget dimension exhausted: tokens/);
    expect(b.broker.getBudgetExhaustion(ADMIN)).toBe("tokens");
    expect(b.broker.recordBudgetExhaustion("tokens", ADMIN)).toEqual({});
    expect(b.events.filter((event) => event.type === "budget.exhausted")).toHaveLength(0);
  });

  it("replays promotion authority and the incumbent", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "resume-b"), casDir: path.join(tmpBase, "cas", "resume-b"), runId: "run-resume-b" };
    const a = await boot(shared);
    a.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(a, candidateTar);
    expect(cand).toBe(candidateHash);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(a.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toEqual({});
    expect(a.broker.trustedIncumbent).toMatchObject({ hash: cand, aggregate: 2 });
    await a.broker.close();

    const b = await boot(shared);
    expect(b.broker.trustedIncumbent).toMatchObject({ hash: cand, aggregate: 2, episode: 0 });
    // Re-report is idempotent; no new incumbent event is fabricated on resume.
    expect(b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toEqual({});
    expect(b.events.filter((e) => e.type === "incumbent.new")).toHaveLength(0);
  });

  it("serializes concurrent holdout charges — the last slot is never double-granted", async () => {
    const b = await boot({ holdoutBudget: 1 });
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: i }, ADMIN),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(BrokerError);
        expect(String(r.reason)).toMatch(/holdout ledger budget exhausted/);
      }
    }
    const holdoutLines = (await stateLines(b)).filter((l) => l["t"] === "holdout");
    expect(holdoutLines.map((line) => ({ t: line["t"], seq: line["seq"] }))).toEqual([{ t: "holdout", seq: 1 }]);
  });

  it("a new run against the same ledger path continues the lifetime holdout count — it never resets", async () => {
    const ledgerPath = path.join(tmpBase, "ledgers", "persist.ndjson");
    const a = await boot({ holdoutBudget: 1, holdoutLedgerPath: ledgerPath });
    a.ctl.evalOutputs.set(baselineHash, score(1));
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 0 }, ADMIN);
    await a.broker.close();

    // Fresh run: new runDir, new journal, new casDir — SAME ledger path.
    const b = await boot({ holdoutBudget: 1, holdoutLedgerPath: ledgerPath });
    b.ctl.evalOutputs.set(baselineHash, score(1));
    await expect(
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 1 }, ADMIN),
    ).rejects.toThrow(/holdout ledger budget exhausted/);
    // The denied access left no per-run journal record and no event.
    expect((await stateLines(b)).filter((l) => l["t"] === "holdout")).toHaveLength(0);
    expect(b.events.filter((e) => e.type === "holdout.accessed")).toHaveLength(0);
  });

  it("two live broker instances on one ledger path cannot double-grant the last slot", async () => {
    const ledgerPath = path.join(tmpBase, "ledgers", "two-instance.ndjson");
    const a = await boot({ holdoutBudget: 1, holdoutLedgerPath: ledgerPath });
    const b = await boot({ holdoutBudget: 1, holdoutLedgerPath: ledgerPath });
    a.ctl.evalOutputs.set(baselineHash, score(1));
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const results = await Promise.allSettled([
      a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 0 }, ADMIN),
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 1 }, ADMIN),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected");
    expect(loser).toBeDefined();
    if (loser?.status === "rejected") {
      expect(loser.reason).toBeInstanceOf(BrokerError);
      expect(String(loser.reason)).toMatch(/holdout ledger budget exhausted/);
    }
  });

  it("truncates a torn partial-JSON tail on open and never fuses new records onto it", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "resume-torn"), casDir: path.join(tmpBase, "cas", "resume-torn"), runId: "run-resume-torn" };
    const a = await boot(shared);
    a.broker.recordSpend({ tokens: 100, usd: 5 }, ADMIN);
    a.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    a.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT);
    await a.broker.close();

    // Simulate a torn crash-write: append a partial JSON record with NO newline.
    const stateFile = path.join(shared.runDir, "broker-state.ndjson");
    await appendFile(stateFile, '{"t":"spend","tokens":424242');

    // Two append/restart cycles: prior authority must survive, the torn tail
    // must be gone from disk, and nothing may fuse onto it.
    let prev = a;
    for (let cycle = 0; cycle < 2; cycle++) {
      const b = await boot(shared);
      expect(b.broker.getBudget(ADMIN).spent).toMatchObject({ tokens: 100 + cycle, usd: 5 });
      expect(b.broker.trustedIncumbent).toMatchObject({ hash: cand, aggregate: 2, episode: 0 });
      b.broker.recordSpend({ tokens: 1, usd: 0 }, ADMIN); // append after recovery
      await b.broker.close();
      prev = b;
    }
    const raw = await readFile(stateFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("424242"); // torn fragment fully gone, not fused
    for (const line of raw.split("\n").filter((l) => l.length > 0)) JSON.parse(line); // every interior line is intact JSON
    const spends = (await stateLines(prev)).filter((l) => l["t"] === "spend");
    expect(spends.map((line) => ({
      t: line["t"],
      tokens: line["tokens"],
      usd: line["usd"],
    }))).toEqual([
      { t: "spend", tokens: 100, usd: 5 },
      { t: "spend", tokens: 1, usd: 0 },
      { t: "spend", tokens: 1, usd: 0 },
    ]);
  });

  it("discards a complete-JSON tail that lacks its newline (unacknowledged write) without fusing", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "resume-nonl"), casDir: path.join(tmpBase, "cas", "resume-nonl"), runId: "run-resume-nonl" };
    const a = await boot(shared);
    a.broker.recordSpend({ tokens: 7, usd: 1 }, ADMIN);
    await a.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT); // episode 0
    await a.broker.close();

    // Complete JSON but missing the terminating newline: the fsync barrier
    // means its action was never acknowledged — it must NOT replay, and a
    // later append must not fuse onto it ({...}{...} on one line).
    const stateFile = path.join(shared.runDir, "broker-state.ndjson");
    await appendFile(stateFile, '{"t":"spend","tokens":999999,"usd":99}');

    for (let cycle = 0; cycle < 2; cycle++) {
      const b = await boot(shared);
      const budget = b.broker.getBudget(ADMIN);
      expect(budget.spent.tokens).toBe(7 + cycle); // 999999 never replays, even after re-append
      expect(budget.spent.usd).toBe(1);
      b.broker.recordSpend({ tokens: 1, usd: 0 }, ADMIN);
      // Episode numbering also survives: next episode continues, never resets.
      await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
      const started = b.events.filter((e) => e.type === "episode.started");
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ episode: 1 + cycle });
      await b.broker.close();
    }
    const raw = await readFile(stateFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).not.toContain("999999");
    for (const line of raw.split("\n").filter((l) => l.length > 0)) JSON.parse(line);
  });
});

describe("run-scoped derived cache recovery", () => {
  it("removes SIGKILL-stranded canonicalization, asset-stage, unpack, and snapshot attempts at init", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "derived-recovery"),
      casDir: path.join(tmpBase, "cas", "derived-recovery"),
      runId: "run-derived-recovery",
    };
    const stale = [
      path.join(shared.runDir, "tmp", "hone-canon-dead", "tree", "workspace"),
      path.join(shared.runDir, "tmp", "assets-dead"),
      path.join(shared.runDir, "unpacked", "sha256-dead.tmp-orphan", "workspace"),
      path.join(shared.runDir, "unpacked", "sha256-partial", "workspace"),
    ];
    const snapshotDir = path.join(shared.runDir, "scratch-snapshot");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, "scratch.tar"), "durable");
    await writeFile(path.join(snapshotDir, "scratch.tar.tmp.dead"), "stranded");
    for (const dir of stale) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "partial"), "stranded");
    }

    const b = await boot(shared);
    expect(await readdir(path.join(shared.runDir, "tmp"))).toEqual([]);
    expect(await readdir(path.join(shared.runDir, "unpacked"))).toEqual([]);
    expect(await readdir(snapshotDir)).toEqual(["scratch.tar"]);
    await b.broker.close();
  });
});

// ---------- promotion authority ----------

describe("promotion authority (reportIncumbent is only a hint)", () => {
  it("rejects artifacts that are not saved candidates of this run", async () => {
    const b = await boot();
    expect(() => b.broker.reportIncumbent({ artifact: { hash: baselineHash }, claimed: { score: 9000 } }, CLIENT)).toThrow(
      /not a saved candidate/,
    );
  });

  it("a failed constraint disqualifies the evaluation from granting any authority", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1));
    b.ctl.evalOutputs.set(candidateHash, { valid: true, objectives: { score: 5 }, constraints: { compiles: false } });
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toThrow(/no trusted evaluation/);
  });

  it("rejects when candidate and parent were never measured at the same group+seed", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 2 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 1 }, CLIENT);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toThrow(/insufficient authority/);
  });

  it("rejects a non-positive paired delta vs the parent, ignoring claimed metrics", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(2)).set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: cand }, claimed: { score: 9000 } }, CLIENT)).toThrow(
      /no positive trusted delta/,
    );
  });

  it("rejects every later candidate before evaluator spawn once the M0 promotion slot is consumed", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(3)).set(candidate2Hash, score(9));

    const candA = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: candA } }, CLIENT)).toEqual({});

    const candB = await saveCandidate(b, candidate2Tar);
    const evaluatorRuns = b.log.filter((argv) => argv[1] === "run" && !argv.includes("-d")).length;
    await expect(
      b.broker.evaluate({ artifact: { hash: candB }, assetGroupId: "train", seed: 1 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
    expect(b.log.filter((argv) => argv[1] === "run" && !argv.includes("-d"))).toHaveLength(evaluatorRuns);
    expect(b.broker.trustedIncumbent).toMatchObject({ hash: candA });
  });

  it("holdout evaluations never grant promotion authority nor appear in events", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 0 }, ADMIN);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "holdout", seed: 0 }, ADMIN);
    expect(b.events.filter((e) => e.type === "eval.completed")).toHaveLength(0);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toThrow(/no trusted evaluation/);
  });
});

// ---------- cross-epoch gate monotonicity ----------


// ---------- irreversible first-pair gate authority ----------


// ---------- trusted probe episode cap ----------

describe("trusted M0 probe episode cap", () => {
  it("admits one new episode, refuses a hostile second create before Docker, and still permits repair resume", async () => {
    const b = await boot({ probeBound: true });
    const sb0 = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const dockerRunsBefore = b.log.filter((argv) => argv[1] === "run" && argv.includes("-d")).length;
    await expect(
      b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT),
    ).rejects.toThrow(/mutation episode cap reached/);
    expect(b.log.filter((argv) => argv[1] === "run" && argv.includes("-d")).length).toBe(dockerRunsBefore);
    expect(b.events.filter((e) => e.type === "episode.started")).toHaveLength(1);
    b.ctl.execExit = 7;
    await b.broker.exec({ sandboxId: sb0.sandboxId, argv: ["false"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    const repair = await b.broker.saveArtifact({ sandboxId: sb0.sandboxId }, CLIENT);
    b.ctl.execExit = 0;
    const resumed = await b.broker.createSandbox({ artifact: { hash: repair.hash }, role: "mutation" }, CLIENT);
    expect(resumed.sandboxId).toBeTruthy();
    expect(b.events.filter((e) => e.type === "episode.started")).toHaveLength(1);
    await expect(
      b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT),
    ).rejects.toThrow(/mutation episode cap reached/);
  });
  it("keeps the one-episode cap consumed across crash/replay", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "probe-cap-resume"),
      casDir: path.join(tmpBase, "cas", "probe-cap-resume"),
      runId: "run-probe-cap-resume",
    };
    const a = await boot({ ...shared, probeBound: true });
    await a.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await a.broker.close();
    const resumed = await boot({ ...shared, probeBound: true });
    const runsBefore = resumed.log.filter((argv) => argv[1] === "run" && argv.includes("-d")).length;
    await expect(
      resumed.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT),
    ).rejects.toThrow(/mutation episode cap reached/);
    expect(resumed.log.filter((argv) => argv[1] === "run" && argv.includes("-d")).length).toBe(runsBefore);
  });
});

// ---------- M0 promotion slot (cross-artifact evaluator cache channel) ----------

describe("M0 one-shot candidate evaluation authority", () => {
  it("rejects public repairs and arbitrary CAS without consuming the attempt; privileged measurement remains available", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2)).set(candidate2Hash, score(3));
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    b.ctl.execExit = 7;
    await b.broker.exec({ sandboxId, argv: ["false"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    const repair = await b.broker.saveArtifact({ sandboxId }, CLIENT);
    const spawnsBefore = b.log.filter((argv) => argv[1] === "run" && argv.includes("--rm")).length;
    await expect(
      b.broker.evaluate({ artifact: { hash: repair.hash }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow(/neither the baseline nor a saved candidate/);
    await expect(
      b.broker.evaluate({ artifact: { hash: candidate2Hash }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow(/neither the baseline nor a saved candidate/);
    expect(b.log.filter((argv) => argv[1] === "run" && argv.includes("--rm")).length).toBe(spawnsBefore);
    await expect(
      b.broker.evaluate({ artifact: { hash: candidate2Hash }, assetGroupId: "train", seed: 0 }, ADMIN),
    ).resolves.toMatchObject({ artifactHash: candidate2Hash });
    b.ctl.execExit = 0;
    const resumed = await b.broker.createSandbox({ artifact: { hash: repair.hash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId: resumed.sandboxId, argv: ["true"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    const cand = await b.broker.saveArtifact({ sandboxId: resumed.sandboxId }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 1 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: cand.hash }, assetGroupId: "train", seed: 1 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: cand.hash } }, CLIENT)).toEqual({});
  });
  it("an invalid first candidate permanently blocks its retry and every distinct candidate, live and replayed", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "slot-consume"),
      casDir: path.join(tmpBase, "cas", "slot-consume"),
      runId: "run-slot-consume",
    };
    const a = await boot(shared);
    a.ctl.evalOutputs.set(candidateHash, { valid: false, objectives: {} }).set(candidate2Hash, score(9));
    const cprobe = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: cprobe }, assetGroupId: "train", seed: 0 }, CLIENT);
    const cpromote = await saveCandidate(a, candidate2Tar);
    const spawns = a.log.filter((argv) => argv[1] === "run" && argv.includes("--rm")).length;
    await expect(
      a.broker.evaluate({ artifact: { hash: cpromote }, assetGroupId: "train", seed: 1 }, CLIENT),
    ).rejects.toThrow(/attempt already consumed/);
    await expect(
      a.broker.evaluate({ artifact: { hash: cprobe }, assetGroupId: "train", seed: 1 }, CLIENT),
    ).rejects.toThrow(/attempt already consumed/);
    expect(a.log.filter((argv) => argv[1] === "run" && argv.includes("--rm")).length).toBe(spawns);
    expect(() => a.broker.reportIncumbent({ artifact: { hash: cprobe } }, CLIENT)).toThrow(/no trusted evaluation/);
    await a.broker.close();
    const b = await boot(shared);
    await expect(
      b.broker.evaluate({ artifact: { hash: cprobe }, assetGroupId: "train", seed: 2 }, CLIENT),
    ).rejects.toThrow(/attempt already consumed/);
    await expect(
      b.broker.evaluate({ artifact: { hash: cpromote }, assetGroupId: "train", seed: 2 }, CLIENT),
    ).rejects.toThrow(/attempt already consumed/);
  });
  it("journals the attempt before a timed-out spawn and never permits a retry after replay", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "slot-wal"),
      casDir: path.join(tmpBase, "cas", "slot-wal"),
      runId: "run-slot-wal",
    };
    const a = await boot(shared);
    const cand = await saveCandidate(a, candidateTar);
    a.ctl.evalMode = "timeout";
    await expect(
      a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow();
    expect((await stateLines(a)).filter((l) => l["t"] === "slot")).toEqual([{ t: "slot", hash: cand }]);
    await a.broker.close();
    const b = await boot(shared);
    await expect(
      b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 1 }, CLIENT),
    ).rejects.toThrow(/attempt already consumed/);
  });
  it("serializes racing candidate admissions so exactly one evaluator can start", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2)).set(candidate2Hash, score(3));
    const a = await saveCandidate(b, candidateTar);
    const c = await saveCandidate(b, candidate2Tar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    const outcomes = await Promise.allSettled([
      b.broker.evaluate({ artifact: { hash: a }, assetGroupId: "train", seed: 0 }, CLIENT),
      b.broker.evaluate({ artifact: { hash: c }, assetGroupId: "train", seed: 0 }, CLIENT),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect((await stateLines(b)).filter((l) => l["t"] === "slot")).toEqual([{ t: "slot", hash: a }]);
  });
  it("rejects duplicate or contradictory persisted attempt facts", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "slot-forged"),
      casDir: path.join(tmpBase, "cas", "slot-forged"),
      runId: "run-slot-forged",
    };
    const a = await boot(shared);
    const cand = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.close();
    await appendFile(path.join(a.runDir, "broker-state.ndjson"), `${JSON.stringify({ t: "slot", hash: cand })}\n`);
    await expect(boot(shared)).rejects.toThrow(/duplicate promotion slot/);
  });
});

// ---------- event derivation ----------

describe("trusted event ordering and candidacy", () => {
  it("pre-episode parent evidence cannot rescue a child-first one-shot candidate", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2)).set(candidate2Hash, score(3));
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.events.filter((e) => e.type === "eval.completed")).toHaveLength(0);

    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.events.filter((e) => e.type === "gate.paired")).toHaveLength(0);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toThrow(/insufficient authority/);

    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 1 }, CLIENT);
    await expect(
      b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 1 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);

    const cand2 = await saveCandidate(b, candidate2Tar);
    await expect(
      b.broker.evaluate({ artifact: { hash: cand2 }, assetGroupId: "train", seed: 2 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
  });

  it("failed-exec snapshots are repairs, not candidates; a follow-up sandbox reuses the episode", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidate2Hash, score(2));

    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    b.ctl.execExit = 7;
    await b.broker.exec({ sandboxId, argv: ["false"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    const snap = await b.broker.saveArtifact({ sandboxId }, CLIENT);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(0);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: snap.hash } }, CLIENT)).toThrow(/not a saved candidate/);

    // Resume the SAME episode from the repair snapshot.
    const second = await b.broker.createSandbox({ artifact: { hash: snap.hash }, role: "mutation" }, CLIENT);
    expect(b.events.filter((e) => e.type === "episode.started")).toHaveLength(1); // no second episode
    b.ctl.execExit = 0;
    b.ctl.saveTar = candidate2Tar;
    await b.broker.exec({ sandboxId: second.sandboxId, argv: ["true"] }, CLIENT);
    const fixed = await b.broker.saveArtifact({ sandboxId: second.sandboxId }, CLIENT);

    const candidates = b.events.filter((e) => e.type === "episode.candidate");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ episode: 0, candidate: { hash: fixed.hash } });

    // Lineage points at the ORIGINAL parent (baseline), so pairing works.
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: fixed.hash }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: fixed.hash } }, CLIENT)).toEqual({});
    expect(b.broker.trustedIncumbent).toMatchObject({ hash: fixed.hash, episode: 0 });
  });

  it("a graduated repair is a candidate, not a repair — later sandboxes from it start a NEW episode", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "graduate"), casDir: path.join(tmpBase, "cas", "graduate"), runId: "run-graduate" };
    const b = await boot(shared);
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT); // ep 0
    b.ctl.execExit = 7;
    await b.broker.exec({ sandboxId, argv: ["false"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    await b.broker.saveArtifact({ sandboxId }, CLIENT); // repair snapshot of candidateTar

    // Follow-up sandbox from the repair: same episode; a SUCCESSFUL save of
    // the SAME hash graduates it to candidate.
    const second = await b.broker.createSandbox({ artifact: { hash: candidateHash }, role: "mutation" }, CLIENT);
    b.ctl.execExit = 0;
    await b.broker.exec({ sandboxId: second.sandboxId, argv: ["true"] }, CLIENT);
    const graduated = await b.broker.saveArtifact({ sandboxId: second.sandboxId }, CLIENT);
    expect(graduated.hash).toBe(candidateHash);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(1);

    // Sandboxes from the graduated candidate must NOT reuse the stale repair
    // episode/parent: a fresh episode starts with the candidate as parent.
    await b.broker.createSandbox({ artifact: { hash: candidateHash }, role: "mutation" }, CLIENT);
    const started = b.events.filter((e) => e.type === "episode.started");
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({ episode: 1, parent: { hash: candidateHash } });

    // And the graduation survives a restart (lineage line is the tombstone).
    await b.broker.close();
    const c = await boot(shared);
    await c.broker.createSandbox({ artifact: { hash: candidateHash }, role: "mutation" }, CLIENT);
    const restarted = c.events.filter((e) => e.type === "episode.started");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]).toMatchObject({ episode: 2, parent: { hash: candidateHash } });
  });

  it("deltaVsBaseline is the paired mean and later artifacts cannot enter the evaluator", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(3)).set(candidate2Hash, score(4));

    const candA = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: candA } }, CLIENT)).toEqual({});
    expect(b.events.filter((e) => e.type === "incumbent.new")[0]).toMatchObject({ deltaVsBaseline: 2 });

    const candB = await saveCandidate(b, candidate2Tar, candA);
    await expect(
      b.broker.evaluate({ artifact: { hash: candB }, assetGroupId: "train", seed: 5 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
    expect(b.events.filter((e) => e.type === "incumbent.new")).toHaveLength(1);
  });

  it("replayIncumbentEvents restores journal-ahead promotions exactly once after a crash", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "recover"), casDir: path.join(tmpBase, "cas", "recover"), runId: "run-recover" };
    const a = await boot(shared);
    a.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    a.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT);
    const original = a.events.filter((e) => e.type === "incumbent.new");
    expect(original).toHaveLength(1);
    await a.broker.close();

    // Crash window: the journal has the promotion, the runner's event log
    // does not (alreadyLogged = 0). Recovery re-emits the ORIGINAL payload.
    const b = await boot(shared);
    expect(b.broker.replayIncumbentEvents(0)).toBe(1);
    const recovered = b.events.filter((e) => e.type === "incumbent.new");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ artifact: { hash: cand }, aggregate: 2, deltaVsBaseline: 1, episode: 0 });

    // Aligned logs recover nothing — exactly once.
    expect(b.broker.replayIncumbentEvents(1)).toBe(0);
    expect(b.events.filter((e) => e.type === "incumbent.new")).toHaveLength(1);
    // A count beyond the journal is a corrupt event log — refuse.
    expect(() => b.broker.replayIncumbentEvents(2)).toThrow(/journal has 1/);

    // Fresh run: nothing to recover.
    const fresh = await boot({});
    expect(fresh.broker.replayIncumbentEvents(0)).toBe(0);
  });
  it("replays the complete broker event journal as an exact suffix and rejects interior gaps", async () => {
    const shared = {
      runDir: path.join(tmpBase, "runs", "recover-all"),
      casDir: path.join(tmpBase, "cas", "recover-all"),
      runId: "run-recover-all",
    };
    const a = await boot(shared);
    a.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    a.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 0 }, ADMIN);
    a.broker.recordSpend({ tokens: a.broker.manifest.budget.maxTokens, usd: 0 }, ADMIN);
    const published = [...a.events];
    expect(published.map((event) => event.type)).toEqual(expect.arrayContaining([
      "episode.started",
      "episode.candidate",
      "eval.completed",
      "gate.paired",
      "incumbent.new",
      "holdout.accessed",
      "budget.snapshot",
      "budget.exhausted",
    ]));
    await a.broker.close();

    const b = await boot(shared);
    expect(b.broker.replayJournalEvents(published)).toBe(0);
    const prefix = published.slice(0, -3);
    expect(b.broker.replayJournalEvents(prefix)).toBe(3);
    expect(b.events).toEqual(published.slice(-3));
    expect(b.broker.replayJournalEvents(published)).toBe(0);

    const gapAt = published.findIndex((event) => event.type === "episode.candidate");
    expect(gapAt).toBeGreaterThanOrEqual(0);
    const withGap = published.filter((_event, index) => index !== gapAt);
    const c = await boot(shared);
    expect(() => c.broker.replayJournalEvents(withGap)).toThrow(/non-prefix gap/);
  });
});

describe("session-trace provenance (episode.candidate always dereferences)", () => {
  it("sessionTrace round-trips the exact exec stdout bytes through CAS", async () => {
    const b = await boot();
    // Includes NUL and invalid-UTF8 bytes: exactness means BYTES, not text.
    const bytes = Buffer.from([0x74, 0x72, 0x61, 0x63, 0x65, 0x00, 0xff, 0xfe, 0x0a, 0x80]);
    b.ctl.execStdout = bytes;
    b.ctl.saveTar = candidateTar;
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    await b.broker.saveArtifact({ sandboxId }, CLIENT);

    const cand = b.events.find(
      (e): e is Extract<RunEvent, { type: "episode.candidate" }> => e.type === "episode.candidate",
    );
    expect(cand).toBeDefined();
    const trace = cand?.sessionTrace ?? "";
    expect(trace).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The hash dereferences, and the blob is byte-identical to the stdout.
    expect(await b.broker.cas.has(trace)).toBe(true);
    expect((await b.broker.cas.readBuffer(trace)).equals(bytes)).toBe(true);
  });

  it("enforces one durable per-run quota across distinct candidate traces", async () => {
    const b = await boot({ sessionTraceQuotaBytes: 15 });
    b.ctl.execStdout = Buffer.from("1234567890");
    b.ctl.saveTar = candidateTar;
    const first = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId: first.sandboxId, argv: ["true"] }, CLIENT);
    await b.broker.saveArtifact({ sandboxId: first.sandboxId }, CLIENT);
    await b.broker.close();
    const resumed = await boot({
      runId: b.runId,
      runDir: b.runDir,
      casDir: b.casDir,
      sessionTraceQuotaBytes: 15,
    });
    resumed.ctl.execStdout = Buffer.from("abcdefghij");
    resumed.ctl.saveTar = candidate2Tar;
    const second = await resumed.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await resumed.broker.exec({ sandboxId: second.sandboxId, argv: ["true"] }, CLIENT);
    await expect(resumed.broker.saveArtifact({ sandboxId: second.sandboxId }, CLIENT)).rejects.toThrow(/session trace quota/);
    expect(b.events.filter((event) => event.type === "episode.candidate")).toHaveLength(1);
    expect(resumed.events.filter((event) => event.type === "episode.candidate")).toHaveLength(0);
  });

  it("serializes saveArtifact behind an in-flight exec on the same sandbox", async () => {
    const b = await boot();
    b.ctl.execStdout = Buffer.from("prior success\n");
    b.ctl.saveTar = candidateTar;
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);

    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    b.ctl.execBarrier = { entered, gate };
    b.ctl.execStdout = Buffer.from("current success\n");
    const inflight = b.broker.exec({ sandboxId, argv: ["sh", "-c", "mutate"] }, CLIENT);
    await enteredP;

    let saveSettled = false;
    const saving = b.broker.saveArtifact({ sandboxId }, CLIENT).finally(() => {
      saveSettled = true;
    });
    expect(saveSettled).toBe(false);
    expect(b.log.some((argv) => argv.includes("-c") && argv.includes("/bin/tar"))).toBe(false);

    release();
    await inflight;
    const saved = await saving;
    expect(saved.hash).toBe(candidateHash);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(1);
  });

  it("a zero-exit exec with a TRUNCATED capture cannot mint a candidate — the save is a repair snapshot", async () => {
    const b = await boot();
    b.ctl.execStdout = Buffer.from("capped partial output");
    b.ctl.execTruncated = true;
    b.ctl.saveTar = candidateTar;
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const res = await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    expect(res.exitCode).toBe(0);
    expect(res.truncated).toBe(true);

    const saved = await b.broker.saveArtifact({ sandboxId }, CLIENT);
    expect(saved.hash).toBe(candidateHash);
    // An incomplete trace can never be cited as candidate provenance.
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(0);
    const lines = await stateLines(b);
    expect(lines.filter((l) => l["t"] === "lineage")).toHaveLength(0);
    expect(lines.filter((l) => l["t"] === "repair")).toHaveLength(1);

    // A follow-up COMPLETE exec on a fresh sandbox from the snapshot still
    // graduates normally — the capped bytes stay in CAS as diagnostics only.
    b.ctl.execTruncated = false;
    const second = await b.broker.createSandbox({ artifact: { hash: saved.hash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId: second.sandboxId, argv: ["true"] }, CLIENT);
    const graduated = await b.broker.saveArtifact({ sandboxId: second.sandboxId }, CLIENT);
    expect(graduated.hash).toBe(candidateHash);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(1);
  });
});

describe("evaluation memo provenance (digests key the cache)", () => {
  it("distinct capsule or optimizer digests never alias onto a cached evaluation", async () => {
    const casDir = path.join(tmpBase, "cas", "memo-digests");
    const evalRuns = (b: Booted): number => b.log.filter((argv) => argv[1] === "run" && !argv.includes("-d")).length;
    const coord = { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 } as const;

    const a = await boot({ casDir });
    a.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await a.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(a)).toBe(1);
    // Same digests, same coordinate: memo hit, no second container.
    expect((await a.broker.evaluate(coord, CLIENT)).cached).toBe(true);
    expect(evalRuns(a)).toBe(1);

    // Different CAPSULE digest, same CAS: miss — a real evaluation runs.
    const c = await boot({ casDir, capsuleDigest: `sha256:${"1".repeat(64)}` });
    c.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await c.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(c)).toBe(1);

    // Different OPTIMIZER digest, same CAS: miss — a real evaluation runs.
    const o = await boot({ casDir, optimizerDigest: `sha256:${"2".repeat(64)}` });
    o.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await o.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(o)).toBe(1);

    // A fresh broker — even with the ORIGINAL digests — never reuses another
    // boot's memo: the per-boot generation in the key forces a fresh
    // comparator after any kill/resume.
    const d = await boot({ casDir });
    d.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await d.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(d)).toBe(1);
    // Within that same boot the retry memoizes.
    expect((await d.broker.evaluate(coord, CLIENT)).cached).toBe(true);
    expect(evalRuns(d)).toBe(1);
  });

  it("a different effective evaluator wall-time cap never aliases onto a cached evaluation; same boot + cap still hits", async () => {
    const casDir = path.join(tmpBase, "cas", "memo-wallcap");
    const evalRuns = (b: Booted): number => b.log.filter((argv) => argv[1] === "run" && !argv.includes("-d")).length;
    const coord = { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 7 } as const;

    // Same artifact/capsuleDigest/optimizerDigest/group/seed throughout —
    // only the evaluator wall-time cap (docker timeout) differs.
    const a = await boot({ casDir, evalTimeoutSec: 600 });
    a.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await a.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(a)).toBe(1);
    // Same boot, same cap: the retry is served from the memo.
    expect((await a.broker.evaluate(coord, CLIENT)).cached).toBe(true);
    expect(evalRuns(a)).toBe(1);

    // Different cap, same CAS + identical digests/coordinate: miss — a real
    // evaluation runs (a result measured under 600s must not answer a 30s run).
    const tight = await boot({ casDir, evalTimeoutSec: 30 });
    tight.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await tight.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(tight)).toBe(1);

    // A fresh broker with the SAME cap is a NEW boot generation: it must
    // re-measure rather than reuse an hours-old pre-kill comparator.
    const same = await boot({ casDir, evalTimeoutSec: 600 });
    same.ctl.evalOutputs.set(baselineHash, score(1));
    expect((await same.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(same)).toBe(1);
  });
  it("keys trusted M1 measurement epochs through memo, in-flight, cache namespace, and journal replay identities", async () => {
    const casDir = path.join(tmpBase, "cas", "measurement-epoch");
    const evalRuns = (b: Booted): number => b.log.filter((argv) => argv[1] === "run" && !argv.includes("-d")).length;
    const coord = { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 23 };
    const epochA = "m1-official-2026-07:candidate-a:train:0";
    const epochB = "m1-official-2026-07:candidate-a:train:1";

    const a = await boot({ casDir, measurementEpoch: epochA });
    a.ctl.evalOutputs.set(baselineHash, score(1));
    const indexA = vi.spyOn(a.broker.cas, "indexGet");
    expect((await a.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect((await a.broker.evaluate(coord, CLIENT)).cached).toBe(true);
    expect(evalRuns(a)).toBe(1);
    const namespaceA = `eval-${createHash("sha256").update(epochA).digest("hex")}`;
    expect(indexA.mock.calls[0]?.[0]).toBe(namespaceA);
    expect(indexA.mock.calls[0]?.[1]).toContain(`|measurementEpoch:${encodeURIComponent(epochA)}`);

    const b = await boot({ casDir, measurementEpoch: epochB });
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const indexB = vi.spyOn(b.broker.cas, "indexGet");
    expect((await b.broker.evaluate(coord, CLIENT)).cached).toBe(false);
    expect(evalRuns(b)).toBe(1);
    expect(indexB.mock.calls[0]?.[0]).toBe(`eval-${createHash("sha256").update(epochB).digest("hex")}`);
    expect(indexB.mock.calls[0]?.[0]).not.toBe(namespaceA);

    const journal = await readFile(path.join(a.runDir, "broker-state.ndjson"), "utf8");
    expect(journal).toContain(`"measurementEpoch":"${epochA}"`);
    await a.broker.close();
    const replayed = await boot({
      casDir,
      runDir: a.runDir,
      runId: a.runId,
      measurementEpoch: epochA,
    });
    await replayed.broker.close();
    await expect(
      boot({
        casDir,
        runDir: a.runDir,
        runId: a.runId,
        measurementEpoch: epochB,
      }),
    ).rejects.toThrow(/measurementEpoch does not match trusted broker configuration/);
  });

  it("deduplicates same-epoch in-flight requests, ignores sandbox epoch fields, and separates cross-epoch evaluators", async () => {
    const coord = { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 24 };
    const same = await boot({ measurementEpoch: "m1:same-inflight" });
    same.ctl.evalOutputs.set(baselineHash, score(1));
    const started = deferred<void>();
    const release = deferred<void>();
    same.ctl.evalInspect = async () => {
      started.resolve();
      await release.promise;
    };
    const firstParams = { ...coord, measurementEpoch: "sandbox-chosen-a" };
    const secondParams = { ...coord, measurementEpoch: "sandbox-chosen-b" };
    const first = same.broker.evaluate(firstParams, CLIENT);
    await started.promise;
    const second = same.broker.evaluate(secondParams, CLIENT);
    release.resolve();
    await Promise.all([first, second]);
    expect(same.log.filter((argv) => argv[1] === "run" && !argv.includes("-d"))).toHaveLength(1);

    const sharedCas = path.join(tmpBase, "cas", "cross-epoch-inflight");
    const epochA = await boot({ casDir: sharedCas, measurementEpoch: "m1:cross-a" });
    const epochB = await boot({ casDir: sharedCas, measurementEpoch: "m1:cross-b" });
    epochA.ctl.evalOutputs.set(baselineHash, score(1));
    epochB.ctl.evalOutputs.set(baselineHash, score(1));
    await Promise.all([
      epochA.broker.evaluate({ ...coord, seed: 25 }, CLIENT),
      epochB.broker.evaluate({ ...coord, seed: 25 }, CLIENT),
    ]);
    expect(epochA.log.filter((argv) => argv[1] === "run" && !argv.includes("-d"))).toHaveLength(1);
    expect(epochB.log.filter((argv) => argv[1] === "run" && !argv.includes("-d"))).toHaveLength(1);
  });

  it("preserves the exact M0 memo key and eval namespace when measurementEpoch is omitted", async () => {
    const broker = await boot();
    broker.ctl.evalOutputs.set(baselineHash, score(1));
    const lookup = vi.spyOn(broker.broker.cas, "indexGet");
    await broker.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 26 }, CLIENT);
    expect(lookup.mock.calls[0]?.[0]).toBe("eval");
    expect(lookup.mock.calls[0]?.[1]).toMatch(
      new RegExp(
        `^run:${broker.runId}\\|gen:[^|]+\\|${baselineHash}\\|${TEST_CAPSULE_DIGEST}\\|${TEST_OPTIMIZER_DIGEST}\\|train\\|26\\|wall:600$`,
      ),
    );
    expect(lookup.mock.calls[0]?.[1]).not.toContain("measurementEpoch");
    const journal = await readFile(path.join(broker.runDir, "broker-state.ndjson"), "utf8");
    expect(journal).not.toContain('"measurementEpoch"');
  });

  it("rejects empty, oversized, and control-character trusted epochs before evaluation", async () => {
    for (const measurementEpoch of ["", "x".repeat(257), `m1${String.fromCharCode(10)}evil`]) {
      await expect(boot({ measurementEpoch })).rejects.toThrow(
        /measurementEpoch must be 1-256 characters without control characters/,
      );
    }
  });
});

// ---------- result minimization ----------

describe("protected result minimization", () => {
  it("strips per-example feedback and diagnostics from protected results for unprivileged clients", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, {
      valid: true,
      objectives: { score: 1 },
      perExample: { "example-id-77": { score: 1, feedback: "SECRET per-example detail" } },
      diagnostics: { summary: "internal evaluator notes" },
    });
    const clientView = await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "secret", seed: 0 }, CLIENT);
    expect(clientView.output.perExample).toEqual({});
    expect(clientView.output.diagnostics).toBeUndefined();
    expect(clientView.output.objectives).toEqual({ score: 1 });
    expect(JSON.stringify(clientView)).not.toContain("SECRET per-example detail");
    expect(JSON.stringify(clientView)).not.toContain("example-id-77");

    // Privileged admin (memo hit) gets the full record.
    const adminView = await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "secret", seed: 0 }, ADMIN);
    expect(adminView.cached).toBe(true);
    expect(adminView.output.perExample["example-id-77"]?.feedback).toBe("SECRET per-example detail");
    expect(adminView.output.diagnostics?.summary).toBe("internal evaluator notes");
  });
  it("redacts each caller independently when protected evaluations deduplicate in flight", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, {
      valid: true,
      objectives: { score: 1 },
      perExample: { hidden: { score: 1, feedback: "SECRET" } },
      diagnostics: { summary: "admin only" },
    });
    const started = deferred<void>();
    const release = deferred<void>();
    b.ctl.evalInspect = async () => {
      started.resolve();
      await release.promise;
    };
    const admin = b.broker.evaluate(
      { artifact: { hash: baselineHash }, assetGroupId: "secret", seed: 42 },
      ADMIN,
    );
    await started.promise;
    const client = b.broker.evaluate(
      { artifact: { hash: baselineHash }, assetGroupId: "secret", seed: 42 },
      CLIENT,
    );
    release.resolve();
    const [adminView, clientView] = await Promise.all([admin, client]);
    expect(adminView.output.perExample["hidden"]?.feedback).toBe("SECRET");
    expect(clientView.output.perExample).toEqual({});
    expect(clientView.output.diagnostics).toBeUndefined();
    expect(b.log.filter((argv) => argv[1] === "run" && argv.includes("--rm"))).toHaveLength(1);
  });

  it("authorizes holdout before attaching a caller to an admin in-flight evaluation", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const started = deferred<void>();
    const release = deferred<void>();
    b.ctl.evalInspect = async () => {
      started.resolve();
      await release.promise;
    };
    const admin = b.broker.evaluate(
      { artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 43 },
      ADMIN,
    );
    await started.promise;
    await expect(
      b.broker.evaluate(
        { artifact: { hash: baselineHash }, assetGroupId: "holdout", seed: 43 },
        CLIENT,
      ),
    ).rejects.toThrow(/holdout asset groups are only reachable/);
    release.resolve();
    await admin;
    expect(b.log.filter((argv) => argv[1] === "run" && argv.includes("--rm"))).toHaveLength(1);
  });


  it("public results keep per-example feedback for unprivileged clients", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, {
      valid: true,
      objectives: { score: 1 },
      perExample: { ex1: { score: 1, feedback: "public feedback" } },
    });
    const rec = await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(rec.output.perExample["ex1"]?.feedback).toBe("public feedback");
  });
});

// ---------- evaluator containment ----------

describe("evaluator containment", () => {
  it("runs the evaluator from the frozen baseline tree with minimal read-only mounts", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    const evalArgv = b.log.find((a) => a[1] === "run" && a.includes("--rm"));
    expect(evalArgv).toBeDefined();
    const argv = evalArgv ?? [];
    const wIdx = argv.indexOf("-w");
    expect(argv[wIdx + 1]).toBe("/trusted/baseline");
    expect(argv.some((a) => a.endsWith(":/trusted/baseline:ro"))).toBe(true);
    expect(argv.some((a) => a.endsWith(":/workspace:ro"))).toBe(true);
    expect(argv).toContain("--read-only");
    const netIdx = argv.indexOf("--network");
    expect(argv[netIdx + 1]).toBe("none");
    expect(argv).toContain("--pids-limit");
    expect(argv).toContain("--memory");
    expect(argv).toContain("--cpus");
    expect(argv).toContain("no-new-privileges");
    // The trusted scorer runs as root so it can drop candidate workers to an
    // unprivileged uid — candidate-to-scorer signal//proc reach is severed.
    const userIdx = argv.indexOf("--user");
    expect(argv[userIdx + 1]).toBe("0:0");
    expect(argv).toContain("SETUID");
    expect(argv).toContain("SETGID");
    expect(argv).toContain("KILL");
    expect(argv).toContain("DAC_OVERRIDE");
    expect(argv).toContain("FOWNER");
    expect(argv).toContain("IPC_OWNER");
    // Namespace-unshare authority for the trusted scorer's per-rep preexec
    // isolation; the candidate worker loses it on setuid + no-new-privileges.
    expect(argv).toContain("SYS_ADMIN");
    const stateTmpfsIdx = argv.indexOf("/tmp:size=16m,nosuid,nodev,noexec");
    expect(stateTmpfsIdx).toBeGreaterThan(0);
    expect(argv[stateTmpfsIdx - 1]).toBe("--tmpfs");
    const shmSizeIdx = argv.indexOf("--shm-size");
    expect(argv[shmSizeIdx + 1]).toBe("16m");
    // Assets are STAGED: a single RO mount of a per-eval staging copy at
    // /capsule/assets — never a bind of the capsule root itself — parented
    // under a root-owned 0700 tmpfs so uid-2000 candidate workers cannot
    // traverse to it.
    const assetMounts = argv.filter((a) => a.endsWith(":/capsule/assets:ro"));
    expect(assetMounts).toHaveLength(1);
    const stageHost = (assetMounts[0] ?? "").split(":")[0] ?? "";
    expect(stageHost.startsWith(capsuleRootDir), "assets must be a staged copy, not the capsule root").toBe(false);
    expect(path.basename(stageHost)).toMatch(/^assets-/);
    const tmpfsIdx = argv.indexOf("/capsule:mode=0700,size=1m");
    expect(tmpfsIdx).toBeGreaterThan(0);
    expect(argv[tmpfsIdx - 1]).toBe("--tmpfs");
    expect(argv.every((a) => !a.includes("holdout"))).toBe(true);
    expect(argv.every((a) => !a.includes("protected"))).toBe(true);
  });

  it("pauses every exact run-labeled container around the evaluator and releases them only after reap", async () => {
    const b = await boot();
    const optimizer = "a".repeat(64);
    const mutation = "b".repeat(64);
    b.ctl.quiesceContainers = [optimizer, mutation];
    b.ctl.evalOutputs.set(baselineHash, score(1));

    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);

    const relevant = b.log.filter((argv) => ["ps", "pause", "run", "rm", "unpause"].includes(argv[1] ?? ""));
    const scan = relevant.findIndex((argv) => argv[1] === "ps");
    const pauseOptimizer = relevant.findIndex((argv) => argv[1] === "pause" && argv[2] === optimizer);
    const pauseMutation = relevant.findIndex((argv) => argv[1] === "pause" && argv[2] === mutation);
    const evaluator = relevant.findIndex((argv) => argv[1] === "run" && argv.includes("--rm"));
    const reap = relevant.findIndex((argv) => argv[1] === "rm" && argv.some((arg) => arg.includes("-eval-")));
    const unpauseMutation = relevant.findIndex((argv) => argv[1] === "unpause" && argv[2] === mutation);
    const unpauseOptimizer = relevant.findIndex((argv) => argv[1] === "unpause" && argv[2] === optimizer);
    expect([scan, pauseOptimizer, pauseMutation, evaluator, reap, unpauseMutation, unpauseOptimizer]).toEqual(
      [...Array(7).keys()],
    );
  });

  it("shares one pause lease across concurrent evaluators and blocks mutation Docker work until the last reap", async () => {
    const b = await boot();
    const optimizer = "e".repeat(64);
    b.ctl.quiesceContainers = [optimizer];
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const bothStarted = deferred<void>();
    const releaseEvaluators = deferred<void>();
    let started = 0;
    b.ctl.evalInspect = async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await releaseEvaluators.promise;
    };

    const evalA = b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 10 }, CLIENT);
    const evalB = b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 11 }, CLIENT);
    await bothStarted.promise;
    const mutation = b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await Promise.resolve();
    expect(b.log.some((argv) => argv[1] === "run" && argv.includes("-d"))).toBe(false);

    releaseEvaluators.resolve();
    await Promise.all([evalA, evalB]);
    expect((await mutation).sandboxId).toBeTruthy();
    expect(b.log.filter((argv) => argv[1] === "pause" && argv[2] === optimizer)).toHaveLength(1);
    expect(b.log.filter((argv) => argv[1] === "unpause" && argv[2] === optimizer)).toHaveLength(1);
    expect(b.log.filter((argv) => argv[1] === "run" && argv.includes("--rm"))).toHaveLength(2);
  });

  it("poisons further broker operations when a paused container cannot be released", async () => {
    const b = await boot();
    const optimizer = "f".repeat(64);
    b.ctl.quiesceContainers = [optimizer];
    b.ctl.unpauseFailFor.add(optimizer);
    b.ctl.evalOutputs.set(baselineHash, score(1));

    await expect(
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow(/quiescence release failed/);
    const dockerCreates = b.log.filter((argv) => argv[1] === "run" && argv.includes("-d")).length;
    await expect(
      b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT),
    ).rejects.toThrow(/quiescence is poisoned/);
    expect(b.log.filter((argv) => argv[1] === "run" && argv.includes("-d"))).toHaveLength(dockerCreates);
  });

  it("rejects evaluation before spawn and rolls back earlier pauses when quiescence is incomplete", async () => {
    const b = await boot();
    const first = "c".repeat(64);
    const blocked = "d".repeat(64);
    b.ctl.quiesceContainers = [first, blocked];
    b.ctl.pauseFailFor.add(blocked);
    b.ctl.evalOutputs.set(baselineHash, score(1));

    await expect(
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow(/evaluator quiescence failed/);
    expect(b.log.some((argv) => argv[1] === "run" && argv.includes("--rm"))).toBe(false);
    expect(b.log.some((argv) => argv[1] === "unpause" && argv[2] === first)).toBe(true);
    expect(b.broker.getBudget(ADMIN).spent.evaluatorInvocations).toBe(0);
  });

  it("rejects asset-group paths that overlap across visibility classes at construction", async () => {
    const manifest = makeManifest({
      assetGroups: [
        { id: "train", visibility: "public", paths: ["train"] },
        { id: "holdout", visibility: "holdout", paths: ["train/holdout"] },
      ],
    });
    expect(
      () =>
        new Broker({
          runId: "run-overlap",
          manifest,
          capsuleRootDir,
          baselineArtifactHash: baselineHash,
          capsuleDigest: TEST_CAPSULE_DIGEST,
          optimizerDigest: TEST_OPTIMIZER_DIGEST,
          holdoutLedgerPath: path.join(tmpBase, "runs", "overlap", "holdout-ledger.ndjson"),
          image: TEST_IMAGE,
          runDir: path.join(tmpBase, "runs", "overlap"),
          casDir: path.join(tmpBase, "cas", "overlap"),
          onEvent: () => {},
        }),
    ).toThrow(/overlap across visibility classes/);
  });

  it("rejects symlinked asset paths at construction — a symlink cannot alias holdout into a public mount", async () => {
    const evilRoot = path.join(tmpBase, "capsule-symlink");
    await mkdir(path.join(evilRoot, "holdout"), { recursive: true });
    await writeFile(path.join(evilRoot, "holdout", "holdout.txt"), "holdout-data");
    // public "train" is a SYMLINK to the holdout dir: lexically disjoint,
    // physically the same files.
    await symlink(path.join(evilRoot, "holdout"), path.join(evilRoot, "train"));
    const bootEvil = (paths: string[]): Broker =>
      new Broker({
        runId: "run-symlink",
        manifest: makeManifest({
          assetGroups: [
            { id: "train", visibility: "public", paths },
            { id: "holdout", visibility: "holdout", paths: ["holdout"] },
          ],
        }),
        capsuleRootDir: evilRoot,
        baselineArtifactHash: baselineHash,
        capsuleDigest: TEST_CAPSULE_DIGEST,
        optimizerDigest: TEST_OPTIMIZER_DIGEST,
        holdoutLedgerPath: path.join(tmpBase, "runs", "symlink", "holdout-ledger.ndjson"),
        image: TEST_IMAGE,
        runDir: path.join(tmpBase, "runs", "symlink"),
        casDir: path.join(tmpBase, "cas", "symlink"),
        onEvent: () => {},
      });
    expect(() => bootEvil(["train"])).toThrow(/symlink in asset path/);
    // A symlink COMPONENT mid-path is caught too.
    expect(() => bootEvil(["train/holdout.txt"])).toThrow(/symlink in asset path/);
    // And a declared path that does not exist fails closed at boot.
    expect(() => bootEvil(["nope"])).toThrow(/asset path missing on host/);
  });

  it("rejects hard-link aliases across visibility classes at construction", async () => {
    const evilRoot = path.join(tmpBase, "capsule-hardlink");
    await mkdir(path.join(evilRoot, "holdout"), { recursive: true });
    await mkdir(path.join(evilRoot, "pub"), { recursive: true });
    await writeFile(path.join(evilRoot, "holdout", "secret.txt"), "holdout-data");
    // Same inode, two names: lexically disjoint, physically identical bytes.
    await link(path.join(evilRoot, "holdout", "secret.txt"), path.join(evilRoot, "pub", "leak.txt"));
    expect(
      () =>
        new Broker({
          runId: "run-hardlink",
          manifest: makeManifest({
            assetGroups: [
              { id: "pub", visibility: "public", paths: ["pub/leak.txt"] },
              { id: "holdout", visibility: "holdout", paths: ["holdout/secret.txt"] },
            ],
          }),
          capsuleRootDir: evilRoot,
          baselineArtifactHash: baselineHash,
          capsuleDigest: TEST_CAPSULE_DIGEST,
          optimizerDigest: TEST_OPTIMIZER_DIGEST,
          holdoutLedgerPath: path.join(tmpBase, "runs", "hardlink", "holdout-ledger.ndjson"),
          image: TEST_IMAGE,
          runDir: path.join(tmpBase, "runs", "hardlink"),
          casDir: path.join(tmpBase, "cas", "hardlink"),
          onEvent: () => {},
        }),
    ).toThrow(/alias the same files across visibility classes/);
  });

  it("rejects hard links NESTED below declared asset dirs — the content scan walks the mounted trees", async () => {
    const evilRoot = path.join(tmpBase, "capsule-nested-hardlink");
    await mkdir(path.join(evilRoot, "holdout"), { recursive: true });
    await mkdir(path.join(evilRoot, "pub", "deep"), { recursive: true });
    await writeFile(path.join(evilRoot, "holdout", "secret.txt"), "holdout-data");
    await writeFile(path.join(evilRoot, "pub", "ok.txt"), "public");
    // Declared paths are the disjoint DIRECTORIES; the alias hides deep
    // inside the public tree.
    await link(path.join(evilRoot, "holdout", "secret.txt"), path.join(evilRoot, "pub", "deep", "leak.txt"));
    expect(
      () =>
        new Broker({
          runId: "run-nested-hardlink",
          manifest: makeManifest({
            assetGroups: [
              { id: "pub", visibility: "public", paths: ["pub"] },
              { id: "holdout", visibility: "holdout", paths: ["holdout"] },
            ],
          }),
          capsuleRootDir: evilRoot,
          baselineArtifactHash: baselineHash,
          capsuleDigest: TEST_CAPSULE_DIGEST,
          optimizerDigest: TEST_OPTIMIZER_DIGEST,
          holdoutLedgerPath: path.join(tmpBase, "runs", "nested-hardlink", "holdout-ledger.ndjson"),
          image: TEST_IMAGE,
          runDir: path.join(tmpBase, "runs", "nested-hardlink"),
          casDir: path.join(tmpBase, "cas", "nested-hardlink"),
          onEvent: () => {},
        }),
    ).toThrow(/alias the same files across visibility classes/);
  });
});

// ---------- lifecycle and resources ----------

describe("sandbox lifecycle and resource ceilings", () => {
  it("caps concurrently active sandboxes", async () => {
    const b = await boot({ maxActiveSandboxes: 2 });
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await expect(b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT)).rejects.toThrow(
      /active sandbox cap/,
    );
  });

  it("applies resource ceilings to mutation sandboxes", async () => {
    const b = await boot();
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const argv = b.log.find((a) => a[1] === "run" && a.includes("-d")) ?? [];
    expect(argv).toContain("--pids-limit");
    expect(argv).toContain("--memory");
    expect(argv).toContain("--cpus");
    expect(argv).toContain("no-new-privileges");
    // SYS_ADMIN is trusted-evaluator-only authority — a mutation sandbox
    // (candidate-controlled code) must never receive it.
    expect(argv).not.toContain("SYS_ADMIN");
  });

  it("a timed-out exec invalidates and removes the sandbox — no orphan keeps computing", async () => {
    const b = await boot();
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    b.ctl.execExit = "timeout";
    const res = await b.broker.exec({ sandboxId, argv: ["sleep", "999"], timeoutSec: 1 }, CLIENT);
    expect(res.exitCode).toBe(124);
    expect(b.log.some((a) => a[1] === "rm" && a[2] === "-f" && a[3] === "c_0")).toBe(true);
    await expect(b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT)).rejects.toThrow(/unknown sandbox/);
  });

  it("a timed-out evaluator is reaped by name and still burns the invocation", async () => {
    const b = await boot();
    b.ctl.evalMode = "timeout";
    await expect(b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT)).rejects.toThrow(
      /evaluator timed out/,
    );
    const evalArgv = b.log.find((a) => a[1] === "run" && a.includes("--rm")) ?? [];
    const evalName = evalArgv[evalArgv.indexOf("--name") + 1] ?? "";
    expect(evalName).toMatch(/-eval-/);
    expect(b.log.some((a) => a[1] === "rm" && a[2] === "-f" && a[3] === evalName)).toBe(true);
    expect(b.broker.getBudget(ADMIN).spent.evaluatorInvocations).toBe(1);
  });

  it("puts the mutable workspace on a size-capped tmpfs and makes every image layer read-only", async () => {
    const b = await boot({ scratchQuotaBytes: 4096 });
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const argv = b.log.find((entry) => entry[1] === "run" && entry.includes("-d")) ?? [];
    expect(argv).toContain("--read-only");
    expect(argv).toContain(`/workspace:rw,exec,nosuid,nodev,size=1073741824,nr_inodes=${WORKSPACE_TMPFS_INODES},mode=1777`);
    expect(argv).toContain("/tmp:rw,exec,nosuid,nodev,size=67108864,mode=1777");
  });
  it("extracts mutation artifacts inside /workspace as the fixed uid", async () => {
    const b = await boot();
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const argv = b.log.find((entry) => entry[1] === "exec" && entry.includes("/bin/tar") && entry.includes("-x")) ?? [];
    const userIdx = argv.indexOf("-u");
    expect(argv[userIdx + 1]).toBe("1000:1000");
    const stripIdx = argv.indexOf("--strip-components");
    expect(argv[stripIdx + 1]).toBe("1");
    const cwdIdx = argv.indexOf("-C");
    expect(argv[cwdIdx + 1]).toBe("/workspace");
  });


  it("scratchVolume: mounts the per-run quota volume and removes it deterministically on close", async () => {
    const b = await boot({ scratchVolume: true, scratchQuotaBytes: 4096 });
    const create = b.log.find((a) => a[1] === "volume" && a[2] === "create") ?? [];
    expect(create).toContain("device=tmpfs");
    expect(create).toContain("o=size=4096,nr_inodes=131072");
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const runArgv = b.log.find((a) => a[1] === "run" && a.includes("-d")) ?? [];
    expect(runArgv.some((a) => a.startsWith(`hone-scratch-${b.runId}:`) && a.includes(":/scratch"))).toBe(true);
    await b.broker.close();
    expect(b.log.some((a) => a[1] === "volume" && a[2] === "rm" && a.includes(`hone-scratch-${b.runId}`))).toBe(true);
  });
  it("freezes every mutation sandbox while snapshotting shared scratch", async () => {
    const b = await boot({ scratchVolume: true });
    await saveCandidate(b, candidateTar);
    const pause = b.log.findIndex((argv) => argv[1] === "pause");
    const snapshot = b.log.findIndex(
      (argv) => argv[1] === "exec" && argv.includes(`hone-scratch-keeper-${b.runId}`) && argv.includes("/bin/sh"),
    );
    const unpause = b.log.findIndex((argv) => argv[1] === "unpause");
    expect(pause).toBeGreaterThanOrEqual(0);
    expect(snapshot).toBeGreaterThan(pause);
    expect(unpause).toBeGreaterThan(snapshot);
  });


  it("scratchVolume provisioning failure fails closed — init aborts instead of an unquota'd host fallback", async () => {
    await expect(boot({ scratchVolume: true, volumeCreateFails: true, scratchQuotaBytes: 16 })).rejects.toThrow(
      /scratch volume provisioning failed/,
    );
  });

  it("parallel createSandbox calls cannot overrun the active-sandbox cap", async () => {
    const b = await boot({ maxActiveSandboxes: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/active sandbox cap/);
    }
    // Exactly one mutation container was ever spawned.
    expect(b.log.filter((a) => a[1] === "run" && a.includes("-d"))).toHaveLength(1);
  });

  it("parallel evaluations cannot overrun maxEvaluatorInvocations", async () => {
    const b = await boot({ manifest: makeManifest({ budget: { ...GENEROUS_BUDGET, maxEvaluatorInvocations: 1 } }) });
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 100 + i }, CLIENT),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/evaluatorInvocations/);
    }
    // Exactly one durable charge, one evaluator container.
    expect((await stateLines(b)).filter((l) => l["t"] === "inv")).toHaveLength(1);
    expect(b.log.filter((a) => a[1] === "run" && a.includes("--rm"))).toHaveLength(1);
    expect(b.broker.getBudget(ADMIN).spent.evaluatorInvocations).toBe(1);
  });
});

// ---------- artifact validation ----------

describe("artifact validation at every ingestion point", () => {
  it("rejects a malformed EXTANT artifact before any container touches it", async () => {
    const b = await boot();
    const evil = makeTar([
      { name: "workspace/", type: "5" },
      { name: "workspace/etc", type: "2", linkname: "/etc" },
    ]);
    const hash = await b.broker.cas.putBuffer(evil);
    const before = b.log.length;
    await expect(b.broker.createSandbox({ artifact: { hash }, role: "mutation" }, CLIENT)).rejects.toThrow(/rejected/);
    expect(b.log.length).toBe(before); // no docker run, no docker cp — nothing was spawned
  });

  it("rejects a malformed SAVED artifact — nothing malformed ever enters CAS", async () => {
    const b = await boot();
    const evil = makeTar([{ name: "evil.txt", type: "0", content: "x" }]);
    const evilHash = `sha256:${createHash("sha256").update(evil).digest("hex")}`;
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    b.ctl.saveTar = evil;
    await expect(b.broker.saveArtifact({ sandboxId }, CLIENT)).rejects.toThrow(/rejected/);
    expect(await b.broker.cas.has(evilHash)).toBe(false);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(0);
  });
});

// ---------- saveArtifact canonicalization ----------

describe("saveArtifact canonicalization (unchanged trees repack to the parent hash)", () => {
  async function casBlobCount(casDir: string): Promise<number> {
    let n = 0;
    for (const shard of await readdir(path.join(casDir, "sha256"))) {
      n += (await readdir(path.join(casDir, "sha256", shard))).length;
    }
    return n;
  }

  it("a metadata-noisy repack of the UNCHANGED parent tree is the parent, not a new candidate", async () => {
    // run_mrmbrlmv312b68 regression: after SIGKILL/resume the sandbox emitted
    // the byte-identical baseline TREE repacked with fresh mtimes plus
    // __pycache__ detritus — pre-fix that minted a spurious candidate hash.
    const b = await boot();
    const noisy = makeTar([
      { name: "workspace/", type: "5", mtime: 777_777 },
      { name: "workspace/answer.txt", type: "0", content: "1", mode: "0000644", mtime: 777_777 },
      { name: "workspace/__pycache__/", type: "5", mtime: 777_777 },
      { name: "workspace/__pycache__/junk.cpython-311.pyc", type: "0", content: "junk", mode: "0000644", mtime: 777_777 },
    ]);
    expect(noisy.equals(baselineTar)).toBe(false); // wire bytes differ...
    const hash = await saveCandidate(b, noisy);
    expect(hash).toBe(baselineHash); // ...but the canonical hash is the parent's
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(0);
    expect((await stateLines(b)).filter((l) => l["t"] === "lineage")).toHaveLength(0);
  });

  it("byte-different saves of the same CHANGED tree land on one canonical hash and one lineage record", async () => {
    const b = await boot();
    const noisy = (mtime: number): Buffer =>
      makeTar([
        { name: "workspace/", type: "5", mtime },
        { name: "workspace/answer.txt", type: "0", content: "2", mode: "0000644", mtime },
        { name: "workspace/.pytest_cache/", type: "5", mtime },
        { name: "workspace/.pytest_cache/lastfailed", type: "0", content: "{}", mode: "0000644", mtime },
      ]);
    expect(noisy(1000).equals(noisy(2000))).toBe(false);
    const h1 = await saveCandidate(b, noisy(1000));
    const h2 = await saveCandidate(b, noisy(2000));
    // Both collapse onto the trusted canonical pack of {answer.txt: "2"}.
    expect(h1).toBe(candidateHash);
    expect(h2).toBe(h1);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(1);
    expect((await stateLines(b)).filter((l) => l["t"] === "lineage")).toHaveLength(1);
  });
  it("serializes convergent saves across sandboxes into one lineage fact", async () => {
    const b = await boot();
    const [h1, h2] = await Promise.all([
      saveCandidate(b, candidateTar),
      saveCandidate(b, candidateTar),
    ]);
    expect(h1).toBe(candidateHash);
    expect(h2).toBe(candidateHash);
    expect(b.events.filter((event) => event.type === "episode.candidate")).toHaveLength(1);
    expect((await stateLines(b)).filter((line) => line["t"] === "lineage")).toHaveLength(1);
  });


  it("a structurally malicious sandbox tar is rejected before extraction and grows CAS by nothing", async () => {
    const b = await boot();
    const evil = makeTar([
      { name: "workspace/", type: "5" },
      { name: "workspace/link", type: "2", linkname: "/etc" },
    ]);
    b.ctl.saveTar = evil;
    b.ctl.execExit = 0;
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    // Snapshot AFTER the exec: its CAS-backed session trace is a legitimate
    // blob; the rejected artifact itself must grow CAS by nothing.
    const before = await casBlobCount(b.casDir);
    await expect(b.broker.saveArtifact({ sandboxId }, CLIENT)).rejects.toThrow(/saved artifact rejected.*symlink/);
    expect(await casBlobCount(b.casDir)).toBe(before);
    expect(b.events.filter((e) => e.type === "episode.candidate")).toHaveLength(0);
  });
});

// ---------- trusted probe evidence ----------

describe("trusted probe evidence (episode-tagged evals + broker-authored gate.paired)", () => {
  it("first accepted eval of a saved candidate is episode-tagged and pairs same-epoch trusted scores before incumbent.new", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    // Parent measured INSIDE the episode's epoch (the sandbox exists first):
    // untagged eval.completed, trusted at train|0 in this generation.
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT);

    const evals = b.events.filter((e) => e.type === "eval.completed");
    expect(evals).toHaveLength(2); // parent (untagged) + candidate (tagged)
    expect(evals[0]).not.toHaveProperty("episode");
    expect(evals[0]).toMatchObject({ artifact: { hash: baselineHash }, aggregate: 1 });
    expect(evals[1]).toMatchObject({ episode: 0, artifact: { hash: cand }, assetGroupId: "train", seed: 0, aggregate: 2 });
    const gates = b.events.filter((e) => e.type === "gate.paired");
    expect(gates).toHaveLength(1);
    // Broker-authored scores from the trusted table — never optimizer claims.
    expect(gates[0]).toMatchObject({ episode: 0, parentScore: 1, childScore: 2, passed: true });
    const types = b.events.map((e) => e.type);
    expect(types.indexOf("gate.paired")).toBe(types.lastIndexOf("eval.completed") + 1);
    expect(types.indexOf("incumbent.new")).toBeGreaterThan(types.indexOf("gate.paired"));
  });

  it("greedy gate: a child that does not strictly beat its parent pairs with passed:false", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(2)).set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    const gates = b.events.filter((e) => e.type === "gate.paired");
    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ episode: 0, parentScore: 2, childScore: 2, passed: false });
  });

  it("no same-coordinate parent score → tagged eval but NO gate is authored", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);
    // Parent was never measured at train|9 — nothing trustworthy to pair.
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 9 }, CLIENT);
    const evals = b.events.filter((e) => e.type === "eval.completed");
    expect(evals).toHaveLength(1);
    expect(evals[0]).toMatchObject({ episode: 0, artifact: { hash: cand } });
    expect(b.events.filter((e) => e.type === "gate.paired")).toHaveLength(0);
  });

  it("rejects old-candidate retries and later candidates after the first accepted evaluation", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2)).set(candidate2Hash, score(3));
    const candA = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.events.filter((e) => e.type === "gate.paired")).toHaveLength(1);

    const candB = await saveCandidate(b, candidate2Tar, candA);
    await expect(
      b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 5 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
    await expect(
      b.broker.evaluate({ artifact: { hash: candB }, assetGroupId: "train", seed: 5 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
    expect(b.events.filter((e) => e.type === "gate.paired")).toHaveLength(1);
  });

  it("replay preserves the consumed one-shot attempt and rejects an old candidate retry", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "probe-replay"), casDir: path.join(tmpBase, "cas", "probe-replay"), runId: "run-probe-replay" };
    const a = await boot(shared);
    a.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.close();

    const b = await boot(shared);
    await expect(
      b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 11 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
    expect(b.events.filter((e) => e.type === "eval.completed")).toHaveLength(0);
  });

  it("persisted gates replay across a crash: an unreported candidate still promotes after restart", async () => {
    const shared = { runDir: path.join(tmpBase, "runs", "gate-resume"), casDir: path.join(tmpBase, "cas", "gate-resume"), runId: "run-gate-resume" };
    const a = await boot(shared);
    a.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(a, candidateTar);
    await a.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await a.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);
    // Crash BEFORE reportIncumbent: the gate exists only in the journal.
    await a.broker.close();

    const b = await boot(shared);
    // No new evaluation after restart: promotion runs purely on the REPLAYED
    // persisted gate identity (same-epoch, parent-first, passed).
    expect(b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toEqual({});
    expect(b.broker.trustedIncumbent).toMatchObject({ hash: cand, aggregate: 2, episode: 0 });
  });

  it("child-first score-shopping consumes the only candidate attempt and can never be repaired", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    const cand = await saveCandidate(b, candidateTar);

    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 3 }, CLIENT);
    await expect(
      b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 4 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 3 }, CLIENT);
    expect(b.events.filter((e) => e.type === "gate.paired")).toHaveLength(0);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toThrow(/insufficient authority/);

    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 5 }, CLIENT);
    await expect(
      b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 5 }, CLIENT),
    ).rejects.toThrow(/candidate evaluation attempt already consumed/);
  });
});

// ---------- asset staging confidentiality ----------

describe("asset staging confidentiality (per-eval 0700 copies, never capsule binds)", () => {
  interface StagedSnapshot {
    root: string;
    rootMode: number;
    tree: Array<{ rel: string; mode: number; kind: "file" | "dir"; content: string | undefined }>;
  }

  /** Captures the staged tree while the (fake) eval container is running. */
  function captureStage(b: Booted, sink: StagedSnapshot[]): void {
    b.ctl.evalInspect = async (argv) => {
      const mount = argv.find((a) => a.endsWith(":/capsule/assets:ro")) ?? "";
      const root = mount.split(":")[0] ?? "";
      const rootSt = await stat(root);
      const tree: StagedSnapshot["tree"] = [];
      for (const rel of (await readdir(root, { recursive: true })).sort()) {
        const abs = path.join(root, String(rel));
        const st = await lstat(abs);
        expect(st.isSymbolicLink()).toBe(false);
        tree.push({
          rel: String(rel),
          mode: st.mode & 0o777,
          kind: st.isDirectory() ? "dir" : "file",
          content: st.isFile() ? await readFile(abs, "utf8") : undefined,
        });
      }
      sink.push({ root, rootMode: rootSt.mode & 0o777, tree });
    };
  }

  it("stages ONLY the selected group — dirs 0755/files 0644 under the 0700 host-only tmp parent — and tears it down afterwards", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const stages: StagedSnapshot[] = [];
    captureStage(b, stages);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);

    expect(stages).toHaveLength(1);
    const s = stages[0] as StagedSnapshot;
    expect(path.dirname(s.root)).toBe(path.join(b.runDir, "tmp"));
    expect(path.basename(s.root)).toMatch(/^assets-/);
    // Host confidentiality lives on the OUTER host-only parent (0700); the
    // staged content itself must be world-readable so the cap-dropped
    // evaluator (no CAP_DAC_OVERRIDE, even as uid 0) can traverse the bind
    // on native Linux.
    expect(((await stat(path.join(b.runDir, "tmp"))).mode & 0o777)).toBe(0o700);
    expect(s.rootMode).toBe(0o755);
    expect(s.tree).toEqual([
      { rel: "train", mode: 0o755, kind: "dir", content: undefined },
      { rel: path.join("train", "data.txt"), mode: 0o644, kind: "file", content: "train-data" },
    ]);
    // Teardown: nothing staged survives the evaluation.
    expect((await readdir(path.join(b.runDir, "tmp"))).filter((e) => e.startsWith("assets-"))).toHaveLength(0);
  });

  it("each evaluation stages into a UNIQUE root", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const stages: StagedSnapshot[] = [];
    captureStage(b, stages);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 1 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 2 }, CLIENT);
    expect(stages).toHaveLength(2);
    expect(stages[0]?.root).not.toBe(stages[1]?.root);
  });

  it("tears the stage down when the evaluator times out", async () => {
    const b = await boot({ evalTimeoutSec: 1 });
    b.ctl.evalMode = "timeout";
    await expect(
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow(/timed out/);
    expect((await readdir(path.join(b.runDir, "tmp"))).filter((e) => e.startsWith("assets-"))).toHaveLength(0);
  });

  it("a symlink raced into an admitted asset path fails closed BEFORE the invocation is burned", async () => {
    // Bespoke capsule root: construction-time validation sees a regular file.
    const racedRoot = path.join(tmpBase, "capsule-raced");
    await mkdir(path.join(racedRoot, "train"), { recursive: true });
    await mkdir(path.join(racedRoot, "protected"), { recursive: true });
    await mkdir(path.join(racedRoot, "holdout"), { recursive: true });
    await writeFile(path.join(racedRoot, "train", "data.txt"), "train-data");
    await writeFile(path.join(racedRoot, "protected", "secret.txt"), "TOP-SECRET-FIXTURE");
    await writeFile(path.join(racedRoot, "holdout", "holdout.txt"), "holdout-data");
    const b = await boot({ capsuleRootDir: racedRoot });
    b.ctl.evalOutputs.set(baselineHash, score(1));

    // The race: after admission, the public asset becomes a symlink to a secret.
    await rm(path.join(racedRoot, "train", "data.txt"));
    await symlink(path.join(racedRoot, "protected", "secret.txt"), path.join(racedRoot, "train", "data.txt"));

    await expect(
      b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT),
    ).rejects.toThrow(/non-regular|not allowed|symlink/i);
    // Fail closed BEFORE the burn: no invocation spent, no eval container ran.
    expect(b.broker.getBudget(ADMIN).spent.evaluatorInvocations).toBe(0);
    expect(b.log.some((a) => a[1] === "run" && !a.includes("-d"))).toBe(false);
    // And nothing secret was staged.
    expect((await readdir(path.join(b.runDir, "tmp"))).filter((e) => e.startsWith("assets-"))).toHaveLength(0);
  });
});

// ---------- terminal saveArtifact ----------

describe("terminal saveArtifact (a successful save retires the sandbox)", () => {
  it("removes the container before acking, deletes the entry, and resumes from CAS in a fresh sandbox", async () => {
    const b = await boot();
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    const saved = await b.broker.saveArtifact({ sandboxId }, CLIENT);
    expect(saved.hash).toBe(candidateHash);
    // The container (c_0: first -d spawn of this boot) was removed BEFORE the ack.
    expect(b.log.some((a) => a[1] === "rm" && a[2] === "-f" && a[3] === "c_0")).toBe(true);
    // The entry is gone — the slot and its proxy bearer are released.
    await expect(b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT)).rejects.toThrow(/sandbox/i);
    // Iteration resumes from the saved CAS artifact in a FRESH sandbox.
    const next = await b.broker.createSandbox({ artifact: { hash: saved.hash }, role: "mutation" }, CLIENT);
    expect(next.sandboxId).not.toBe(sandboxId);
  });

  it("a failed-exec REPAIR save is terminal too, and its CAS snapshot resumes in a fresh sandbox", async () => {
    const b = await boot();
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    b.ctl.execExit = 7;
    await b.broker.exec({ sandboxId, argv: ["false"] }, CLIENT);
    b.ctl.saveTar = candidateTar;
    const snap = await b.broker.saveArtifact({ sandboxId }, CLIENT);
    await expect(b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT)).rejects.toThrow(/sandbox/i);
    // Repair resume: fresh sandbox from the snapshot keeps the episode (no new episode.started).
    b.ctl.execExit = 0;
    await b.broker.createSandbox({ artifact: { hash: snap.hash }, role: "mutation" }, CLIENT);
    expect(b.events.filter((e) => e.type === "episode.started")).toHaveLength(1);
  });

  it("8 create→exec→save cycles under an active cap of 2 exhaust nothing and leave no container holding the proxy bearer", async () => {
    const b = await boot({ maxActiveSandboxes: 2 });
    for (let i = 0; i < 8; i++) {
      const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
      await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
      b.ctl.saveTar = i % 2 === 0 ? candidateTar : candidate2Tar;
      await b.broker.saveArtifact({ sandboxId }, CLIENT);
    }
    // Every one of the 8 mutation containers was spawned AND removed — none
    // survives to retain /scratch, an active slot, or the injected proxy token.
    const spawned = b.log.filter((a) => a[1] === "run" && a.includes("-d"));
    expect(spawned).toHaveLength(8);
    const removed = new Set(b.log.filter((a) => a[1] === "rm" && a[2] === "-f").map((a) => a[3]));
    for (let i = 0; i < 8; i++) expect(removed.has(`c_${i}`), `container c_${i} must be removed`).toBe(true);
  });

  it("fails closed when the container cannot be removed: no ack, entry retained for the reaper", async () => {
    const b = await boot();
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    b.ctl.rmFailFor.add("c_0");
    b.ctl.saveTar = candidateTar;
    await expect(b.broker.saveArtifact({ sandboxId }, CLIENT)).rejects.toThrow(/retirement failed/);
    // The entry stays registered — still reachable, and the TTL reaper remains its backup.
    b.ctl.rmFailFor.clear();
    const res = await b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT);
    expect(res.exitCode).toBe(0);
  });
});

// ---------- close quiescence ----------

describe("broker close quiescence", () => {
  it("close rejects new operations, drains in-flight ones, and freezes the event stream", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1));
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);

    const entered = deferred<void>();
    const gate = deferred<void>();
    b.ctl.execBarrier = { entered: entered.resolve, gate: gate.promise };
    let slowSettled = false;
    const slow = b.broker.exec({ sandboxId, argv: ["held"] }, CLIENT).finally(() => {
      slowSettled = true;
    });
    await entered.promise; // the exec is now IN FLIGHT inside the fake docker CLI

    let closeDone = false;
    const closing = b.broker.close().then(() => {
      closeDone = true;
    });
    // Admission is rejected synchronously once close() begins; each awaited
    // rejection also yields scheduler turns — close() STILL must not have
    // resolved, because the in-flight exec is held by the gate (deterministic:
    // the drain waiter can only fire after the gate opens).
    await expect(b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT)).rejects.toThrow(/broker is closed/);
    await expect(b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT)).rejects.toThrow(/broker is closed/);
    await expect(b.broker.getFile({ sandboxId, path: "answer.txt" }, CLIENT)).rejects.toThrow(/broker is closed/);
    expect(closeDone).toBe(false);
    expect(slowSettled).toBe(false);

    gate.resolve();
    await closing;
    await slow; // drained BEFORE close returned; settles for the caller here
    expect(slowSettled).toBe(true);

    // After close returns: nothing emits, spends, or writes.
    const frozenAt = b.events.length;
    await expect(b.broker.exec({ sandboxId, argv: ["true"] }, CLIENT)).rejects.toThrow(/broker is closed/);
    await expect(b.broker.saveArtifact({ sandboxId }, CLIENT)).rejects.toThrow(/broker is closed/);
    expect(b.events.length).toBe(frozenAt);
  });

  it("close aborts an ACTIVE eval container by name and returns without waiting out the evaluator", async () => {
    const b = await boot();
    b.ctl.evalHangsUntilReaped = true;
    const evalStarted = deferred<void>();
    b.ctl.evalInspect = () => evalStarted.resolve();
    const evalP = b.broker
      .evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT)
      .then(() => undefined)
      .catch((err: unknown) => err);
    await evalStarted.promise; // the eval `docker run` is now blocked in flight

    await b.broker.close(); // must reap the eval container BY NAME to unblock the drain
    const err = await evalP;
    expect(err).toBeInstanceOf(BrokerError);
    expect(String((err as BrokerError).message)).toMatch(/evaluator exited 137/);

    const evalRun = b.log.find((a) => a[1] === "run" && !a.includes("-d"));
    const evalName = evalRun?.[evalRun.indexOf("--name") + 1] ?? "";
    expect(evalName).toMatch(/-eval-/);
    expect(b.log.some((a) => a[1] === "rm" && a[2] === "-f" && a[3] === evalName)).toBe(true);
    // The staged assets were torn down even on the aborted path.
    expect((await readdir(path.join(b.runDir, "tmp"))).filter((e) => e.startsWith("assets-"))).toHaveLength(0);
  });
  it("rejects close while a tracked container cannot be removed, then succeeds after cleanup is possible", async () => {
    const b = await boot({ scratchVolume: true });
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    // c_0 is the scratch keeper's daemon id; the sandbox container is c_1.
    b.ctl.rmFailFor.add("c_1");
    await expect(b.broker.close()).rejects.toThrow(/containers still live: c_1/);
    expect(b.log.filter((argv) => argv[1] === "rm" && argv[3] === "c_1").length).toBeGreaterThanOrEqual(2);
    expect(
      b.log.some(
        (argv) => argv[1] === "exec" && argv.includes(`hone-scratch-keeper-${b.runId}`) && argv.includes("/bin/sh"),
      ),
    ).toBe(false);
    expect(b.log.some((argv) => argv[1] === "volume" && argv[2] === "rm")).toBe(false);

    b.ctl.rmFailFor.clear();
    await expect(b.broker.close()).resolves.toBeUndefined();
  });
});

// ---------- live docker smoke ----------

describe("live docker smoke (quota volume + full loop, no leaks)", () => {
  it("create/exec/save/eval with scratchVolume, then leaves no hone container or volume behind", async () => {
    await waitForDocker();
    await ensureImage(TEST_IMAGE);

    const runId = `run-live-${randomBytes(4).toString("hex")}`;
    const runDir = path.join(tmpBase, "runs", runId);
    const casDir = path.join(tmpBase, "cas", runId);
    await mkdir(runDir, { recursive: true });
    const cas = new CasStore(casDir);
    await cas.putBuffer(baselineTar);

    const events: RunEvent[] = [];
    const broker = new Broker({
      runId,
      manifest: makeManifest(),
      capsuleRootDir,
      baselineArtifactHash: baselineHash,
      capsuleDigest: TEST_CAPSULE_DIGEST,
      optimizerDigest: TEST_OPTIMIZER_DIGEST,
      holdoutLedgerPath: path.join(runDir, "holdout-ledger.ndjson"),
      image: TEST_IMAGE,
      runDir,
      casDir,
      onEvent: (e) => events.push(e),
      scratchVolume: true,
      scratchQuotaBytes: 64 * 1024 * 1024,
    });
    await broker.init();
    try {
      // The quota volume exists while the run is live.
      const inspect = await runCommand(["docker", "volume", "inspect", `hone-scratch-${runId}`]);
      expect(inspect.exitCode).toBe(0);

      const { sandboxId } = await broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
      const write = await broker.exec({ sandboxId, argv: ["sh", "-c", "echo 3 > /workspace/answer.txt"] }, CLIENT);
      expect(write.exitCode).toBe(0);
      const scratch = await broker.exec({ sandboxId, argv: ["sh", "-c", "echo s > /scratch/s.txt && cat /scratch/s.txt"] }, CLIENT);
      expect(scratch.exitCode).toBe(0);
      const saved = await broker.saveArtifact({ sandboxId }, CLIENT);

      const record = await broker.evaluate({ artifact: { hash: saved.hash }, assetGroupId: "train", seed: 7 }, CLIENT);
      expect(record.output.valid).toBe(true);
      expect(record.output.objectives["score"]).toBe(3);
    } finally {
      await broker.close();
    }

    // No hone container or volume of this run survives close().
    const ps = await runCommand(["docker", "ps", "-a", "--filter", `label=hone.runId=${runId}`, "--format", "{{.ID}}"]);
    expect(ps.stdout.toString("utf8").trim()).toBe("");
    const vols = await runCommand(["docker", "volume", "ls", "--filter", `label=hone.runId=${runId}`, "--format", "{{.Name}}"]);
    expect(vols.stdout.toString("utf8").trim()).toBe("");
  }, 300_000);
});
