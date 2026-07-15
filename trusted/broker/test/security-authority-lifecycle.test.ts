import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapsuleManifest, RunEvent } from "@hone/schema";
import { Broker, type BrokerConfig, type CallContext } from "../src/broker.js";
import { packDirAsArtifact } from "../src/artifact.js";
import { CasStore } from "../src/cas.js";
import { runCommand, type CmdResult, type RunCommand } from "../src/command.js";
import { BrokerError } from "../src/errors.js";
import { TEST_IMAGE, ensureImage, waitForDocker } from "./helpers.js";

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

function makeManifest(over: Partial<CapsuleManifest> = {}): CapsuleManifest {
  return {
    schemaVersion: 1,
    id: "cap_0123456789ab",
    objective: "make the answer bigger",
    baseline: { kind: "cas", hash: `sha256:${"0".repeat(64)}` },
    image: TEST_IMAGE,
    evalEntrypoint: [
      "sh",
      "-c",
      'S="$(cat /workspace/answer.txt 2>/dev/null || echo 0)"; printf \'{"valid":true,"objectives":{"score":%s}}\' "$S"',
    ],
    protectedPaths: [],
    assetGroups: [
      { id: "train", visibility: "public", paths: ["train"] },
      { id: "secret", visibility: "protected", paths: ["protected"] },
      { id: "holdout", visibility: "holdout", paths: ["holdout"] },
    ],
    budget: GENEROUS_BUDGET,
    contentHashes: {},
    ...over,
  };
}

// ---------- minimal ustar builder (hostile-archive fixtures) ----------

function tarHeader(name: string, size: number, typeflag: string, linkname: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000755\0", 100, 8, "utf8");
  h.write("0000000\0", 108, 8, "utf8");
  h.write("0000000\0", 116, 8, "utf8");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  h.write("00000000000\0", 136, 12, "utf8");
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

function makeTar(entries: ReadonlyArray<{ name: string; type: string; content?: string; linkname?: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.content ?? "");
    parts.push(tarHeader(e.name, e.type === "0" ? body.length : 0, e.type, e.linkname ?? ""));
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
  /** Tar bytes `docker cp <c>:/workspace -` returns for saveArtifact. */
  saveTar: Buffer;
  /** artifactHash -> EvaluatorOutput JSON for eval containers (matched via the /workspace mount). */
  evalOutputs: Map<string, unknown>;
  /** When "timeout", eval containers simulate a hang. */
  evalMode: "normal" | "timeout";
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
    runDir?: string;
    casDir?: string;
    holdoutBudget?: number;
    maxActiveSandboxes?: number;
    scratchQuotaBytes?: number;
    scratchVolume?: boolean;
    volumeCreateFails?: boolean;
    runId?: string;
  } = {},
): Promise<Booted> {
  const id = randomBytes(4).toString("hex");
  const runId = opts.runId ?? `run-${id}`;
  const runDir = opts.runDir ?? path.join(tmpBase, "runs", id);
  const casDir = opts.casDir ?? path.join(tmpBase, "cas", id);
  await mkdir(runDir, { recursive: true });

  const ctl: FakeCtl = { execExit: 0, saveTar: candidateTar, evalOutputs: new Map(), evalMode: "normal" };
  const log: string[][] = [];
  const events: RunEvent[] = [];
  let containerSeq = 0;

  const run: RunCommand = async (argv, cmdOpts) => {
    if (argv[0] !== "docker") return runCommand(argv, cmdOpts);
    log.push([...argv]);
    const sub = argv[1];
    if (sub === "run" && argv.includes("-d")) return fakeResult({ stdout: Buffer.from(`c_${containerSeq++}\n`) });
    if (sub === "run") {
      // eval container
      if (ctl.evalMode === "timeout") return fakeResult({ exitCode: -1, timedOut: true });
      const wsMount = argv.find((a) => a.endsWith(":/workspace:ro")) ?? "";
      let output: unknown = { valid: true, objectives: { score: 0 } };
      for (const [hash, out] of ctl.evalOutputs) {
        if (wsMount.includes(hash.replace(":", "-"))) output = out;
      }
      return fakeResult({ stdout: Buffer.from(JSON.stringify(output)) });
    }
    if (sub === "cp" && argv[2] === "-") return fakeResult(); // unpack into container
    if (sub === "cp" && argv[3] === "-") return fakeResult({ stdout: ctl.saveTar }); // saveArtifact
    if (sub === "exec") {
      const joined = argv.join(" ");
      if (joined.includes('echo "$(id -u):$(id -g)"')) return fakeResult({ stdout: Buffer.from("0:0\n") });
      if (argv[2] === "-u") return fakeResult(); // chown fixup
      if (ctl.execExit === "timeout") return fakeResult({ exitCode: -1, timedOut: true });
      return fakeResult({ exitCode: ctl.execExit });
    }
    if (sub === "volume" && argv[2] === "create") {
      return opts.volumeCreateFails === true
        ? fakeResult({ exitCode: 1, stderr: Buffer.from("volume driver does not support tmpfs") })
        : fakeResult({ stdout: Buffer.from("ok\n") });
    }
    return fakeResult(); // rm -f, volume rm, ...
  };

  const config: BrokerConfig = {
    runId,
    manifest: opts.manifest ?? makeManifest(),
    capsuleRootDir,
    baselineArtifactHash: baselineHash,
    image: TEST_IMAGE,
    runDir,
    casDir,
    onEvent: (e) => events.push(e),
    runCommand: run,
    ...(opts.holdoutBudget !== undefined ? { holdoutBudget: opts.holdoutBudget } : {}),
    ...(opts.maxActiveSandboxes !== undefined ? { maxActiveSandboxes: opts.maxActiveSandboxes } : {}),
    ...(opts.scratchQuotaBytes !== undefined ? { scratchQuotaBytes: opts.scratchQuotaBytes } : {}),
    ...(opts.scratchVolume !== undefined ? { scratchVolume: opts.scratchVolume } : {}),
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
      Array.from({ length: 5 }, (_, i) =>
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
    expect(holdoutLines).toEqual([{ t: "holdout", seq: 1 }]);
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
    expect(spends).toEqual([
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

  it("rejects a candidate that beats its parent but not the current incumbent", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(3)).set(candidate2Hash, score(2));
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);

    const candA = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: candA } }, CLIENT)).toEqual({});

    const candB = await saveCandidate(b, candidate2Tar);
    await b.broker.evaluate({ artifact: { hash: candB }, assetGroupId: "train", seed: 0 }, CLIENT);
    // candB (2) > parent baseline (1) but < incumbent candA (3) on the paired key.
    expect(() => b.broker.reportIncumbent({ artifact: { hash: candB } }, CLIENT)).toThrow(/not an improvement/);
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

// ---------- event derivation ----------

describe("trusted event ordering and candidacy", () => {
  it("pre-episode parent evaluations populate authority without emitting eval.completed", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(2));
    // Optimizer measures the parent BEFORE any episode exists.
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.events.filter((e) => e.type === "eval.completed")).toHaveLength(0);

    const cand = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: cand }, assetGroupId: "train", seed: 0 }, CLIENT);

    const types = b.events.map((e) => e.type);
    expect(types.indexOf("episode.started")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("eval.completed")).toBeGreaterThan(types.indexOf("episode.started"));

    // The silent pre-episode measurement still counts as promotion authority.
    expect(b.broker.reportIncumbent({ artifact: { hash: cand } }, CLIENT)).toEqual({});
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

  it("deltaVsBaseline is computed over paired keys only, and promotion requires a baseline pair", async () => {
    const b = await boot();
    b.ctl.evalOutputs.set(baselineHash, score(1)).set(candidateHash, score(3)).set(candidate2Hash, score(4));

    // Episode 0: candA promoted on train|0 (baseline paired there).
    const candA = await saveCandidate(b, candidateTar);
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 0 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: candA } }, CLIENT)).toEqual({});
    expect(b.events.filter((e) => e.type === "incumbent.new")[0]).toMatchObject({ deltaVsBaseline: 2 });

    // Episode 1: candB (parent candA) measured only at seed 5 — parent and
    // incumbent pair there, but the BASELINE was never measured at seed 5.
    const candB = await saveCandidate(b, candidate2Tar, candA);
    await b.broker.evaluate({ artifact: { hash: candA }, assetGroupId: "train", seed: 5 }, CLIENT);
    await b.broker.evaluate({ artifact: { hash: candB }, assetGroupId: "train", seed: 5 }, CLIENT);
    expect(() => b.broker.reportIncumbent({ artifact: { hash: candB } }, CLIENT)).toThrow(/candidate and baseline/);

    // Measuring the baseline at the promoted key unblocks promotion, and the
    // delta is paired-mean over the INTERSECTION only (4 - 1), not a
    // client-steerable mean-vs-mean over disjoint key sets.
    await b.broker.evaluate({ artifact: { hash: baselineHash }, assetGroupId: "train", seed: 5 }, CLIENT);
    expect(b.broker.reportIncumbent({ artifact: { hash: candB } }, CLIENT)).toEqual({});
    const promotions = b.events.filter((e) => e.type === "incumbent.new");
    expect(promotions).toHaveLength(2);
    expect(promotions[1]).toMatchObject({ artifact: { hash: candB }, deltaVsBaseline: 3 });
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
    await b.broker.evaluate({ artifact: { hash: candidateHash }, assetGroupId: "train", seed: 0 }, CLIENT);
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
    // Only the SELECTED asset group is mounted — nothing else from the capsule.
    const assetMounts = argv.filter((a) => a.includes(":/capsule/assets/"));
    expect(assetMounts).toHaveLength(1);
    expect(assetMounts[0]).toContain(":/capsule/assets/train:");
    expect(argv.every((a) => !a.includes("holdout"))).toBe(true);
    expect(argv.every((a) => !a.includes("protected"))).toBe(true);
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

  it("scratchVolume: mounts the per-run quota volume and removes it deterministically on close", async () => {
    const b = await boot({ scratchVolume: true, scratchQuotaBytes: 4096 });
    const create = b.log.find((a) => a[1] === "volume" && a[2] === "create") ?? [];
    expect(create).toContain("o=size=4096");
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const runArgv = b.log.find((a) => a[1] === "run" && a.includes("-d")) ?? [];
    expect(runArgv.some((a) => a.startsWith(`hone-scratch-${b.runId}:`) && a.includes(":/scratch"))).toBe(true);
    await b.broker.close();
    expect(b.log.some((a) => a[1] === "volume" && a[2] === "rm" && a.includes(`hone-scratch-${b.runId}`))).toBe(true);
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
