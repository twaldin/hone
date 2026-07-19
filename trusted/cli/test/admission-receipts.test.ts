import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AdmissionReceiptRecord,
  type AdmissionReceiptRecordBody,
  admissionReceiptRecordHash,
  capsuleDigest,
} from "@hone/schema";
import { describe, expect, it } from "vitest";
import { admitCapsule } from "../src/admission.js";
import {
  appendAdmissionReceipt,
  verifyAdmissionApproval,
} from "../src/admission-receipts.js";
import { makeCapsule, makeRoot, manifestObject } from "./helpers.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const HASH = `sha256:${"c".repeat(64)}`;

function makeReceipt(
  sequence = 0,
  previousReceiptHash: string | null = null,
  action: AdmissionReceiptRecordBody["action"] = "gate2-approve",
  overrides: Partial<AdmissionReceiptRecordBody> = {},
): AdmissionReceiptRecord {
  const body: AdmissionReceiptRecordBody = {
    v: 1,
    sequence,
    previousReceiptHash,
    capsuleDigest: DIGEST,
    action,
    identities: {
      author: { identity: "capsule-author", kind: "agent" },
      "adversarial-validator": { identity: "red-team", kind: "agent" },
      "final-reviewer": { identity: "repository-owner", kind: "owner" },
    },
    provisional: false,
    timestamp: `2026-07-18T12:00:0${sequence}.000Z`,
    ...overrides,
  };
  return AdmissionReceiptRecord.parse({
    ...body,
    recordHash: admissionReceiptRecordHash(body),
  });
}
function approvalHistory(
  overrides: Partial<AdmissionReceiptRecordBody> = {},
): readonly [AdmissionReceiptRecord, AdmissionReceiptRecord] {
  const gate1 = makeReceipt(0, null, "gate1-accept", {
    ...(overrides.capsuleDigest !== undefined ? { capsuleDigest: overrides.capsuleDigest } : {}),
    ...(overrides.identities !== undefined ? { identities: overrides.identities } : {}),
  });
  return [
    gate1,
    makeReceipt(1, gate1.recordHash, "gate2-approve", overrides),
  ];
}

function receiptChain(
  actions: readonly AdmissionReceiptRecordBody["action"][],
): AdmissionReceiptRecord[] {
  const receipts: AdmissionReceiptRecord[] = [];
  let previousReceiptHash: string | null = null;
  for (const [sequence, action] of actions.entries()) {
    const receipt = makeReceipt(sequence, previousReceiptHash, action);
    receipts.push(receipt);
    previousReceiptHash = receipt.recordHash;
  }
  return receipts;
}


function ledgerPath(casRoot: string, digest = DIGEST): string {
  return join(casRoot, "admission-receipts", `${digest.slice("sha256:".length)}.ndjson`);
}

function writeLedger(casRoot: string, records: readonly AdmissionReceiptRecord[], digest = DIGEST): void {
  const path = ledgerPath(casRoot, digest);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  chmodSync(path, 0o600);
}

describe("admission receipt ledger", () => {
  it("appends and verifies an owner approval in an owner-only hash-chained ledger", () => {
    const root = makeRoot();
    const casRoot = join(root, ".hone-cas");
    const [gate1, receipt] = approvalHistory();

    appendAdmissionReceipt(casRoot, gate1);
    expect(appendAdmissionReceipt(casRoot, receipt)).toEqual(receipt);
    expect(verifyAdmissionApproval(casRoot, DIGEST)).toEqual({
      approved: true,
      provisional: false,
      receipt,
    });
    expect(statSync(ledgerPath(casRoot)).mode & 0o777).toBe(0o600);
  });

  it("requires an agent approval to carry a complete hard-budget delegation and surfaces it as provisional", () => {
    const root = makeRoot();
    const casRoot = join(root, ".hone-cas");
    const identities: AdmissionReceiptRecordBody["identities"] = {
      author: { identity: "capsule-author", kind: "agent" },
      "adversarial-validator": { identity: "red-team", kind: "agent" },
      "final-reviewer": { identity: "independent-reviewer", kind: "agent" },
    };

    const [gate1, undelegated] = approvalHistory({
      identities,
      provisional: false,
    });
    appendAdmissionReceipt(casRoot, gate1);
    appendAdmissionReceipt(casRoot, undelegated);
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/delegation/);

    const delegatedRoot = join(root, "delegated-cas");
    const [delegatedGate1, receipt] = approvalHistory({
      identities,
      delegation: {
        delegator: { identity: "repository-owner", kind: "owner" },
        delegate: { identity: "independent-reviewer", kind: "agent" },
        scope: "provisional-private-apply-none",
        budgetUsd: 8.5,
      },
      provisional: true,
    });
    appendAdmissionReceipt(delegatedRoot, delegatedGate1);
    appendAdmissionReceipt(delegatedRoot, receipt);
    expect(verifyAdmissionApproval(delegatedRoot, DIGEST)).toEqual({
      approved: true,
      provisional: true,
      receipt,
    });

  });

  it("fails closed on a tampered recordHash", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const [gate1, approval] = approvalHistory();
    appendAdmissionReceipt(casRoot, gate1);
    appendAdmissionReceipt(casRoot, approval);
    const path = ledgerPath(casRoot);
    const tampered = readFileSync(path, "utf8").replace(
      /"recordHash":"sha256:[0-9a-f]{64}"/,
      `"recordHash":"${HASH}"`,
    );
    writeFileSync(path, tampered, { mode: 0o600 });
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/recordHash|hash/);
  });

  it("fails closed on a sequence gap", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const first = makeReceipt(0, null, "gate1-accept");
    const gap = makeReceipt(2, first.recordHash, "gate2-approve");
    writeLedger(casRoot, [first, gap]);
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/sequence/);
  });

  it("fails closed on a wrong previousReceiptHash", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const first = makeReceipt(0, null, "gate1-accept");
    const approval = makeReceipt(1, HASH);
    writeLedger(casRoot, [first, approval]);
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/chain|previousReceiptHash/);
  });

  it("fails closed when a ledger file contains a record for another capsule digest", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const wrong = makeReceipt(0, null, "gate1-accept", { capsuleDigest: OTHER_DIGEST });
    writeLedger(casRoot, [wrong], DIGEST);
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/capsule digest/);
  });

  it.each(["revoke", "gate2-reject"] as const)(
    "uses the latest terminal state and rejects a post-approval %s",
    (action) => {
      const casRoot = join(makeRoot(), ".hone-cas");
      const [gate1, approval] = approvalHistory();
      appendAdmissionReceipt(casRoot, gate1);
      appendAdmissionReceipt(casRoot, approval);
      appendAdmissionReceipt(casRoot, makeReceipt(2, approval.recordHash, action));
      expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/revoke|gate2-reject|not approved/);
    },
  );

  it("ignores and repairs an unacknowledged torn trailing line", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const [gate1, receipt] = approvalHistory();
    appendAdmissionReceipt(casRoot, gate1);
    appendAdmissionReceipt(casRoot, receipt);
    const path = ledgerPath(casRoot);
    appendFileSync(path, '{"v":1');

    expect(verifyAdmissionApproval(casRoot, DIGEST).receipt).toEqual(receipt);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
  it.each([
    ["a lone gate2 approval", ["gate2-approve"]],
    ["reject then direct approval", ["gate1-accept", "gate2-reject", "gate2-approve"]],
    ["revoke then direct approval", ["gate1-accept", "gate2-approve", "revoke", "gate2-approve"]],
    ["duplicate approval", ["gate1-accept", "gate2-approve", "gate2-approve"]],
  ] as const)("fails closed on the invalid two-gate transition: %s", (_name, actions) => {
    const casRoot = join(makeRoot(), ".hone-cas");
    writeLedger(casRoot, receiptChain(actions));
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/transition|gate1/i);
  });

  it("requires revision and a fresh gate1 acceptance after a terminal gate1 rejection", () => {
    const rejectedRoot = join(makeRoot(), ".hone-cas");
    writeLedger(rejectedRoot, receiptChain(["gate1-reject"]));
    expect(() => verifyAdmissionApproval(rejectedRoot, DIGEST)).toThrow(/not approved|gate1/i);

    const bypassRoot = join(makeRoot(), ".hone-cas");
    writeLedger(bypassRoot, receiptChain(["gate1-reject", "gate2-approve"]));
    expect(() => verifyAdmissionApproval(bypassRoot, DIGEST)).toThrow(/transition|gate1/i);

    const reopenedRoot = join(makeRoot(), ".hone-cas");
    const reopened = receiptChain([
      "gate1-reject",
      "gate1-revise",
      "gate1-accept",
      "gate2-approve",
    ]);
    writeLedger(reopenedRoot, reopened);
    expect(verifyAdmissionApproval(reopenedRoot, DIGEST).receipt).toEqual(reopened[3]);
  });

  it.each(["author", "adversarial-validator", "final-reviewer"] as const)(
    "fails closed when the %s identity changes within a chain",
    (role) => {
      const casRoot = join(makeRoot(), ".hone-cas");
      const gate1 = makeReceipt(0, null, "gate1-accept");
      const identities: AdmissionReceiptRecordBody["identities"] = {
        author: role === "author"
          ? { identity: "replacement-author", kind: "agent" }
          : gate1.identities.author,
        "adversarial-validator": role === "adversarial-validator"
          ? { identity: "replacement-validator", kind: "agent" }
          : gate1.identities["adversarial-validator"],
        "final-reviewer": role === "final-reviewer"
          ? { identity: "replacement-owner", kind: "owner" }
          : gate1.identities["final-reviewer"],
      };
      const approval = makeReceipt(1, gate1.recordHash, "gate2-approve", { identities });
      writeLedger(casRoot, [gate1, approval]);
      expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/identity.*change|continuity/i);
    },
  );

  it("allows an explicit gate1 reopen after a revocation", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const records = receiptChain([
      "gate1-accept",
      "gate2-approve",
      "revoke",
      "gate1-accept",
      "gate2-approve",
    ]);
    writeLedger(casRoot, records);
    expect(verifyAdmissionApproval(casRoot, DIGEST).receipt).toEqual(records[4]);
  });

  it("fails verification while an append failure has poisoned the ledger", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const [gate1, approval] = approvalHistory();
    appendAdmissionReceipt(casRoot, gate1);
    appendAdmissionReceipt(casRoot, approval);
    const path = ledgerPath(casRoot);
    chmodSync(path, 0o400);
    expect(() => appendAdmissionReceipt(
      casRoot,
      makeReceipt(2, approval.recordHash, "revoke"),
    )).toThrow();
    chmodSync(path, 0o600);
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/poison|unusable/);
  });

});

describe("admitCapsule review gate", () => {
  it("keeps review off backward-compatible for an unreceipted capsule", () => {
    const root = makeRoot();
    const capsuleDir = makeCapsule(root);
    expect(admitCapsule(capsuleDir, { review: "off" }).provisional).toBe(false);
  });

  it("requires the exact full capsule digest and threads provisional approval", () => {
    const root = makeRoot();
    const capsuleDir = makeCapsule(root);
    const digest = capsuleDigest(manifestObject());
    const identities: AdmissionReceiptRecordBody["identities"] = {
      author: { identity: "capsule-author", kind: "agent" },
      "adversarial-validator": { identity: "red-team", kind: "agent" },
      "final-reviewer": { identity: "independent-reviewer", kind: "agent" },
    };
    expect(() => admitCapsule(capsuleDir, { review: "required" })).toThrow(/admission receipt|approval/);

    const [gate1, approval] = approvalHistory({
      capsuleDigest: digest,
      identities,
      delegation: {
        delegator: { identity: "repository-owner", kind: "owner" },
        delegate: { identity: "independent-reviewer", kind: "agent" },
        scope: "provisional-private-apply-none",
        budgetUsd: 10,
      },
      provisional: true,
    });
    appendAdmissionReceipt(join(root, ".hone-cas"), gate1);
    appendAdmissionReceipt(join(root, ".hone-cas"), approval);
    expect(admitCapsule(capsuleDir, { review: "required" }).provisional).toBe(true);
  });
});
