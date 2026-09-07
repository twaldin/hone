import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, capsuleDigest } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { freezeCapsuleAssets } from "../src/admission.js";
import { createBackend } from "../src/backends/local.js";
import { optimizerBuildArgs, optimizerCreateArgs } from "../src/backends/optimizer-container.js";
import { DOCKER_CREATE_WAL, readOpenDockerCreateIntents } from "../src/docker-create-gate.js";
import { makeDockerRunLease } from "../src/docker-lease.js";
import { appendEvent, replayRun } from "../src/eventlog.js";
import type { RunnerBackendContext } from "../src/types.js";
import { at, fakeHash, gitIn, initScratchRepo, makeCapsule, makeRoot, scriptedCreateHelper } from "./helpers.js";

/**
 * DockerRunLease lifecycle under the create gate: a PER-EPOCH stopped donor
 * is minted after the initial strict sweep and attached
 * (`--volumes-from <donor>:ro`) by every per-run container. Live creates are
 * JOINED (write-ahead journal + definitive daemon response); the donor's
 * never-re-minted epoch is the causal anchor for crash-window proofs. Every
 * donor and per-run create pins `--pull=never` so a create can never linger
 * through an image pull. An UNCERTAIN create leaves a durable open intent
 * and the run unterminalizable.
 */

const RUN_ID = "run_lease";
/** Epoch 1: fresh runDir, first gate open. */
const DONOR = `hone-lease-${RUN_ID}-e1`;

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

describe("makeDockerRunLease (per-epoch donor create/remove semantics)", () => {
  it("creates the stopped donor with --pull=never and full isolation; the name embeds the epoch; attachArgs bind it read-only", async () => {
    const argvs: (readonly string[])[] = [];
    const run: RunCommand = (argv) => {
      argvs.push(argv);
      return Promise.resolve(res({ stdout: Buffer.from("cid123\n") }));
    };
    const lease = makeDockerRunLease(RUN_ID, "img@sha256:deadbeef", run, 1);
    expect(lease.name).toBe(DONOR);
    expect(lease.attachArgs).toEqual(["--volumes-from", `${DONOR}:ro`]);
    // A different attempt NEVER re-mints an old epoch's name.
    expect(makeDockerRunLease(RUN_ID, "img@sha256:deadbeef", run, 2).name).toBe(`hone-lease-${RUN_ID}-e2`);
    expect(() => makeDockerRunLease(RUN_ID, "img@sha256:deadbeef", run, 0)).toThrow(/epoch/);

    await lease.start();
    const create = argvs[0];
    expect(create?.slice(0, 2)).toEqual(["docker", "create"]);
    expect(create).toContain("--pull=never");
    expect(create).toContain(DONOR);
    expect(create).toContain(`hone.runId=${RUN_ID}`);
    expect(create).toContain("none"); // --network none: the donor never talks
    // The donor never starts: create only, command is a no-op `true`.
    expect(create?.[create.length - 1]).toBe("true");

    await expect(lease.start()).rejects.toThrow(/already started/);

    await lease.close();
    expect(argvs.at(-1)).toEqual(["docker", "rm", "-f", DONOR]);
  });

  it("close tolerates an already-missing donor but never a live removal failure", async () => {
    const missing: RunCommand = (argv) =>
      Promise.resolve(
        argv[1] === "rm" ? res({ exitCode: 1, stderr: Buffer.from(`Error: No such container: ${DONOR}`) }) : res({ stdout: Buffer.from("cid\n") }),
      );
    const leaseA = makeDockerRunLease(RUN_ID, "img@sha256:deadbeef", missing, 1);
    await leaseA.start();
    await expect(leaseA.close()).resolves.toBeUndefined();

    const broken: RunCommand = (argv) =>
      Promise.resolve(argv[1] === "rm" ? res({ exitCode: 1, stderr: Buffer.from("daemon exploded") }) : res({ stdout: Buffer.from("cid\n") }));
    const leaseB = makeDockerRunLease(RUN_ID, "img@sha256:deadbeef", broken, 1);
    await leaseB.start();
    await expect(leaseB.close()).rejects.toThrow(/lease cleanup failed/);
  });

  it("an uncertain create (client timeout shape) fails start AND poisons close — never a silent success", async () => {
    const run: RunCommand = (argv) => Promise.resolve(argv[1] === "create" ? res({ timedOut: true }) : res());
    const lease = makeDockerRunLease(RUN_ID, "img@sha256:deadbeef", run, 1);
    await expect(lease.start()).rejects.toThrow(/lease create failed/);
    // Even after a successful rm, the uncertainty is surfaced: the daemon may
    // still materialize the donor later, so terminal completion must refuse.
    await expect(lease.close()).rejects.toThrow(/uncertain.*refusing terminal completion/);
  });
});

describe("optimizer container argv (donor attach + --pull=never)", () => {
  it("build and create argvs attach the donor read-only (REQUIRED — the production omission was a P1) and never pull", () => {
    const build = optimizerBuildArgs({
      runId: RUN_ID,
      safeRunId: RUN_ID,
      image: "img@sha256:deadbeef",
      stagingDir: "/tmp/stage",
      outDir: "/tmp/out",
      containerLease: DONOR,
      hostUid: 501,
      hostGid: 20,
    });
    expect(build).toContain("--pull=never");
    const buildAt = build.indexOf("--volumes-from");
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(build[buildAt + 1]).toBe(`${DONOR}:ro`);

    const createArgv = optimizerCreateArgs({
      name: `hone-opt-${RUN_ID}-1`,
      runId: RUN_ID,
      image: "img@sha256:deadbeef",
      bundleDir: null,
      transport: { kind: "unix", hostSocketPath: "/tmp/broker.sock", token: "a".repeat(64) },
      env: {},
      containerLease: DONOR,
      runArgv: ["true"],
    });
    expect(createArgv.slice(0, 2)).toEqual(["docker", "create"]);
    expect(createArgv).toContain("--pull=never");
    const runAt = createArgv.indexOf("--volumes-from");
    expect(runAt).toBeGreaterThanOrEqual(0);
    expect(createArgv[runAt + 1]).toBe(`${DONOR}:ro`);
  });
});

/** Scripted-docker local-backend harness (same shape as the image-wiring test): aborted signal = setup + full teardown, no optimizer. */
function makeCtx(root: string, run: RunCommand, barriers: { cleanup: (p: Promise<void>) => void }): RunnerBackendContext {
  const runDir = join(root, ".hone-runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(root, ".hone-cas"), { recursive: true });
  // Idempotent across attempts on the same root (resume-style tests).
  const baseline = join(root, "capsule", "baseline");
  if (!existsSync(join(baseline, ".git"))) initScratchRepo(baseline);
  const commit = gitIn(baseline, "rev-parse", "HEAD");
  const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
  const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
  if (!existsSync(join(runDir, "capsule-assets"))) freezeCapsuleAssets(runDir, capsuleDir, manifest);
  if (!existsSync(join(runDir, "events.ndjson"))) {
    appendEvent(runDir, { runId: RUN_ID, at: at(), type: "run.started", capsuleId: manifest.id, contractHash: fakeHash("c"), optimizerDigest: fakeHash("0") });
  }
  const abort = new AbortController();
  abort.abort(new Error("stop requested")); // setup-only pass: sweep, donor, egress, broker — then unwind
  return {
    runId: RUN_ID,
    root,
    runDir,
    casDir: join(root, ".hone-cas"),
    capsuleDir,
    manifest,
    config: RunConfig.parse({
      version: 1,
      capsuleId: manifest.id,
      objective: manifest.objective,
      budget: manifest.budget,
      routing: { mutation: { model: "m" } },
      headless: true,
    }),
    env: {
      PATH: process.env["PATH"] ?? "",
      HONE_EGRESS: "network", // exercise the relay-container path
    },
    capsuleDigest: capsuleDigest(manifest),
    // Direct backend fixture: frozen assets/run.started already exist; this is the post-seal byte recheck.
    admissionReview: "off",
    optimizerDigest: fakeHash("0"),
    replayed: replayRun(runDir),
    signal: abort.signal,
    emit: (event) => appendEvent(runDir, event),
    registerChild: () => () => {},
    probeGate: () => Promise.resolve(true),
    requestStop: () => {},
    registerAuthorityBarrier: (b) => {
      void b.catch(() => {});
    },
    registerCleanupBarrier: (b) => {
      barriers.cleanup(b);
      void b.catch(() => {});
    },
  };
}

/** Shared scripted docker: engine identity, keeper-snapshot exec publishing the exact per-attempt OUT basename; every create answers with an id. */
function scriptedDocker(runDir: string, argvs: (readonly string[])[], engineId = "ENGINE-TEST"): RunCommand {
  return (argv) => {
    argvs.push(argv);
    if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from(`${engineId}\n`) }));
    if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
    if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("cid\n") }));
    const outArg = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
    if (argv[1] === "exec" && outArg !== undefined) {
      // Emulate the keeper's snapshot exec: the in-container tar publishes
      // exactly the minted per-attempt basename into the snapshot dir.
      mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
      writeFileSync(join(runDir, "scratch-snapshot", outArg.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "");
    }
    return Promise.resolve(res());
  };
}

describe("donor lifecycle through the local backend (gated creates)", () => {
  it("donor after the initial strict sweep; every per-run create is two-phase, joined, journaled, and attaches the donor; strict post-fence sweep and an empty latch before the barrier", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    const argvs: (readonly string[])[] = [];
    const run = scriptedDocker(runDir, argvs);
    let cleanupBarrier: Promise<void> | null = null;
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });

    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).resolves.toBeUndefined(); // full teardown succeeded

    const isSweepList = (a: readonly string[]): boolean => a[0] === "docker" && a[1] === "ps" && a.includes(`label=hone.runId=${RUN_ID}`);
    const donorCreate = argvs.findIndex((a) => a[0] === "docker" && a[1] === "create" && a.includes(DONOR));
    const initialSweep = argvs.findIndex(isSweepList);
    expect(initialSweep, JSON.stringify(argvs.slice(0, 5))).toBeGreaterThanOrEqual(0);
    expect(donorCreate).toBeGreaterThan(initialSweep); // donor minted AFTER the strict sweep
    expect(argvs[donorCreate]).toContain("--pull=never");

    // NO raw `docker run` ever reaches the daemon: the gate rewrites every
    // one two-phase (joined create + bounded start).
    expect(argvs.filter((a) => a[0] === "docker" && a[1] === "run")).toEqual([]);

    // Every per-run container create (egress relays AND the broker's scratch
    // keeper — proving the donor name reached the broker) attaches the donor
    // read-only, never pulls, and is created only after the donor exists.
    const neverPulls = (a: readonly string[]): boolean => a.includes("--pull=never") || a.join("\u0000").includes("--pull\u0000never");
    const workloadCreates = argvs.flatMap((a, i) =>
      a[0] === "docker" && a[1] === "create" && i !== donorCreate ? [{ argv: a, index: i }] : [],
    );
    expect(workloadCreates.length).toBeGreaterThan(0);
    const runNames: string[] = [];
    for (const { argv, index } of workloadCreates) {
      expect(index).toBeGreaterThan(donorCreate);
      expect(neverPulls(argv), argv.join(" ")).toBe(true);
      const attach = argv.indexOf("--volumes-from");
      expect(attach, argv.join(" ")).toBeGreaterThanOrEqual(0);
      expect(argv[attach + 1]).toBe(`${DONOR}:ro`);
      const name = argv[argv.indexOf("--name") + 1];
      if (name !== undefined) runNames.push(name);
      // Two-phase: each create is followed by a start of the id/name.
      const start = argvs.findIndex((a, j) => j > index && a[0] === "docker" && a[1] === "start");
      expect(start, `create at ${index} must be started`).toBeGreaterThan(index);
    }
    expect(runNames.some((n) => n.startsWith("hone-scratch-keeper"))).toBe(true); // the broker spawned under the donor lease

    // Teardown order: donor removal comes after workload cleanup, and the
    // strict post-fence sweep (cleanup, not proof) runs after it.
    const donorRm = argvs.findIndex((a) => a[0] === "docker" && a[1] === "rm" && a.includes(DONOR));
    expect(donorRm).toBeGreaterThan(donorCreate);
    for (const name of runNames) {
      const firstRm = argvs.findIndex((a) => a[0] === "docker" && a[1] === "rm" && a.includes(name));
      expect(firstRm, `first removal of ${name} must precede the donor fence`).toBeGreaterThanOrEqual(0);
      expect(firstRm, `first removal of ${name} must precede the donor fence`).toBeLessThan(donorRm);
    }
    const postFenceSweep = argvs.findIndex((a, i) => i > donorRm && isSweepList(a));
    expect(postFenceSweep).toBeGreaterThan(donorRm);

    // The write-ahead journal exists, is fully settled (no open intents), and
    // recorded the donor + every workload create.
    expect(existsSync(join(runDir, DOCKER_CREATE_WAL))).toBe(true);
    expect(readOpenDockerCreateIntents(runDir)).toEqual([]);
    const wal = readFileSync(join(runDir, DOCKER_CREATE_WAL), "utf8");
    expect(wal).toContain(`"name":"${DONOR}"`);
    expect(wal).toContain('"t":"settled"');
  });

  it("an uncertain donor create (signaled client) fails setup, leaves a durable open intent, AND rejects the cleanup barrier — the run stays unterminalizable", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    const run: RunCommand = (argv) => {
      if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-TEST\n") }));
      // The donor create's docker client dies by signal AFTER the POST may
      // have been accepted: no engine response, no conclusive verdict.
      if (argv[1] === "create" && argv.includes(DONOR)) return Promise.resolve(res({ exitCode: 137, stderr: Buffer.from("") }));
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      return Promise.resolve(res());
    };
    let cleanupBarrier: Promise<void> | null = null;
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });

    await expect(createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx)).rejects.toThrow(/lease create failed/);
    expect(cleanupBarrier).not.toBeNull();
    // The ambiguous outcome latches: the write-ahead intent stays durably open.
    await expect(cleanupBarrier).rejects.toThrow(/docker create gate: .*unresolved/);
    const open = readOpenDockerCreateIntents(runDir);
    expect(open.length).toBe(1);
    expect(open[0]?.name).toBe(DONOR);
    expect(open[0]?.kind).toBe("container");
  });

  it("Engine identity seal: a resume under a DIFFERENT daemon refuses before any proof or sweep; the sealed engine proceeds", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    // Attempt 1 on ENGINE-A: donor create client dies by signal — the run
    // seals to A and leaves an open intent (resources may live on A).
    const runA: RunCommand = (argv) => {
      if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-A\n") }));
      if (argv[1] === "create" && argv.includes(DONOR)) return Promise.resolve(res({ exitCode: 137, stderr: Buffer.from("") }));
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      return Promise.resolve(res());
    };
    const ctxA = makeCtx(root, runA, { cleanup: () => {} });
    await expect(createBackend({ run: runA, createHelper: scriptedCreateHelper(runA) }).start(ctxA)).rejects.toThrow(/lease create failed/);
    expect(readOpenDockerCreateIntents(runDir).length).toBe(1);

    // Resume under ENGINE-B: refused BEFORE any proof/sweep/create — no
    // docker call besides the identity query happens.
    const argvsB: (readonly string[])[] = [];
    const runB: RunCommand = (argv) => {
      argvsB.push(argv);
      if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-B\n") }));
      return Promise.resolve(res());
    };
    const ctxB = makeCtx(root, runB, { cleanup: () => {} });
    await expect(createBackend({ run: runB, createHelper: scriptedCreateHelper(runB) }).start(ctxB)).rejects.toThrow(
      /sealed to Docker engine ENGINE-A.*ENGINE-B/,
    );
    expect(argvsB.every((a) => a[1] === "info")).toBe(true);
    expect(readOpenDockerCreateIntents(runDir).length).toBe(1); // latch untouched

    // Resume back on ENGINE-A: the seal verifies and startup proceeds past
    // the identity gate (the latch resolves through the normal proof path).
    const argvsA2: (readonly string[])[] = [];
    const runA2 = scriptedDocker(runDir, argvsA2, "ENGINE-A");
    const ctxA2 = makeCtx(root, runA2, { cleanup: () => {} });
    await createBackend({ run: runA2, createHelper: scriptedCreateHelper(runA2) }).start(ctxA2);
    expect(argvsA2.some((a) => a[1] === "ps")).toBe(true); // proofs/sweeps ran
  });

  it("mid-run engine switch (context/config mutated): the terminal recheck through the frozen resolution refuses — a final sweep against daemon B can never terminalize a run sealed to A", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", RUN_ID);
    const argvs: (readonly string[])[] = [];
    let infoCalls = 0;
    const run: RunCommand = (argv) => {
      argvs.push(argv);
      if (argv[1] === "info") {
        infoCalls += 1;
        // The FIRST identity query (the seal) sees ENGINE-A; the daemon
        // answering by the end of the run — after a context/config
        // mutation — is ENGINE-B.
        return Promise.resolve(res({ stdout: Buffer.from(infoCalls === 1 ? "ENGINE-A\n" : "ENGINE-B\n") }));
      }
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("cid\n") }));
      const outArg = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
      if (argv[1] === "exec" && outArg !== undefined) {
        mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
        writeFileSync(join(runDir, "scratch-snapshot", outArg.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "");
      }
      return Promise.resolve(res());
    };
    let cleanupBarrier: Promise<void> | null = null;
    const ctx = makeCtx(root, run, { cleanup: (p) => (cleanupBarrier = p) });
    await createBackend({ run, createHelper: scriptedCreateHelper(run) }).start(ctx);
    expect(cleanupBarrier).not.toBeNull();
    await expect(cleanupBarrier).rejects.toThrow(/terminal recheck: .*sealed to Docker engine ENGINE-A.*ENGINE-B/);
  });
});
