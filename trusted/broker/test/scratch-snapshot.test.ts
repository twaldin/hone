import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapsuleManifest } from "@hone/schema";
import {
  Broker,
  SCRATCH_INODE_LIMIT,
  SCRATCH_SNAPSHOT_DEADLINE_SEC,
  SCRATCH_SNAPSHOT_SCRIPT,
  SCRATCH_SNAPSHOT_TMP_PREFIX,
  finalizeScratchSnapshot,
  newScratchSnapshotAttemptName,
  scratchSnapshotArchiveCapBytes,
  type BrokerConfig,
} from "../src/broker.js";
import { CasStore, durability } from "../src/cas.js";
import { packDirAsArtifact } from "../src/artifact.js";
import { runCommand, type CmdResult, type RunCommand } from "../src/command.js";
import {
  TEST_CAPSULE_DIGEST,
  TEST_IMAGE,
  TEST_OPTIMIZER_DIGEST,
  buildTestCapsule,
  ensureImage,
  waitForDocker,
} from "./helpers.js";

// Repo-relative base so Docker Desktop file sharing covers bind mounts.
const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpBase = path.join(pkgDir, ".test-tmp", `scratch-${randomBytes(4).toString("hex")}`);

const BUDGET = { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 3_600, maxEvaluatorInvocations: 100 };

afterAll(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

function fakeRes(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

interface FakeDockerHarness {
  broker: Broker;
  runDir: string;
  calls: string[][];
  baselineHash: string;
  keeperName: string;
  /** HONE_SCRATCH_SNAPSHOT_OUT basename of each snapshot exec, in order. */
  snapshotNames: string[];
}

/**
 * Broker over a fake docker CLI: volume/keeper/sandbox creation succeed,
 * `docker rm -f <id>` fails for ids in `failRemove`, and the snapshot exec
 * writes the per-attempt output the exec's HONE_SCRATCH_SNAPSHOT_OUT names —
 * exactly like the real keeper would (overridable via `snapshotExec`).
 */
async function makeFakeDockerBroker(
  name: string,
  opts: {
    failRemove?: ReadonlySet<string>;
    containerLease?: string;
    scratchQuotaBytes?: number;
    /** Per-attempt override of the snapshot exec; receives the attempt basename, 1-based attempt ordinal, host snapshot dir, and all names so far. */
    snapshotExec?: (ctx: { name: string; attempt: number; snapshotDir: string; names: readonly string[] }) => Promise<CmdResult> | CmdResult;
  } = {},
): Promise<FakeDockerHarness> {
  const base = path.join(tmpBase, "fake", name);
  const runDir = path.join(base, "run");
  await mkdir(runDir, { recursive: true });
  const capsule = await buildTestCapsule(base, BUDGET);
  const cas = new CasStore(path.join(base, "cas"));
  const baselineHash = await packDirAsArtifact(capsule.baselineDir, cas);
  const manifest: CapsuleManifest = { ...capsule.manifest, baseline: { kind: "cas", hash: baselineHash } };
  const calls: string[][] = [];
  const snapshotNames: string[] = [];
  const snapshotDir = path.join(runDir, "scratch-snapshot");
  let cid = 0;
  const run: RunCommand = (argv) => {
    calls.push([...argv]);
    if (argv[0] !== "docker") return Promise.resolve(fakeRes());
    if (argv[1] === "run") return Promise.resolve(fakeRes({ stdout: Buffer.from(`cid-${++cid}\n`) }));
    if (argv[1] === "rm" && argv[2] === "-f" && opts.failRemove?.has(argv[3] ?? "")) {
      return Promise.resolve(fakeRes({ exitCode: 1, stderr: Buffer.from("cannot remove: device busy") }));
    }
    if (argv[1] === "exec" && argv.includes(SCRATCH_SNAPSHOT_SCRIPT)) {
      const outEnv = argv.find((a) => a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
      if (outEnv === undefined) {
        return Promise.resolve(fakeRes({ exitCode: 1, stderr: Buffer.from("HONE_SCRATCH_SNAPSHOT_OUT: parameter not set") }));
      }
      const attemptName = outEnv.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length);
      const attempt = snapshotNames.push(attemptName);
      if (opts.snapshotExec !== undefined) {
        return Promise.resolve(opts.snapshotExec({ name: attemptName, attempt, snapshotDir, names: snapshotNames }));
      }
      // The in-container script only writes ITS OWN per-attempt temp; the
      // trusted host publishes it afterwards.
      return (async () => {
        await writeFile(path.join(snapshotDir, attemptName), "fake-tar-bytes");
        return fakeRes();
      })();
    }
    return Promise.resolve(fakeRes());
  };
  const config: BrokerConfig = {
    runId: `run-${name}`,
    manifest,
    capsuleRootDir: capsule.capsuleRootDir,
    baselineArtifactHash: baselineHash,
    capsuleDigest: TEST_CAPSULE_DIGEST,
    optimizerDigest: TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: path.join(runDir, "holdout-ledger.ndjson"),
    image: TEST_IMAGE,
    runDir,
    casDir: path.join(base, "cas"),
    onEvent: () => {},
    scratchVolume: true,
    runCommand: run,
    ...(opts.containerLease !== undefined ? { containerLease: opts.containerLease } : {}),
    ...(opts.scratchQuotaBytes !== undefined ? { scratchQuotaBytes: opts.scratchQuotaBytes } : {}),
  };
  const broker = new Broker(config);
  await broker.init();
  return { broker, runDir, calls, baselineHash, keeperName: `hone-scratch-keeper-run-${name}`, snapshotNames };
}

const findCall = (calls: string[][], ...prefix: string[]): number =>
  calls.findIndex((c) => prefix.every((p, i) => c[i] === p));

const hasPair = (argv: readonly string[], flag: string, value: string): boolean =>
  argv.some((a, i) => a === flag && argv[i + 1] === value);

describe("scratch snapshot bounds (kernel cap + deadline wired into the keeper)", () => {
  it("derives the archive cap from quota + inode allowance and bakes cap/deadline into the keeper env", async () => {
    const quota = 4096;
    const cap = scratchSnapshotArchiveCapBytes(quota);
    expect(cap).toBe(quota + SCRATCH_INODE_LIMIT * 2048 + 10240);
    // The in-container deadline must sit strictly below the 300s host exec timeout.
    expect(SCRATCH_SNAPSHOT_DEADLINE_SEC * 1000).toBeLessThan(300_000);

    const h = await makeFakeDockerBroker("bounds", { scratchQuotaBytes: quota, containerLease: "hone-lease-x" });
    const volumeCreate = h.calls[findCall(h.calls, "docker", "volume", "create")];
    expect(volumeCreate).toContain(`o=size=${quota},nr_inodes=${SCRATCH_INODE_LIMIT}`);

    const keeperRun = h.calls[findCall(h.calls, "docker", "run", "-d", "--name", h.keeperName)];
    expect(keeperRun).toBeDefined();
    expect(hasPair(keeperRun ?? [], "-e", `HONE_SCRATCH_QUOTA_BYTES=${quota}`)).toBe(true);
    expect(hasPair(keeperRun ?? [], "-e", `HONE_SCRATCH_SNAPSHOT_MAX_BYTES=${cap}`)).toBe(true);
    expect(hasPair(keeperRun ?? [], "-e", `HONE_SCRATCH_SNAPSHOT_DEADLINE_SEC=${SCRATCH_SNAPSHOT_DEADLINE_SEC}`)).toBe(true);
    expect(hasPair(keeperRun ?? [], "--volumes-from", "hone-lease-x:ro")).toBe(true);
    expect(hasPair(keeperRun ?? [], "--cap-add", "DAC_OVERRIDE")).toBe(true);
    // GNU tar restores ownership before final modes. The trusted keeper must
    // retain FOWNER or a production uid-1000 scratch tree cannot resume.
    expect(hasPair(keeperRun ?? [], "--cap-add", "FOWNER")).toBe(true);

    // The script itself enforces the kernel cap via ulimit and bounds the
    // WHOLE sequence (preflight + tar + rename) with the group watchdog. It
    // writes ONLY the per-attempt output named by HONE_SCRATCH_SNAPSHOT_OUT;
    // the final scratch.tar name is never touched in-container: publication
    // is the trusted host's job.
    expect(SCRATCH_SNAPSHOT_SCRIPT).toContain("ulimit -f");
    expect(SCRATCH_SNAPSHOT_SCRIPT).toContain("HONE_SCRATCH_SNAPSHOT_MAX_BYTES");
    expect(SCRATCH_SNAPSHOT_SCRIPT).toContain("HONE_SCRATCH_SNAPSHOT_DEADLINE_SEC");
    expect(SCRATCH_SNAPSHOT_SCRIPT).toContain("HONE_SCRATCH_SNAPSHOT_OUT");
    expect(SCRATCH_SNAPSHOT_SCRIPT).toContain("kill -9 0");
    expect(SCRATCH_SNAPSHOT_SCRIPT).not.toMatch(/scratch\.tar(?!\.tmp)/);

    // close(): snapshot exec runs with a fresh unguessable per-attempt
    // basename passed via env, then the HOST publishes exactly that output.
    await h.broker.close();
    expect(findCall(h.calls, "docker", "exec")).toBeGreaterThanOrEqual(0);
    expect(h.snapshotNames).toHaveLength(1);
    const attemptName = h.snapshotNames[0] ?? "";
    expect(attemptName).toMatch(new RegExp(`^${SCRATCH_SNAPSHOT_TMP_PREFIX.replace(/\./g, "\\.")}[0-9a-f]{32}$`));
    const snapshotExec = h.calls.find((c) => c.includes(SCRATCH_SNAPSHOT_SCRIPT));
    expect(hasPair(snapshotExec ?? [], "-e", `HONE_SCRATCH_SNAPSHOT_OUT=${attemptName}`)).toBe(true);
    expect((await readFile(path.join(h.runDir, "scratch-snapshot", "scratch.tar"), "utf8"))).toBe("fake-tar-bytes");
    // Nothing but the published snapshot survives: the attempt temp is swept.
    expect(await readdir(path.join(h.runDir, "scratch-snapshot"))).toEqual(["scratch.tar"]);
  });

  it("attaches the docker-run lease to mutation sandbox containers", async () => {
    const h = await makeFakeDockerBroker("lease-sb", { containerLease: "hone-lease-y" });
    await h.broker.createSandbox({ artifact: { hash: h.baselineHash }, role: "mutation" }, { privileged: false });
    const sandboxRun = h.calls.find(
      (c) => c[0] === "docker" && c[1] === "run" && c.some((a) => a.includes("-sb_")),
    );
    expect(sandboxRun).toBeDefined();
    expect(hasPair(sandboxRun ?? [], "--volumes-from", "hone-lease-y:ro")).toBe(true);
    await h.broker.close();
  });

  it("close() skips snapshot, keeper removal, and volume removal while any work container cannot be reaped", async () => {
    // cid-2 is the mutation sandbox (cid-1 is the keeper).
    const h = await makeFakeDockerBroker("fence", { failRemove: new Set(["cid-2"]) });
    await h.broker.createSandbox({ artifact: { hash: h.baselineHash }, role: "mutation" }, { privileged: false });
    await expect(h.broker.close()).rejects.toThrow(/containers still live/);
    // A possibly-still-writing container means the scratch authority must be
    // preserved intact for the next strict resume sweep: no snapshot exec, no
    // keeper removal, no volume removal.
    expect(h.calls.some((c) => c.includes(SCRATCH_SNAPSHOT_SCRIPT))).toBe(false);
    expect(findCall(h.calls, "docker", "rm", "-f", h.keeperName)).toBe(-1);
    expect(findCall(h.calls, "docker", "volume", "rm")).toBe(-1);
  });
});

describe("per-attempt snapshot outputs (a late-writing orphaned exec is inert)", () => {
  it("a stale archive published late by a timed-out attempt can never SATISFY the next attempt", async () => {
    const h = await makeFakeDockerBroker("late-satisfy", {
      snapshotExec: async ({ attempt, snapshotDir, names }) => {
        // Attempt 1: the host exec times out; the in-container work is
        // orphaned but still alive.
        if (attempt === 1) return fakeRes({ exitCode: -1, timedOut: true });
        // Attempt 2: the ORPHAN lands its completed stale archive late —
        // under the only basename it was ever told (attempt 1's) — while
        // attempt 2's own tar produces nothing (killed before its rename).
        await writeFile(path.join(snapshotDir, names[0] ?? ""), "stale-orphan-bytes");
        return fakeRes();
      },
    });
    await expect(h.broker.close()).rejects.toThrow(/scratch snapshot failed/);
    await expect(h.broker.close()).rejects.toThrow(/scratch snapshot finalize failed/);
    // Two attempts, two distinct unguessable basenames.
    expect(h.snapshotNames).toHaveLength(2);
    expect(h.snapshotNames[0]).not.toBe(h.snapshotNames[1]);
    // Fail closed: the stale orphan bytes were NOT published, and the sweep
    // removed them — nothing stale survives to satisfy a later attempt.
    const snapshotDir = path.join(h.runDir, "scratch-snapshot");
    await expect(stat(path.join(snapshotDir, "scratch.tar"))).rejects.toThrow();
    expect(await readdir(snapshotDir)).toEqual([]);
  });

  it("a stale archive published late by a timed-out attempt can never OVERWRITE the next attempt's output", async () => {
    const h = await makeFakeDockerBroker("late-overwrite", {
      snapshotExec: async ({ name, attempt, snapshotDir, names }) => {
        if (attempt === 1) return fakeRes({ exitCode: -1, timedOut: true });
        // Attempt 2 completes its own archive; THEN the attempt-1 orphan's
        // rename lands, after attempt 2's but before the host publishes —
        // the exact interleaving that clobbered a shared temp basename.
        await writeFile(path.join(snapshotDir, name), "fresh-attempt-bytes");
        await writeFile(path.join(snapshotDir, names[0] ?? ""), "stale-orphan-bytes");
        return fakeRes();
      },
    });
    await expect(h.broker.close()).rejects.toThrow(/scratch snapshot failed/);
    await h.broker.close();
    expect(h.snapshotNames).toHaveLength(2);
    expect(h.snapshotNames[0]).not.toBe(h.snapshotNames[1]);
    // The host published exactly attempt 2's output; the orphan's late write
    // is inert garbage and the sweep removed it.
    const snapshotDir = path.join(h.runDir, "scratch-snapshot");
    expect(await readFile(path.join(snapshotDir, "scratch.tar"), "utf8")).toBe("fresh-attempt-bytes");
    expect(await readdir(snapshotDir)).toEqual(["scratch.tar"]);
  });
});

describe("finalizeScratchSnapshot power-loss ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes fsync(attempt temp) → rename → fsync(parent dir), atomically replacing the previous snapshot", async () => {
    const dir = path.join(tmpBase, "finalize", "ok");
    await mkdir(dir, { recursive: true });
    const attemptName = newScratchSnapshotAttemptName();
    await writeFile(path.join(dir, "scratch.tar"), "previous");
    await writeFile(path.join(dir, attemptName), "next");

    const order: string[] = [];
    const origSyncFile = durability.syncFile;
    const origRename = durability.rename;
    const origSyncDir = durability.syncDir;
    vi.spyOn(durability, "syncFile").mockImplementation(async (p) => {
      order.push(`syncFile:${path.basename(p)}`);
      return origSyncFile(p);
    });
    vi.spyOn(durability, "rename").mockImplementation(async (from, to) => {
      order.push(`rename:${path.basename(from)}->${path.basename(to)}`);
      return origRename(from, to);
    });
    vi.spyOn(durability, "syncDir").mockImplementation(async (p) => {
      order.push(`syncDir:${path.basename(p)}`);
      return origSyncDir(p);
    });

    await finalizeScratchSnapshot(dir, attemptName);
    // The temp bytes are durable BEFORE the rename publishes them, and the
    // rename is durable (dir fsync) before the caller may thaw or journal.
    expect(order).toEqual([
      `syncFile:${attemptName}`,
      `rename:${attemptName}->scratch.tar`,
      "syncDir:ok",
    ]);
    expect(await readFile(path.join(dir, "scratch.tar"), "utf8")).toBe("next");
    await expect(stat(path.join(dir, attemptName))).rejects.toThrow();
  });

  it("refuses to publish anything but a per-attempt basename (no legacy shared temp, no traversal, no self-rename)", async () => {
    const dir = path.join(tmpBase, "finalize", "names");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "scratch.tar"), "previous");
    await writeFile(path.join(dir, "scratch.tar.tmp"), "legacy-shared");
    for (const bad of ["scratch.tar", "scratch.tar.tmp", `../${newScratchSnapshotAttemptName()}`, `evil/${newScratchSnapshotAttemptName()}`]) {
      await expect(finalizeScratchSnapshot(dir, bad)).rejects.toThrow(/non-attempt snapshot output/);
    }
    expect(await readFile(path.join(dir, "scratch.tar"), "utf8")).toBe("previous");
  });

  it("fails closed when no temp archive exists, leaving the previous snapshot untouched", async () => {
    const dir = path.join(tmpBase, "finalize", "missing");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "scratch.tar"), "previous");
    await expect(finalizeScratchSnapshot(dir, newScratchSnapshotAttemptName())).rejects.toThrow();
    expect(await readFile(path.join(dir, "scratch.tar"), "utf8")).toBe("previous");
  });

  it("a temp fsync failure never publishes the torn archive", async () => {
    const dir = path.join(tmpBase, "finalize", "torn");
    await mkdir(dir, { recursive: true });
    const attemptName = newScratchSnapshotAttemptName();
    await writeFile(path.join(dir, "scratch.tar"), "previous");
    await writeFile(path.join(dir, attemptName), "torn-bytes");
    vi.spyOn(durability, "syncFile").mockRejectedValue(new Error("EIO: fsync failed"));
    await expect(finalizeScratchSnapshot(dir, attemptName)).rejects.toThrow(/fsync failed/);
    expect(await readFile(path.join(dir, "scratch.tar"), "utf8")).toBe("previous");
  });
});

describe("scratch snapshot script semantics (real container)", () => {
  beforeAll(async () => {
    await waitForDocker();
    await ensureImage(TEST_IMAGE);
    await mkdir(tmpBase, { recursive: true });
  }, 240_000);

  const envArgs = (quota: number, maxBytes: number, deadlineSec: number, outName: string): string[] => [
    "-e", `HONE_SCRATCH_QUOTA_BYTES=${quota}`,
    "-e", `HONE_SCRATCH_SNAPSHOT_MAX_BYTES=${maxBytes}`,
    "-e", `HONE_SCRATCH_SNAPSHOT_DEADLINE_SEC=${deadlineSec}`,
    "-e", `HONE_SCRATCH_SNAPSHOT_OUT=${outName}`,
    "-e", `SNAP_SCRIPT=${SCRATCH_SNAPSHOT_SCRIPT}`,
  ];

  it("kernel file limit kills tar when many zero-byte entries exceed the archive allowance", async () => {
    // 200 empty files cost ~100 KiB of tar headers while the apparent size
    // (and thus the quota check) is 0 bytes — the RLIMIT_FSIZE cap of 8 KiB
    // must stop tar; nothing may be published.
    const outName = newScratchSnapshotAttemptName();
    const res = await runCommand(
      [
        "docker", "run", "--rm",
        "--tmpfs", "/scratch",
        "--tmpfs", "/snapshot",
        ...envArgs(1_048_576, 8_192, 60, outName),
        TEST_IMAGE,
        "sh", "-c",
        'i=0; while [ "$i" -lt 200 ]; do : > "/scratch/f$i"; i=$((i+1)); done; ' +
          'if sh -c "$SNAP_SCRIPT"; then echo SNAP-OK; else echo SNAP-FAILED; fi; ' +
          '[ -e /snapshot/scratch.tar ] || echo NO-FINAL; ' +
          '[ -e "/snapshot/$HONE_SCRATCH_SNAPSHOT_OUT" ] || echo NO-ATTEMPT-OUT',
      ],
      { timeoutMs: 120_000 },
    );
    expect(res.exitCode).toBe(0);
    const out = res.stdout.toString("utf8");
    expect(out).toContain("SNAP-FAILED");
    expect(out).toContain("NO-FINAL");
    expect(out).toContain("NO-ATTEMPT-OUT");
    expect(res.stderr.toString("utf8")).toMatch(/scratch snapshot failed or exceeded its byte cap/);
  }, 180_000);

  it("in-container watchdog kills a stalled tar below the host timeout and leaves nothing running", async () => {
    const keeper = `hone-test-snapwatch-${randomBytes(4).toString("hex")}`;
    const started = await runCommand(
      ["docker", "run", "-d", "--name", keeper, TEST_IMAGE, "sleep", "300"],
      { timeoutMs: 120_000 },
    );
    expect(started.exitCode, started.stderr.toString("utf8")).toBe(0);
    try {
      // PATH-shadowed `tar` that never returns — the shape of a stall a
      // killed host CLI would otherwise leave running inside the keeper.
      const startedAt = Date.now();
      const res = await runCommand(
        [
          "docker", "exec",
          ...envArgs(1_048_576, 1_073_741_824, 2, newScratchSnapshotAttemptName()),
          keeper,
          "sh", "-c",
          "mkdir -p /scratch /snapshot /fake; printf '#!/bin/sh\\nsleep 1000\\n' > /fake/tar; chmod +x /fake/tar; " +
            'PATH="/fake:$PATH" sh -c "$SNAP_SCRIPT"',
        ],
        { timeoutMs: 120_000 },
      );
      const elapsedMs = Date.now() - startedAt;
      expect(res.timedOut).toBe(false);
      expect(res.exitCode).not.toBe(0);
      // The 2s in-container deadline did the killing, not the host timeout.
      expect(elapsedMs).toBeLessThan(60_000);
      const ps = await runCommand(["docker", "exec", keeper, "ps"], { timeoutMs: 30_000 });
      expect(ps.exitCode).toBe(0);
      // Zombie entries ([sh]/[find]/[awk], dead but unreaped by the keeper's
      // non-reaping PID 1) are not survivors; live processes show a cmdline.
      const live = ps.stdout.toString("utf8").split("\n").filter((line) => !/\[\w+\]\s*$/.test(line));
      expect(live.join("\n")).not.toMatch(/sleep 1000|tar -cf|find \/scratch/);
    } finally {
      await runCommand(["docker", "rm", "-f", keeper], { timeoutMs: 30_000 });
    }
  }, 180_000);

  it("the deadline bounds the PREFLIGHT too: a hung find is group-killed with no survivors", async () => {
    const keeper = `hone-test-snappre-${randomBytes(4).toString("hex")}`;
    const started = await runCommand(
      ["docker", "run", "-d", "--name", keeper, TEST_IMAGE, "sleep", "300"],
      { timeoutMs: 120_000 },
    );
    expect(started.exitCode, started.stderr.toString("utf8")).toBe(0);
    try {
      const startedAt = Date.now();
      const res = await runCommand(
        [
          "docker", "exec",
          ...envArgs(1_048_576, 1_073_741_824, 2, newScratchSnapshotAttemptName()),
          keeper,
          "sh", "-c",
          "mkdir -p /scratch /snapshot /hang; printf '#!/bin/sh\\nsleep 1000\\n' > /hang/find; chmod +x /hang/find; " +
            'PATH="/hang:$PATH" sh -c "$SNAP_SCRIPT"',
        ],
        { timeoutMs: 120_000 },
      );
      const elapsedMs = Date.now() - startedAt;
      expect(res.timedOut).toBe(false);
      expect(res.exitCode).not.toBe(0);
      expect(elapsedMs).toBeLessThan(60_000);
      const ps = await runCommand(["docker", "exec", keeper, "ps"], { timeoutMs: 30_000 });
      expect(ps.exitCode).toBe(0);
      // No RUNNING survivor from the killed group — not the fake find, not
      // its sleep, not awk/stat. Zombie entries ([name], dead but unreaped
      // by the keeper's non-reaping PID 1) are not survivors.
      const live = ps.stdout.toString("utf8").split("\n").filter((line) => !/\[\w+\]\s*$/.test(line));
      expect(live.join("\n")).not.toMatch(/sleep 1000|find \/scratch|awk/);
    } finally {
      await runCommand(["docker", "rm", "-f", keeper], { timeoutMs: 30_000 });
    }
  }, 180_000);

  it("a within-bounds tree snapshots to the per-attempt output; the host publishes exactly it and it restores", async () => {
    const hostSnap = path.join(tmpBase, "snap-ok");
    await mkdir(hostSnap, { recursive: true });
    const outName = newScratchSnapshotAttemptName();
    const res = await runCommand(
      [
        "docker", "run", "--rm",
        "--tmpfs", "/scratch",
        "-v", `${hostSnap}:/snapshot`,
        ...envArgs(1_048_576, scratchSnapshotArchiveCapBytes(1_048_576), 60, outName),
        TEST_IMAGE,
        "sh", "-c",
        'printf hello > /scratch/data.txt; mkdir -p /scratch/sub; printf world > /scratch/sub/inner.txt; sh -c "$SNAP_SCRIPT"',
      ],
      { timeoutMs: 120_000 },
    );
    expect(res.exitCode, res.stderr.toString("utf8")).toBe(0);
    // The container produced ONLY this attempt's output — no `$out.$$` pid
    // temp survives a successful in-container rename, and the final name is
    // untouched until the host publishes.
    expect((await readdir(hostSnap)).sort()).toEqual([outName]);
    await stat(path.join(hostSnap, outName));
    await expect(stat(path.join(hostSnap, "scratch.tar"))).rejects.toThrow();

    await finalizeScratchSnapshot(hostSnap, outName);
    await stat(path.join(hostSnap, "scratch.tar"));
    await expect(stat(path.join(hostSnap, outName))).rejects.toThrow();

    // Resumable: the published archive restores the exact tree.
    const restored = await runCommand(
      [
        "docker", "run", "--rm",
        "-v", `${hostSnap}:/snapshot:ro`,
        TEST_IMAGE,
        "sh", "-c",
        "mkdir /r && tar -xf /snapshot/scratch.tar -C /r && cat /r/data.txt /r/sub/inner.txt",
      ],
      { timeoutMs: 120_000 },
    );
    expect(restored.exitCode, restored.stderr.toString("utf8")).toBe(0);
    expect(restored.stdout.toString("utf8")).toBe("helloworld");
  }, 180_000);
});
