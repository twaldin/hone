import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DiagnosticOrderingReport, RunConfig, capsuleDigest } from "@hone/schema";
import { writeCapsuleSnapshot } from "../src/admission.js";
import { contractHash, renderContract } from "../src/contract.js";
import { readEvents, replayRun } from "../src/eventlog.js";
import { loadRunConfigFile, writeRunConfigFile } from "../src/runs.js";
import { runCommand as cliRunCommand, superviseRun } from "../src/supervisor.js";
import type { SuperviseExtra } from "../src/supervisor.js";
import {
  CAP_ID,
  FIX_OPTIMIZER_DIGEST,
  fakeHash,
  fixtureEvents,
  makeCapsule,
  makeIo,
  makeRoot,
  manifestObject,
  orderingReportRaw,
  writeEvents,
} from "./helpers.js";

/**
 * Resume/config seal: the backend, headless mode, run config, and approved
 * contract are frozen at run creation. A resume re-proves ALL of it under the
 * run lock, before run.resumed or any backend launch; tamper refuses with no
 * event and no terminal, leaving the run resumable once undone.
 */

interface Sealed {
  runDir: string;
  runId: string;
  config: RunConfig;
  extra: SuperviseExtra;
}

function sealedRun(root: string, runId: string, configOverrides: Record<string, unknown> = {}): Sealed {
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
    ...configOverrides,
  });
  const orderingReport = DiagnosticOrderingReport.parse(orderingReportRaw());
  const contract = renderContract({
    runId,
    config,
    manifest,
    capsuleDigest: capsuleDigest(manifest),
    optimizerDigest: FIX_OPTIMIZER_DIGEST,
    orderingReport,
  });
  const runDir = writeEvents(
    root,
    runId,
    fixtureEvents({ runId, baselineHash: fakeHash("b"), bestHash: fakeHash("d"), finished: false, contractHash: contractHash(contract) }),
  );
  writeFileSync(join(runDir, "contract.md"), contract);
  writeCapsuleSnapshot(runDir, manifest);
  writeRunConfigFile(runDir, config);
  return {
    runDir,
    runId,
    config,
    extra: {
      manifest,
      capsuleDir: join(root, "capsule"),
      capsuleDigest: capsuleDigest(manifest),
      optimizerDigest: FIX_OPTIMIZER_DIGEST,
      orderingReport,
    },
  };
}

/** Resume through the REAL lock path with the pre-lock plan `config`. */
async function resumeWith(root: string, sealed: Sealed, env: Record<string, string> = {}): Promise<{ code: number; err: string[] }> {
  const { io, err } = makeIo(root, { HONE_STUB_EPISODES: "1", ...env });
  const plan = { runId: sealed.runId, runDir: sealed.runDir, config: sealed.config, resumed: true };
  const code = await superviseRun(plan, sealed.extra, io);
  return { code, err };
}

describe("under-lock seal verification (tamper => refuse, no event, no terminal)", () => {
  it("an untampered sealed run resumes clean", async () => {
    const root = makeRoot();
    const sealed = sealedRun(root, "run_ok");
    const { code, err } = await resumeWith(root, sealed);
    expect(code, err.join("\n")).toBe(0);
    expect(readEvents(sealed.runDir).some((e) => e.type === "run.resumed")).toBe(true);
  });

  it("runconfig.json swapped between plan and lock refuses (backend/headless/config seals)", async () => {
    const root = makeRoot();
    const sealed = sealedRun(root, "run_cfg");
    // Tamper AFTER the plan was chosen: bump the seed on disk.
    writeRunConfigFile(sealed.runDir, { ...sealed.config, seed: 7 });
    const { code, err } = await resumeWith(root, sealed);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/resume seal violated.*runconfig\.json changed/);
    const events = readEvents(sealed.runDir);
    expect(events.some((e) => e.type === "run.resumed")).toBe(false);
    expect(replayRun(sealed.runDir).finished).toBeNull(); // still resumable

    // Undo the tamper: the run resumes normally — nothing was terminalized.
    writeRunConfigFile(sealed.runDir, sealed.config);
    const retry = await resumeWith(root, { ...sealed, config: loadRunConfigFile(sealed.runDir) });
    expect(retry.code, retry.err.join("\n")).toBe(0);
  });

  it("an edited contract.md refuses (hash != run.started seal)", async () => {
    const root = makeRoot();
    const sealed = sealedRun(root, "run_con");
    const contractPath = join(sealed.runDir, "contract.md");
    writeFileSync(contractPath, `${readFileSync(contractPath, "utf8")}\n<!-- tampered -->\n`);
    const { code, err } = await resumeWith(root, sealed);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/resume seal violated.*approved contract was altered/);
    expect(readEvents(sealed.runDir).some((e) => e.type === "run.resumed")).toBe(false);
    expect(replayRun(sealed.runDir).finished).toBeNull();
  });

  it("a CONSISTENTLY re-forged config+contract still refuses: the run.started hash is the root of trust", async () => {
    const root = makeRoot();
    const sealed = sealedRun(root, "run_forge");
    // Attacker rewrites BOTH files coherently (config + re-rendered contract),
    // upping the budget. Only the event-log hash cannot be rewritten.
    const forged = RunConfig.parse({ ...sealed.config, budget: { ...sealed.config.budget, maxUsd: 9999 } });
    writeRunConfigFile(sealed.runDir, forged);
    writeFileSync(
      join(sealed.runDir, "contract.md"),
      renderContract({
        runId: sealed.runId,
        config: forged,
        manifest: sealed.extra.manifest,
        capsuleDigest: sealed.extra.capsuleDigest,
        optimizerDigest: sealed.extra.optimizerDigest,
        orderingReport: sealed.extra.orderingReport,
      }),
    );
    const { code, err } = await resumeWith(root, { ...sealed, config: forged });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/resume seal violated/);
    expect(readEvents(sealed.runDir).some((e) => e.type === "run.resumed")).toBe(false);
  });
});

describe("hone run identity flags", () => {
  it("--repo is gone from `hone run` entirely", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root);
    await expect(cliRunCommand(["capsule", "--headless", "--backend", "stub", "--repo", "elsewhere"], io)).rejects.toThrow(/repo/);
  });

  it("a fresh run seals the selected backend into runconfig and the contract", async () => {
    const root = makeRoot();
    makeCapsule(root);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await cliRunCommand(["capsule", "--headless", "--backend", "stub"], io)).toBe(0);
    const runsDir = join(root, ".hone-runs");
    const runDir = join(runsDir, readdirSync(runsDir)[0] ?? "");
    expect(loadRunConfigFile(runDir).backend).toBe("stub");
    expect(readFileSync(join(runDir, "contract.md"), "utf8")).toContain("- backend: **stub**");
  });

  it("resume with an absent --backend reuses the sealed backend; a conflicting flag refuses", async () => {
    const root = makeRoot();
    const sealed = sealedRun(root, "run_bk");
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    await expect(cliRunCommand(["capsule", "--headless", "--resume", "--backend", "local"], io)).rejects.toThrow(/conflicts with the run's sealed backend "stub"/);
    expect(readEvents(sealed.runDir).some((e) => e.type === "run.resumed")).toBe(false);
    // Absent flag: the stored stub backend runs.
    const retry = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await cliRunCommand(["capsule", "--headless", "--resume"], retry.io)).toBe(0);
    expect(readEvents(sealed.runDir).some((e) => e.type === "run.resumed")).toBe(true);
  });

  it("--headless on resume may not flip a sealed interactive run", async () => {
    const root = makeRoot();
    sealedRun(root, "run_hd", { headless: false });
    const { io } = makeIo(root);
    await expect(cliRunCommand(["capsule", "--headless", "--resume"], io)).rejects.toThrow(/sealed interactive mode/);
  });

  it("absence of --headless preserves the stored headless mode", async () => {
    const root = makeRoot();
    const sealed = sealedRun(root, "run_hd2"); // stored headless: true
    const { io, out } = makeIo(root, { HONE_STUB_EPISODES: "1" });
    expect(await cliRunCommand(["capsule", "--resume"], io)).toBe(0);
    // Headless NDJSON streaming proves the stored mode drove supervision.
    expect(out.some((l) => l.startsWith("{"))).toBe(true);
    expect(readEvents(sealed.runDir).some((e) => e.type === "run.resumed")).toBe(true);
  });
});
