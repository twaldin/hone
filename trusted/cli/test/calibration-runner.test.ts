import type * as SupervisorModule from "../src/supervisor.js";
import type * as AdmissionModule from "../src/admission.js";
import type * as OptimizerDigestModule from "../src/optimizer-digest.js";
import type * as RuntimeDigestModule from "../src/runtime-digest.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapsuleManifest, DiagnosticOrderingReport, RunConfig, capsuleDigest, deriveCapsuleId, M2_INNER_MODEL_ROUTE } from "@hone/schema";
import { admitCapsule } from "../src/admission.js";
import { createCalibrationPlan } from "../src/calibration.js";
import { createCalibrationRunner, calibrationMeasurementEpoch } from "../src/calibration-runner.js";
import { CALIBRATION_BUDGET, CALIBRATION_TASKS, type CalibrationRunRequest } from "../src/calibration-types.js";
import { corpusProvenanceInputsDigest, type CorpusProvenanceV1 } from "../src/corpus-provenance.js";
import { contractHash, renderContract } from "../src/contract.js";
import { runCommand } from "../src/supervisor.js";
import { orderingReportRaw } from "./helpers.js";

vi.mock("../src/supervisor.js", async (original) => ({
  ...await original<typeof SupervisorModule>(), runCommand: vi.fn(),
}));
vi.mock("../src/admission.js", async (original) => ({
  ...await original<typeof AdmissionModule>(), admitCapsule: vi.fn(),
}));
vi.mock("../src/optimizer-digest.js", async (original) => ({
  ...await original<typeof OptimizerDigestModule>(),
  collectOptimizerSnapshot: () => ({ files: new Map() }),
  resolveOptimizerSnapshotDigest: () => `sha256:${"a".repeat(64)}`,
}));
vi.mock("../src/runtime-digest.js", async (original) => ({
  ...await original<typeof RuntimeDigestModule>(),
  verifiedBootRuntimeDigest: () => `sha256:${"b".repeat(64)}`,
}));

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporary: string[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
beforeEach(() => { vi.mocked(runCommand).mockReset(); vi.mocked(admitCapsule).mockReset(); });
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(draft = false) {
  const root = mkdtempSync(join(tmpdir(), "hone-cal-evidence-"));
  temporary.push(root);
  const stateDir = join(root, "calibration");
  mkdirSync(stateDir);
  mkdirSync(join(root, "capsules", "seeded-astar"), { recursive: true });
  writeFileSync(join(root, "capsules", "seeded-astar", "manifest.json"), readFileSync(join(sourceRoot, "capsules", "seeded-astar", "manifest.json")));
  const orderingReport = DiagnosticOrderingReport.parse(orderingReportRaw());
  const tasks = CALIBRATION_TASKS.map((task) => {
    const manifest = CapsuleManifest.parse(JSON.parse(readFileSync(join(sourceRoot, "capsules", task, "manifest.draft.json"), "utf8")));
    manifest.diagnosticOrdering.hash = digest(JSON.stringify(orderingReport));
    manifest.id = deriveCapsuleId(manifest);
    return { task, capsuleDir: join(root, "capsules", task), manifest,
      manifestDigest: capsuleDigest(manifest), orderingReport, admission: draft ? "draft" as const : "admitted" as const };
  });
  vi.mocked(admitCapsule).mockImplementation((path) => {
    const task = tasks.find((entry) => entry.capsuleDir === path);
    if (task === undefined) throw new Error("unexpected admission path");
    return { manifest: task.manifest, digest: task.manifestDigest, orderingReport, provisional: false, approval: null };
  });
  const capsules = Array.from({ length: 27 }, (_, index) => ({ id: `cap_${(index + 1).toString(16).padStart(12, "0")}`,
    digest: digest(`member:${index}`), role: index < 16 ? "development" as const : "terminal" as const }));
  const corpus: Omit<CorpusProvenanceV1, "inputsDigest"> = {
    version: "corpus-provenance.v1", capsules,
    developmentCapsuleIds: capsules.slice(0, 16).map((entry) => entry.id), terminalCapsuleIds: capsules.slice(16).map((entry) => entry.id),
    terminalContentHashes: [digest("terminal")], publicSnapshotDigest: digest("public"),
    docHashes: {}, panelDocs: [], generatedAt: "2026-09-07T00:00:00.000Z",
  };
  const plan = createCalibrationPlan({ tasks, corpus: { ...corpus, inputsDigest: corpusProvenanceInputsDigest(corpus) },
    image: tasks[0]!.manifest.image, optimizerDigest: `sha256:${"a".repeat(64)}`, runtimeDigest: `sha256:${"b".repeat(64)}` });
  const request: CalibrationRunRequest = { plan, cell: plan.cells[0]!, task: tasks[0]!, runId: "run_cal_evidence", resume: false,
    remainingBudget: { ...CALIBRATION_BUDGET }, stateDir };
  const runner = createCalibrationRunner({ root, env: {}, isTTY: false, out: () => {}, err: () => {} });
  return { root, runner, request };
}

function recordRun(root: string, request: CalibrationRunRequest, epoch = calibrationMeasurementEpoch(request.plan.planDigest, request.cell.key)) {
  const runDir = join(root, ".hone-runs", request.runId);
  mkdirSync(runDir, { recursive: true });
  const config = RunConfig.parse({ version: 1, capsuleId: request.cell.capsuleId, objective: request.task.manifest.objective,
    budget: request.remainingBudget, routing: { mutation: { model: M2_INNER_MODEL_ROUTE } }, apply: "none", headless: true,
    backend: "local", seed: request.cell.seed });
  const contract = renderContract({ runId: request.runId, config, manifest: request.task.manifest,
    capsuleDigest: request.task.manifestDigest, optimizerDigest: request.plan.optimizerDigest,
    orderingReport: request.task.orderingReport, deliveryTarget: null });
  const at = "2026-09-07T00:00:00.000Z";
  const artifact = { hash: digest("accepted artifact") };
  const events = [
    { type: "run.started", capsuleId: request.cell.capsuleId, contractHash: contractHash(contract), optimizerDigest: request.plan.optimizerDigest, campaignConfigHash: request.plan.planDigest },
    { type: "episode.started", episode: 0, parent: { hash: digest("baseline") } },
    { type: "incumbent.new", episode: 0, artifact, aggregate: 0.6, deltaVsBaseline: 0.1 },
    { type: "budget.snapshot", budget: { envelope: request.remainingBudget, spent: { tokens: 100, usd: 0.01, wallClockSec: 1, evaluatorInvocations: 1 } } },
    { type: "run.finished", status: "completed", best: artifact },
  ].map((event) => ({ ...event, runId: request.runId, at }));
  writeFileSync(join(runDir, "events.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(join(runDir, "contract.md"), contract);
  writeFileSync(join(runDir, "runconfig.json"), JSON.stringify(config));
  writeFileSync(join(runDir, "capsule-manifest.json"), JSON.stringify(request.task.manifest));
  writeFileSync(join(runDir, ".hone-version"), request.plan.runtimeDigest + "\n");
  writeFileSync(join(runDir, "campaign-session.v1.json"), JSON.stringify({ version: 1, campaignConfigHash: request.plan.planDigest,
    authorityPath: join(request.stateDir, "campaign-pause.v1.json"), proxyRole: "inner-capsule-improvement" }));
  writeFileSync(join(runDir, "broker-state.ndjson"), JSON.stringify({ t: "eval", measurementEpoch: epoch, record: {
    capsuleId: request.cell.capsuleId, artifactHash: artifact.hash, assetGroupId: "train", seed: request.cell.seed,
    output: { valid: true, objectives: { q: 0.6 }, constraints: { correct: true }, perExample: {} },
    costUsd: 0, durationMs: 1, cached: false, evaluatedAt: at,
  } }) + "\n");
  return runDir;
}

describe("calibration production adapter with offline run records", () => {
  it("derives gain from trusted evaluation/ordering records and rejects later contract drift", async () => {
    const { root, request, runner } = fixture();
    vi.mocked(runCommand).mockImplementation(async () => { recordRun(root, request); return 0; });
    const outcome = await runner.run(request);
    expect(outcome.status).toBe("valid");
    expect(outcome.normalizedGain).toBeCloseTo(0.5);
    await runner.verify(request, outcome);
    writeFileSync(join(root, ".hone-runs", request.runId, "contract.md"), "changed approval contract");
    await expect(runner.verify(request, outcome)).rejects.toThrow(/does not match/);
  });

  it("keeps a valid-looking evaluation from another measurement epoch invalid", async () => {
    const { root, request, runner } = fixture();
    vi.mocked(runCommand).mockImplementation(async () => { recordRun(root, request, "another-cell-epoch"); return 0; });
    const outcome = await runner.run(request);
    expect(outcome.status).toBe("invalid");
    expect(outcome.normalizedGain).toBeUndefined();
    await runner.verify(request, outcome);
  });

  it("reconciles an already finished same-run resume without invoking the supervisor again", async () => {
    const { root, request, runner } = fixture();
    recordRun(root, request);
    request.resume = true;
    const result = await runner.run(request);
    expect(result.status).toBe("valid");
    expect(result.normalizedGain).toBeCloseTo(0.5);
    expect(runCommand).not.toHaveBeenCalled();
    await runner.verify(request, result);
  });

  it("retains missing resumed run evidence as incomplete with unknown spend, not a free retry", async () => {
    const { request, runner } = fixture();
    request.resume = true;
    const result = await runner.run(request);
    expect(result).toMatchObject({ status: "incomplete", resumable: false, usage: null });
    expect(runCommand).not.toHaveBeenCalled();
    await runner.verify(request, result);
  });

  it("refuses draft admission before any run or provider authority is created", async () => {
    const { root, request, runner } = fixture(true);
    await expect(runner.run(request)).rejects.toThrow(/draft/);
    expect(runCommand).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
    expect(existsSync(join(request.stateDir, "campaign-pause.v1.json"))).toBe(false);
  });
});
