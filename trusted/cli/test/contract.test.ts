import { describe, expect, it } from "vitest";
import { DiagnosticOrderingReport, RunConfig, capsuleDigest } from "@hone/schema";
import {
  applyContractRevision,
  contractHash,
  extractRunConfigBlock,
  renderContract,
  stripRunConfigBlock,
} from "../src/contract.js";
import type { ContractInputs } from "../src/contract.js";
import { FIX_OPTIMIZER_DIGEST, fakeHash, manifestObject, orderingReportRaw } from "./helpers.js";

function config(overrides: Record<string, unknown> = {}): RunConfig {
  const manifest = manifestObject();
  return RunConfig.parse({
    version: 1,
    capsuleId: manifest.id,
    objective: manifest.objective,
    budget: manifest.budget,
    routing: { mutation: { model: "gpt-5.6-terra" } },
    apply: "branch",
    headless: false,
    improverSeat: false,
    seed: 7,
    ...overrides,
  });
}

function inputs(cfg: RunConfig = config()): ContractInputs {
  const manifest = manifestObject();
  return {
    runId: "run_c1",
    config: cfg,
    manifest,
    capsuleDigest: capsuleDigest(manifest),
    optimizerDigest: FIX_OPTIMIZER_DIGEST,
    orderingReport: DiagnosticOrderingReport.parse(orderingReportRaw()),
  };
}

/** Replace the executable block's body with `json` (mirrors an $EDITOR edit). */
function withBlock(text: string, json: string): string {
  const open = text.indexOf("```json hone.runconfig\n");
  const bodyStart = open + "```json hone.runconfig\n".length;
  const close = text.indexOf("\n```", bodyStart);
  return `${text.slice(0, bodyStart)}${json}${text.slice(close)}`;
}

describe("contract checkpoint rendering (VI.4)", () => {
  it("renders frozen identity, measured diagnostics, honest cost, and every reviewable dimension", () => {
    const seal = inputs();
    const text = renderContract(seal);
    // frozen identity: capsule id, digest, immutable image, optimizer digest
    expect(text).toContain(seal.manifest.id);
    expect(text).toContain(seal.capsuleDigest);
    expect(text).toContain(seal.manifest.image);
    expect(text).toContain(seal.optimizerDigest);
    // objective verbatim
    expect(text).toContain(seal.manifest.objective);
    // baseline
    expect(text).toContain(fakeHash("b"));
    // EXACT evaluator argv (JSON form, not prose)
    expect(text).toContain(JSON.stringify(seal.manifest.evalEntrypoint));
    // manifest-derived split sizes
    expect(text).toContain("| train | public | 1 |");
    expect(text).toContain("| validation | protected | 1 |");
    // parsed ordering report: measured baseline + variants + stability
    expect(text).toContain("measured baseline aggregate: 0.5");
    expect(text).toMatch(/\| broken \| 0\.1 \| 0\.1 \| 0\.1 \|/);
    expect(text).toContain("spread 0");
    // honest cost range bounded by the hard cap and the duration bound
    expect(text).toContain("between $0 and $25");
    expect(text).toContain("3600s wall clock");
    // budget, protected paths, routing, delivery
    expect(text).toMatch(/\$25/);
    expect(text).toContain("1000000");
    expect(text).toContain("protected/keep.txt");
    expect(text).toContain("gpt-5.6-terra");
    expect(text).toContain("branch");
  });

  it("hash is deterministic and content-addressed", () => {
    const a = renderContract(inputs());
    const b = renderContract(inputs());
    expect(contractHash(a)).toBe(contractHash(b));
    expect(contractHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contractHash(renderContract(inputs(config({ apply: "none" }))))).not.toBe(contractHash(a));
  });

  it("contains exactly one executable run-config block that round-trips to the rendered config", () => {
    const cfg = config();
    const text = renderContract(inputs(cfg));
    const block = extractRunConfigBlock(text);
    if ("error" in block) throw new Error(block.error);
    expect(RunConfig.parse(JSON.parse(block.body))).toEqual(cfg);
  });
});

describe("contract revision (interactive E — parse back, fail closed)", () => {
  const pre = (): string => renderContract(inputs());

  it("a valid budget-tightening edit parses back into the executed config", () => {
    const preEdit = pre();
    const revised = { ...config(), budget: { ...config().budget, maxUsd: 5 }, seed: 11 };
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.budget.maxUsd).toBe(5);
      expect(outcome.config.seed).toBe(11);
      // and the re-render from the approved config keeps a valid unique block
      const rerendered = renderContract(inputs(outcome.config));
      expect(rerendered).toContain('"maxUsd": 5');
      expect("error" in extractRunConfigBlock(rerendered)).toBe(false);
    }
  });

  it("forbids capsule-id changes", () => {
    const preEdit = pre();
    const revised = { ...config(), capsuleId: "cap_000000000000" };
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/capsuleId is frozen/);
  });

  it("forbids budget increases beyond the capsule envelope", () => {
    const preEdit = pre();
    const revised = { ...config(), budget: { ...config().budget, maxUsd: 26 } };
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/exceeds the capsule envelope/);
  });

  it("fails closed on a non-parseable block", () => {
    const preEdit = pre();
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, "{ not json"),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/not valid JSON/);
  });

  it("fails closed when the block is deleted or duplicated", () => {
    const preEdit = pre();
    const deleted = stripRunConfigBlock(preEdit).replace(/```json hone\.runconfig[\s\S]*?```/, "");
    const gone = applyContractRevision({ preEdit, edited: deleted, original: config(), manifest: manifestObject(), env: {} });
    expect(gone.ok).toBe(false);

    const dup = `${preEdit}\n\`\`\`json hone.runconfig\n${JSON.stringify(config())}\n\`\`\`\n`;
    const twice = applyContractRevision({ preEdit, edited: dup, original: config(), manifest: manifestObject(), env: {} });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error).toMatch(/unique/);
  });

  it("fails closed on misleading edits OUTSIDE the executable block", () => {
    const preEdit = pre();
    // Tamper with the narrative (claim a different hard cap) but keep the block intact.
    const edited = preEdit.replace("**hard USD cap: $25**", "**hard USD cap: $1**");
    const outcome = applyContractRevision({ preEdit, edited, original: config(), manifest: manifestObject(), env: {} });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/outside the executable/);
  });

  it("re-runs the autonomy ladder on the revised config", () => {
    const preEdit = renderContract(inputs(config({ improverSeat: true, apply: "none" })));
    const revised = config({ improverSeat: true, apply: "auto" });
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config({ improverSeat: true, apply: "none" }),
      manifest: manifestObject(),
      env: {}, // HONE_LADDER_OK unset -> locked
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/ladder/);
  });

  it("forbids flipping headless or improverSeat mid-approval", () => {
    const preEdit = pre();
    const revised = { ...config(), headless: true };
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/headless/);
  });
});
