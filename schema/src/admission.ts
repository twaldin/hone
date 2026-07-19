import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** A durable review actor identity. Identity text is normalized at parse time. */
export const ReviewIdentity = z.object({
  identity: z.string().trim().min(1),
  kind: z.enum(["owner", "agent"]),
}).strict();
export type ReviewIdentity = z.infer<typeof ReviewIdentity>;

export const AdmissionReviewRole = z.enum([
  "author",
  "adversarial-validator",
  "final-reviewer",
]);
export type AdmissionReviewRole = z.infer<typeof AdmissionReviewRole>;

const AdmissionReviewIdentities = z.object({
  author: ReviewIdentity,
  "adversarial-validator": ReviewIdentity,
  "final-reviewer": ReviewIdentity,
}).strict();

const AdmissionDelegation = z.object({
  delegator: ReviewIdentity,
  scope: z.literal("provisional-private-apply-none"),
  budgetUsd: z.number().finite().positive(),
}).strict();

const AdmissionReceiptRecordBodySchema = z.object({
  v: z.literal(1),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  previousReceiptHash: SHA256.nullable(),
  capsuleDigest: SHA256,
  action: z.enum([
    "gate1-accept",
    "gate1-revise",
    "gate2-approve",
    "gate2-reject",
    "revoke",
  ]),
  identities: AdmissionReviewIdentities,
  delegation: AdmissionDelegation.optional(),
  provisional: z.boolean(),
  timestamp: z.string().datetime({ offset: true }),
}).strict();

export type AdmissionReceiptRecordBody = z.infer<typeof AdmissionReceiptRecordBodySchema>;
export type AdmissionReceiptHash = `sha256:${string}`;

/** Hash the canonical record body. A present recordHash is always excluded. */
export function admissionReceiptRecordHash(
  record: AdmissionReceiptRecordBody & { recordHash?: string },
): AdmissionReceiptHash {
  const { recordHash: _recordHash, ...body } = record;
  return `sha256:${createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

export const AdmissionReceiptRecord = AdmissionReceiptRecordBodySchema.extend({
  recordHash: SHA256,
}).strict().superRefine((record, ctx) => {
  const identities = AdmissionReviewRole.options.map((role) =>
    record.identities[role].identity.trim().toLowerCase()
  );
  if (new Set(identities).size !== identities.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identities"],
      message: "author, adversarial-validator, and final-reviewer identities must be pairwise distinct after trim and case-fold",
    });
  }

  if (record.action === "gate2-approve" && record.delegation !== undefined && !record.provisional) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["provisional"],
      message: "a delegated gate2 approval must be provisional",
    });
  }

  if (admissionReceiptRecordHash(record) !== record.recordHash) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recordHash"],
      message: "recordHash does not match the canonical admission receipt record",
    });
  }
});
export type AdmissionReceiptRecord = z.infer<typeof AdmissionReceiptRecord>;
