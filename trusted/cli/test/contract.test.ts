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
    deliveryTarget: null,
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

describe("promotion rule in the contract (campaign-start freeze)", () => {
  it("renders the pre-registered rule visibly and inside the executable block", () => {
    const text = renderContract(inputs());
    expect(text).toContain("## Promotion rule (pre-registered — frozen at campaign start)");
    // defaults: {minDeltaOverSe:2, minSignConsistency:0.8, replicates:3, requireNegativeControls:true}
    expect(text).toContain("paired delta must exceed **2×** its standard error");
    expect(text).toContain("sign consistency: at least **0.8**");
    expect(text).toContain("replicates per arm per task: **3**");
    expect(text).toContain("negative controls required: **yes**");
    expect(text).toContain("M0 is one cache-safe candidate");
    expect(text).toContain("Multi-episode inner search requires M1 fresh evaluator cache domains");
    const block = extractRunConfigBlock(text);
    if ("error" in block) throw new Error(block.error);
    expect(JSON.parse(block.body).promotion).toEqual({ minDeltaOverSe: 2, minSignConsistency: 0.8, replicates: 3, requireNegativeControls: true });
  });

  it("a different rule changes the contract hash — the rule is sealed at campaign start", () => {
    const custom = config({ promotion: { minDeltaOverSe: 4, minSignConsistency: 0.9, replicates: 5, requireNegativeControls: false } });
    const customText = renderContract(inputs(custom));
    expect(contractHash(customText)).not.toBe(contractHash(renderContract(inputs())));
    expect(customText).toContain("negative controls required: **no**");
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

  it("allows an owner promotion-rule edit under schema validation", () => {
    const preEdit = pre();
    const rule = { minDeltaOverSe: 3, minSignConsistency: 0.9, replicates: 5, requireNegativeControls: true };
    const revised = { ...config(), promotion: rule };
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (outcome.ok) {
      expect(outcome.config.promotion).toEqual(rule);
      // the re-render freezes the revised rule into the narrative and the block
      const rerendered = renderContract(inputs(outcome.config));
      expect(rerendered).toContain("replicates per arm per task: **5**");
      expect(rerendered).toContain('"minDeltaOverSe": 3');
    }
  });

  it("fails closed on an out-of-range promotion rule", () => {
    const preEdit = pre();
    const revised = { ...config(), promotion: { minDeltaOverSe: 2, minSignConsistency: 1.5, replicates: 3, requireNegativeControls: true } };
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config(),
      manifest: manifestObject(),
      env: {},
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/promotion\.minSignConsistency/);
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

  it("apply mode is frozen mid-approval (none→auto can never bypass the sealed delivery target)", () => {
    const preEdit = renderContract(inputs(config({ improverSeat: true, apply: "none" })));
    const revised = config({ improverSeat: true, apply: "auto" });
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(revised, null, 2)),
      original: config({ improverSeat: true, apply: "none" }),
      manifest: manifestObject(),
      env: { HONE_LADDER_OK: "1" }, // even an unlocked ladder cannot license an apply flip
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/apply mode is frozen/);
  });

  it("re-runs the autonomy ladder on the revised config", () => {
    // apply/improverSeat are frozen, so the ladder re-check is defense in
    // depth: an unchanged auto+seat config still refuses without the env ack.
    const locked = config({ improverSeat: true, apply: "auto" });
    const preEdit = renderContract(inputs(locked));
    const outcome = applyContractRevision({
      preEdit,
      edited: withBlock(preEdit, JSON.stringify(locked, null, 2)),
      original: locked,
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

describe("contract binds duration and the sealed delivery target", () => {
  it("renders a deterministic heuristic duration RANGE plus a separately labeled hard stop", () => {
    const text = renderContract(inputs());
    // 3600s envelope → deterministic heuristic range 10–80%: 6m–48m, plus a
    // separately labeled hard stop (the cap is a bound, never the estimate).
    expect(text).toContain("- estimated duration: 6m–48m (heuristic: 10–80% of the wall envelope");
    expect(text).toContain("- hard stop: 3600s wall clock");
    const manifest = manifestObject();
    const custom = renderContract(inputs(config({ budget: { ...manifest.budget, maxWallClockSec: 5400 } })));
    expect(custom).toContain("- estimated duration: 9m–1h 12m (heuristic: 10–80% of the wall envelope");
    expect(custom).toContain("- hard stop: 5400s wall clock");
  });

  it("renders the sealed delivery target (repo, gitDir, baseline commit, filesystem identity, marker) into the hashed text", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const identity = { repoIdentity: { dev: "16777231", ino: "424242" }, storeIdentity: { dev: "16777231", ino: "424243" } };
    const marker = { file: "hone-delivery-marker.run_x", nonce: "0f".repeat(16) };
    const seal = {
      ...inputs(),
      deliveryTarget: { repo: "/work/target-repo", gitDir: "/work/target-repo/.gitdir", baselineCommit: commit, ...identity, marker },
    };
    const text = renderContract(seal);
    expect(text).toContain("- delivery target (sealed at creation; re-validated on resume and before delivery): `/work/target-repo`");
    expect(text).toContain("- delivery git store (embedded baseline, explicitly bound): `/work/target-repo/.gitdir`");
    expect(text).toContain(`- delivery baseline commit (frozen manifest baseline): \`${commit}\``);
    // The immutable filesystem identity and the in-store marker are part of
    // the approved bytes — the hash binds WHICH filesystem object may
    // receive the run, not just its path.
    expect(text).toContain("- delivery repo identity (dev:ino, sealed at creation): `16777231:424242`");
    expect(text).toContain("- delivery store identity (dev:ino, sealed at creation): `16777231:424243`");
    expect(text).toContain("- delivery incarnation marker (in-store, per-run): `hone-delivery-marker.run_x`");
    expect(text).not.toContain(marker.nonce); // the nonce itself is never disclosed — only its sha256
    // The target is part of the approved bytes: the hash binds it.
    expect(contractHash(text)).not.toBe(contractHash(renderContract(inputs())));
    expect(contractHash(text)).not.toBe(
      contractHash(renderContract({ ...seal, deliveryTarget: { repo: "/work/other-repo", baselineCommit: commit, ...identity, marker } })),
    );
    expect(contractHash(text)).not.toBe(
      contractHash(
        renderContract({
          ...seal,
          deliveryTarget: { ...seal.deliveryTarget, repoIdentity: { dev: "16777231", ino: "999999" } },
        }),
      ),
    );
    // apply=none renders an explicit no-target line.
    expect(renderContract(inputs())).toContain("- delivery target: none (apply=none");
  });
});
