import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DiagnosticOrderingReport, RunConfig, capsuleDigest } from "@hone/schema";
import type { BudgetState } from "@hone/schema";
import { renderContract } from "../src/contract.js";
import { promptApproval, promptProbe } from "../src/supervisor.js";
import type { ProbeReport } from "../src/types.js";
import { FIX_OPTIMIZER_DIGEST, fakeHash, makeIo, makeRoot, manifestObject, orderingReportRaw, sleep } from "./helpers.js";

/**
 * Explicit-consent gates: a bare Enter NEVER approves — not the run
 * contract, not the probe verdict. Only an explicit y/yes approves; anything
 * else reprompts. (The 200ms pending-probe windows are real-time by nature:
 * the assertion is that the promise has NOT settled after real input was
 * delivered, which fake timers cannot exercise through a real readline.)
 */

const BUDGET: BudgetState = {
  envelope: { maxTokens: 1_000_000, maxUsd: 25, maxWallClockSec: 3600, maxEvaluatorInvocations: 100 },
  spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
};

function report(): ProbeReport {
  return {
    baseline: { artifact: { hash: fakeHash("b") }, aggregate: 0.5 },
    candidate: { artifact: { hash: fakeHash("c") }, aggregate: 0.6, delta: 0.1 },
    promoted: true,
    assetGroupId: "validation",
    seed: 7,
    budget: BUDGET,
  };
}

function streams(): { input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume(); // discard rendered prompts
  return { input, output };
}

async function stillPending(p: Promise<unknown>): Promise<boolean> {
  const result = await Promise.race([p.then(() => "settled"), sleep(200).then(() => "pending")]);
  return result === "pending";
}

describe("probe gate consent (explicit yes only)", () => {
  it("bare Enter reprompts; explicit yes approves", async () => {
    const io = makeIo(makeRoot()).io;
    const s = streams();
    const pending = promptProbe(report(), io, new AbortController().signal, s);
    s.input.write("\n");
    s.input.write("\n");
    expect(await stillPending(pending)).toBe(true); // no verdict from bare Enters
    s.input.write("y\n");
    await expect(pending).resolves.toBe(true);
  });

  it("bare Enter reprompts; explicit no declines", async () => {
    const io = makeIo(makeRoot()).io;
    const s = streams();
    const pending = promptProbe(report(), io, new AbortController().signal, s);
    s.input.write("\n");
    expect(await stillPending(pending)).toBe(true);
    s.input.write("no\n");
    await expect(pending).resolves.toBe(false);
  });
});

describe("contract approval consent (explicit yes only)", () => {
  function fixture(root: string): { contractPath: string; seal: Parameters<typeof promptApproval>[1]; cfg: RunConfig } {
    const manifest = manifestObject();
    const cfg = RunConfig.parse({
      version: 1,
      capsuleId: manifest.id,
      objective: manifest.objective,
      budget: manifest.budget,
      routing: { mutation: { model: "test-model" } },
      apply: "none",
      headless: false,
      improverSeat: false,
      seed: 7,
    });
    const seal = {
      runId: "run_consent1",
      manifest,
      capsuleDigest: capsuleDigest(manifest),
      optimizerDigest: FIX_OPTIMIZER_DIGEST,
      orderingReport: DiagnosticOrderingReport.parse(orderingReportRaw()),
      deliveryTarget: null,
    };
    const contractPath = join(root, "contract.md");
    writeFileSync(contractPath, renderContract({ ...seal, config: cfg }));
    return { contractPath, seal, cfg };
  }

  it("bare Enter never approves the contract; explicit n declines", async () => {
    const root = makeRoot();
    const { contractPath, seal, cfg } = fixture(root);
    const io = makeIo(root).io;
    const s = streams();
    const pending = promptApproval(contractPath, seal, cfg, io, s);
    s.input.write("\n");
    expect(await stillPending(pending)).toBe(true); // reprompted, not approved
    s.input.write("n\n");
    await expect(pending).resolves.toBeNull();
  });

  it("explicit yes approves with the unrevised config", async () => {
    const root = makeRoot();
    const { contractPath, seal, cfg } = fixture(root);
    const io = makeIo(root).io;
    const s = streams();
    const pending = promptApproval(contractPath, seal, cfg, io, s);
    s.input.write("yes\n");
    await expect(pending).resolves.toEqual(cfg);
  });
});
