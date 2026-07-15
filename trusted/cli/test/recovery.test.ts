import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BudgetState, RunEvent } from "@hone/schema";
import { runCommand } from "@hone/broker";
import type { CallContext, CmdResult, RunCommand } from "@hone/broker";
import type { ProxyHandle } from "@hone/proxy";
import { reconcileBrokerAuthority, setupEgress, sweepStaleRunResources } from "../src/backends/local.js";
import type { AuthorityRecoverySource } from "../src/backends/local.js";
import { appendEvent, bestArtifact, readEvents, replayRun } from "../src/eventlog.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import { at, fakeHash, fixtureEvents, makeCapsule, makeIo, makeRoot, writeEvents } from "./helpers.js";

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
    expect(calls[ps]).toEqual(["docker", "ps", "-aq", "--filter", "label=hone.runId=run:7f3a"]);

    const rmLabeled = findCall(calls, "docker", "rm", "-f", "aaa111");
    expect(calls[rmLabeled]).toEqual(["docker", "rm", "-f", "aaa111", "bbb222"]);

    const rmRelay = findCall(calls, "docker", "rm", "-f", "hone-proxy-run-7f3a");
    expect(rmRelay).toBeGreaterThanOrEqual(0);

    const rmNet = findCall(calls, "docker", "network", "rm");
    expect(calls[rmNet]).toEqual(["docker", "network", "rm", "hone-run-7f3a"]);
    // containers must be gone BEFORE the network removal (attached containers block it)
    expect(rmLabeled).toBeLessThan(rmNet);
    expect(rmRelay).toBeLessThan(rmNet);

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
    expect(findCall(calls, "docker", "network", "rm", "hone-run_x")).toBeGreaterThanOrEqual(0);
    // no batch rm for an unknown container list
    expect(findCall(calls, "docker", "rm", "-f", "aaa111")).toBe(-1);
  });

  it("never touches docker volumes (durable scratch is preserved)", async () => {
    const { calls, run } = fakeRunner(() => undefined);
    await sweepStaleRunResources("run_x", makeRoot(), run);
    expect(calls.some((c) => c.includes("volume"))).toBe(false);
  });
});

function fakeProxy(port: number): ProxyHandle {
  return {
    tokens: [],
    tokenFor: () => "tok",
    listenUnix: () => Promise.resolve(),
    listenTcp: () => Promise.resolve(port),
    close: () => Promise.resolve(),
  };
}

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

describe("resume liveness guard (finding 10 — the sweep must never hit a live run)", () => {
  it("refuses --resume while the recorded supervisor pid is alive", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const runId = "run_live1";
    const runDir = writeEvents(
      root,
      runId,
      fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false }),
    );
    // The test process itself: a pid that is certainly alive.
    writeFileSync(join(runDir, "supervisor.json"), `${JSON.stringify({ pid: process.pid, runId })}\n`);
    const { io } = makeIo(root);
    await expect(cliRunCommand(["capsule", "--headless", "--resume"], io)).rejects.toThrow(/still running/);
  });
});
