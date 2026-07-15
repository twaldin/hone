import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { hone, makeCapsule, makeRoot, readLogLines } from "./helpers.js";

interface Report {
  runId: string;
  status: string;
  best: string | null;
  aggregate: number | null;
  deltaVsBaseline: number | null;
  spend: { tokens: number; usd: number; wallClockSec: number; evaluatorInvocations: number } | null;
}

function splitHeadless(stdout: string): { eventLines: string[]; report: Report } {
  const lines = stdout.trim().split("\n");
  expect(lines.length).toBeGreaterThan(1);
  const last = lines[lines.length - 1];
  expect(last).toBeDefined();
  const report: Report = JSON.parse(last ?? "");
  return { eventLines: lines.slice(0, -1), report };
}

describe("hone run — headless end-to-end (scripted stub backend)", () => {
  it("produces a schema-valid event log, NDJSON stdout, and a machine-readable exit report", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const r = await hone(["run", "capsule", "--headless"], { cwd: root, env: { HONE_STUB_EPISODES: "3" } });
    expect(r.code, r.stderr).toBe(0);

    // stdout: every line but the last parses as a RunEvent, the last is the exit report
    const { eventLines, report } = splitHeadless(r.stdout);
    for (const line of eventLines) {
      expect(() => RunEvent.parse(JSON.parse(line))).not.toThrow();
    }
    expect(report.status).toBe("completed");
    expect(report.best).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.aggregate).toBeCloseTo(0.53);
    expect(report.deltaVsBaseline).toBeCloseTo(0.03);
    expect(report.spend?.usd).toBeGreaterThan(0);
    expect(report.spend?.tokens).toBeGreaterThan(0);

    // on-disk log: schema-valid, mirrors stdout event stream
    const logLines = readLogLines(root, report.runId);
    expect(logLines.length).toBe(eventLines.length);
    const types = logLines.map((l) => RunEvent.parse(JSON.parse(l)).type);
    expect(types[0]).toBe("run.started");
    expect(types[types.length - 1]).toBe("run.finished");
    expect(types.filter((t) => t === "episode.started").length).toBe(3);

    // run dir artifacts
    const runDir = join(root, ".hone-runs", report.runId);
    expect(existsSync(join(runDir, "contract.md"))).toBe(true);
    expect(existsSync(join(runDir, "runconfig.json"))).toBe(true);
    const contract = readFileSync(join(runDir, "contract.md"), "utf8");
    expect(contract).toContain("Make the fixture task measurably better");
  });

  it("--budget-usd overrides the USD cap in the run config and contract", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const r = await hone(["run", "capsule", "--headless", "--budget-usd", "3.5"], { cwd: root, env: { HONE_STUB_EPISODES: "1" } });
    expect(r.code, r.stderr).toBe(0);
    const { report } = splitHeadless(r.stdout);
    const cfg = JSON.parse(readFileSync(join(root, ".hone-runs", report.runId, "runconfig.json"), "utf8"));
    expect(cfg.budget.maxUsd).toBe(3.5);
  });

  it("injects a custom backend module via --backend", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const hash = `sha256:${"7".repeat(64)}`;
    writeFileSync(
      join(root, "custom-backend.mjs"),
      `export function createBackend() {
        return {
          async start(ctx) {
            const at = () => new Date().toISOString();
            ctx.emit({ runId: ctx.runId, at: at(), type: "episode.started", episode: 0, parent: { hash: "${hash}" } });
            ctx.emit({ runId: ctx.runId, at: at(), type: "incumbent.new", artifact: { hash: "${hash}" }, aggregate: 0.9, deltaVsBaseline: 0.4, episode: 0 });
          },
        };
      }
      `,
    );
    const r = await hone(["run", "capsule", "--headless", "--backend", "./custom-backend.mjs"], { cwd: root });
    expect(r.code, r.stderr).toBe(0);
    const { report } = splitHeadless(r.stdout);
    expect(report.best).toBe(hash);
    expect(report.aggregate).toBeCloseTo(0.9);
  });

  it("refuses interactive approval without a TTY (and without --headless)", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root);
    const r = await hone(["run", "capsule"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/tty/i);
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("rejects an invalid capsule with a usage error", { timeout: 60_000 }, async () => {
    const root = makeRoot();
    makeCapsule(root, { assetGroups: [] });
    const r = await hone(["run", "capsule", "--headless"], { cwd: root });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/manifest/i);
  });
});
