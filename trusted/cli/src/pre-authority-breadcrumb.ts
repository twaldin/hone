import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { repairTornTail, syncDir, writeAllSync } from "./eventlog.js";

export const PRE_AUTHORITY_BREADCRUMB_FILE = "pre-authority-refusals.v1.ndjson";
export const PRE_AUTHORITY_STDERR_TAIL_CHARS = 4_096;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const PreAuthorityRefusalReasonClass = z.enum([
  "docker-client-environment-divergence",
  "campaign-authority-refusal",
  "runtime-seal-refusal",
  "journal-authority-recovery-failure",
  "backend-startup-failure",
  "unclassified-pre-authority-exit",
]);
export type PreAuthorityRefusalReasonClass = z.infer<typeof PreAuthorityRefusalReasonClass>;

/**
 * Diagnostic-only child refusal fact. This schema deliberately lives in the
 * CLI rather than @hone/schema: it grants no authority and is never an input
 * to child settlement, journal replay, or resume selection.
 */
export const PreAuthorityRefusalBreadcrumbV1 = z.object({
  version: z.literal(1),
  recordedAt: z.string().datetime(),
  childRunId: z.string().min(1),
  exitCode: z.number().int(),
  reasonClass: PreAuthorityRefusalReasonClass,
  stderrTail: z.string().min(1).max(PRE_AUTHORITY_STDERR_TAIL_CHARS),
  launch: z.object({
    executionRunId: z.string().min(1),
    mode: z.enum(["start", "resume"]),
    attempt: z.union([z.literal(0), z.literal(1)]),
    phase: z.string().min(1),
    arm: z.string().min(1),
    replicate: z.number().int().nonnegative(),
    measurementEpoch: z.string().min(1),
    capsuleId: z.string().min(1),
    capsuleDigest: Digest,
    sourceArtifact: Digest,
    bundleDigest: Digest,
    requestedModel: z.string().min(1),
    innerEpisodesMax: z.number().int().positive(),
    campaignConfigHash: Digest.nullable(),
  }).strict(),
}).strict();
export type PreAuthorityRefusalBreadcrumbV1 = z.infer<typeof PreAuthorityRefusalBreadcrumbV1>;
export type PreAuthorityRefusalBreadcrumbInput = Omit<PreAuthorityRefusalBreadcrumbV1, "version" | "recordedAt">;

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Retain only bounded, printable diagnostic tail bytes from the child CmdIo. */
export function extendPreAuthorityStderrTail(current: string, line: string): string {
  const next = `${line.replace(CONTROL_CHARS, "�")}\n`;
  if (next.length >= PRE_AUTHORITY_STDERR_TAIL_CHARS) return next.slice(-PRE_AUTHORITY_STDERR_TAIL_CHARS);
  const keep = PRE_AUTHORITY_STDERR_TAIL_CHARS - next.length;
  return `${current.slice(-keep)}${next}`;
}

export function classifyPreAuthorityRefusal(stderrTail: string): PreAuthorityRefusalReasonClass {
  if (/docker client environment diverges/i.test(stderrTail)) return "docker-client-environment-divergence";
  if (/campaign (?:admission|child admission|session|remains).*?(?:refus|violat|paus)|campaign seal violated/i.test(stderrTail)) {
    return "campaign-authority-refusal";
  }
  if (/runtime (?:pin|identity).*?(?:drift|violat|refus)|optimizer artifact seal violated|resume seal violated/i.test(stderrTail)) {
    return "runtime-seal-refusal";
  }
  if (/trusted authority recovery failed/i.test(stderrTail)) return "journal-authority-recovery-failure";
  if (/backend (?:failed|cleanup incomplete)/i.test(stderrTail)) return "backend-startup-failure";
  return "unclassified-pre-authority-exit";
}

/**
 * Append and fsync one diagnostic line. Callers must treat any write failure
 * as non-authoritative: losing a breadcrumb can never change child outcome.
 */
export function appendPreAuthorityRefusalBreadcrumb(
  campaignDir: string,
  input: PreAuthorityRefusalBreadcrumbInput,
): PreAuthorityRefusalBreadcrumbV1 {
  const record = PreAuthorityRefusalBreadcrumbV1.parse({
    version: 1,
    recordedAt: new Date().toISOString(),
    ...input,
  });
  const path = join(campaignDir, PRE_AUTHORITY_BREADCRUMB_FILE);
  const fd = openSync(path, "a+", 0o600);
  try {
    repairTornTail(fd);
    writeAllSync(fd, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  syncDir(campaignDir);
  return record;
}
