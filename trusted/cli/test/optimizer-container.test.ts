import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapsuleManifest, RunConfig, capsuleDigest } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { createBackend, runOptimizer } from "../src/backends/local.js";
import {
  optimizerBuildArgs,
  optimizerRunArgs,
  prepareOptimizerRuntime,
} from "../src/backends/optimizer-container.js";
import { appendEvent, readEvents, replayRun } from "../src/eventlog.js";
import { computeOptimizerDigest } from "../src/optimizer-digest.js";
import type { RunnerBackendContext } from "../src/types.js";
import {
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

describe("build container argv exactness", () => {
  it("no network, read-only source, isolated output, uid 2000, caps, pinned image, bun build", () => {
    const argv = optimizerBuildArgs({ runId: "run_b", safeRunId: "run_b", image: FIX_IMAGE, stagingDir: "/tmp/src", outDir: "/tmp/out" });
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
    expect(flagValue(argv, "--network")).toBe("none");
    expect(argv).toContain("--read-only");
    expect(flagValue(argv, "--user")).toBe("2000:2000");
    expect(flagValue(argv, "--cap-drop")).toBe("ALL");
    expect(flagValue(argv, "--security-opt")).toBe("no-new-privileges");
    expect(flagValue(argv, "--pids-limit")).toBe("512");
    expect(flagValue(argv, "--label")).toBe("hone.runId=run_b");
    expect(mountsOf(argv)).toEqual(["/tmp/src:/hone/src:ro", "/tmp/out:/hone/out"]);
    // The compiler runs INSIDE the pinned image on the staged tree only.
    const imageIdx = argv.indexOf(FIX_IMAGE);
    expect(imageIdx).toBeGreaterThan(0);
    expect(argv.slice(imageIdx + 1)).toEqual(["bun", "build", "/hone/src/optimizer/src/main.ts", "--target=node", "--outfile=/hone/out/optimizer.mjs"]);
  });
});

describe("run container argv exactness", () => {
  const baseOpts = {
    name: "hone-opt-run_r-1",
    runId: "run_r",
    image: FIX_IMAGE,
    bundleDir: "/tmp/bundle",
    runArgv: ["node", "/hone/bundle/optimizer.mjs"],
    env: { HONE_BROKER_SOCK: "/run/hone/broker.sock", HONE_RUN_ID: "run_r", HONE_SEED: "0", HONE_RESUME: "{}" },
  };

  it("linux/unix transport: --network none, ONLY bundle + public broker.sock mounted, uid 2000", () => {
    const argv = optimizerRunArgs({ ...baseOpts, transport: { kind: "unix", hostSocketPath: "/runs/r/broker.sock" } });
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"]);
    expect(flagValue(argv, "--network")).toBe("none");
    expect(argv).toContain("--read-only");
    expect(flagValue(argv, "--user")).toBe("2000:2000");
    expect(flagValue(argv, "--cap-drop")).toBe("ALL");
    // The FULL mount set: bundle (ro) and the public broker socket. Nothing else —
    // no repo, no runDir, no CAS, no capsule, no holdout ledger, no docker.sock.
    expect(mountsOf(argv)).toEqual(["/tmp/bundle:/hone/bundle:ro", "/runs/r/broker.sock:/run/hone/broker.sock"]);
    expect(argv.join(" ")).not.toMatch(/docker\.sock|\.hone-cas|admin/);
    // No token machinery on the unix path.
    expect(argv).not.toContain("HONE_BROKER_TOKEN");
  });

  it("darwin/tcp transport: joins ONLY the internal egress network; token is value-less env, NEVER argv", () => {
    const token = "f".repeat(64);
    const argv = optimizerRunArgs({
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
});

describe("prepareOptimizerRuntime: exact snapshot proof + one-time build", () => {
  const ctxSlice = (digest: string): Pick<RunnerBackendContext, "runId" | "env" | "optimizerDigest"> => ({
    runId: "run_prep",
    env: {},
    optimizerDigest: digest,
  });

  it("recollects, requires the sealed digest, stages the capture, and builds once", async () => {
    const argvs: string[][] = [];
    const run: RunCommand = (argv) => {
      argvs.push([...argv]);
      if (argv[1] === "run" && argv.includes("bun")) {
        // The "build container": consume the staged ro mount, emit the bundle.
        const out = mountsOf(argv)[1]?.split(":")[0] ?? "";
        const src = mountsOf(argv)[0]?.split(":")[0] ?? "";
        expect(existsSync(join(src, "optimizer", "src", "main.ts"))).toBe(true);
        expect(existsSync(join(src, "optimizer", "node_modules", "@hone", "schema", "package.json"))).toBe(true);
        writeFileSync(join(out, "optimizer.mjs"), "// bundle\n");
      }
      return Promise.resolve(res());
    };
    const runtime = await prepareOptimizerRuntime(ctxSlice(computeOptimizerDigest(FIX_IMAGE)), {
      image: FIX_IMAGE,
      transport: { kind: "unix", hostSocketPath: "/dev/null" },
      run,
      spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
    });
    const builds = argvs.filter((a) => a[1] === "run" && a.includes("bun"));
    expect(builds.length).toBe(1);
    expect(runtime.bundleDir).not.toBeNull();
    expect(runtime.runArgv).toEqual(["node", "/hone/bundle/optimizer.mjs"]);
    const bundleDir = runtime.bundleDir ?? "";
    expect(existsSync(join(bundleDir, "optimizer.mjs"))).toBe(true);
    await runtime.cleanup();
    // Temp staging/output trees are gone; containers were rm -f'd by name.
    expect(existsSync(bundleDir)).toBe(false);
    expect(argvs.some((a) => a[1] === "rm" && a.includes("hone-optbuild-run_prep"))).toBe(true);
  });

  it("refuses to execute when the recollected digest differs from the seal", async () => {
    await expect(
      prepareOptimizerRuntime(ctxSlice(fakeHash("0")), {
        image: FIX_IMAGE,
        transport: { kind: "unix", hostSocketPath: "/dev/null" },
        run: okRun(),
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
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
      { image: FIX_IMAGE, transport: { kind: "unix", hostSocketPath: "/dev/null" }, run, spawnImpl: fakeOptimizerSpawn(FIX_IMAGE) },
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
        transport: { kind: "unix", hostSocketPath: "/dev/null" },
        run: async (argv) =>
          argv[1] === "rm"
            ? res({ exitCode: 1, stderr: Buffer.from("daemon refused removal") })
            : res(),
        spawnImpl: fakeOptimizerSpawn(FIX_IMAGE),
      },
    );
    runtime.spawnedNames.push("hone-opt-run_leak-0");
    await expect(runtime.cleanup()).rejects.toThrow(/optimizer cleanup incomplete.*daemon refused removal/);
  });
});

describe("runOptimizer: docker-only launch, token hygiene", () => {
  it("launches ONLY via docker run of the pinned image — a host argv is rejected by the seam", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_host");
    mkdirSync(runDir, { recursive: true });
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const script = join(root, "opt.mjs");
    writeFileSync(script, "process.exit(0);\n");
    const ctx = optCtx(root, runDir, "run_host");
    await runOptimizer(ctx, testOptimizerRuntime({ runId: "run_host", argv: [process.execPath, script], spawnImpl: fakeOptimizerSpawn(FIX_IMAGE, seen) }));
    expect(seen.argvs.length).toBe(1);
    expect(seen.argvs[0]?.[0]).toBe("docker");
    expect(seen.argvs[0]?.[1]).toBe("run");
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
    expect(seen.argvs[0]?.join(" ")).not.toContain(token);
    expect(seen.envs[0]?.["HONE_BROKER_TOKEN"]).toBe(token); // docker client env — resolved by the value-less -e
    expect(existsSync(join(runDir, "events.ndjson"))).toBe(false);
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

describe("full local backend: TCP broker + one build reused by probe AND full launch", () => {
  it("network egress opens the authenticated public TCP listener; two invocations share one bundle", { timeout: 60_000 }, async () => {
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
      if (argv[1] === "network" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("true\n") }));
      if (argv[1] === "run" && argv.includes("bun")) {
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
      }
      return Promise.resolve(res());
    };
    const seen = { argvs: [] as string[][], envs: [] as NodeJS.ProcessEnv[] };
    const backend = createBackend({ run, spawnOptimizer: fakeOptimizerSpawn(FIX_IMAGE, seen) });
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

    // Exactly ONE build; both optimizer invocations reuse the bundle.
    expect(argvs.filter((a) => a[1] === "run" && a.includes("bun")).length).toBe(1);
    expect(seen.argvs.length).toBe(2);
    const bundleMounts = seen.argvs.map((a) => mountsOf(a).find((m) => m.endsWith(":/hone/bundle:ro")));
    expect(bundleMounts[0]).toBeDefined();
    expect(bundleMounts[1]).toBe(bundleMounts[0]);
    // Both joined ONLY the internal egress network.
    for (const a of seen.argvs) expect(flagValue(a, "--network")).toBe(`hone-${runId}`);

    // The optimizer dialed the authenticated TCP listener with the capability.
    const lines = readFileSync(invocations, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { sock: string; tokenPresent: boolean; maxEpisodes: string | null });
    expect(lines.length).toBe(2);
    expect(lines[0]?.sock).toBe(`tcp://hone-broker-${runId}:8080`);
    expect(lines[0]?.tokenPresent).toBe(true);
    expect(lines[0]?.maxEpisodes).toBe("1"); // probe bound
    expect(lines[1]?.maxEpisodes).toBeNull(); // full relaunch
    // The token never reached argv, the diagnostics log, or the event log.
    const token = seen.envs[0]?.["HONE_BROKER_TOKEN"] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(64);
    expect(seen.argvs.flat().join(" ")).not.toContain(token);
    expect(readFileSync(join(runDir, "optimizer.log"), "utf8")).not.toContain(token);
    expect(readFileSync(join(runDir, "events.ndjson"), "utf8")).not.toContain(token);
  });
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
