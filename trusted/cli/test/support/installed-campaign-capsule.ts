/**
 * Install a small synthetic capsule (with a Python evaluator source) under a
 * capsules root, give it an owner Gate-2 receipt in the state root's CAS, and
 * rebind one development slot of a recursive campaign config to it, so that
 * installed-capsule resolution (cohort policy, admission binding, registered
 * identity) works end to end without the real capsules or `.hone-cas`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AdmissionReceiptRecord,
  MetaCampaignConfigV2,
  admissionReceiptRecordHash,
  type AdmissionApprovalBasis,
  type AdmissionReceiptRecordBody,
  type M2CohortEvidencePointer,
  type MetaCampaignConfigV2 as RecursiveConfig,
} from "@hone/schema";
import { admitCapsule, capsuleOracleDigest, capsuleScalarizerDigest } from "../../src/admission.js";
import { appendAdmissionReceipt } from "../../src/admission-receipts.js";
import { resolveRepoPath, type CapsulePaths } from "../../src/capsules-root.js";
import { makeCapsule } from "../helpers.js";

/**
 * A synthetic evaluator: never reads the campaign seed variable, draws fresh
 * entropy per measurement, and times itself. Authored for these tests.
 */
export const SYNTHETIC_EVALUATOR_SOURCE = [
  "import json",
  "import secrets",
  "import time",
  "",
  "CHALLENGE = {\"repetitions\": {\"fixture\": {\"measured\": 3}}}",
  "",
  "",
  "def measure(source, mode):",
  "    repetitions = int(CHALLENGE[\"repetitions\"][source][mode])",
  "    measured_nonce = secrets.randbits(63)",
  "    warmup_nonce = secrets.randbits(63)",
  "    started = time.perf_counter_ns()",
  "    total = sum((measured_nonce ^ warmup_nonce) % 7 for _ in range(repetitions))",
  "    elapsed_ms = (time.perf_counter_ns() - started) / 1_000_000.0",
  "    return total, elapsed_ms",
  "",
  "",
  "if __name__ == \"__main__\":",
  "    print(json.dumps({\"score\": measure(\"fixture\", \"measured\")[1]}))",
  "",
].join("\n");

/** Repository-relative evaluator path for a capsule installed under `label`. */
export function evaluatorRelativePath(label: string): string {
  return `capsules/${label}/baseline/eval.py`;
}

/** A `{ line, exactSourceLine }` citation of the first evaluator line containing `fragment`. */
export function evaluatorCitation(fragment: string): { line: number; exactSourceLine: string } {
  const lines = SYNTHETIC_EVALUATOR_SOURCE.split("\n");
  const index = lines.findIndex((line) => line.includes(fragment));
  if (index < 0) throw new Error(`synthetic evaluator has no line containing ${fragment}`);
  return { line: index + 1, exactSourceLine: lines[index]! };
}

export interface InstalledCapsule {
  /** Installed capsule directory (`<capsulesRoot>/<label>`). */
  readonly dir: string;
  /** The rebound, reparsed campaign config. */
  readonly config: RecursiveConfig;
}

export interface InstallCampaignCapsuleOptions {
  /** State root; receipts go to `<root>/.hone-cas`, non-capsule evidence under it. */
  readonly root: string;
  readonly capsulesRoot: string;
  /** Development (train) slot to rebind; the panel member for the same capsule follows. */
  readonly trainIndex: number;
  readonly label?: string;
}

const EVALUATOR_ENTRYPOINT = ["python3", "/trusted/baseline/eval.py"];

function writeOwnerGate2Receipts(casDir: string, digest: string, basis: AdmissionApprovalBasis): string {
  const gate1Body: AdmissionReceiptRecordBody = {
    v: 1,
    sequence: 0,
    previousReceiptHash: null,
    capsuleDigest: digest,
    action: "gate1-accept",
    identities: {
      author: { identity: "fixture-author", kind: "agent" },
      "adversarial-validator": { identity: "fixture-adversary", kind: "agent" },
      "final-reviewer": { identity: "fixture-owner", kind: "owner" },
    },
    provisional: false,
    timestamp: "2026-08-20T00:00:00.000Z",
  };
  const gate1 = AdmissionReceiptRecord.parse({ ...gate1Body, recordHash: admissionReceiptRecordHash(gate1Body) });
  const gate2Body: AdmissionReceiptRecordBody = {
    ...gate1Body,
    sequence: 1,
    previousReceiptHash: gate1.recordHash,
    action: "gate2-approve",
    approvalBasis: basis,
    timestamp: "2026-08-20T00:00:01.000Z",
  };
  const gate2 = AdmissionReceiptRecord.parse({ ...gate2Body, recordHash: admissionReceiptRecordHash(gate2Body) });
  appendAdmissionReceipt(casDir, gate1);
  appendAdmissionReceipt(casDir, gate2);
  return gate2.recordHash;
}

/** Materialize every cited cohort evidence file and rebind its pointer digest to those bytes. */
function materializeCohortEvidence(paths: CapsulePaths, pointers: M2CohortEvidencePointer[]): void {
  for (const pointer of pointers) {
    const path = resolveRepoPath(paths, pointer.path);
    const bytes = `${JSON.stringify({ syntheticCohortEvidence: pointer.path })}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    pointer.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
}

/**
 * Install a synthetic evaluator capsule and rebind `config.train[trainIndex]`
 * (with its panel member and owner-authorized cohort binding) to it. Returns
 * the reparsed config; the input config is not modified.
 */
export function installCampaignCapsule(
  input: RecursiveConfig,
  options: InstallCampaignCapsuleOptions,
): InstalledCapsule {
  const config = structuredClone(input);
  const previous = config.train[options.trainIndex];
  if (previous === undefined) throw new Error(`campaign has no train slot ${options.trainIndex}`);
  const label = options.label ?? "synthetic-evaluator-capsule";
  const dir = join(options.capsulesRoot, label);
  const scratch = mkdtempSync(join(tmpdir(), "hone-installed-capsule-"));
  try {
    makeCapsule(scratch, {
      evalEntrypoint: EVALUATOR_ENTRYPOINT,
      objective: `Synthetic evaluator capsule ${label} for campaign slot ${options.trainIndex}.`,
    });
    mkdirSync(join(scratch, "capsule", "baseline"), { recursive: true });
    writeFileSync(join(scratch, "capsule", "baseline", "eval.py"), SYNTHETIC_EVALUATOR_SOURCE);
    mkdirSync(options.capsulesRoot, { recursive: true });
    renameSync(join(scratch, "capsule"), dir);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const casDir = join(options.root, ".hone-cas");
  const unreviewed = admitCapsule(dir);
  const capsuleId = unreviewed.manifest.id;
  const capsuleDigest = unreviewed.digest;

  const cohort = config.corpusCohort;
  if (!("mode" in cohort)) throw new Error("installCampaignCapsule expects an owner-authorized partial cohort");
  cohort.developmentCapsuleIds[cohort.developmentCapsuleIds.indexOf(previous.capsuleId)] = capsuleId;
  const policy = cohort.partialCohort;
  const authorized = policy.admitted.find((entry) => entry.capsuleId === previous.capsuleId);
  if (authorized === undefined) throw new Error(`train slot ${previous.capsuleId} is not in the authorized cohort`);
  const basis: AdmissionApprovalBasis = authorized.gate2Authorization ?? {
    authorizationKey: policy.authorization.decisionKey,
    authorizedBy: policy.authorization.owner,
    authorizedAt: policy.authorization.decidedAt,
    deliveredVia: policy.authorization.deliveredVia,
    reviewEvidence: policy.authorization.evidence.map((pointer) => pointer.path),
  };
  authorized.label = label;
  authorized.capsuleId = capsuleId;
  authorized.capsuleDigest = capsuleDigest;
  authorized.gate2ReceiptHash = writeOwnerGate2Receipts(casDir, capsuleDigest, basis);
  const paths = { root: options.root, capsulesRoot: options.capsulesRoot };
  materializeCohortEvidence(paths, policy.authorization.evidence);
  for (const deferred of policy.deferred) materializeCohortEvidence(paths, deferred.evidence);

  const admitted = admitCapsule(dir, { review: "required", casDir });
  const entry = {
    ...previous,
    capsuleId,
    capsuleDigest,
    image: admitted.manifest.image,
    oracleDigest: capsuleOracleDigest(admitted),
    scalarizerDigest: capsuleScalarizerDigest(admitted),
  };
  config.train[options.trainIndex] = entry;
  for (const member of config.developmentPanel.members) {
    if (member.capsule.capsuleId === previous.capsuleId) member.capsule = { ...entry };
  }
  return { dir, config: MetaCampaignConfigV2.parse(config) };
}
