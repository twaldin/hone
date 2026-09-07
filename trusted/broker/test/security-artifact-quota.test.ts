import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapsuleManifest, RunEvent } from "@hone/schema";
import { Broker, type BrokerConfig, type CallContext } from "../src/broker.js";
import { packDirAsArtifact } from "../src/artifact.js";
import { CasStore } from "../src/cas.js";
import { runCommand, type CmdResult, type RunCommand } from "../src/command.js";
import { WORKSPACE_TMPFS_INODES } from "../src/broker.js";
import { MAX_ARTIFACT_ENTRIES } from "../src/tarcheck.js";
import { TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST, buildTestCapsule } from "./helpers.js";

/**
 * Candidate-artifact admission quotas (host-inode exhaustion hardening):
 * every admitted candidate can be retained as an unpacked host tree, so the
 * run carries a DURABLE aggregate entry budget, charged at admission (before
 * CAS growth), journaled, and replayed across restarts. The mutation
 * /workspace tmpfs carries the matching kernel nr_inodes cap. All against a
 * fake docker CLI — the broker's admission boundary is under test.
 */

const CLIENT: CallContext = { privileged: false };
const GENEROUS_BUDGET = { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 3_600, maxEvaluatorInvocations: 100 };

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpBase = path.join(pkgDir, ".test-tmp", `artifact-quota-${randomBytes(4).toString("hex")}`);

let manifest: CapsuleManifest;
let capsuleRootDir: string;
let baselineTar: Buffer;
let baselineHash: string;
/** Three-entry candidate tars (workspace + d/ + d/x.txt), distinct contents. */
let tarA: Buffer;
let hashA: string;
let tarB: Buffer;
let tarC: Buffer;
let tarD: Buffer;

interface Booted {
  broker: Broker;
  log: string[][];
  hostTarSpawns: string[][];
  ctl: { saveTar: Buffer };
  runDir: string;
  casDir: string;
  runId: string;
}

const booted: Booted[] = [];

function fakeResult(over: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...over };
}

async function boot(
  opts: { runId?: string; runDir?: string; casDir?: string; maxCandidateArtifactEntries?: number } = {},
): Promise<Booted> {
  const id = randomBytes(4).toString("hex");
  const runId = opts.runId ?? `run-${id}`;
  const runDir = opts.runDir ?? path.join(tmpBase, "runs", id);
  const casDir = opts.casDir ?? path.join(tmpBase, "cas", id);
  await mkdir(runDir, { recursive: true });

  const ctl = { saveTar: baselineTar };
  const log: string[][] = [];
  const hostTarSpawns: string[][] = [];
  let containerSeq = 0;
  const run: RunCommand = async (argv, cmdOpts) => {
    if (argv[0] !== "docker") {
      // canonicalizeWorkspaceTar's host-side `tar -x` — real, but observed.
      hostTarSpawns.push([...argv]);
      return runCommand(argv, cmdOpts);
    }
    log.push([...argv]);
    const sub = argv[1];
    if (sub === "run") return fakeResult({ stdout: Buffer.from(`c_${containerSeq++}\n`) });
    if (sub === "exec") {
      if (argv.includes("/bin/tar") && argv.includes("-x")) return fakeResult();
      if (argv.includes("/bin/tar") && argv.includes("-c")) return fakeResult({ stdout: ctl.saveTar });
      if (argv.join(" ").includes('echo "$(id -u):$(id -g)"')) return fakeResult({ stdout: Buffer.from("0:0\n") });
      return fakeResult();
    }
    return fakeResult(); // rm, volume, pause/unpause, ...
  };

  const config: BrokerConfig = {
    runId,
    manifest,
    capsuleRootDir,
    baselineArtifactHash: baselineHash,
    capsuleDigest: TEST_CAPSULE_DIGEST,
    optimizerDigest: TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: path.join(runDir, "holdout-ledger.ndjson"),
    image: TEST_IMAGE,
    runDir,
    casDir,
    onEvent: (_e: RunEvent) => {},
    runCommand: run,
    ...(opts.maxCandidateArtifactEntries !== undefined
      ? { maxCandidateArtifactEntries: opts.maxCandidateArtifactEntries }
      : {}),
  };
  const broker = new Broker(config);
  await broker.init();
  await broker.cas.putBuffer(baselineTar);
  const b: Booted = { broker, log, hostTarSpawns, ctl, runDir, casDir, runId };
  booted.push(b);
  return b;
}

/** Save `tar` from a fresh baseline sandbox (repair path — no exec needed; admission charges either way). */
async function save(b: Booted, tar: Buffer): Promise<string> {
  b.ctl.saveTar = tar;
  const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
  const ref = await b.broker.saveArtifact({ sandboxId }, CLIENT);
  return ref.hash;
}

async function casBlobCount(casDir: string): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (d.isDirectory()) await walk(path.join(dir, d.name));
      else count++;
    }
  };
  await walk(casDir);
  return count;
}

async function journalArtifactLines(runDir: string): Promise<Array<{ hash: string; entries?: number }>> {
  const raw = await readFile(path.join(runDir, "broker-state.ndjson"), "utf8");
  const out: Array<{ hash: string; entries?: number }> = [];
  for (const line of raw.split("\n")) {
    if (line === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (parsed !== null && typeof parsed === "object" && "t" in parsed && parsed.t === "artifact") {
      const hash = "hash" in parsed && typeof parsed.hash === "string" ? parsed.hash : "";
      const entries = "entries" in parsed && typeof parsed.entries === "number" ? parsed.entries : undefined;
      out.push(entries !== undefined ? { hash, entries } : { hash });
    }
  }
  return out;
}

/** One well-formed ustar header: name/prefix/typeflag as given, everything else canonical-zero. */
function rawHeader(name: string, typeflag: string, prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000755\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  h.write("00000000000\0", 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write(typeflag, 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  if (prefix !== "") h.write(prefix, 345, 155, "utf8");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}

beforeAll(async () => {
  await mkdir(tmpBase, { recursive: true });
  const capsule = await buildTestCapsule(path.join(tmpBase, "fixture"), GENEROUS_BUDGET);
  manifest = capsule.manifest;
  capsuleRootDir = capsule.capsuleRootDir;
  const scratchCas = new CasStore(path.join(tmpBase, "fixture", "scratch-cas"));
  const mkTar = async (label: string): Promise<[Buffer, string]> => {
    const dir = path.join(tmpBase, "fixture", `tree-${label}`);
    await mkdir(path.join(dir, "d"), { recursive: true });
    await writeFile(path.join(dir, "d", "x.txt"), label);
    const hash = await packDirAsArtifact(dir, scratchCas);
    return [await scratchCas.readBuffer(hash), hash];
  };
  [baselineTar, baselineHash] = await mkTar("baseline");
  [tarA, hashA] = await mkTar("A");
  [tarB] = await mkTar("B");
  [tarC] = await mkTar("C");
  [tarD] = await mkTar("D");
}, 60_000);

afterAll(async () => {
  for (const b of booted) {
    try {
      await b.broker.close();
    } catch {
      // already closed by a test
    }
  }
  await rm(tmpBase, { recursive: true, force: true });
});

describe("mutation sandbox /workspace tmpfs", () => {
  it("carries a kernel nr_inodes cap: the admission ceiling plus fixed temp headroom", async () => {
    const b = await boot();
    await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const spawn = b.log.find((argv) => argv[1] === "run" && argv.includes("-d")) ?? [];
    expect(spawn.length).toBeGreaterThan(0);
    const wsTmpfs = spawn.find((a) => a.startsWith("/workspace:"));
    expect(wsTmpfs).toBeDefined();
    // The kernel refuses inode number cap+1 at write time. The cap is the
    // admission ceiling plus FIXED headroom (tmpfs root + transient temp
    // files), so an exactly-admitted MAX_ARTIFACT_ENTRIES tree can still
    // extract and mutate while saveArtifact enforces the exact archive cap.
    expect(WORKSPACE_TMPFS_INODES).toBe(MAX_ARTIFACT_ENTRIES + 1024);
    expect(wsTmpfs).toContain(`nr_inodes=${WORKSPACE_TMPFS_INODES}`);
    expect(spawn[spawn.indexOf(wsTmpfs ?? "") - 1]).toBe("--tmpfs");
  });
});

describe("aggregate candidate entry budget", () => {
  it("charges admissions, rejects the overflowing artifact, and leaves CAS untouched on rejection", async () => {
    // Each candidate canonicalizes to exactly 3 entries (workspace, d, d/x.txt).
    const b = await boot({ maxCandidateArtifactEntries: 7 });
    const savedA = await save(b, tarA); // 3/7
    const savedB = await save(b, tarB); // 6/7
    const blobsBefore = await casBlobCount(b.casDir);
    await expect(save(b, tarC)).rejects.toThrow(/candidate artifact entry cap reached \(7\)/); // 9 > 7
    // Admission is charged BEFORE the canonical blob is stored: the rejected
    // candidate must not grow CAS, the journal, or the unpack cache.
    expect(await casBlobCount(b.casDir)).toBe(blobsBefore);
    const lines = await journalArtifactLines(b.runDir);
    expect(lines.map((l) => l.hash).sort()).toEqual([savedA, savedB].sort());
    expect(lines.every((l) => l.entries === 3)).toBe(true);
    expect(await readdir(path.join(b.runDir, "unpacked")).catch(() => [])).toEqual([]); // nothing ever unpacked
  });

  it("survives resume: the replayed charge still blocks the next admission", async () => {
    const b = await boot({ maxCandidateArtifactEntries: 7 });
    await save(b, tarA);
    await save(b, tarB); // 6/7 charged and journaled
    await b.broker.close();

    const resumed = await boot({
      runId: b.runId,
      runDir: b.runDir,
      casDir: b.casDir,
      maxCandidateArtifactEntries: 7,
    });
    // A restart must replay to EXACTLY the charged budget — a fresh in-memory
    // counter would grant the whole quota again.
    await expect(save(resumed, tarD)).rejects.toThrow(/candidate artifact entry cap reached \(7\)/);
    // Re-saving an already-admitted hash is idempotent: no second charge.
    expect(await save(resumed, tarA)).toBe(hashA);
    expect((await journalArtifactLines(resumed.runDir)).length).toBe(2);
  });

  it("never charges the trusted baseline artifact", async () => {
    // Budget of 1 entry: ANY candidate charge would overflow instantly.
    const b = await boot({ maxCandidateArtifactEntries: 1 });
    const saved = await save(b, baselineTar);
    expect(saved).toBe(baselineHash);
    expect(await journalArtifactLines(b.runDir)).toEqual([]);
  });

  it("refuses to boot from a journal that already exceeds the entry quota", async () => {
    const id = randomBytes(4).toString("hex");
    const runDir = path.join(tmpBase, "runs", `hostile-${id}`);
    await mkdir(runDir, { recursive: true });
    const lineOf = (fill: string, entries: number): string =>
      `${JSON.stringify({ t: "artifact", hash: `sha256:${fill.repeat(64)}`, bytes: 100, entries })}\n`;
    await writeFile(path.join(runDir, "broker-state.ndjson"), lineOf("a", 4) + lineOf("b", 4));
    await expect(boot({ runDir, maxCandidateArtifactEntries: 7 })).rejects.toThrow(
      /run state log exceeds the configured candidate artifact quota/,
    );
  });

  it("rejects a depth-bomb archive from a sandbox before any host extraction, with zero CAS growth", async () => {
    const b = await boot();
    // 67-component path, delivered via the ustar prefix field so the header
    // itself is well-formed — only the depth ceiling can reject it.
    b.ctl.saveTar = Buffer.concat([
      rawHeader("workspace/", "5"),
      rawHeader("z", "0", `workspace${"/a".repeat(65)}`),
      Buffer.alloc(1024),
    ]);
    const { sandboxId } = await b.broker.createSandbox({ artifact: { hash: baselineHash }, role: "mutation" }, CLIENT);
    const blobsBefore = await casBlobCount(b.casDir);
    const tarSpawnsBefore = b.hostTarSpawns.length;
    await expect(b.broker.saveArtifact({ sandboxId }, CLIENT)).rejects.toThrow(/exceeds 64 components/);
    expect(await casBlobCount(b.casDir)).toBe(blobsBefore);
    // Validation failed CLOSED before canonicalization ever spawned host tar.
    expect(b.hostTarSpawns.length).toBe(tarSpawnsBefore);
  });
});
