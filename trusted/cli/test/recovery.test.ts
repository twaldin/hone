import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, constants as fsConstants, existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticOrderingReport, RunConfig, RunEvent, capsuleDigest } from "@hone/schema";
import type { BudgetState } from "@hone/schema";
import { runCommand } from "@hone/broker";
import type { CallContext, CmdResult, RunCommand } from "@hone/broker";
import type { ProxyHandle } from "@hone/proxy";
import { freezeCapsuleAssets, writeCapsuleSnapshot } from "../src/admission.js";
import { contractHash, renderContract } from "../src/contract.js";
import { reconcileBrokerAuthority, setupEgress, sweepStaleRunResources } from "../src/backends/local.js";
import type { AuthorityRecoverySource } from "../src/backends/local.js";
import { appendEvent, bestArtifact, eventsPath, readEvents, replayRun } from "../src/eventlog.js";

import { deferred, sleep } from "../src/promise.js";
import { loadRunConfigFile, writeRunConfigFile } from "../src/runs.js";
import { RUNTIME_PIN_FILE, acquireRunLock, probeRunLockIdentity, runCommand as cliRunCommand, runLockPath, superviseRun, trustedRuntimeDigest } from "../src/supervisor.js";
import {
  CAP_ID,
  FIX_OPTIMIZER_DIGEST,
  at,
  fakeHash,
  fixtureEvents,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestObject,
  orderingReportRaw,
  writeEvents,
} from "./helpers.js";

const DARWIN_O_EXLOCK = 0x20;

function holdForeignRunClaim(path: string): number {
  if (process.platform === "darwin") {
    return openSync(path, fsConstants.O_RDWR | fsConstants.O_NONBLOCK | DARWIN_O_EXLOCK);
  }
  return openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
}

/**
 * Second-pass review findings 10 + 11: crash-resume must sweep stale docker
 * resources on the default local backend, and must reconcile the broker's
 * durable authority journal into events.ndjson exactly once before the
 * optimizer resumes.
 */

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

function fakeRunner(handler: (argv: readonly string[]) => CmdResult | undefined): { calls: string[][]; run: RunCommand } {
  const calls: string[][] = [];
  const run: RunCommand = (argv) => {
    calls.push([...argv]);
    return Promise.resolve(handler(argv) ?? res());
  };
  return { calls, run };
}

const findCall = (calls: string[][], ...prefix: string[]): number =>
  calls.findIndex((c) => prefix.every((p, i) => c[i] === p));

describe("sweepStaleRunResources (finding 10 — crashed prior process)", () => {
  it("removes labeled containers, the deterministic relay/network, and stale sockets", async () => {
    const runDir = makeRoot();
    for (const sock of ["proxy.sock", "broker.sock", "broker-admin.sock"]) {
      writeFileSync(join(runDir, sock), "");
    }
    // runId with a char outside the docker-name alphabet: label filter must
    // use the RAW id, container/network names the sanitized one.
    const runId = "run:7f3a";
    const { calls, run } = fakeRunner((argv) => {
      if (argv[1] === "ps") return res({ stdout: Buffer.from("aaa111\nbbb222\n") });
      return undefined;
    });

    await sweepStaleRunResources(runId, runDir, run);

    const ps = findCall(calls, "docker", "ps");
    expect(ps).toBeGreaterThanOrEqual(0);
    expect(calls[ps]).toEqual(["docker", "ps", "-aq", "--no-trunc", "--filter", "label=hone.runId=run:7f3a"]);

    const rmLabeled = findCall(calls, "docker", "rm", "-f", "aaa111");
    expect(calls[rmLabeled]).toEqual(["docker", "rm", "-f", "aaa111", "bbb222"]);

    const rmRelay = findCall(calls, "docker", "rm", "-f", "hone-proxy-run-7f3a");
    expect(rmRelay).toBeGreaterThanOrEqual(0);
    const rmBrokerRelay = findCall(calls, "docker", "rm", "-f", "hone-broker-run-7f3a");
    expect(rmBrokerRelay).toBeGreaterThanOrEqual(0);

    const rmNet = findCall(calls, "docker", "network", "rm");
    expect(calls[rmNet]).toEqual(["docker", "network", "rm", "hone-run-7f3a"]);
    // containers must be gone BEFORE the network removal (attached containers block it)
    expect(rmLabeled).toBeLessThan(rmNet);
    expect(rmRelay).toBeLessThan(rmNet);
    expect(rmBrokerRelay).toBeLessThan(rmNet);

    for (const sock of ["proxy.sock", "broker.sock", "broker-admin.sock"]) {
      expect(existsSync(join(runDir, sock))).toBe(false);
    }
  });

  it("is best-effort: a failing `docker ps` still sweeps the deterministic names", async () => {
    const runDir = makeRoot();
    const { calls, run } = fakeRunner((argv) => {
      if (argv[1] === "ps") return res({ exitCode: 1, stderr: Buffer.from("daemon down") });
      return undefined;
    });

    await expect(sweepStaleRunResources("run_x", runDir, run)).resolves.toBeUndefined();
    expect(findCall(calls, "docker", "rm", "-f", "hone-proxy-run_x")).toBeGreaterThanOrEqual(0);
    expect(findCall(calls, "docker", "rm", "-f", "hone-broker-run_x")).toBeGreaterThanOrEqual(0);
    expect(findCall(calls, "docker", "network", "rm", "hone-run_x")).toBeGreaterThanOrEqual(0);
    // no batch rm for an unknown container list
    expect(findCall(calls, "docker", "rm", "-f", "aaa111")).toBe(-1);
  });

  it("removes labeled and deterministic per-run scratch volumes", async () => {
    const { calls, run } = fakeRunner((argv) =>
      argv[1] === "volume" && argv[2] === "ls"
        ? res({ stdout: Buffer.from("hone-extra-run_x\n") })
        : undefined,
    );
    await sweepStaleRunResources("run_x", makeRoot(), run);
    expect(findCall(calls, "docker", "volume", "rm", "-f", "hone-scratch-run_x")).toBeGreaterThanOrEqual(0);
    expect(findCall(calls, "docker", "volume", "rm", "-f", "hone-extra-run_x")).toBeGreaterThanOrEqual(0);
  });

  it("removes stale scratch writers before taking a quiescent keeper snapshot, then publishes it durably", async () => {
    const runDir = makeRoot();
    let psCalls = 0;
    const { calls, run } = fakeRunner((argv) => {
      if (argv[1] === "inspect") return res({ stdout: Buffer.from("keeper-id true\n") });
      if (argv[1] === "ps") {
        psCalls += 1;
        return res({ stdout: Buffer.from(psCalls === 1 ? "keeper-id\nstale-mutation\n" : "keeper-id\n") });
      }
      if (argv[1] === "exec") {
        // The in-container script only produces the per-attempt temp archive
        // (exactly the minted HONE_SCRATCH_SNAPSHOT_OUT basename); the HOST
        // publishes it (fsync → rename → fsync dir) after the exec returns.
        const out = argv.find((a) => typeof a === "string" && a.startsWith("HONE_SCRATCH_SNAPSHOT_OUT="));
        if (out === undefined) return res({ exitCode: 1, stderr: Buffer.from("missing HONE_SCRATCH_SNAPSHOT_OUT") });
        writeFileSync(join(runDir, "scratch-snapshot", out.slice("HONE_SCRATCH_SNAPSHOT_OUT=".length)), "tar-bytes");
        return res();
      }
      return undefined;
    });

    await sweepStaleRunResources("run_x", runDir, run, true);
    const snapshot = calls.findIndex((c) => c[0] === "docker" && c[1] === "exec" && c.includes("hone-scratch-keeper-run_x"));
    const remove = findCall(calls, "docker", "rm", "-f", "stale-mutation");
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(remove).toBeLessThan(snapshot);
    // Durable, atomic publication: every unpublished temp swept, final snapshot in place.
    expect(readdirSync(join(runDir, "scratch-snapshot")).filter((e) => e.startsWith("scratch.tar.tmp"))).toEqual([]);
    expect(readFileSync(join(runDir, "scratch-snapshot", "scratch.tar"), "utf8")).toBe("tar-bytes");
  });

  it("strict mode fails closed when the snapshot exec succeeds but no temp archive exists to publish", async () => {
    const runDir = makeRoot();
    const { run } = fakeRunner((argv) => {
      if (argv[1] === "inspect") return res({ stdout: Buffer.from("keeper-id true\n") });
      if (argv[1] === "ps") return res({ stdout: Buffer.from("keeper-id\n") });
      return undefined; // exec "succeeds" but writes nothing
    });
    await expect(sweepStaleRunResources("run_x", runDir, run, true)).rejects.toThrow(
      /scratch snapshot finalize/,
    );
  });

  it("strict mode rejects when resource discovery cannot prove cleanup", async () => {
    const { run } = fakeRunner((argv) =>
      argv[1] === "ps" ? res({ exitCode: 1, stderr: Buffer.from("daemon down") }) : undefined,
    );
    await expect(sweepStaleRunResources("run_x", makeRoot(), run, true)).rejects.toThrow(/container discovery: daemon down/);
  });
});

function fakeProxy(port: number): ProxyHandle {
  const preflight = { passed: true, observations: [] };
  return {
    tokens: [],
    tokenFor: () => "tok",
    dispatchRecovery: () =>
      Promise.resolve({ poisoned: undefined, recovered: [], chargedTotals: { tokens: 0, usd: 0 } }),
    campaignPause: () => Promise.resolve(undefined),
    preflight: () => Promise.resolve(preflight),
    resume: () => Promise.resolve(preflight),
    listenUnix: () => Promise.resolve(),
    listenTcp: () => Promise.resolve(port),
    close: () => Promise.resolve(),
  };
}

describe("setupEgress Unix socket path", () => {
  it("binds a short deterministic host path for deep meta-run directories and removes it on cleanup", async () => {
    const runDir = join(makeRoot(), "nested", "campaign", "directory");
    const runId = `run_meta_outer_${"a".repeat(64)}`;
    let listenedPath: string | null = null;
    const proxy: ProxyHandle = {
      ...fakeProxy(0),
      listenUnix: async (socketPath) => {
        listenedPath = socketPath;
        writeFileSync(socketPath, "");
      },
    };
    const { run } = fakeRunner(() => undefined);

    const egress = await setupEgress({ runId, runDir, env: { HONE_EGRESS: "socket" } }, proxy, "img:latest", run);
    const boundPath = egress.proxySocketHostPath;
    expect(boundPath).not.toBeNull();
    if (boundPath === null) throw new Error("expected Unix proxy socket path");
    expect(Buffer.byteLength(boundPath, "utf8")).toBeLessThan(108);
    expect(boundPath.startsWith(runDir)).toBe(false);
    expect(boundPath).toBe(listenedPath);
    expect(existsSync(boundPath)).toBe(true);

    await egress.cleanup();
    expect(existsSync(boundPath)).toBe(false);
  });
});

describe("setupEgress network create (finding 10 — idempotent after cleanup)", () => {
  const ctx = (runDir: string): { runId: string; runDir: string; env: NodeJS.ProcessEnv } => ({
    runId: "run_y",
    runDir,
    env: { HONE_EGRESS: "network" },
  });

  it("tolerates an already-existing network only when it is --internal", async () => {
    const { calls, run } = fakeRunner((argv) => {
      if (argv[1] === "network" && argv[2] === "create") {
        return res({ exitCode: 1, stderr: Buffer.from("Error: network with name hone-run_y already exists") });
      }
      if (argv[1] === "network" && argv[2] === "inspect") return res({ stdout: Buffer.from("true\n") });
      return undefined;
    });

    const egress = await setupEgress(ctx(makeRoot()), fakeProxy(43210), "img:latest", run);
    expect(egress.sandboxNetwork).toEqual({ mode: "internal", network: "hone-run_y" });
    expect(egress.proxyBaseUrl).toBe("http://hone-proxy-run_y:8080/v1");
    expect(findCall(calls, "docker", "network", "inspect")).toBeGreaterThanOrEqual(0);
    // relay container still launched and bridged
    expect(findCall(calls, "docker", "run")).toBeGreaterThanOrEqual(0);
    expect(findCall(calls, "docker", "network", "connect")).toBeGreaterThanOrEqual(0);
    const brokerEndpoint = await egress.exposeBroker(54321);
    expect(brokerEndpoint).toBe("tcp://hone-broker-run_y:8080");
    const brokerRelayRun = calls.find(
      (argv) => argv[0] === "docker" && argv[1] === "run" && argv.includes("hone-broker-run_y"),
    );
    expect(brokerRelayRun).toEqual(expect.arrayContaining([
      "--network",
      "hone-run_y",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "HONE_RELAY_PORT=54321",
      "img:latest",
    ]));
    expect(findCall(calls, "docker", "network", "connect", "bridge", "hone-broker-run_y")).toBeGreaterThanOrEqual(0);
  });

  it("compacts long run ids into resolvable Docker DNS labels", async () => {
    const { run } = fakeRunner(() => undefined);
    const runId = `run_meta_outer_${"a".repeat(64)}`;
    const egress = await setupEgress(
      { runId, runDir: makeRoot(), env: { HONE_EGRESS: "network" } },
      fakeProxy(43210),
      "img:latest",
      run,
    );
    expect(egress.sandboxNetwork.mode).toBe("internal");
    if (egress.sandboxNetwork.mode !== "internal") throw new Error("expected internal network");
    expect(egress.sandboxNetwork.network.length).toBeLessThanOrEqual(63);
    expect(new URL(egress.proxyBaseUrl ?? "").hostname.length).toBeLessThanOrEqual(63);
    const brokerEndpoint = await egress.exposeBroker(54321);
    expect(new URL(brokerEndpoint).hostname.length).toBeLessThanOrEqual(63);
    await egress.cleanup();
  });

  it("refuses to attach sandboxes to a pre-existing NON-internal network of the same name", async () => {
    const { run } = fakeRunner((argv) => {
      if (argv[1] === "network" && argv[2] === "create") {
        return res({ exitCode: 1, stderr: Buffer.from("already exists") });
      }
      if (argv[1] === "network" && argv[2] === "inspect") return res({ stdout: Buffer.from("false\n") });
      return undefined;
    });
    await expect(setupEgress(ctx(makeRoot()), fakeProxy(43210), "img:latest", run)).rejects.toThrow(/not --internal/);
  });

  it("still fails loudly on any other create error", async () => {
    const { run } = fakeRunner((argv) => {
      if (argv[1] === "network" && argv[2] === "create") return res({ exitCode: 1, stderr: Buffer.from("permission denied") });
      return undefined;
    });
    await expect(setupEgress(ctx(makeRoot()), fakeProxy(43210), "img:latest", run)).rejects.toThrow(/permission denied/);
  });
  it("rejects cleanup when a relay network may still be live", async () => {
    const { run } = fakeRunner((argv) =>
      argv[1] === "network" && argv[2] === "rm"
        ? res({ exitCode: 1, stderr: Buffer.from("network has active endpoints") })
        : undefined,
    );
    const egress = await setupEgress(ctx(makeRoot()), fakeProxy(43210), "img:latest", run);
    await expect(egress.cleanup()).rejects.toThrow(/egress cleanup incomplete.*active endpoints/);
  });

  it("attaches the docker-run lease to BOTH Darwin relay containers when provided", async () => {
    const { calls, run } = fakeRunner(() => undefined);
    const egress = await setupEgress(ctx(makeRoot()), fakeProxy(43210), "img:latest", run, "hone-lease-run_y");
    await egress.exposeBroker(54321);

    const relayRuns = calls.filter((argv) => argv[0] === "docker" && argv[1] === "run");
    expect(relayRuns).toHaveLength(2); // proxy relay + broker relay
    for (const argv of relayRuns) {
      const flag = argv.indexOf("--volumes-from");
      expect(flag, `--volumes-from missing in: ${argv.join(" ")}`).toBeGreaterThanOrEqual(0);
      expect(argv[flag + 1]).toBe("hone-lease-run_y:ro");
      // The lease attachment lands BEFORE the image, where docker parses flags.
      expect(flag).toBeLessThan(argv.indexOf("img:latest"));
    }
  });

  it("omits --volumes-from entirely when no lease is provided", async () => {
    const { calls, run } = fakeRunner(() => undefined);
    await setupEgress(ctx(makeRoot()), fakeProxy(43210), "img:latest", run);
    const relayRuns = calls.filter((argv) => argv[0] === "docker" && argv[1] === "run");
    expect(relayRuns.length).toBeGreaterThanOrEqual(1);
    for (const argv of relayRuns) expect(argv).not.toContain("--volumes-from");
  });
});

const FIX_BUDGET: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
  spent: { tokens: 10, usd: 0.5, wallClockSec: 3, evaluatorInvocations: 1 },
};

/** Fake honoring the agreed Broker.replayIncumbentEvents contract (count alignment, ordered re-emit). */
function fakeBrokerJournal(
  runDir: string,
  runId: string,
  journal: { hash: string; aggregate: number; deltaVsBaseline: number; episode: number }[],
): AuthorityRecoverySource {
  return {
    replayIncumbentEvents(alreadyLogged: number): number {
      if (!Number.isInteger(alreadyLogged) || alreadyLogged < 0 || alreadyLogged > journal.length) {
        throw new Error(`event log claims ${alreadyLogged} incumbents, journal has ${journal.length}`);
      }
      const missing = journal.slice(alreadyLogged);
      for (const inc of missing) {
        appendEvent(runDir, {
          runId,
          at: at(),
          type: "incumbent.new",
          artifact: { hash: inc.hash },
          aggregate: inc.aggregate,
          deltaVsBaseline: inc.deltaVsBaseline,
          episode: inc.episode,
        });
      }
      return missing.length;
    },
    getBudget(_ctx: CallContext): BudgetState {
      return FIX_BUDGET;
    },
  };
}

describe("reconcileBrokerAuthority (finding 11 — split-journal crash window)", () => {
  const runId = "run_z";
  const durable = fakeHash("d");

  /** events.ndjson as left by a SIGKILL between the broker's fsynced journal append and the event sink. */
  function crashWindowRunDir(): string {
    const runDir = makeRoot();
    appendEvent(runDir, { runId, at: at(), type: "run.started", capsuleId: "cap_00000000abcd", contractHash: fakeHash("c"), optimizerDigest: "unpinned" });
    appendEvent(runDir, { runId, at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } });
    return runDir;
  }

  it("re-emits the journaled incumbent exactly once; best resolves to the durable artifact", () => {
    const runDir = crashWindowRunDir();
    const broker = fakeBrokerJournal(runDir, runId, [{ hash: durable, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 }]);
    const emit = (e: RunEvent): RunEvent => appendEvent(runDir, e);

    // before: the exploit — replay sees no incumbent, delivery would ship null/stale
    expect(replayRun(runDir).incumbent).toBeNull();

    const recovered = reconcileBrokerAuthority(runDir, broker, emit, runId);
    expect(recovered).toBe(1);

    const events = readEvents(runDir);
    const incumbents = events.filter((e) => e.type === "incumbent.new");
    expect(incumbents.length).toBe(1);
    const state = replayRun(runDir);
    expect(bestArtifact(state)?.hash).toBe(durable);
    expect(state.incumbent?.aggregate).toBe(0.7);
    expect(state.incumbent?.deltaVsBaseline).toBe(0.2);
    // budget authority reconverges through the same durable sink
    expect(state.lastBudget).toEqual(FIX_BUDGET);

    // resuming AGAIN reconciles to zero: exactly-once, no duplicate incumbents or snapshots
    const again = reconcileBrokerAuthority(runDir, broker, emit, runId);
    expect(again).toBe(0);
    expect(readEvents(runDir).filter((e) => e.type === "incumbent.new").length).toBe(1);
    expect(readEvents(runDir).filter((e) => e.type === "budget.snapshot").length).toBe(1);
  });

  it("is a no-op on a fresh run (no journal, no events)", () => {
    const runDir = makeRoot();
    const broker = fakeBrokerJournal(runDir, runId, []);
    const emit = (e: RunEvent): RunEvent => appendEvent(runDir, e);
    expect(reconcileBrokerAuthority(runDir, broker, emit, runId)).toBe(0);
    expect(readEvents(runDir).length).toBe(0);
  });

  it("is a no-op when the event log already saw every promotion", () => {
    const runDir = crashWindowRunDir();
    appendEvent(runDir, { runId, at: at(), type: "incumbent.new", artifact: { hash: durable }, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 });
    const broker = fakeBrokerJournal(runDir, runId, [{ hash: durable, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 }]);
    const emit = (e: RunEvent): RunEvent => appendEvent(runDir, e);
    expect(reconcileBrokerAuthority(runDir, broker, emit, runId)).toBe(0);
    expect(readEvents(runDir).filter((e) => e.type === "incumbent.new").length).toBe(1);
  });

  it("replays a multi-promotion backlog in order", () => {
    const runDir = crashWindowRunDir();
    const older = fakeHash("a");
    appendEvent(runDir, { runId, at: at(), type: "incumbent.new", artifact: { hash: older }, aggregate: 0.6, deltaVsBaseline: 0.1, episode: 0 });
    const broker = fakeBrokerJournal(runDir, runId, [
      { hash: older, aggregate: 0.6, deltaVsBaseline: 0.1, episode: 0 },
      { hash: durable, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 1 },
    ]);
    const emit = (e: RunEvent): RunEvent => appendEvent(runDir, e);
    expect(reconcileBrokerAuthority(runDir, broker, emit, runId)).toBe(1);
    const incs = readEvents(runDir).flatMap((e) => (e.type === "incumbent.new" ? [e.artifact.hash] : []));
    expect(incs).toEqual([older, durable]);
    expect(bestArtifact(replayRun(runDir))?.hash).toBe(durable);
  });

  it("fails closed when the event log claims MORE incumbents than the durable journal", () => {
    const runDir = crashWindowRunDir();
    appendEvent(runDir, { runId, at: at(), type: "incumbent.new", artifact: { hash: durable }, aggregate: 0.7, deltaVsBaseline: 0.2, episode: 0 });
    const broker = fakeBrokerJournal(runDir, runId, []);
    const emit = (e: RunEvent): RunEvent => appendEvent(runDir, e);
    expect(() => reconcileBrokerAuthority(runDir, broker, emit, runId)).toThrow(/journal has 0/);
  });
  it("prefers complete event-journal replay and re-reads before the legacy incumbent fallback", () => {
    const runDir = crashWindowRunDir();
    const durableEvent = RunEvent.parse({
      runId,
      at: at(),
      type: "incumbent.new",
      artifact: { hash: durable },
      aggregate: 0.7,
      deltaVsBaseline: 0.2,
      episode: 0,
    });
    const broker: AuthorityRecoverySource = {
      replayJournalEvents(alreadyLogged) {
        expect(alreadyLogged.some((event) => event.type === "incumbent.new")).toBe(false);
        appendEvent(runDir, durableEvent);
        return 1;
      },
      replayIncumbentEvents(alreadyLogged) {
        expect(alreadyLogged).toBe(1);
        return 0;
      },
      getBudget: () => FIX_BUDGET,
    };
    expect(reconcileBrokerAuthority(runDir, broker, (event) => appendEvent(runDir, event), runId)).toBe(1);
    expect(bestArtifact(replayRun(runDir))?.hash).toBe(durable);
  });
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;

describe("live docker smoke (finding 10)", () => {
  it.skipIf(!hasDocker)("sweep removes a leftover deterministic network; create is clean afterwards", { timeout: 60_000 }, async () => {
    const runId = `smoke-${Date.now()}`;
    const network = `hone-${runId}`;
    const create = await runCommand(["docker", "network", "create", "--internal", network], { timeoutMs: 30_000 });
    expect(create.exitCode, create.stderr.toString("utf8")).toBe(0);
    try {
      await sweepStaleRunResources(runId, makeRoot());
      const inspect = await runCommand(["docker", "network", "inspect", network], { timeoutMs: 30_000 });
      expect(inspect.exitCode).not.toBe(0); // gone — resume's create cannot trip over it
      const recreate = await runCommand(["docker", "network", "create", "--internal", network], { timeoutMs: 30_000 });
      expect(recreate.exitCode, recreate.stderr.toString("utf8")).toBe(0);
    } finally {
      await runCommand(["docker", "network", "rm", network], { timeoutMs: 30_000 });
    }
  });
});

/**
 * A resumable run whose seals are REAL: the contract on disk renders from the
 * stored runconfig + frozen identity, run.started carries its true hash, and
 * the sealed backend is the stub the tests resume with — exactly what a
 * genuine interrupted run leaves behind (the under-lock seal check verifies
 * all of it before run.resumed).
 */
function resumableFixture(root: string, runId: string): string {
  makeCapsule(root);
  const manifest = manifestObject();
  const config = RunConfig.parse({
    version: 1,
    capsuleId: CAP_ID,
    objective: "fixture objective",
    budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
    routing: { mutation: { model: "test-model" } },
    headless: true,
    backend: "stub",
  });
  const contract = renderContract({
    runId,
    config,
    manifest,
    capsuleDigest: capsuleDigest(manifest),
    optimizerDigest: FIX_OPTIMIZER_DIGEST,
    orderingReport: DiagnosticOrderingReport.parse(orderingReportRaw()),
    deliveryTarget: null,
  });
  const runDir = writeEvents(
    root,
    runId,
    fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false, contractHash: contractHash(contract) }),
  );
  writeFileSync(join(runDir, "contract.md"), contract);
  // Frozen-admission resume gate: the run dir must carry the capsule snapshot.
  writeCapsuleSnapshot(runDir, manifest);
  freezeCapsuleAssets(runDir, join(root, "capsule"), manifest);
  writeRunConfigFile(runDir, config);
  // The trusted-runtime pin is a resume prerequisite (drift refuses first).
  writeFileSync(join(runDir, RUNTIME_PIN_FILE), `${trustedRuntimeDigest()}\n`);
  return runDir;
}

describe("run lock (FinalSecurityGate finding 2 — OS-enforced exclusivity)", () => {
  it("holds exclusively: a competitor rejects while held and acquires after release", async () => {
    const runDir = makeRoot();
    const release = await acquireRunLock(runDir, "run_l1");
    await expect(acquireRunLock(runDir, "run_l1")).rejects.toThrow(/already being supervised/);
    await release();
    expect(existsSync(runLockPath(runDir))).toBe(false);
    const release2 = await acquireRunLock(runDir, "run_l1");
    await release2();
  });

  it("reclaims a junk file squatting on the lock path", async () => {
    const runDir = makeRoot();
    writeFileSync(runLockPath(runDir), "not a socket");
    const release = await acquireRunLock(runDir, "run_l2");
    await release();
  });

  it("reclaims a dead owner's socket file (ECONNREFUSED probe)", async () => {
    const runDir = makeRoot();
    const sockPath = runLockPath(runDir);
    const dead = net.createServer();
    const listening = deferred<void>();
    dead.listen(sockPath, () => listening.resolve());
    await listening.promise;
    const closed = deferred<void>();
    dead.close(() => closed.resolve());
    await closed.promise;
    // whether or not node unlinked the file on close, acquisition must win
    const release = await acquireRunLock(runDir, "run_l3");
    await release();
  });

  it("concurrent contenders over a stale lock yield exactly one winner", async () => {
    const runDir = makeRoot();
    writeFileSync(runLockPath(runDir), "");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireRunLock(runDir, "run_l4")));
    const winners = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(winners.length).toBe(1);
    for (const r of results) {
      if (r.status === "rejected") expect(String(r.reason)).toMatch(/already being supervised/);
    }
    const winner = winners[0];
    if (winner !== undefined) await winner();
  });

  it("a cleanup wedged during release never disturbs a successor's rebind (ownership-guarded removal)", { timeout: 15_000 }, async () => {
    const runDir = makeRoot();
    const runId = "run_l6";
    const sockPath = runLockPath(runDir);
    const idA = { pid: process.pid, runId, nonce: "nonce-cas-A" };
    const releaseA = await acquireRunLock(runDir, runId, idA);

    // Wedge A's post-close cleanup: a foreign (unprovable) claim makes it
    // remove NOTHING — A's identity metadata survives its own release, the
    // exact leftover shape of a release racing a claimant or a power cut.
    // (Held lease connections no longer delay close: release destroys them.)
    const claimFd = holdForeignRunClaim(`${sockPath}.claim`);
    await releaseA();
    expect(JSON.parse(readFileSync(`${sockPath}.id`, "utf8"))).toEqual({
      pid: process.pid,
      runId,
      nonce: "nonce-cas-A",
      sock: expect.stringMatching(/^\d+:\d+$/),
    });
    closeSync(claimFd);
    rmSync(`${sockPath}.claim`);

    // A successor arbitrates the leftovers and rebinds; A's stale metadata
    // can never be confirmed over B's socket, and B is fully identified.
    const idB = { pid: process.pid, runId, nonce: "nonce-cas-B" };
    const releaseB = await acquireRunLock(runDir, runId, idB);
    expect(await probeRunLockIdentity(runDir)).toEqual(idB);
    await expect(acquireRunLock(runDir, runId)).rejects.toThrow(/already being supervised/);

    await releaseB();
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(`${sockPath}.id`)).toBe(false);
  });

  it("release under a foreign claim removes nothing — the claimant owns cleanup", async () => {
    const runDir = makeRoot();
    const runId = "run_l7";
    const sockPath = runLockPath(runDir);
    const releaseA = await acquireRunLock(runDir, runId, { pid: process.pid, runId, nonce: "nonce-claim-A" });
    // A live claimant is mid-arbitration: release must not race its view of
    // the socket/metadata pair — deferred cleanup removes nothing. (Node
    // itself may unlink the socket PATH at close-initiation, while the path
    // is still provably A's; the identity metadata is the guarded artifact.)
    const claimFd = holdForeignRunClaim(`${sockPath}.claim`);
    await releaseA();
    expect(JSON.parse(readFileSync(`${sockPath}.id`, "utf8"))).toEqual({
      pid: process.pid,
      runId,
      nonce: "nonce-claim-A",
      sock: expect.stringMatching(/^\d+:\d+$/),
    });
    closeSync(claimFd);
    rmSync(`${sockPath}.claim`);
    // The next acquirer arbitrates the now-dead leftovers normally.
    const idB = { pid: process.pid, runId, nonce: "nonce-claim-B" };
    const releaseB = await acquireRunLock(runDir, runId, idB);
    expect(await probeRunLockIdentity(runDir)).toEqual(idB);
    await releaseB();
    expect(existsSync(sockPath)).toBe(false);
    expect(existsSync(`${sockPath}.id`)).toBe(false);
  });

  it("refuses --resume while the run lock is held by a live process", async () => {
    const root = makeRoot();
    const runDir = resumableFixture(root, "run_live1");
    const release = await acquireRunLock(runDir, "run_live1");
    try {
      const { io } = makeIo(root);
      await expect(cliRunCommand(["capsule", "--headless", "--resume", "--backend", "stub"], io)).rejects.toThrow(/already being supervised/);
    } finally {
      await release();
    }
    // no event was appended by the refused contender
    expect(readEvents(runDir).filter((e) => e.type === "run.resumed").length).toBe(0);
  });

  it("two simultaneous resumes: exactly one proceeds and finalizes the log once", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = resumableFixture(root, "run_dual1");
    const env = { HONE_STUB_EPISODES: "4", HONE_STUB_DELAY_MS: "250" };
    const results = await Promise.allSettled([
      cliRunCommand(["capsule", "--headless", "--resume", "--backend", "stub"], makeIo(root, env).io),
      cliRunCommand(["capsule", "--headless", "--resume", "--backend", "stub"], makeIo(root, env).io),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled" && r.value === 0);
    const rejected = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(ok.length, JSON.stringify(results)).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0])).toMatch(/already being supervised/);
    // the winner's log is complete and clean; the loser never touched it
    const events = readEvents(runDir);
    expect(events.filter((e) => e.type === "run.started").length).toBe(1);
    expect(events.filter((e) => e.type === "run.resumed").length).toBe(1);
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
    const episodes = events.flatMap((e) => (e.type === "episode.started" ? [e.episode] : []));
    expect(new Set(episodes).size).toBe(episodes.length);
  });

  it("late contender: a resume planned while unfinished rejects under the lock after the winner finished", async () => {
    const root = makeRoot();
    const runId = "run_late1";
    const runDir = resumableFixture(root, runId);
    // Contender's plan, chosen from the UNFINISHED log (exactly what runCommand builds pre-lock).
    const plan = { runId, runDir, config: loadRunConfigFile(runDir), resumed: true };
    // Winner finishes and releases the lock before the contender acquires.
    appendEvent(runDir, { runId, at: at(), type: "run.finished", best: { hash: fakeHash("d") }, status: "completed" });
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "4" });
    await expect(
      superviseRun(
        plan,
        {
          manifest: manifestObject(),
          capsuleDir: join(root, "capsule"),
          capsuleDigest: fakeHash("f"),
          optimizerDigest: fakeHash("0"),
          orderingReport: DiagnosticOrderingReport.parse(orderingReportRaw()),
        },
        io,
      ),
    ).rejects.toThrow(/already finished/);
    const events = readEvents(runDir);
    // exactly one run.finished; the late contender appended nothing and started no backend
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
    expect(events.filter((e) => e.type === "run.resumed").length).toBe(0);
    expect(events[events.length - 1]?.type).toBe("run.finished");
    // and the lock was released on the rejection path: a fresh acquire succeeds
    const release = await acquireRunLock(runDir, runId);
    await release();
  });
});

describe("event log torn-tail repair (FinalSecurityGate finding 3)", () => {
  const started: RunEvent = {
    runId: "run_t1",
    at: at(),
    type: "run.started",
    capsuleId: CAP_ID,
    contractHash: fakeHash("c"),
    optimizerDigest: "unpinned",
  };

  it("append after a torn tail truncates the torn bytes instead of fusing lines", () => {
    const runDir = makeRoot();
    appendEvent(runDir, started);
    appendFileSync(eventsPath(runDir), '{"runId":"run_t1","at":"2026-07-'); // SIGKILL mid-append
    appendEvent(runDir, { runId: "run_t1", at: at(), type: "episode.started", episode: 0, parent: { hash: fakeHash("b") } });
    const events = readEvents(runDir); // throws on any fused interior line
    expect(events.map((e) => e.type)).toEqual(["run.started", "episode.started"]);
    const rawLines = readFileSync(eventsPath(runDir), "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(rawLines.length).toBe(2);
  });

  it("repairs a torn tail with no complete predecessor line", () => {
    const runDir = makeRoot();
    writeFileSync(eventsPath(runDir), '{"half":');
    appendEvent(runDir, started);
    const events = readEvents(runDir);
    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("run.started");
  });

  it("survives repeated crash/append cycles without corrupting replay", () => {
    const runDir = makeRoot();
    for (let i = 0; i < 3; i++) {
      appendEvent(runDir, { runId: "run_t1", at: at(), type: "episode.started", episode: i, parent: { hash: fakeHash("b") } });
      appendFileSync(eventsPath(runDir), `{"torn":${i}`); // crash leaves a torn tail every cycle
    }
    appendEvent(runDir, started);
    const events = readEvents(runDir);
    expect(events.length).toBe(4);
    expect(replayRun(runDir).episodes.size).toBe(3);
  });
});
