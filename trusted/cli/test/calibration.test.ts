import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapsuleManifest, DiagnosticOrderingReport, canonicalJson, capsuleDigest } from "@hone/schema";
import { selectSaturationCeiling } from "@hone/scoring";
import {
  buildCalibrationReport, calibrationClock, createCalibrationPlan, executeCalibration, initializeCalibration,
  readCalibrationState, validateCalibrationPlan, verifyCalibrationReport,
} from "../src/calibration.js";
import {
  CALIBRATION_BOOTSTRAP, CALIBRATION_BUDGET, CALIBRATION_CAPS, CALIBRATION_SEEDS, CALIBRATION_TASKS,
  type CalibrationOutcome, type CalibrationPlanInputs, type CalibrationRunner, type CalibrationRunRequest,
} from "../src/calibration-types.js";
import { corpusProvenanceInputsDigest, type CorpusProvenanceV1 } from "../src/corpus-provenance.js";
import { calibrationCommand } from "../src/commands/calibration.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory(): string {
  const result = mkdtempSync(join(tmpdir(), "hone-cal-"));
  directories.push(result);
  return result;
}
function inputs(): CalibrationPlanInputs {
  const capsules = Array.from({ length: 27 }, (_, index) => ({
    id: `cap_${(index + 1).toString(16).padStart(12, "0")}`,
    digest: digest(`cohort-${index}`),
    role: index < 16 ? "development" as const : "terminal" as const,
  }));
  const unbound: Omit<CorpusProvenanceV1, "inputsDigest"> = {
    version: "corpus-provenance.v1", capsules,
    developmentCapsuleIds: capsules.slice(0, 16).map((capsule) => capsule.id),
    terminalCapsuleIds: capsules.slice(16).map((capsule) => capsule.id),
    terminalContentHashes: [digest("terminal-inputs")], publicSnapshotDigest: digest("public-snapshot"),
    docHashes: { "objective.md": digest("objective") }, panelDocs: [], generatedAt: "2026-09-07T00:00:00.000Z",
  };
  const tasks = CALIBRATION_TASKS.map((task) => {
    const capsuleDir = join(root, "capsules", task);
    const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(capsuleDir, "manifest.draft.json"), "utf8")));
    return { task, capsuleDir, manifest, manifestDigest: capsuleDigest(manifest),
      orderingReport: DiagnosticOrderingReport.parse(JSON.parse(readFileSync(join(capsuleDir, manifest.diagnosticOrdering!.path), "utf8"))),
      admission: "draft" as const };
  });
  return { tasks, corpus: { ...unbound, inputsDigest: corpusProvenanceInputsDigest(unbound) },
    image: tasks[0]!.manifest.image, optimizerDigest: digest("optimizer"), runtimeDigest: digest("runtime") };
}
function outcome(status: CalibrationOutcome["status"] = "valid", gain = 0.1): CalibrationOutcome {
  return { status, resumable: false, reason: `offline ${status}`,
    usage: { tokens: 100, usd: 0.01, wallClockSec: 1, evaluatorInvocations: 1 },
    ...(status === "valid" ? { normalizedGain: gain } : {}), evidence: { fixture: "offline-no-provider" } };
}
function fake(run: CalibrationRunner["run"] = async () => outcome()): CalibrationRunner {
  return { mode: "offline", run, verify: async () => {} };
}
async function initialize() {
  const stateDir = directory();
  const plan = createCalibrationPlan(inputs());
  await initializeCalibration(stateDir, plan, "offline");
  return { stateDir, plan };
}

describe("approved bounded calibration coordinator", () => {
  it("plans the exact matched matrix from the four task drafts without admitting them", async () => {
    const { plan, stateDir } = await initialize();
    expect(new Set(plan.cells.map((cell) => `${cell.task}:${cell.cap}:${cell.seed}`))).toEqual(new Set(
      CALIBRATION_TASKS.flatMap((task) => CALIBRATION_CAPS.flatMap((cap) => CALIBRATION_SEEDS.map((seed) => `${task}:${cap}:${seed}`))),
    ));
    expect(plan.budget).toEqual(CALIBRATION_BUDGET);
    expect(plan.reservations).toEqual({ tokens: 48_000_000, usd: 800, serialHours: 160 });
    expect(validateCalibrationPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    let dispatched = false;
    await expect(executeCalibration(stateDir, { ...fake(async () => { dispatched = true; return outcome(); }), mode: "trusted" })).rejects.toThrow();
    expect(dispatched).toBe(false);
  });

  it.each(["development", "terminal"] as const)("rejects a calibration identity anywhere in the %s cohort", (role) => {
    const value = inputs();
    const member = value.corpus.capsules.find((capsule) => capsule.role === role)!;
    const oldId = member.id;
    member.id = value.tasks[0]!.manifest.id;
    const key = role === "development" ? "developmentCapsuleIds" : "terminalCapsuleIds";
    value.corpus[key] = value.corpus[key].map((id) => id === oldId ? member.id : id);
    value.corpus.inputsDigest = corpusProvenanceInputsDigest(value.corpus);
    expect(() => createCalibrationPlan(value)).toThrow();
  });

  it("holds the same cross-process lock while a runner is active and records intent first", async () => {
    const { stateDir } = await initialize();
    let release!: () => void;
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = executeCalibration(stateDir, fake(async (request) => {
      const durable = readCalibrationState(stateDir).attempts[0]!;
      expect(durable.runId).toBe(request.runId);
      expect(durable.outcomes).toEqual([]);
      entered(); await blocked; return outcome();
    }), { maxCells: 1 });
    await running;
    try {
      await expect(executeCalibration(stateDir, fake(), { maxCells: 1 })).rejects.toThrow(/lock|held|active|already/i);
    } finally { release(); }
    await first;
  });

  it("resumes the interrupted run identity without losing incomplete evidence or resetting its budget", async () => {
    const { stateDir, plan } = await initialize();
    const requests: CalibrationRunRequest[] = [];
    await executeCalibration(stateDir, fake(async (request) => {
      requests.push(request);
      return { ...outcome("incomplete"), resumable: true, reason: "interrupted" };
    }), { maxCells: 1 });
    await executeCalibration(stateDir, fake(async (request) => { requests.push(request); return outcome("valid", 0.25); }),
      { cellKey: plan.cells[0]!.key, resume: true });
    const attempts = readCalibrationState(stateDir).attempts;
    expect(requests.map((request) => request.runId)).toEqual([attempts[0]!.runId, attempts[0]!.runId]);
    expect(requests.map((request) => request.resume)).toEqual([false, true]);
    expect(requests[1]!.remainingBudget).toEqual(requests[0]!.remainingBudget);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcomes.map((result) => result.status)).toEqual(["incomplete", "valid"]);
    const bundle = await buildCalibrationReport(stateDir, fake());
    expect(bundle.report.cells.find((cell) => cell.capsuleId === plan.cells[0]!.capsuleId && cell.cap === plan.cells[0]!.cap && cell.seed === plan.cells[0]!.seed))
      .toMatchObject({ status: "valid", normalizedGain: 0.25 });
  });

  it("retains a thrown runner failure as unknown incomplete spend and never silently reruns it", async () => {
    const { stateDir, plan } = await initialize();
    await executeCalibration(stateDir, fake(async () => { throw new Error("lost supervisor response"); }), { maxCells: 1 });
    const saved = readCalibrationState(stateDir);
    expect(saved.attempts[0]!.outcomes[0]).toMatchObject({ status: "incomplete", usage: null });
    let calls = 0;
    try { await executeCalibration(stateDir, fake(async () => { calls++; return outcome(); }), { maxCells: 1 }); } catch { /* explicit recovery required */ }
    expect(calls).toBe(0);
    await expect(executeCalibration(stateDir, fake(), { cellKey: plan.cells[0]!.key, retryReason: "inspect infrastructure" })).rejects.toThrow();
  });

  it("recovers a process exit after durable dispatch intent without creating a second run", async () => {
    const { stateDir, plan } = await initialize();
    const script = join(directory(), "interrupt.mts");
    writeFileSync(script, `
      import { executeCalibration } from ${JSON.stringify(join(root, "trusted/cli/src/calibration.ts"))};
      await executeCalibration(${JSON.stringify(stateDir)}, {
        mode: "offline",
        run: async () => { process.exit(17); },
        verify: async () => {},
      }, { maxCells: 1 });
    `);
    const child = spawnSync(process.execPath, ["--import", "tsx", script], {
      cwd: join(root, "trusted/cli"), encoding: "utf8", timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(17);
    const interrupted = readCalibrationState(stateDir).attempts[0]!;
    expect(interrupted.outcomes).toEqual([]);
    expect(interrupted.dispatches).toHaveLength(1);
    const requests: CalibrationRunRequest[] = [];
    await executeCalibration(stateDir, fake(async (request) => { requests.push(request); return outcome(); }),
      { cellKey: plan.cells[0]!.key, resume: true });
    expect(requests.map((request) => [request.runId, request.resume])).toEqual([[interrupted.runId, true]]);
    expect(readCalibrationState(stateDir).attempts).toHaveLength(1);
  });

  it("invalidates decreasing resume meters and never refunds earlier consumption to a retry", async () => {
    const { stateDir, plan } = await initialize();
    await executeCalibration(stateDir, fake(async () => ({
      ...outcome("incomplete"), resumable: true,
      usage: { tokens: 500_000, usd: 8, wallClockSec: 2, evaluatorInvocations: 40 },
    })), { maxCells: 1 });
    await executeCalibration(stateDir, fake(), { cellKey: plan.cells[0]!.key, resume: true });
    expect(readCalibrationState(stateDir).attempts[0]!.outcomes.at(-1)!.status).toBe("invalid");
    let budget: CalibrationRunRequest["remainingBudget"] | undefined;
    await executeCalibration(stateDir, fake(async (request) => { budget = request.remainingBudget; return outcome(); }),
      { cellKey: plan.cells[0]!.key, retryReason: "offline meter regression inspection" });
    expect(budget).toMatchObject({ maxTokens: 100_000, maxUsd: 2, maxEvaluatorInvocations: 9 });
  });

  it("counts downtime against the same cell wall limit and refuses another launch after expiry", async () => {
    const { stateDir, plan } = await initialize();
    const clock = vi.spyOn(calibrationClock, "now").mockReturnValue("2026-09-07T00:00:00.000Z");
    await executeCalibration(stateDir, fake(async () => ({ ...outcome("incomplete"), resumable: true })), { maxCells: 1 });
    clock.mockReturnValue("2026-09-07T02:00:01.000Z");
    let launched = false;
    await expect(executeCalibration(stateDir, fake(async () => { launched = true; return outcome(); }),
      { cellKey: plan.cells[0]!.key, resume: true })).rejects.toThrow(/wall.clock|downtime/);
    expect(launched).toBe(false);
    expect(readCalibrationState(stateDir).attempts[0]!.outcomes.at(-1)!.status).toBe("invalid");
    await expect(executeCalibration(stateDir, fake(), { cellKey: plan.cells[0]!.key, retryReason: "cannot reset clock" })).rejects.toThrow(/exhausted/);
  });

  it("keeps an explicit favorable retry supplementary and debits prior attempt spend", async () => {
    const { stateDir, plan } = await initialize();
    await executeCalibration(stateDir, fake(async () => outcome("invalid")), { maxCells: 1 });
    let retryRequest: CalibrationRunRequest | undefined;
    await executeCalibration(stateDir, fake(async (request) => { retryRequest = request; return outcome("valid", 100); }),
      { cellKey: plan.cells[0]!.key, retryReason: "offline infrastructure diagnosis" });
    expect(retryRequest!.remainingBudget.maxTokens).toBe(599_900);
    expect(retryRequest!.remainingBudget.maxUsd).toBeCloseTo(9.99);
    expect(retryRequest!.remainingBudget.maxEvaluatorInvocations).toBe(48);
    const saved = readCalibrationState(stateDir);
    expect(saved.attempts.map((attempt) => attempt.ordinal)).toEqual([0, 1]);
    expect(saved.attempts[1]!.runId).not.toBe(saved.attempts[0]!.runId);
    const bundle = await buildCalibrationReport(stateDir, fake());
    expect(bundle.report.cells.find((cell) => cell.capsuleId === plan.cells[0]!.capsuleId && cell.cap === plan.cells[0]!.cap && cell.seed === plan.cells[0]!.seed)!.status).toBe("invalid");
    expect(bundle.report.cells.filter((cell) => cell.status === "incomplete")).toHaveLength(79);
  });

  it.each([
    ["tokens", 600_001], ["usd", 10.01], ["wallClockSec", 7201], ["evaluatorInvocations", 50],
  ] as const)("refuses to score a runner exceeding the %s envelope", async (dimension, spent) => {
    const { stateDir } = await initialize();
    await executeCalibration(stateDir, fake(async () => {
      const result = outcome("valid", 100);
      result.usage![dimension] = spent;
      return result;
    }), { maxCells: 1 });
    const saved = readCalibrationState(stateDir);
    expect(saved.attempts[0]!.outcomes.at(-1)!.status).toBe("invalid");
    const report = await buildCalibrationReport(stateDir, fake());
    expect(report.report.cells.every((cell) => cell.status !== "valid")).toBe(true);
  });

  it("binds all 80 outcomes and the approved bootstrap to reproducible scorer output", async () => {
    const { stateDir } = await initialize();
    await executeCalibration(stateDir, fake(async (request) => {
      if (request.cell.cap === 8 && request.cell.seed === CALIBRATION_SEEDS[0]) return outcome("invalid");
      return outcome("valid", { 2: 0, 4: 0.03, 8: 0.06, 12: 0.07 }[request.cell.cap]);
    }));
    const bundle = await buildCalibrationReport(stateDir, fake());
    expect(bundle.report).toEqual(selectSaturationCeiling(bundle.report.cells, CALIBRATION_BOOTSTRAP));
    expect(bundle.report.bootstrap).toMatchObject({ rngSeed: 20260907, samples: 10000 });
    expect(bundle.report.cells.filter((cell) => cell.status === "invalid")).toHaveLength(4);
    expect(verifyCalibrationReport(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
    const changed = structuredClone(bundle);
    changed.report.selectedCeiling = changed.report.selectedCeiling === 4 ? 8 : 4;
    expect(() => verifyCalibrationReport(changed)).toThrow();
    const missingAttempt = structuredClone(bundle);
    missingAttempt.state.attempts.pop();
    expect(() => verifyCalibrationReport(missingAttempt)).toThrow();
    await expect(buildCalibrationReport(stateDir, { ...fake(), verify: async () => { throw new Error("run evidence drift"); } })).rejects.toThrow(/drift/);
  });

  it("rejects a persisted plan edit rather than resuming under changed limits", async () => {
    const { stateDir } = await initialize();
    const file = join(stateDir, "calibration-state.v1.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.plan.budget.maxTokens++;
    writeFileSync(file, canonicalJson(state));
    await expect(executeCalibration(stateDir, fake())).rejects.toThrow();
  });

  it("requires explicit execution acknowledgement before inspecting or launching real cells", async () => {
    const output: string[] = [];
    const io = { root: directory(), env: {}, isTTY: false, out: (text: string) => output.push(text), err: (text: string) => output.push(text) };
    await expect(calibrationCommand(["run", "--state", "absent"], io)).rejects.toThrow(/acknowledge-execution/);
    expect(output).toEqual([]);
  });
});
