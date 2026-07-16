import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest, RunEvent, capsuleDigest, deriveCapsuleId } from "@hone/schema";
import type { RunCommand } from "@hone/broker";
import type { OptimizerChildLike, OptimizerRuntime, OptimizerSpawn, OptimizerTransport } from "../src/backends/optimizer-container.js";
import { openDockerCreateGate, type DockerCreateGate, type DockerCreateHelper } from "../src/docker-create-gate.js";
import { writeCas } from "../src/cas.js";
import { contractHash } from "../src/contract.js";
import { computeOptimizerDigest } from "../src/optimizer-digest.js";
import { deferred } from "../src/promise.js";
import type { CmdIo } from "../src/io.js";

export const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
export const mainTs = join(pkgRoot, "src", "main.ts");

export function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "hone-cli-"));
}

/** Immutable fixture image (v2 schema: repo@sha256 only). */
export const FIX_IMAGE = `hone-task@sha256:${"a".repeat(64)}`;

function sha256Of(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

const TRAIN_CONTENT = "train\n";
const VAL_CONTENT = "val\n";

/** A schema-valid persisted ordering report with zero failures (admission accepts it). */
export function orderingReportRaw(): Record<string, unknown> {
  const variant = (train: number, validation: number): Record<string, unknown> => ({
    train,
    validation,
    combined: (train + validation) / 2,
    trainTestsPass: true,
    validationTestsPass: true,
  });
  return {
    version: 1,
    variants: {
      baseline: variant(0.5, 0.5),
      broken: variant(0.1, 0.1),
      naive: variant(0.3, 0.3),
      shortcut: { train: 0.9, validation: 0.2, combined: 0.55, trainTestsPass: true, validationTestsPass: false },
      improved: variant(0.7, 0.7),
    },
    stability: { aggregates: [0.5, 0.5, 0.5], spread: 0, band: 0.15 },
    failures: [],
  };
}

export const ORDERING_REPORT_JSON = `${JSON.stringify(orderingReportRaw(), null, 2)}\n`;
export const ORDERING_REPORT_PATH = "diagnostics/ordering-report.json";

/**
 * Raw manifest JSON — deliberately unvalidated so tests can feed the CLI
 * broken capsules. The id is content-derived AFTER overrides (pass `id` to
 * break identity on purpose). Content references exactly the files
 * makeCapsule writes, so a default capsule passes frozen admission.
 */
export function manifestRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 2,
    objective: "Make the fixture task measurably better while keeping every test green.",
    baseline: { kind: "cas", hash: fakeHash("b") },
    image: FIX_IMAGE,
    evalEntrypoint: ["python3", "/capsule/eval.py"],
    protectedPaths: ["protected/keep.txt"],
    assetGroups: [
      { id: "train", visibility: "public", paths: ["assets/train/data.txt"] },
      { id: "validation", visibility: "protected", paths: ["assets/validation/data.txt"] },
    ],
    budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
    diagnosticOrdering: { path: ORDERING_REPORT_PATH, hash: sha256Of(ORDERING_REPORT_JSON) },
    contentHashes: {
      "assets/train/data.txt": sha256Of(TRAIN_CONTENT),
      "assets/validation/data.txt": sha256Of(VAL_CONTENT),
    },
    ...overrides,
  };
  if (base["id"] === undefined) base["id"] = deriveCapsuleId(base);
  return base;
}

/** The default fixture capsule's content-derived id. */
export const CAP_ID = String(manifestRaw()["id"]);

/** The computed default-optimizer digest for the fixture image — what runCommand seals. */
export const FIX_OPTIMIZER_DIGEST = computeOptimizerDigest(FIX_IMAGE);

export function manifestObject(): CapsuleManifest {
  return CapsuleManifest.parse(manifestRaw());
}

/** A capsule directory that passes frozen admission (assets + hashed ordering report on disk). */
export function makeCapsule(root: string, overrides: Record<string, unknown> = {}): string {
  const dir = join(root, "capsule");
  mkdirSync(join(dir, "assets", "train"), { recursive: true });
  mkdirSync(join(dir, "assets", "validation"), { recursive: true });
  mkdirSync(join(dir, "diagnostics"), { recursive: true });
  writeFileSync(join(dir, "assets", "train", "data.txt"), TRAIN_CONTENT);
  writeFileSync(join(dir, "assets", "validation", "data.txt"), VAL_CONTENT);
  writeFileSync(join(dir, ORDERING_REPORT_PATH), ORDERING_REPORT_JSON);
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

/**
 * A settled, traced proxy dispatch journal whose cumulative charge matches
 * fixtureEvents' budget.snapshot spend (4200 tokens / $1.25 by default).
 * Stop's dispatch-authority gate requires the journal for any run whose
 * trusted budget authority recorded proxy spend.
 */
export function writeAlignedDispatchJournal(
  root: string,
  runId: string,
  opts: { tokens?: number; usd?: number } = {},
): string {
  const dir = join(root, ".hone-runs", runId);
  mkdirSync(dir, { recursive: true });
  const tokens = opts.tokens ?? 4200;
  const usd = opts.usd ?? 1.25;
  const intent = {
    v: 1,
    kind: "intent",
    id: "d_fixture",
    runId,
    role: "mutation",
    model: "m",
    requestAt: at(),
    requestSha256: "0".repeat(64),
    promptTokens: Math.max(tokens - 1, 0),
    completionTokens: 1,
    ceilTokens: tokens,
    ceilUsd: usd,
  };
  const settle = { v: 1, kind: "settle", id: "d_fixture", tokens, usd, outcome: "usage", traced: true };
  const path = join(dir, "proxy-dispatch.ndjson");
  writeFileSync(path, `${JSON.stringify(intent)}\n${JSON.stringify(settle)}\n`);
  return path;
}

/**
 * Minimal contract binding a snapshot manifest's identity — exactly the
 * lines authenticateCapsuleSnapshot requires the approved text to carry.
 */
export function fixtureContractFor(manifest: Record<string, unknown>): string {
  const parsed = CapsuleManifest.parse(manifest);
  const baseline =
    parsed.baseline.kind === "git" ? `- git commit \`${parsed.baseline.commit}\`` : `- cas artifact \`${parsed.baseline.hash}\``;
  return ["# Hone Run Contract (fixture)", `- capsule: \`${parsed.id}\``, `- capsule digest: \`${capsuleDigest(parsed)}\``, baseline, ""].join("\n");
}

/**
 * Seal `manifest` as the run's capsule snapshot and BIND it the way a real
 * run is bound: a contract.md carrying the snapshot identity, and the
 * run.started line (if already written) patched to seal that contract hash
 * + capsule id. Delivery authenticates the snapshot against exactly these
 * seals.
 */
export function bindSnapshotFixture(root: string, runId: string, manifest: Record<string, unknown>): void {
  const dir = join(root, ".hone-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "capsule-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const contract = fixtureContractFor(manifest);
  writeFileSync(join(dir, "contract.md"), contract);
  const eventsFile = join(dir, "events.ndjson");
  if (existsSync(eventsFile)) {
    const patched = readFileSync(eventsFile, "utf8")
      .split("\n")
      .map((line) => {
        if (line.trim() === "") return line;
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (raw["type"] !== "run.started") return line;
        return JSON.stringify({ ...raw, capsuleId: manifest["id"], contractHash: contractHash(contract) });
      })
      .join("\n");
    writeFileSync(eventsFile, patched);
  }
}

/** Seal a git-baseline capsule snapshot into the run dir with an explicit frozen baseline commit (bound; see bindSnapshotFixture). */
export function sealBaselineCommitSnapshot(root: string, runId: string, commit: string): void {
  bindSnapshotFixture(root, runId, manifestRaw({ baseline: { kind: "git", commit } }));
}

/**
 * Git-baseline capsule + delivery target in one: a clean nested worktree at
 * capsule/baseline whose HEAD is the frozen manifest baseline commit. The
 * baseline dir doubles as a valid `--repo` target (its repo root contains
 * the sealed commit), which `hone run --apply …` now REQUIRES at creation.
 */
export function makeGitBaselineCapsule(
  root: string,
  overrides: Record<string, unknown> = {},
): { capsuleDir: string; baselineDir: string; commit: string } {
  const baselineDir = join(root, "capsule", "baseline");
  initScratchRepo(baselineDir);
  const commit = git(baselineDir, "rev-parse", "HEAD");
  const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit }, ...overrides });
  return { capsuleDir, baselineDir, commit };
}

/**
 * Seal a git-baseline capsule snapshot into the run dir, binding `repo`'s
 * HEAD as the frozen manifest baseline commit — what a real admission
 * writes, and what manual delivery validates the --repo target against.
 * Returns the sealed commit.
 */
export function sealGitBaselineSnapshot(root: string, runId: string, repo: string): string {
  const commit = git(repo, "rev-parse", "HEAD");
  sealBaselineCommitSnapshot(root, runId, commit);
  return commit;
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
  /** Real sealed hash for resume-seal fixtures; defaults to a fake. */
  contractHash?: string;
}): RunEvent[] {
  const base = { runId: opts.runId };
  const events: RunEvent[] = [
    { ...base, at: at(), type: "run.started", capsuleId: CAP_ID, contractHash: opts.contractHash ?? fakeHash("c"), optimizerDigest: FIX_OPTIMIZER_DIGEST },
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

/** Every-call-succeeds RunCommand stub (docker teardown calls etc.). */
export function okRun(): RunCommand {
  return () => Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false });
}

/**
 * In-process stand-in for the DETACHED docker-create helper, driven by the
 * same scripted RunCommand a test injects. Mirrors the real helper's Dekker
 * protocol exactly: publish `started`, check `abort`, invoke docker joined,
 * publish `outcome`. A scripted timedOut result is normalized to the
 * ambiguous signaled-client shape (the real helper never times out).
 */
export function scriptedCreateHelper(run: RunCommand): DockerCreateHelper {
  return async (task) => {
    writeFileSync(task.startedPath, "");
    if (existsSync(task.abortPath)) {
      writeFileSync(task.outcomePath, JSON.stringify({ aborted: true, exitCode: -1, stdout: "", stderr: "" }));
      return;
    }
    let outcome: Record<string, unknown>;
    try {
      const r = await run(task.argv, {});
      outcome = {
        exitCode: r.timedOut ? -1 : r.exitCode,
        stdout: r.stdout.toString("base64"),
        stderr: r.stderr.toString("base64"),
      };
    } catch (err) {
      // A throwing RunCommand models a GENUINE pre-spawn failure: record the
      // explicit never-spawned witness the real helper persists (pid 0).
      outcome = { exitCode: 127, stdout: "", stderr: "", spawnError: String(err), spawnErrorCode: "ENOENT", spawned: false, pid: 0 };
    }
    writeFileSync(task.outcomePath, JSON.stringify(outcome));
  };
}

/**
 * Fake optimizer spawn modelling the production TWO-PHASE launch: a
 * `docker create` of the manifest image (recorded; a scripted client emits a
 * fake id and exits 0) followed by `docker start -a <name>`, which executes
 * the CONTAINER argv recorded at create time as a host process with ONLY the
 * env the container would have seen (-e K=V pairs, plus value-less -e
 * resolved from the docker CREATE client env — exactly docker's semantics:
 * container env is baked at create). Lifecycle (stdout piping, process-group
 * kill, exit codes) stays real on the start child.
 */
export function fakeOptimizerSpawn(image: string, seen?: { argvs: string[][]; envs: NodeJS.ProcessEnv[] }): OptimizerSpawn {
  const created = new Map<string, { env: Record<string, string>; containerArgv: string[] }>();
  return (cmd, args, opts) => {
    const argv = [cmd, ...args];
    seen?.argvs.push(argv);
    seen?.envs.push(opts.env);
    if (cmd === "docker" && argv[1] === "create") {
      const imageIdx = argv.indexOf(image);
      if (imageIdx < 0) throw new Error(`optimizer create is not of the manifest image: ${argv.join(" ")}`);
      const env: Record<string, string> = {};
      const mounts: [container: string, host: string][] = [];
      for (let i = 2; i < imageIdx; i++) {
        if (argv[i] === "-e") {
          const kv = argv[i + 1] ?? "";
          const eq = kv.indexOf("=");
          if (eq >= 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
          else {
            const passthrough = opts.env[kv];
            if (passthrough !== undefined) env[kv] = passthrough;
          }
        } else if (argv[i] === "-v") {
          const spec = (argv[i + 1] ?? "").split(":");
          if (spec[0] !== undefined && spec[1] !== undefined) mounts.push([spec[1], spec[0]]);
        }
      }
      // Translate mounted container paths back to their host sources (what
      // the container would see) at CREATE time, like docker does.
      const mapPath = (arg: string): string => {
        for (const [container, host] of mounts) {
          if (arg === container) return host;
          if (arg.startsWith(`${container}/`)) return host + arg.slice(container.length);
        }
        return arg;
      };
      const name = argv[argv.indexOf("--name") + 1] ?? "";
      created.set(name, { env, containerArgv: argv.slice(imageIdx + 1).map(mapPath) });
      return scriptedClientChild(`${name.replace(/[^a-zA-Z0-9]/g, "")}cid\n`);
    }
    if (cmd === "docker" && argv[1] === "start") {
      const name = argv[argv.length - 1] ?? "";
      const rec = created.get(name);
      if (rec === undefined) throw new Error(`docker start of a never-created container: ${argv.join(" ")}`);
      const [prog, ...progArgs] = rec.containerArgv;
      if (prog === undefined) throw new Error("optimizer container argv is empty");
      return spawn(prog, progArgs, {
        env: { ...rec.env, PATH: process.env["PATH"] ?? "" },
        stdio: opts.stdio,
        detached: opts.detached,
      });
    }
    throw new Error(`optimizer launch is not a two-phase docker create/start of the manifest image: ${argv.join(" ")}`);
  };
}

/** Scripted docker CLIENT child (create phase): emits stdout/stderr, then closes with the given code. */
export function scriptedClientChild(stdout: string, code = 0, stderr = ""): OptimizerChildLike {
  const out = new PassThrough();
  const errStream = new PassThrough();
  const closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const child: OptimizerChildLike = {
    pid: undefined,
    stdout: out,
    stderr: errStream,
    kill: () => false,
    on(event: "error" | "close", cb: unknown): unknown {
      if (event === "close") closeListeners.push(cb as (code: number | null, signal: NodeJS.Signals | null) => void);
      return child;
    },
  };
  setImmediate(() => {
    out.end(stdout);
    errStream.end(stderr);
    setImmediate(() => {
      for (const cb of closeListeners) cb(code, null);
    });
  });
  return child;
}

/** A ready OptimizerRuntime for direct runOptimizer tests (no build; scripted argv; real WAL gate over a temp dir). */
export function testOptimizerRuntime(opts: {
  runId: string;
  argv: string[];
  image?: string;
  transport?: OptimizerTransport;
  run?: RunCommand;
  spawnImpl?: OptimizerSpawn;
  containerLease?: string;
  clientEnv?: NodeJS.ProcessEnv;
  gate?: DockerCreateGate;
}): OptimizerRuntime {
  const image = opts.image ?? FIX_IMAGE;
  const safeRunId = opts.runId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const runtime: OptimizerRuntime = {
    image,
    runId: opts.runId,
    safeRunId,
    transport: opts.transport ?? { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
    bundleDir: null,
    bundleSeal: null,
    runArgv: opts.argv,
    spawnImpl: opts.spawnImpl ?? fakeOptimizerSpawn(image),
    run: opts.run ?? okRun(),
    spawnedNames: [],
    invocation: 0,
    containerLease: opts.containerLease ?? `hone-lease-${safeRunId}-e1`,
    gate: opts.gate ?? openDockerCreateGate(mkdtempSync(join(tmpdir(), "hone-gate-")), opts.runId),
    clientEnv: opts.clientEnv ?? { PATH: process.env["PATH"] ?? "" },
    cleanup: () => Promise.resolve(),
  };
  return runtime;
}
