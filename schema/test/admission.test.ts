import { describe, expect, it } from "vitest";
import {
  AdmissionReceiptRecord,
  type AdmissionReceiptRecordBody,
  admissionReceiptRecordHash,
} from "../src/admission.js";

const CAPSULE_DIGEST = `sha256:${"a".repeat(64)}`;

function ownerApproval(
  identities: AdmissionReceiptRecordBody["identities"] = {
    author: { identity: "capsule-author", kind: "agent" },
    "adversarial-validator": { identity: "red-team", kind: "agent" },
    "final-reviewer": { identity: "repository-owner", kind: "owner" },
  },
): AdmissionReceiptRecordBody & { recordHash: string } {
  const body: AdmissionReceiptRecordBody = {
    v: 1,
    sequence: 0,
    previousReceiptHash: null,
    capsuleDigest: CAPSULE_DIGEST,
    action: "gate2-approve",
    identities,
    provisional: false,
    timestamp: "2026-07-18T12:00:00.000Z",
  };
  return { ...body, recordHash: admissionReceiptRecordHash(body) };
}

describe("AdmissionReceiptRecord", () => {
  it("parses a hash-bound owner approval and rejects unknown fields", () => {
    const parsed = AdmissionReceiptRecord.parse(ownerApproval());
    expect(parsed.recordHash).toBe(admissionReceiptRecordHash(parsed));
    expect(() => AdmissionReceiptRecord.parse({ ...ownerApproval(), extra: true })).toThrow();
  });

  it.each([
    {
      author: { identity: "same-agent", kind: "agent" as const },
      "adversarial-validator": { identity: "same-agent", kind: "agent" as const },
      "final-reviewer": { identity: "repository-owner", kind: "owner" as const },
    },
    {
      author: { identity: " Review Agent ", kind: "agent" as const },
      "adversarial-validator": { identity: "review agent", kind: "agent" as const },
      "final-reviewer": { identity: "repository-owner", kind: "owner" as const },
    },
  ])("rejects role identity collisions after trim and case-fold", (identities) => {
    expect(() => AdmissionReceiptRecord.parse(ownerApproval(identities))).toThrow(/pairwise distinct/);
  });

  it("requires delegated approvals to be provisional and validates delegation scope and budget", () => {
    const base = ownerApproval({
      author: { identity: "capsule-author", kind: "agent" },
      "adversarial-validator": { identity: "red-team", kind: "agent" },
      "final-reviewer": { identity: "independent-reviewer", kind: "agent" },
    });
    const { recordHash: _recordHash, ...body } = base;
    const delegated = {
      ...body,
      delegation: {
        delegator: { identity: "repository-owner", kind: "owner" as const },
        scope: "provisional-private-apply-none" as const,
        budgetUsd: 12.5,
      },
      provisional: true,
    };
    expect(AdmissionReceiptRecord.parse({
      ...delegated,
      recordHash: admissionReceiptRecordHash(delegated),
    }).provisional).toBe(true);

    const nonProvisional = { ...delegated, provisional: false };
    expect(() => AdmissionReceiptRecord.parse({
      ...nonProvisional,
      recordHash: admissionReceiptRecordHash(nonProvisional),
    })).toThrow(/provisional/);

    const incomplete = AdmissionReceiptRecord.safeParse({
      ...delegated,
      delegation: { delegator: delegated.delegation.delegator },
      recordHash: admissionReceiptRecordHash(delegated),
    });
    expect(incomplete.success).toBe(false);
    if (!incomplete.success) {
      const paths = incomplete.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("delegation.scope");
      expect(paths).toContain("delegation.budgetUsd");
    }

    const badBudget = { ...delegated, delegation: { ...delegated.delegation, budgetUsd: 0 } };
    expect(() => AdmissionReceiptRecord.parse({
      ...badBudget,
      recordHash: admissionReceiptRecordHash(badBudget),
    })).toThrow();
  });

  it("rejects a record whose canonical record hash does not match", () => {
    expect(() => AdmissionReceiptRecord.parse({
      ...ownerApproval(),
      recordHash: `sha256:${"f".repeat(64)}`,
    })).toThrow(/recordHash/);
  });
});
