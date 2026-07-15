import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest, RunEvent } from "@hone/schema";
import { writeCas } from "../src/cas.js";
import { deferred } from "../src/promise.js";
import type { CmdIo } from "../src/io.js";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
export const mainTs = join(pkgRoot, "src", "main.ts");

export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "hone-cli-"));
}

export const CAP_ID = "cap_00000000abcd";

/** Raw manifest JSON — deliberately unvalidated so tests can feed the CLI broken capsules. */
export function manifestRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: CAP_ID,
    objective: "Make the fixture task measurably better while keeping every test green.",
    baseline: { kind: "git", commit: "0123456789abcdef0123456789abcdef01234567" },
    image: `hone-task@sha256:${"a".repeat(64)}`,
    evalEntrypoint: ["python3", "/capsule/eval.py"],
    protectedPaths: ["protected/keep.txt"],
    assetGroups: [
      { id: "train", visibility: "public", paths: ["assets/train"] },
      { id: "validation", visibility: "protected", paths: ["assets/validation"] },
    ],
    budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
    contentHashes: { "assets/train": `sha256:${"b".repeat(64)}` },
    ...overrides,
  };
}

export function manifestObject(): CapsuleManifest {
  return CapsuleManifest.parse(manifestRaw());
}

export function makeCapsule(root: string, overrides: Record<string, unknown> = {}): string {
  const dir = join(root, "capsule");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifestRaw(overrides), null, 2));
  return dir;
}

/** seed must be lowercase hex chars. */
export function fakeHash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function hone(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CliResult> {
  const { promise, resolve, reject } = deferred<CliResult>();
  const child = spawn(tsxBin, [mainTs, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  return promise;
}

/** Spawn without waiting — caller drives lifecycle (kill tests). Detached so the whole tree can be nuked. */
export function honeSpawn(args: string[], opts: { cwd: string; env?: Record<string, string> }): ChildProcess {
  return spawn(tsxBin, [mainTs, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
  });
}

/** SIGKILL the child's whole process group (tsx nests a node child). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Build a broker-convention artifact tar (files nested under a single
 * `workspace/` root, packed by the real host tar) and store it in the root
 * CAS; returns the sha256:<hex> hash.
 */
export function tarToCas(root: string, files: Record<string, string>): string {
  const stage = mkdtempSync(join(tmpdir(), "hone-stage-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(stage, "workspace", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const tarPath = join(mkdtempSync(join(tmpdir(), "hone-tarout-")), "artifact.tar");
  // Same host-metadata stripping as the broker's packDirAsArtifact — real
  // artifacts never carry AppleDouble (._*) entries or xattr pax records.
  const metaFlags =
    process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata", "--no-acls", "--no-fflags"] : ["--no-xattrs"];
  const r = spawnSync("tar", ["-C", stage, ...metaFlags, "-cf", tarPath, "workspace"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return writeCas(join(root, ".hone-cas"), readFileSync(tarPath));
}

export interface RawTarEntry {
  name: string;
  /** ustar typeflag: "0" file (default), "5" dir, "1" hardlink, "2" symlink, "x" pax, "L" GNU longname… */
  type?: string;
  content?: string;
  linkname?: string;
}

/** Byte-level ustar builder — expresses adversarial layouts host tar refuses to create. */
export function buildTar(entries: RawTarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100); // mode
    header.write("0000000\0", 108); // uid
    header.write("0000000\0", 116); // gid
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124); // size
    header.write("00000000000\0", 136); // mtime
    header.fill(0x20, 148, 156); // checksum placeholder = spaces
    header.write(entry.type ?? "0", 156, 1, "utf8");
    if (entry.linkname !== undefined) header.write(entry.linkname, 157, 100, "utf8");
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

export function writeEvents(root: string, runId: string, events: unknown[]): string {
  const dir = join(root, ".hone-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "events.ndjson"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return dir;
}

export function readLogLines(root: string, runId: string): string[] {
  return readFileSync(join(root, ".hone-runs", runId, "events.ndjson"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

export function at(): string {
  return new Date().toISOString();
}

const FIX_BUDGET = { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 };

/** A schema-valid single-episode run log with a real incumbent + budget snapshot. */
export function fixtureEvents(opts: {
  runId: string;
  baselineHash: string;
  bestHash: string;
  finished: boolean;
}): RunEvent[] {
  const base = { runId: opts.runId };
  const events: RunEvent[] = [
    { ...base, at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: fakeHash("c"), optimizerDigest: "unpinned" },
    { ...base, at: at(), type: "episode.started", episode: 0, parent: { hash: opts.baselineHash } },
    { ...base, at: at(), type: "episode.candidate", episode: 0, candidate: { hash: opts.bestHash }, sessionTrace: fakeHash("e") },
    { ...base, at: at(), type: "eval.completed", episode: 0, artifact: { hash: opts.bestHash }, assetGroupId: "validation", seed: 0, aggregate: 0.62, cached: false },
    { ...base, at: at(), type: "gate.paired", episode: 0, parentScore: 0.5, childScore: 0.62, passed: true },
    { ...base, at: at(), type: "incumbent.new", artifact: { hash: opts.bestHash }, aggregate: 0.62, deltaVsBaseline: 0.12, episode: 0 },
    { ...base, at: at(), type: "budget.snapshot", budget: { envelope: FIX_BUDGET, spent: { tokens: 4200, usd: 1.25, wallClockSec: 12, evaluatorInvocations: 2 } } },
  ];
  if (opts.finished) {
    events.push({ ...base, at: at(), type: "run.finished", best: { hash: opts.bestHash }, status: "completed" });
  }
  return events;
}

export interface CapturedIo {
  io: CmdIo;
  out: string[];
  err: string[];
}

export function makeIo(root: string, env: Record<string, string | undefined> = {}): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mergedEnv[k];
  }
  return {
    io: {
      root,
      env: mergedEnv,
      isTTY: false,
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    },
    out,
    err,
  };
}

function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Scratch git repo with one baseline commit (hello.txt = "baseline\n"). Local identity only. */
export function initScratchRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "hone-test");
  git(dir, "config", "user.email", "hone-test@localhost");
  writeFileSync(join(dir, "hello.txt"), "baseline\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "baseline");
}

export { git as gitIn };
