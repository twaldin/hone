import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.js";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const AUTHORIZATION_IDENTITY = /^[a-z0-9][a-z0-9._@-]*$/;
function normalizeAuthorizationIdentity(identity: string): string {
  return identity.trim().normalize("NFKC").toLowerCase();
}
const NormalizedAuthorizationIdentity = z.string()
  .transform(normalizeAuthorizationIdentity)
  .pipe(z.string().min(1).regex(
    AUTHORIZATION_IDENTITY,
    "identity must use the canonical ASCII authorization alphabet",
  ));

/** A durable review actor identity. Identity text is normalized at parse time. */
export const ReviewIdentity = z.object({
  identity: NormalizedAuthorizationIdentity,
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
  delegate: ReviewIdentity,
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
  const normalizeIdentity = (identity: ReviewIdentity): ReviewIdentity => ({
    ...identity,
    identity: normalizeAuthorizationIdentity(identity.identity),
  });
  const normalized = {
    ...body,
    identities: {
      author: normalizeIdentity(body.identities.author),
      "adversarial-validator": normalizeIdentity(body.identities["adversarial-validator"]),
      "final-reviewer": normalizeIdentity(body.identities["final-reviewer"]),
    },
    delegation: body.delegation === undefined
      ? undefined
      : {
          ...body.delegation,
          delegator: normalizeIdentity(body.delegation.delegator),
          delegate: normalizeIdentity(body.delegation.delegate),
        },
  };
  return `sha256:${createHash("sha256").update(canonicalJson(normalized)).digest("hex")}`;
}

export const AdmissionReceiptRecord = AdmissionReceiptRecordBodySchema.extend({
  recordHash: SHA256,
}).strict().superRefine((record, ctx) => {
  const identities = AdmissionReviewRole.options.map((role) =>
    record.identities[role].identity
  );
  if (new Set(identities).size !== identities.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identities"],
      message: "author, adversarial-validator, and final-reviewer identities must be pairwise distinct after authorization identity normalization",
    });
  }

  if (record.delegation !== undefined) {
    const { delegate, delegator } = record.delegation;
    const finalReviewer = record.identities["final-reviewer"];
    if (
      delegate.identity !== finalReviewer.identity
      || delegate.kind !== finalReviewer.kind
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delegation", "delegate"],
        message: "delegation delegate must equal the final-reviewer identity",
      });
    }
    if (delegator.identity === delegate.identity) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delegation", "delegator"],
        message: "delegation delegator must differ from the delegate",
      });
    }
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
