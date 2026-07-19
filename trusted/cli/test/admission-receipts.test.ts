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
    const receipt = makeReceipt();

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

    appendAdmissionReceipt(casRoot, makeReceipt(0, null, "gate2-approve", {
      identities,
      provisional: false,
    }));
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/delegation/);

    const delegatedRoot = join(root, "delegated-cas");
    const receipt = makeReceipt(0, null, "gate2-approve", {
      identities,
      delegation: {
        delegator: { identity: "repository-owner", kind: "owner" },
        scope: "provisional-private-apply-none",
        budgetUsd: 8.5,
      },
      provisional: true,
    });
    appendAdmissionReceipt(delegatedRoot, receipt);
    expect(verifyAdmissionApproval(delegatedRoot, DIGEST)).toEqual({
      approved: true,
      provisional: true,
      receipt,
    });

  });

  it("fails closed on a tampered recordHash", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    appendAdmissionReceipt(casRoot, makeReceipt());
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
    const first = makeReceipt(0);
    const gap = makeReceipt(2, first.recordHash);
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
    const wrong = makeReceipt(0, null, "gate2-approve", { capsuleDigest: OTHER_DIGEST });
    writeLedger(casRoot, [wrong], DIGEST);
    expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/capsule digest/);
  });

  it.each(["revoke", "gate2-reject"] as const)(
    "uses the latest terminal state and rejects a post-approval %s",
    (action) => {
      const casRoot = join(makeRoot(), ".hone-cas");
      const approval = makeReceipt();
      appendAdmissionReceipt(casRoot, approval);
      appendAdmissionReceipt(casRoot, makeReceipt(1, approval.recordHash, action));
      expect(() => verifyAdmissionApproval(casRoot, DIGEST)).toThrow(/revoke|gate2-reject|not approved/);
    },
  );

  it("ignores and repairs an unacknowledged torn trailing line", () => {
    const casRoot = join(makeRoot(), ".hone-cas");
    const receipt = makeReceipt();
    appendAdmissionReceipt(casRoot, receipt);
    const path = ledgerPath(casRoot);
    appendFileSync(path, '{"v":1');

    expect(verifyAdmissionApproval(casRoot, DIGEST).receipt).toEqual(receipt);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
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

    appendAdmissionReceipt(join(root, ".hone-cas"), makeReceipt(0, null, "gate2-approve", {
      capsuleDigest: digest,
      identities,
      delegation: {
        delegator: { identity: "repository-owner", kind: "owner" },
        scope: "provisional-private-apply-none",
        budgetUsd: 10,
      },
      provisional: true,
    }));
    expect(admitCapsule(capsuleDir, { review: "required" }).provisional).toBe(true);
  });
});
