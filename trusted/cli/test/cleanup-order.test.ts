import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BudgetState } from "@hone/schema";
import { readEvents, replayRun } from "../src/eventlog.js";
import { headlessProbeVerdict, pidAlive, promptProbe, runCommand as cliRunCommand } from "../src/supervisor.js";
import type { ProbeReport } from "../src/types.js";
import { fakeHash, makeCapsule, makeIo, makeRoot } from "./helpers.js";

/**
 * Cleanup ordering: children are reaped on FAILURE paths too (not only
 * aborts); the supervisor never delivers/terminalizes/returns before the
 * backend's cleanup barrier settles; a failed or timed-out cleanup leaves the
 * run unterminalized and resumable; the probe gate is abort-aware.
 */

const BUDGET: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
  spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
};

function report(delta: number | null): ProbeReport {
  return {
    baseline: { artifact: { hash: fakeHash("b") }, aggregate: 0.5 },
    candidate: delta === null ? null : { artifact: { hash: fakeHash("c") }, aggregate: 0.5 + delta, delta },
    assetGroupId: "validation",
    seed: 3,
    budget: BUDGET,
  };
}

describe("M0 headless probe policy (ONE paired eval — never the M1 statistical gate)", () => {
  it("auto-approves only a valid completed pair with strictly positive delta", () => {
    expect(headlessProbeVerdict(report(0.12))).toBe(true);
    expect(headlessProbeVerdict(report(0))).toBe(false);
    expect(headlessProbeVerdict(report(-0.05))).toBe(false);
    expect(headlessProbeVerdict(report(null))).toBe(false); // no candidate = no valid pair
  });
});

describe("promptProbe is AbortSignal-aware", () => {
  it("an abort while the question is pending resolves false without an answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const abort = new AbortController();
    const { io } = makeIo(makeRoot());
    const pending = promptProbe(report(0.12), io, abort.signal, { input, output });
    // The question is on the wire; nobody answers — a stop lands instead.
    abort.abort(new Error("stop requested"));
    await expect(pending).resolves.toBe(false);
  });

  it("a pre-aborted signal short-circuits without touching the streams", async () => {
    const abort = new AbortController();
    abort.abort(new Error("stop requested"));
    const { io } = makeIo(makeRoot());
    await expect(promptProbe(report(0.12), io, abort.signal, { input: new PassThrough(), output: new PassThrough() })).resolves.toBe(false);
  });

  it("still accepts a normal answer", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const { io } = makeIo(makeRoot());
    const pending = promptProbe(report(0.12), io, new AbortController().signal, { input, output });
    input.write("y\n");
    await expect(pending).resolves.toBe(true);
  });
});

describe("failure paths reap registered children (not only aborts)", () => {
  it("a FAILING backend's registered child group is dead before the supervisor returns", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const pidFile = join(root, "child.pid");
    writeFileSync(
      join(root, "failing-backend.mjs"),
      `import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      export function createBackend() {
        return {
          async start(ctx) {
            const child = spawn("sleep", ["60"], { detached: true });
            writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
            ctx.registerChild({ pid: child.pid, kill: (sig) => { try { process.kill(-child.pid, sig ?? "SIGTERM"); return true; } catch { try { return child.kill(sig); } catch { return false; } } } });
            throw new Error("backend blew up mid-run");
          },
        };
      }
      `,
    );
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./failing-backend.mjs"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/backend failed: backend blew up/);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(childPid)).toBe(true);
    expect(pidAlive(childPid)).toBe(false); // TERM→KILL barrier ran on the failure path
  });

  it("an AUTHORITY failure reaps children too and leaves the run unterminalized", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const pidFile = join(root, "child.pid");
    writeFileSync(
      join(root, "authority-failing-backend.mjs"),
      `import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      export function createBackend() {
        return {
          async start(ctx) {
            ctx.registerAuthorityBarrier(Promise.reject(new Error("journal unreadable")));
            const child = spawn("sleep", ["60"], { detached: true });
            writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
            ctx.registerChild({ pid: child.pid, kill: (sig) => { try { process.kill(-child.pid, sig ?? "SIGTERM"); return true; } catch { try { return child.kill(sig); } catch { return false; } } } });
          },
        };
      }
      `,
    );
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./authority-failing-backend.mjs"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/trusted authority recovery failed/);
    expect(pidAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
    const runId = readdirSync(join(root, ".hone-runs"))[0] ?? "";
    const runDir = join(root, ".hone-runs", runId);
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false); // resumable
  });
});

describe("cleanup barrier gates delivery/terminal/return", () => {
  it("run.finished is emitted only AFTER the backend's cleanup barrier resolved", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const marker = join(root, "terminal-at-cleanup.json");
    // The fixture's real timer is the integration point under test: the
    // supervisor must WAIT on the barrier while wall time passes — fake
    // timers cannot exercise the cross-promise ordering here.
    writeFileSync(
      join(root, "slow-cleanup-backend.mjs"),
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      export function createBackend() {
        return {
          async start(ctx) {
            ctx.registerCleanupBarrier(new Promise((resolve) => {
              setTimeout(() => {
                // At barrier resolution, the terminal event must NOT exist yet.
                const p = join(ctx.runDir, "events.ndjson");
                const finishedAlready = existsSync(p) && readFileSync(p, "utf8").includes('"run.finished"');
                writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ finishedAlready }));
                resolve();
              }, 400);
            }));
          },
        };
      }
      `,
    );
    const { io } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./slow-cleanup-backend.mjs"], io);
    expect(code).toBe(0);
    const observed = JSON.parse(readFileSync(marker, "utf8")) as { finishedAlready: boolean };
    expect(observed.finishedAlready).toBe(false); // cleanup strictly precedes the terminal
    const runId = readdirSync(join(root, ".hone-runs"))[0] ?? "";
    const events = readEvents(join(root, ".hone-runs", runId));
    expect(events[events.length - 1]?.type).toBe("run.finished");
  });

  it("a REJECTED cleanup barrier leaves the run unterminalized and resumable", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "dirty-cleanup-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            ctx.registerCleanupBarrier(Promise.reject(new Error("egress network refused to die")));
          },
        };
      }
      `,
    );
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./dirty-cleanup-backend.mjs"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/backend cleanup incomplete: egress network refused to die/);
    const runId = readdirSync(join(root, ".hone-runs"))[0] ?? "";
    const runDir = join(root, ".hone-runs", runId);
    expect(readEvents(runDir).some((e) => e.type === "run.finished")).toBe(false);
    expect(replayRun(runDir).finished).toBeNull();
  });

  it("a HUNG cleanup barrier times out into the same unterminalized refusal", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "hung-cleanup-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            ctx.registerCleanupBarrier(new Promise(() => {})); // never settles
          },
        };
      }
      `,
    );
    const { io, err } = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "50", HONE_CLEANUP_TIMEOUT_MS: "200" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "./hung-cleanup-backend.mjs"], io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/did not complete within 200ms/);
    const runId = readdirSync(join(root, ".hone-runs"))[0] ?? "";
    expect(readEvents(join(root, ".hone-runs", runId)).some((e) => e.type === "run.finished")).toBe(false);
  });
});
