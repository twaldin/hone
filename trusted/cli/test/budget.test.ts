import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunConfig, RunEvent } from "@hone/schema";
import { UsageError } from "../src/args.js";
import { remainingWallBudgetMs, runCommand } from "../src/supervisor.js";
import { hone, honeSpawn, killTree, makeCapsule, makeIo, makeRoot, readLogLines, sleep } from "./helpers.js";

/** The one persisted runconfig.json — asserts exactly one run was minted. */
function soleRunConfig(root: string): RunConfig {
  const runsDir = join(root, ".hone-runs");
  const entries = readdirSync(runsDir);
  expect(entries.length).toBe(1);
  return RunConfig.parse(JSON.parse(readFileSync(join(runsDir, entries[0] ?? "", "runconfig.json"), "utf8")));
}

describe("wall-clock budget enforcement", () => {
  it("aborts the backend at the cap and finishes the run with status=budget", { timeout: 20_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    // a backend that holds until the supervisor aborts it (never finishes on its own)
    writeFileSync(
      join(root, "waiter.mjs"),
      `export function createBackend() {
        return {
          start(ctx) {
            return new Promise((resolve) => {
              ctx.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        };
      }
      `,
    );
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ budget: { maxWallClockSec: 1 } }));
    const { io, out } = makeIo(root, { HONE_UNSAFE_BACKEND: "1" });
    const code = await runCommand(
      ["capsule", "--headless", "--backend", "./waiter.mjs", "--config", "cfg.json"],
      io,
    );
    expect(code).toBe(0);

    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("budget");

    const events = readLogLines(root, report.runId).map((l) => RunEvent.parse(JSON.parse(l)));
    const exhausted = events.find((e) => e.type === "budget.exhausted");
    expect(exhausted).toBeDefined();
    if (exhausted?.type === "budget.exhausted") expect(exhausted.dimension).toBe("wallClockSec");
    const finished = events[events.length - 1];
    expect(finished?.type).toBe("run.finished");
    if (finished?.type === "run.finished") expect(finished.status).toBe("budget");
  });
});

describe("broker-authored budget boundaries", () => {
  it("an exact-cap budget snapshot aborts the backend and terminalizes as budget", { timeout: 20_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "exact-cap.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            ctx.emit({
              runId: ctx.runId,
              at: new Date().toISOString(),
              type: "budget.snapshot",
              budget: {
                envelope: ctx.config.budget,
                spent: { tokens: ctx.config.budget.maxTokens, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
              },
            });
            if (!ctx.signal.aborted) throw new Error("exact-cap snapshot did not abort the backend");
          },
        };
      }
      `,
    );
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ budget: { maxTokens: 10 } }));
    const { io, out } = makeIo(root, { HONE_UNSAFE_BACKEND: "1" });
    expect(await runCommand(["capsule", "--headless", "--backend", "./exact-cap.mjs", "--config", "cfg.json"], io)).toBe(0);
    const report = JSON.parse(out[out.length - 1] ?? "");
    expect(report.status).toBe("budget");
    const events = readLogLines(root, report.runId).map((line) => RunEvent.parse(JSON.parse(line)));
    expect(events.filter((event) => event.type === "budget.exhausted")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "budget" });
  });

  it("resume restores a durable exhaustion latch before backend work and never duplicates the event", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "resume-budget.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            if (ctx.replayed.resumeCount > 0) {
              if (!ctx.signal.aborted) throw new Error("durable exhaustion was not relatched");
              return;
            }
            ctx.emit({ runId: ctx.runId, at: new Date().toISOString(), type: "budget.exhausted", dimension: "tokens" });
            await new Promise(() => {});
          },
        };
      }
      `,
    );
    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "./resume-budget.mjs"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "10000" },
    });
    let runId = "";
    for (let attempt = 0; attempt < 500; attempt++) {
      const runsDir = join(root, ".hone-runs");
      const entries = existsSync(runsDir) ? readdirSync(runsDir) : [];
      const candidate = entries.length === 1 ? entries[0] : undefined;
      if (candidate !== undefined) {
        const eventFile = join(runsDir, candidate, "events.ndjson");
        if (existsSync(eventFile) && readFileSync(eventFile, "utf8").includes('"type":"budget.exhausted"')) {
          runId = candidate;
          break;
        }
      }
      await sleep(10);
    }
    expect(runId).not.toBe("");
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    killTree(child);
    await exited;

    const resumed = await hone(["run", "capsule", "--headless", "--resume"], {
      cwd: root,
      env: { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "10" },
    });
    expect(resumed.code, resumed.stderr).toBe(0);
    const events = readLogLines(root, runId).map((line) => RunEvent.parse(JSON.parse(line)));
    expect(events.filter((event) => event.type === "budget.exhausted")).toHaveLength(1);
    expect(events.some((event) => event.type === "run.resumed")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run.finished", status: "budget" });
  });

  it("resume wall time includes time elapsed while no supervisor was running", () => {
    const startedAt = "2026-07-15T00:00:00.000Z";
    expect(remainingWallBudgetMs(10, 2, startedAt, Date.parse(startedAt) + 5_000)).toBe(5_000);
    expect(remainingWallBudgetMs(10, 2, startedAt, Date.parse(startedAt) + 11_000)).toBe(0);
  });
});

describe("capsule budget: hard upper envelope on every initial run path", () => {
  // Fixture manifest envelope: maxTokens 1_000_000, maxUsd 25, maxWallClockSec 3600, maxEvaluatorInvocations 100.
  const overCap: Array<[dim: string, budget: Record<string, number>, message: string]> = [
    ["maxTokens", { maxTokens: 1_000_001 }, "maxTokens 1000001 > 1000000"],
    ["maxUsd", { maxUsd: 25.5 }, "maxUsd 25.5 > 25"],
    ["maxWallClockSec", { maxWallClockSec: 3601 }, "maxWallClockSec 3601 > 3600"],
    ["maxEvaluatorInvocations", { maxEvaluatorInvocations: 101 }, "maxEvaluatorInvocations 101 > 100"],
  ];

  for (const [dim, budget, message] of overCap) {
    it(`--config raising ${dim} above the frozen manifest refuses with the exact dimension and mints no run`, async () => {
      const root = makeRoot();
      makeCapsule(root);
      writeFileSync(join(root, "cfg.json"), JSON.stringify({ budget }));
      const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
      await expect(runCommand(["capsule", "--headless", "--backend", "stub", "--config", "cfg.json"], io)).rejects.toThrow(message);
      expect(existsSync(join(root, ".hone-runs"))).toBe(false);
    });
  }

  it("--budget-usd cannot raise the cap: refused before any run state exists", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    const attempt = runCommand(["capsule", "--headless", "--backend", "stub", "--budget-usd", "26"], io);
    await expect(attempt).rejects.toThrow(UsageError);
    await expect(attempt).rejects.toThrow("budget exceeds the capsule envelope: maxUsd 26 > 25");
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("names EVERY over-cap dimension at once", async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "cfg.json"),
      JSON.stringify({ budget: { maxTokens: 2_000_000, maxWallClockSec: 7200, maxEvaluatorInvocations: 200 } }),
    );
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(runCommand(["capsule", "--headless", "--backend", "stub", "--config", "cfg.json", "--budget-usd", "100"], io)).rejects.toThrow(
      "maxUsd 100 > 25, maxTokens 2000000 > 1000000, maxWallClockSec 7200 > 3600, maxEvaluatorInvocations 200 > 100",
    );
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("exact-cap values run: the envelope is inclusive", async () => {
    const root = makeRoot();
    makeCapsule(root);
    writeFileSync(
      join(root, "cfg.json"),
      JSON.stringify({ budget: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 } }),
    );
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await runCommand(["capsule", "--headless", "--backend", "stub", "--config", "cfg.json"], io)).toBe(0);
    expect(soleRunConfig(root).budget).toEqual({ maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 });
  });

  it("tightening runs and the tightened cap is what persists", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await runCommand(["capsule", "--headless", "--backend", "stub", "--budget-usd", "5"], io)).toBe(0);
    const config = soleRunConfig(root);
    expect(config.budget.maxUsd).toBe(5);
    // untouched dimensions inherit the manifest envelope verbatim
    expect(config.budget.maxTokens).toBe(1_000_000);
  });
});
