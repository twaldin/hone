import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CapsuleManifest, RunConfig, capsuleDigest } from "@hone/schema";
import { runCommand } from "@hone/broker";
import type { CmdResult, RunCommand } from "@hone/broker";
import { createBackend, runOptimizer } from "../src/backends/local.js";
import {
  optimizerBuildArgs,
  optimizerCreateArgs,
  optimizerStartArgs,
  prepareOptimizerRuntime,
  verifyOptimizerBundleSeal,
} from "../src/backends/optimizer-container.js";
import type { OptimizerBundleSeal, OptimizerRuntime } from "../src/backends/optimizer-container.js";
import { openDockerCreateGate } from "../src/docker-create-gate.js";
import { appendEvent, readEvents, replayRun } from "../src/eventlog.js";
import { computeOptimizerDigest } from "../src/optimizer-digest.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
  scriptedCreateHelper,
  scriptedClientChild,
  FIX_IMAGE,
  fakeHash,
  fakeOptimizerSpawn,
  gitIn,
  initScratchRepo,
  makeCapsule,
  makeRoot,
  okRun,
  testOptimizerRuntime,
  writeEvents,
} from "./helpers.js";

/**
 * Containment exactness for the two optimizer containers: docker argv, mounts,
 * env, network, and uid are all pinned; the host repo/runDir/CAS/capsule/
 * Docker socket never appear; the TCP capability never enters argv or logs.
 */

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

/** All -v mount specs in a docker argv. */
function mountsOf(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "-v") out.push(argv[i + 1] ?? "");
  return out;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** A real create gate over a throwaway WAL dir (unit tests never resume it). */
function testGate(runId: string) {
  return openDockerCreateGate(mkdtempSync(join(tmpdir(), "hone-gate-")), runId);
}

describe("build container argv exactness", () => {
  it("no network, read-only source, isolated output, NUMERIC host uid/gid, caps, pinned image, donor attach, one argv emitting BOTH bundles", () => {
    const argv = optimizerBuildArgs({
      runId: "run_b",
      safeRunId: "run_b",
      image: FIX_IMAGE,
      stagingDir: "/tmp/src",
      outDir: "/tmp/out",
      containerLease: "hone-lease-run_b-e1",
      hostUid: 1234,
      hostGid: 5678,
    });
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
    // Digest-pinned image must already be present — a create can never linger through a pull.
    const pullIdx = argv.indexOf("--pull=never");
    expect(pullIdx).toBeGreaterThan(2);
    expect(pullIdx).toBeLessThan(argv.indexOf(FIX_IMAGE));
    expect(flagValue(argv, "--network")).toBe("none");
    expect(argv).toContain("--read-only");
    // The build runs as the invoking NUMERIC host uid/gid: it writes into a
    // host-created 0700-rooted dir, never a world-writable handoff.
    expect(flagValue(argv, "--user")).toBe("1234:5678");
    expect(flagValue(argv, "--cap-drop")).toBe("ALL");
    expect(flagValue(argv, "--security-opt")).toBe("no-new-privileges");
    expect(flagValue(argv, "--pids-limit")).toBe("512");
    expect(flagValue(argv, "--label")).toBe("hone.runId=run_b");
    expect(mountsOf(argv)).toEqual(["/tmp/src:/hone/src:ro", "/tmp/out:/hone/out"]);
    // The donor lease attach is REQUIRED (production omission was a P1).
    expect(argv[argv.indexOf("--volumes-from") + 1]).toBe("hone-lease-run_b-e1:ro");
    // The compiler runs INSIDE the pinned image on the staged tree only, and
    // the SAME container command emits the loop AND the worker bundle.
    const imageIdx = argv.indexOf(FIX_IMAGE);
    expect(imageIdx).toBeGreaterThan(0);
    const build = argv.slice(imageIdx + 1);
    expect(build.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(build[2]).toContain("bun build /hone/src/optimizer/src/main.ts");
    expect(build[2]).toContain("--outfile=/hone/out/optimizer.mjs");
    expect(build[2]).toContain("bun build /hone/src/optimizer/worker/mutate.ts");
    expect(build[2]).toContain("--outfile=/hone/out/worker.mjs");
  });

  it("attaches the docker-run lease as `--volumes-from <lease>:ro` BEFORE the image", () => {
    const argv = optimizerBuildArgs({
      runId: "run_b",
      safeRunId: "run_b",
      image: FIX_IMAGE,
      stagingDir: "/tmp/src",
      outDir: "/tmp/out",
      containerLease: "hone-lease-run_b",
      hostUid: 1234,
      hostGid: 5678,
    });
    const leaseIdx = argv.indexOf("--volumes-from");
    expect(leaseIdx).toBeGreaterThan(0);
    expect(argv[leaseIdx + 1]).toBe("hone-lease-run_b:ro");
    expect(leaseIdx).toBeLessThan(argv.indexOf(FIX_IMAGE));
  });
});

describe("run container create/start argv exactness (two-phase)", () => {
  const baseOpts = {
    name: "hone-opt-run_r-1",
    runId: "run_r",
    image: FIX_IMAGE,
    bundleDir: "/tmp/bundle",
    runArgv: ["node", "/hone/bundle/optimizer.mjs"],
    env: { HONE_BROKER_SOCK: "/run/hone/broker.sock", HONE_RUN_ID: "run_r", HONE_SEED: "0", HONE_RESUME: "{}" },
    containerLease: "hone-lease-run_r-e1",
  };

  it("linux/unix transport: --network none, ONLY bundle + public broker.sock mounted, uid 2000; token is value-less env, NEVER argv", () => {
    // Distinct from FIX_IMAGE's a-repeated digest: a colliding token would
    // vacuously satisfy the not-in-argv assertion's inverse.
    const token = "b".repeat(64);
    const argv = optimizerCreateArgs({ ...baseOpts, transport: { kind: "unix", hostSocketPath: "/runs/r/broker.sock", token } });
    // Phase one is a plain `docker create` — no --rm: the awaited post-exit
    // reap removes by name, and start exit codes never race auto-remove.
    expect(argv.slice(0, 2)).toEqual(["docker", "create"]);
    expect(argv).not.toContain("--rm");
    // Digest-pinned image must already be present — a create can never linger through a pull.
    const pullIdx = argv.indexOf("--pull=never");
    expect(pullIdx).toBeGreaterThan(1);
    expect(pullIdx).toBeLessThan(argv.indexOf(FIX_IMAGE));
    expect(flagValue(argv, "--network")).toBe("none");
    expect(argv).toContain("--read-only");
    expect(flagValue(argv, "--user")).toBe("2000:2000");
    expect(flagValue(argv, "--cap-drop")).toBe("ALL");
    // The FULL mount set: bundle (ro) and the public broker socket. Nothing else —
    // no repo, no runDir, no CAS, no capsule, no holdout ledger, no docker.sock.
    expect(mountsOf(argv)).toEqual(["/tmp/bundle:/hone/bundle:ro", "/runs/r/broker.sock:/run/hone/broker.sock"]);
    expect(argv.join(" ")).not.toMatch(/docker\.sock|\.hone-cas|admin/);
    // The 0666 public socket demands the same bearer as TCP: the capability
    // travels via the docker CREATE client env as a value-less `-e
    // HONE_BROKER_TOKEN`; the token bytes appear nowhere in argv.
    expect(argv).toContain("HONE_BROKER_TOKEN");
    expect(argv.join(" ")).not.toContain(token);
    const eIdx = argv.indexOf("HONE_BROKER_TOKEN");
    expect(argv[eIdx - 1]).toBe("-e");
  });

  it("darwin/tcp transport: joins ONLY the internal egress network; token is value-less env, NEVER argv", () => {
    const token = "f".repeat(64);
    const argv = optimizerCreateArgs({
      ...baseOpts,
      env: { ...baseOpts.env, HONE_BROKER_SOCK: "tcp://host.docker.internal:49999" },
      transport: { kind: "tcp", endpoint: "tcp://host.docker.internal:49999", token, network: "hone-run_r" },
    });
    expect(flagValue(argv, "--network")).toBe("hone-run_r");
    // Only the bundle is mounted — no broker.sock, nothing from the host run dir.
    expect(mountsOf(argv)).toEqual(["/tmp/bundle:/hone/bundle:ro"]);
    // The capability travels via the docker client env: `-e HONE_BROKER_TOKEN`
    // with NO value; the exact token string appears nowhere in argv.
    expect(argv).toContain("HONE_BROKER_TOKEN");
    expect(argv.join(" ")).not.toContain(token);
    const eIdx = argv.indexOf("HONE_BROKER_TOKEN");
    expect(argv[eIdx - 1]).toBe("-e");
  });

  it("attaches the docker-run lease as `--volumes-from <lease>:ro` BEFORE the image; start argv addresses the registered name", () => {
    const argv = optimizerCreateArgs({
      ...baseOpts,
      transport: { kind: "unix", hostSocketPath: "/runs/r/broker.sock", token: "a".repeat(64) },
    });
    const leaseIdx = argv.indexOf("--volumes-from");
    expect(leaseIdx).toBeGreaterThan(0);
    expect(argv[leaseIdx + 1]).toBe("hone-lease-run_r-e1:ro");
    expect(leaseIdx).toBeLessThan(argv.indexOf(FIX_IMAGE));
    // Phase two: bounded, killable attach-start of the registered container.
    expect(optimizerStartArgs(baseOpts.name)).toEqual(["docker", "start", "-a", baseOpts.name]);
  });
});

describe("prepareOptimizerRuntime: exact snapshot proof + one-time build", () => {
  const ctxSlice = (digest: string): Pick<RunnerBackendContext, "runId" | "env" | "optimizerDigest"> => ({
    runId: "run_prep",
    env: {},
    optimizerDigest: digest,
  });

  /** The build container in this file's fakes: `docker run ... /bin/sh -c "bun build ..."`. */
  const isBuild = (argv: readonly string[]): boolean => argv[1] === "run" && argv.some((a) => a.includes("bun build"));

  it("recollects, requires the sealed digest, stages the capture, and builds BOTH bundles once", async () => {
    const argvs: string[][] = [];
    const run: RunCommand = (argv) => {
      argvs.push([...argv]);
      if (isBuild(argv)) {
        // The "build container": consume the staged ro mount, emit both bundles.
        const out = mountsOf(argv)[1]?.split(":")[0] ?? "";
        const src = mountsOf(argv)[0]?.split(":")[0] ?? "";
        expect(existsSync(join(src, "optimizer", "src", "main.ts"))).toBe(true);
        expect(existsSync(join(src, "optimizer", "worker", "mutate.ts"))).toBe(true);
        expect(existsSync(join(src, "optimizer", "node_modules", "@hone", "schema", "package.json"))).toBe(true);
        // The staged Pi closure resolves THROUGH the optimizer's node_modules link.
        expect(existsSync(join(src, "optimizer", "node_modules", "@oh-my-pi", "pi-coding-agent", "package.json"))).toBe(true);
        writeFileSync(join(out, "optimizer.mjs"), "// bundle\n");
        writeFileSync(join(out, "worker.mjs"), "// worker bundle\n");
      }
      return Promise.resolve(res());
    };
    const runtime = await prepareOptimizerRuntime(ctxSlice(computeOptimizerDigest(FIX_IMAGE)), {
      image: FIX_IMAGE,
      transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
      run,
      spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
      containerLease: "hone-lease-run_prep-e1",
      gate: testGate("run_prep"),
      clientEnv: { PATH: process.env["PATH"] ?? "" },
    });
    expect(argvs.filter(isBuild).length).toBe(1);
    expect(runtime.bundleDir).not.toBeNull();
    expect(runtime.runArgv).toEqual(["node", "/hone/bundle/optimizer.mjs"]);
    const bundleDir = runtime.bundleDir ?? "";
    expect(existsSync(join(bundleDir, "optimizer.mjs"))).toBe(true);
    expect(existsSync(join(bundleDir, "worker.mjs"))).toBe(true);
    await runtime.cleanup();
    // Temp staging/output trees are gone; containers were rm -f'd by name.
    expect(existsSync(bundleDir)).toBe(false);
    expect(argvs.some((a) => a[1] === "rm" && a.includes("hone-optbuild-run_prep"))).toBe(true);
  });

  it("fails closed when the build emits no worker bundle", async () => {
    const run: RunCommand = (argv) => {
      if (isBuild(argv)) {
        const out = mountsOf(argv)[1]?.split(":")[0] ?? "";
        writeFileSync(join(out, "optimizer.mjs"), "// bundle\n"); // worker.mjs deliberately absent
      }
      return Promise.resolve(res());
    };
    await expect(
      prepareOptimizerRuntime(ctxSlice(computeOptimizerDigest(FIX_IMAGE)), {
        image: FIX_IMAGE,
        transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
        run,
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
        containerLease: "hone-lease-run_prep-e1",
        gate: testGate("run_prep"),
        clientEnv: { PATH: process.env["PATH"] ?? "" },
      }),
    ).rejects.toThrow(/produced no .*worker\.mjs/);
  });

  it("threads the docker-run lease into the build argv and the runtime", async () => {
    const argvs: string[][] = [];
    const run: RunCommand = (argv) => {
      argvs.push([...argv]);
      if (isBuild(argv)) {
        const out = mountsOf(argv)[1]?.split(":")[0] ?? "";
        writeFileSync(join(out, "optimizer.mjs"), "// bundle\n");
        writeFileSync(join(out, "worker.mjs"), "// worker bundle\n");
      }
      return Promise.resolve(res());
    };
    const runtime = await prepareOptimizerRuntime(ctxSlice(computeOptimizerDigest(FIX_IMAGE)), {
      image: FIX_IMAGE,
      transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
      run,
      spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
      containerLease: "hone-lease-run_prep",
      gate: testGate("run_prep"),
      clientEnv: { PATH: process.env["PATH"] ?? "" },
    });
    const build = argvs.find(isBuild) ?? [];
    const leaseIdx = build.indexOf("--volumes-from");
    expect(leaseIdx).toBeGreaterThan(0);
    expect(build[leaseIdx + 1]).toBe("hone-lease-run_prep:ro");
    expect(leaseIdx).toBeLessThan(build.indexOf(FIX_IMAGE));
    expect(runtime.containerLease).toBe("hone-lease-run_prep");
    await runtime.cleanup();
  });

  it("refuses to execute when the recollected digest differs from the seal", async () => {
    await expect(
      prepareOptimizerRuntime(ctxSlice(fakeHash("0")), {
        image: FIX_IMAGE,
        transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
        run: okRun(),
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
        containerLease: "hone-lease-run_prep-e1",
        gate: testGate("run_prep"),
        clientEnv: { PATH: process.env["PATH"] ?? "" },
      }),
    ).rejects.toThrow(/optimizer drift at launch/);
  });

  it("HONE_OPTIMIZER_CMD override: no staging, no build — argv INSIDE the container only", async () => {
    const argvs: string[][] = [];
    const run: RunCommand = (argv) => {
      argvs.push([...argv]);
      return Promise.resolve(res());
    };
    const runtime = await prepareOptimizerRuntime(
      { runId: "run_ovr", env: { HONE_OPTIMIZER_CMD: "python3 /evil.py" }, optimizerDigest: fakeHash("9") },
      {
        image: FIX_IMAGE,
        transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
        run,
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
        containerLease: "hone-lease-run_ovr-e1",
        gate: testGate("run_ovr"),
        clientEnv: { PATH: process.env["PATH"] ?? "" },
      },
    );
    expect(argvs.filter((a) => a[1] === "run").length).toBe(0); // never built
    expect(runtime.bundleDir).toBeNull();
    expect(runtime.runArgv).toEqual(["python3", "/evil.py"]);
  });
  it("rejects cleanup when an optimizer container cannot be removed", async () => {
    const runtime = await prepareOptimizerRuntime(
      { runId: "run_leak", env: { HONE_OPTIMIZER_CMD: "node /hone/bundle/optimizer.mjs" }, optimizerDigest: fakeHash("8") },
      {
        image: FIX_IMAGE,
        transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
        run: async (argv) =>
          argv[1] === "rm"
            ? res({ exitCode: 1, stderr: Buffer.from("daemon refused removal") })
            : res(),
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
        containerLease: "hone-lease-run_leak-e1",
        gate: testGate("run_leak"),
        clientEnv: { PATH: process.env["PATH"] ?? "" },
      },
    );
    runtime.spawnedNames.push("hone-opt-run_leak-0");
    await expect(runtime.cleanup()).rejects.toThrow(/optimizer cleanup incomplete.*daemon refused removal/);
  });
});

describe("runOptimizer: docker-only two-phase launch, token hygiene", () => {
  it("launches ONLY via docker create + start -a of the pinned image — a host argv is rejected by the seam", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_host");
    mkdirSync(runDir, { recursive: true });
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const script = join(root, "opt.mjs");
    writeFileSync(script, "process.exit(0);\n");
    const ctx = optCtx(root, runDir, "run_host");
    await runOptimizer(ctx, testOptimizerRuntime({ runId: "run_host", argv: [process.execPath, script], spawnImpl: fakeOptimizerSpawn(FIX_IMAGE, seen) }));
    // Two client spawns: the JOINED create, then the bounded attach-start.
    expect(seen.argvs.length).toBe(2);
    expect(seen.argvs[0]?.slice(0, 2)).toEqual(["docker", "create"]);
    expect(seen.argvs[1]?.slice(0, 3)).toEqual(["docker", "start", "-a"]);
    expect(seen.argvs[1]?.[3]).toBe("hone-opt-run_host-1");
  });

  it("the TCP token reaches the container env but never argv, optimizer.log, or events", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_tok");
    mkdirSync(runDir, { recursive: true });
    const token = "e".repeat(64);
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const script = join(root, "opt.mjs");
    // The scripted optimizer proves DELIVERY without printing the secret.
    writeFileSync(script, 'console.log(`token-present=${process.env.HONE_BROKER_TOKEN !== undefined} sock=${process.env.HONE_BROKER_SOCK}`);\n');
    const ctx = optCtx(root, runDir, "run_tok");
    await runOptimizer(
      ctx,
      testOptimizerRuntime({
        runId: "run_tok",
        argv: [process.execPath, script],
        transport: { kind: "tcp", endpoint: "tcp://host.docker.internal:50123", token, network: "hone-run_tok" },
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE, seen),
      }),
    );
    const log = readFileSync(join(runDir, "optimizer.log"), "utf8");
    expect(log).toContain("token-present=true");
    expect(log).toContain("sock=tcp://host.docker.internal:50123");
    expect(log).not.toContain(token);
    expect(seen.argvs.flat().join(" ")).not.toContain(token);
    expect(seen.envs[0]?.["HONE_BROKER_TOKEN"]).toBe(token); // docker CREATE client env — resolved by the value-less -e
    expect(seen.envs[1]?.["HONE_BROKER_TOKEN"]).toBeUndefined(); // the bounded start client never needs the capability
    expect(existsSync(join(runDir, "events.ndjson"))).toBe(false);
  });

  it("the UNIX token reaches the container env but never argv, optimizer.log, or events", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_utok");
    mkdirSync(runDir, { recursive: true });
    const token = "u".repeat(64);
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const script = join(root, "opt.mjs");
    // The scripted optimizer proves DELIVERY without printing the secret.
    writeFileSync(script, 'console.log(`token-present=${process.env.HONE_BROKER_TOKEN !== undefined} sock=${process.env.HONE_BROKER_SOCK}`);\n');
    const ctx = optCtx(root, runDir, "run_utok");
    await runOptimizer(
      ctx,
      testOptimizerRuntime({
        runId: "run_utok",
        argv: [process.execPath, script],
        transport: { kind: "unix", hostSocketPath: "/runs/r/broker.sock", token },
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE, seen),
      }),
    );
    const log = readFileSync(join(runDir, "optimizer.log"), "utf8");
    expect(log).toContain("token-present=true");
    expect(log).toContain("sock=/run/hone/broker.sock");
    expect(log).not.toContain(token);
    expect(seen.argvs.flat().join(" ")).not.toContain(token);
    expect(seen.envs[0]?.["HONE_BROKER_TOKEN"]).toBe(token); // docker CREATE client env — resolved by the value-less -e
    expect(seen.envs[1]?.["HONE_BROKER_TOKEN"]).toBeUndefined(); // the bounded start client never needs the capability
    expect(existsSync(join(runDir, "events.ndjson"))).toBe(false);
  });

  it("REGRESSION: after the client is reaped, the kill handle NEVER signals numeric PIDs/PGIDs — a recycled number is untouchable; the daemon owns the container by name", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_pgid");
    mkdirSync(runDir, { recursive: true });
    const killSpy = vi.spyOn(process, "kill");
    try {
      const dockerCalls: string[][] = [];
      const run: RunCommand = (argv) => {
        dockerCalls.push([...argv]);
        return Promise.resolve(res());
      };
      const clientKills: NodeJS.Signals[] = [];
      const closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
      const startChild = {
        pid: 424242, // adversarial: a number that could be recycled after reap
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (sig?: NodeJS.Signals) => {
          clientKills.push(sig ?? "SIGTERM");
          return true;
        },
        on(event: "error" | "close", cb: unknown): unknown {
          if (event === "close") closeListeners.push(cb as (code: number | null, signal: NodeJS.Signals | null) => void);
          return startChild;
        },
      };
      const started = { promise: Promise.resolve(), resolve: () => {} };
      const startSpawned = new Promise<void>((resolveStart) => (started.resolve = resolveStart));
      const runtime = testOptimizerRuntime({
        runId: "run_pgid",
        argv: ["true"],
        run,
        spawnImpl: (cmd, args) => {
          if (cmd === "docker" && args[0] === "create") return scriptedClientChild("pgidcid\n");
          started.resolve();
          return startChild;
        },
      });
      const captured: { handle: { kill(signal?: NodeJS.Signals): boolean } | null } = { handle: null };
      const ctx = optCtx(root, runDir, "run_pgid");
      ctx.registerChild = (child) => {
        captured.handle = child;
        return () => {};
      };
      const invocation = runOptimizer(ctx, runtime);
      await startSpawned;
      const handle = captured.handle;
      if (handle === null) throw new Error("runOptimizer never registered its kill handle");

      // Live client: TERM covers the client's process group (the unreaped
      // leader pins the pgid) with the ChildProcess handle as fallback, plus
      // the daemon by NAME.
      handle.kill("SIGTERM");
      expect(clientKills).toEqual(["SIGTERM"]); // fake pid 424242 has no real group: fell through to the handle
      expect(dockerCalls.some((a) => a[1] === "kill" && a.includes("hone-opt-run_pgid-1"))).toBe(true);
      const numericCallsWhileAlive = killSpy.mock.calls.filter(([pid]) => pid === -424242 || pid === 424242).length;

      // The client is reaped; its number may now belong to a stranger.
      for (const cb of closeListeners) cb(0, null);
      await invocation;
      handle.kill("SIGKILL");
      expect(clientKills).toEqual(["SIGTERM"]); // NO client signal after reap
      expect(dockerCalls.some((a) => a[1] === "rm" && a.includes("hone-opt-run_pgid-1"))).toBe(true); // daemon authority
      // THE P1: not one numeric signal after reap — the count is frozen.
      expect(killSpy.mock.calls.filter(([pid]) => pid === -424242 || pid === 424242).length).toBe(numericCallsWhileAlive);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("caps attacker-controlled optimizer diagnostics across stdout and stderr", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_logcap");
    mkdirSync(runDir, { recursive: true });
    const script = join(root, "noisy-opt.mjs");
    writeFileSync(script, 'process.stdout.write("o".repeat(1024)); process.stderr.write("e".repeat(1024));\n');
    const ctx = optCtx(root, runDir, "run_logcap");
    ctx.env["HONE_OPTIMIZER_LOG_LIMIT_BYTES"] = "128";
    await runOptimizer(
      ctx,
      testOptimizerRuntime({ runId: "run_logcap", argv: [process.execPath, script], spawnImpl: fakeOptimizerSpawn(FIX_IMAGE) }),
    );
    expect(statSync(join(runDir, "optimizer.log")).size).toBeLessThanOrEqual(128);
    expect(readFileSync(join(runDir, "optimizer.log"), "utf8")).toContain("optimizer.log truncated");
  });
});

describe("full local backend: TCP broker + one build feeding the single one-shot probe invocation", () => {
  it("network egress opens the authenticated public TCP listener; the one-shot probe is the only optimizer invocation", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    const runId = "run_tcpflow";
    const runDir = join(root, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(root, ".hone-cas"), { recursive: true });
    const baseline = join(root, "capsule", "baseline");
    initScratchRepo(baseline);
    const commit = gitIn(baseline, "rev-parse", "HEAD");
    const capsuleDir = makeCapsule(root, { baseline: { kind: "git", commit } });
    const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")));
    const digest = capsuleDigest(manifest);
    writeEvents(root, runId, [
      { runId, at: new Date().toISOString(), type: "run.started", capsuleId: manifest.id, contractHash: fakeHash("c"), optimizerDigest: computeOptimizerDigest(FIX_IMAGE) },
      { runId, at: new Date().toISOString(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } },
      { runId, at: new Date().toISOString(), type: "eval.completed", episode: 0, artifact: { hash: fakeHash("b") }, assetGroupId: "train", seed: 1, aggregate: 0.5, cached: false },
    ]);

    const invocations = join(root, "invocations.ndjson");
    const argvs: string[][] = [];
    const run: RunCommand = (argv) => {
      argvs.push([...argv]);
      if (argv[1] === "info") return Promise.resolve(res({ stdout: Buffer.from("ENGINE-TEST\n") }));
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      if (argv[1] === "create" && argv.some((a) => a.includes("bun build"))) {
        // The gated two-phase rewrite delivers the BUILD as a joined create;
        // model the daemon: bake the bundle outputs at create time.
        const out = mountsOf(argv)[1]?.split(":")[0] ?? "";
        // The "bundle": records each invocation's broker endpoint + episode cap.
        writeFileSync(
          join(out, "optimizer.mjs"),
          [
            'import { appendFileSync } from "node:fs";',
            `appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({`,
            "  sock: process.env.HONE_BROKER_SOCK,",
            "  tokenPresent: process.env.HONE_BROKER_TOKEN !== undefined,",
            "  maxEpisodes: process.env.HONE_MAX_EPISODES ?? null,",
            '}) + "\\n");',
          ].join("\n"),
        );
        writeFileSync(join(out, "worker.mjs"), "// worker bundle\n");
        return Promise.resolve(res({ stdout: Buffer.from("bu1ldc1d\n") }));
      }
      // Every other create (donor, relays, keeper) answers with a container id.
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("d0n0r1d\n") }));
      const outArg = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
      if (argv[1] === "exec" && outArg !== undefined) {
        // Model the keeper's snapshot exec: the in-container tar publishes
        // EXACTLY the minted per-attempt basename into the bind-mounted
        // snapshot dir on success — without it, broker cleanup correctly
        // refuses (keeper stays "live") and the cleanup barrier rejects.
        mkdirSync(join(runDir, "scratch-snapshot"), { recursive: true });
        writeFileSync(join(runDir, "scratch-snapshot", outArg.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "");
      }
      return Promise.resolve(res());
    };
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const backend = createBackend({ run, spawnOptimizer: fakeOptimizerSpawn(FIX_IMAGE, seen), createHelper: scriptedCreateHelper(run) });
    const ctx: RunnerBackendContext = {
      runId,
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
      env: { PATH: process.env["PATH"] ?? "", HONE_EGRESS: "network" },
      capsuleDigest: digest,
      optimizerDigest: computeOptimizerDigest(FIX_IMAGE),
      replayed: replayRun(runDir),
      signal: new AbortController().signal,
      emit: (event) => appendEvent(runDir, event),
      registerChild: () => () => {},
      probeGate: () => Promise.resolve(true),
      requestStop: () => {},
      registerAuthorityBarrier: () => {},
      registerCleanupBarrier: () => {},
    };

    await backend.start(ctx);

    // Exactly ONE build (delivered as a joined create by the gate), and the
    // single one-shot probe invocation mounts its bundle. No raw `docker run`
    // survives.
    expect(argvs.filter((a) => a[1] === "create" && a.some((x) => x.includes("bun build"))).length).toBe(1);
    expect(argvs.filter((a) => a[1] === "run")).toEqual([]);
    // M0 one-shot: the probe IS the run — exactly one two-phase optimizer
    // invocation (create + start -a); approval never launches a second.
    const optCreates = seen.argvs.filter((a) => a[1] === "create");
    const optStarts = seen.argvs.filter((a) => a[1] === "start");
    expect(optCreates.length).toBe(1);
    expect(optStarts.length).toBe(1);
    for (const a of optStarts) expect(a[2]).toBe("-a");
    const bundleMounts = optCreates.map((a) => mountsOf(a).find((m) => m.endsWith(":/hone/bundle:ro")));
    expect(bundleMounts[0]).toBeDefined();
    // The invocation joined ONLY the internal egress network and attached the donor.
    for (const a of optCreates) {
      expect(flagValue(a, "--network")).toBe(`hone-${runId}`);
      expect(flagValue(a, "--volumes-from")).toBe(`hone-lease-${runId}-e1:ro`);
    }

    // The optimizer dialed the authenticated TCP listener with the capability.
    const lines = readFileSync(invocations, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { sock: string; tokenPresent: boolean; maxEpisodes: string | null });
    expect(lines.length).toBe(1); // one-shot: no full relaunch ever follows
    expect(lines[0]?.sock).toBe(`tcp://hone-broker-${runId}:8080`);
    expect(lines[0]?.tokenPresent).toBe(true);
    expect(lines[0]?.maxEpisodes).toBe("1"); // probe bound
    // The token never reached argv, the diagnostics log, or the event log.
    const token = seen.envs[0]?.["HONE_BROKER_TOKEN"] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(seen.argvs.flat().join(" ")).not.toContain(token);
    expect(readFileSync(join(runDir, "optimizer.log"), "utf8")).not.toContain(token);
    expect(readFileSync(join(runDir, "events.ndjson"), "utf8")).not.toContain(token);
  });
});

function mustSeal(runtime: { bundleSeal: OptimizerBundleSeal | null }): OptimizerBundleSeal {
  const seal = runtime.bundleSeal;
  if (seal === null) throw new Error("runtime has no bundle seal");
  return seal;
}

const OUR_UID = process.getuid?.() ?? -1;

describe("bundle handoff seal: 0700-rooted output, frozen modes, pre-create re-proof", () => {
  /** A prepared runtime whose "build" is this process writing both bundles (owner-created, exactly like the host-uid build container). */
  async function sealedRuntime(runId: string, seen?: { argvs: string[][]; envs: NodeJS.ProcessEnv[] }) {
    const run: RunCommand = (argv) => {
      if (argv[1] === "run" && argv.some((a) => a.includes("bun build"))) {
        const out = mountsOf(argv)[1]?.split(":")[0] ?? "";
        writeFileSync(join(out, "optimizer.mjs"), "// sealed bundle\n");
        writeFileSync(join(out, "worker.mjs"), "// sealed worker\n");
      }
      return Promise.resolve(res());
    };
    return prepareOptimizerRuntime(
      { runId, env: {}, optimizerDigest: computeOptimizerDigest(FIX_IMAGE) },
      {
        image: FIX_IMAGE,
        transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
        run,
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE, seen),
        containerLease: `hone-lease-${runId}-e1`,
        gate: testGate(runId),
        clientEnv: { PATH: process.env["PATH"] ?? "" },
      },
    );
  }

  it("seals the exact captured bytes under an owner-only umbrella: hashes, inode identities, frozen modes, ownership", async () => {
    const runtime = await sealedRuntime("run_seal");
    const seal = mustSeal(runtime);
    const dir = runtime.bundleDir ?? "";
    expect(seal.dir).toBe(dir);
    expect(seal.root).toBe(dirname(dir));
    expect(basename(seal.root).startsWith("hone-optout-")).toBe(true);
    // The 0700 umbrella is the different-UID wall: not one group/other bit.
    const rootSt = statSync(seal.root);
    expect(rootSt.mode & 0o077).toBe(0);
    expect(rootSt.uid).toBe(OUR_UID);
    // NEVER 0777 again: after sealing, nothing below is writable by ANYONE.
    expect(statSync(dir).mode & 0o777).toBe(0o555);
    expect(seal.uid).toBe(OUR_UID);
    expect(seal.files.map((f) => f.name)).toEqual(["optimizer.mjs", "worker.mjs"]);
    for (const f of seal.files) {
      const st = lstatSync(join(dir, f.name));
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o444);
      expect(st.uid).toBe(OUR_UID);
      expect(st.ino).toBe(f.ino);
      expect(f.size).toBe(st.size);
      expect(f.sha256).toBe(createHash("sha256").update(readFileSync(join(dir, f.name))).digest("hex"));
    }
    // The untouched seal re-verifies clean.
    verifyOptimizerBundleSeal(runtime);
    // Cleanup restores OWNER mode only and removes the whole frozen tree.
    await runtime.cleanup();
    expect(existsSync(seal.root)).toBe(false);
  });

  it("byte replacement between build and run refuses BEFORE any docker client is spawned (same inode, same owner, same modes — only the bytes differ)", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_swapbytes");
    mkdirSync(runDir, { recursive: true });
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const runtime = await sealedRuntime("run_swapbytes", seen);
    const seal = mustSeal(runtime);
    const target = join(seal.dir, "optimizer.mjs");
    // Same-uid tamper simulation (another host UID cannot even traverse the
    // 0700 umbrella): restore write, swap bytes IN PLACE, re-freeze the exact
    // sealed modes. Path existence and permissions all still check out.
    chmodSync(seal.dir, 0o700);
    chmodSync(target, 0o600);
    writeFileSync(target, "// evil replacement\n");
    chmodSync(target, 0o444);
    chmodSync(seal.dir, 0o555);
    await expect(runOptimizer(optCtx(root, runDir, "run_swapbytes"), runtime)).rejects.toThrow(/sealed bundle bytes drifted/);
    // The refusal precedes the create: ZERO docker clients were ever spawned.
    expect(seen.argvs.length).toBe(0);
    await runtime.cleanup();
  });

  it("inode swap with byte-identical content refuses — replacement is detected even when the hash would match", async () => {
    const runtime = await sealedRuntime("run_swapino");
    const seal = mustSeal(runtime);
    const target = join(seal.dir, "worker.mjs");
    const bytes = readFileSync(target);
    chmodSync(seal.dir, 0o700);
    rmSync(target);
    writeFileSync(target, bytes);
    chmodSync(target, 0o444);
    chmodSync(seal.dir, 0o555);
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/replaced \(inode changed\)/);
    await runtime.cleanup();
  });

  it("symlink and non-regular swaps refuse", async () => {
    const runtime = await sealedRuntime("run_swapsym");
    const seal = mustSeal(runtime);
    const target = join(seal.dir, "optimizer.mjs");
    const decoy = join(seal.root, "decoy.mjs");
    writeFileSync(decoy, readFileSync(target)); // byte-identical decoy elsewhere
    chmodSync(seal.dir, 0o700);
    rmSync(target);
    symlinkSync(decoy, target);
    chmodSync(seal.dir, 0o555);
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/not a regular file/);
    // Non-regular: a directory in the file's place.
    chmodSync(seal.dir, 0o700);
    rmSync(target);
    mkdirSync(target);
    chmodSync(seal.dir, 0o555);
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/not a regular file/);
    await runtime.cleanup();
  });

  it("mode swaps refuse: a writable file, a writable dir, an opened-up umbrella — and the restored seal verifies again", async () => {
    const runtime = await sealedRuntime("run_swapmode");
    const seal = mustSeal(runtime);
    const target = join(seal.dir, "optimizer.mjs");
    chmodSync(seal.dir, 0o700);
    chmodSync(target, 0o644); // file regained owner write
    chmodSync(seal.dir, 0o555);
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/regained write permission/);
    chmodSync(seal.dir, 0o700);
    chmodSync(target, 0o444);
    chmodSync(seal.dir, 0o755); // dir regained write
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/regained write permission/);
    chmodSync(seal.dir, 0o555);
    chmodSync(seal.root, 0o755); // umbrella opened to other UIDs
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/group\/other-accessible/);
    chmodSync(seal.root, 0o700);
    verifyOptimizerBundleSeal(runtime); // fully restored: clean again
    await runtime.cleanup();
  });

  it("owner drift refuses: the on-disk uid must match the sealed owner", async () => {
    const runtime = await sealedRuntime("run_swapowner");
    const seal = mustSeal(runtime);
    // A chown needs root; simulate the mismatch from the seal's side — the
    // comparison under test is identical either way.
    runtime.bundleSeal = { ...seal, uid: seal.uid + 1 };
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/owned by uid/);
    runtime.bundleSeal = seal;
    verifyOptimizerBundleSeal(runtime);
    await runtime.cleanup();
  });

  it("a mounted bundleDir without a seal refuses; an argv override (nothing mounted) is exempt", () => {
    const runtime = testOptimizerRuntime({ runId: "run_unsealed", argv: ["true"] });
    verifyOptimizerBundleSeal(runtime); // bundleDir null: no mount, nothing to prove
    runtime.bundleDir = "/tmp/anything";
    expect(() => verifyOptimizerBundleSeal(runtime)).toThrow(/never sealed/);
    const sealedElsewhere = { bundleDir: "/tmp/anything", bundleSeal: { root: "/tmp", dir: "/tmp/other", uid: OUR_UID, dirIno: 0, dirDev: 0, files: [] } };
    expect(() => verifyOptimizerBundleSeal(sealedElsewhere)).toThrow(/drifted from its seal/);
  });

  it("no other host UID holds authority over ANY handoff component — the kernel bits are the different-UID denial", async () => {
    const runtime = await sealedRuntime("run_authz");
    const seal = mustSeal(runtime);
    // POSIX decides another uid's access from exactly these bits: the 0700
    // umbrella (zero group/other bits, owned by us) denies traversal — so
    // listing, reading, writing, unlinking, and recreating are ALL impossible
    // below it — and no inode below carries a write bit for anyone. (A true
    // setuid probe requires root; these bits are the enforcement itself.)
    expect(lstatSync(seal.root).mode & 0o077).toBe(0);
    expect(lstatSync(seal.root).uid).toBe(OUR_UID);
    expect(lstatSync(seal.dir).mode & 0o222).toBe(0);
    for (const f of seal.files) expect(lstatSync(join(seal.dir, f.name)).mode & 0o222).toBe(0);
    // The umbrella itself cannot be unlinked/renamed by others: its parent is
    // either owner-only (macOS per-user tmp) or sticky (Linux /tmp).
    const parent = lstatSync(dirname(seal.root));
    expect((parent.mode & 0o022) === 0 || (parent.mode & 0o1000) !== 0).toBe(true);
    await runtime.cleanup();
  });
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;
const REAL_IMAGE = "hone-mutation:latest";
const hasRealImage = hasDocker && spawnSync("docker", ["image", "inspect", REAL_IMAGE], { stdio: "ignore", timeout: 15_000 }).status === 0;

describe("REAL docker: host-uid build into the 0700-rooted handoff", () => {
  it.skipIf(!hasRealImage)(
    "prepareOptimizerRuntime truly builds inside the image as the numeric host uid; the output seals, verifies, and a tamper refuses",
    { timeout: 600_000 },
    async () => {
      const runId = `sealsmoke-${Date.now()}`;
      const lease = `hone-lease-${runId}-e1`;
      const donor = await runCommand(["docker", "create", "--name", lease, "--label", `hone.runId=${runId}`, REAL_IMAGE, "true"], { timeoutMs: 60_000 });
      expect(donor.exitCode).toBe(0);
      let runtime: OptimizerRuntime | undefined;
      try {
        runtime = await prepareOptimizerRuntime(
          { runId, env: {}, optimizerDigest: computeOptimizerDigest(REAL_IMAGE) },
          {
            image: REAL_IMAGE,
            transport: { kind: "unix", hostSocketPath: "/dev/null", token: "a".repeat(64) },
            run: runCommand,
            spawnImpl: fakeOptimizerSpawn(REAL_IMAGE),
            containerLease: lease,
            gate: testGate(runId),
            clientEnv: { PATH: process.env["PATH"] ?? "" },
          },
        );
        const rt = runtime;
        const seal = mustSeal(rt);
        // The REAL bun-built bundles landed as owner-owned regular files in
        // the 0700-rooted, write-permission-stripped handoff.
        expect(statSync(seal.root).mode & 0o077).toBe(0);
        expect(statSync(seal.dir).mode & 0o777).toBe(0o555);
        for (const f of seal.files) {
          expect(f.size).toBeGreaterThan(0);
          const st = lstatSync(join(seal.dir, f.name));
          expect(st.isFile()).toBe(true);
          expect(st.uid).toBe(OUR_UID); // --user <host uid>:<host gid> wrote as US, not 2000
          expect(st.mode & 0o777).toBe(0o444);
        }
        verifyOptimizerBundleSeal(rt);
        // Simulated replacement between build and run refuses at the pre-create gate.
        const target = join(seal.dir, "optimizer.mjs");
        chmodSync(seal.dir, 0o700);
        chmodSync(target, 0o600);
        writeFileSync(target, "// evil\n");
        chmodSync(target, 0o444);
        chmodSync(seal.dir, 0o555);
        expect(() => verifyOptimizerBundleSeal(rt)).toThrow(/sealed bundle bytes drifted/);
      } finally {
        await runtime?.cleanup();
        await runCommand(["docker", "rm", "-f", lease], { timeoutMs: 60_000 });
      }
    },
  );
});

function optCtx(root: string, runDir: string, runId: string): RunnerBackendContext {
  const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(makeCapsule(root), "manifest.json"), "utf8")));
  return {
    runId,
    root,
    runDir,
    casDir: join(root, ".hone-cas"),
    capsuleDir: join(root, "capsule"),
    manifest,
    config: RunConfig.parse({
      version: 1,
      capsuleId: manifest.id,
      objective: manifest.objective,
      budget: manifest.budget,
      routing: { mutation: { model: "m" } },
    }),
    env: { PATH: process.env["PATH"] ?? "" },
    capsuleDigest: fakeHash("f"),
    optimizerDigest: fakeHash("0"),
    replayed: replayRun(runDir),
    signal: new AbortController().signal,
    emit: (event) => event,
    registerChild: () => () => {},
    probeGate: () => Promise.resolve(true),
    requestStop: () => {},
    registerAuthorityBarrier: () => {},
    registerCleanupBarrier: () => {},
  };
}
