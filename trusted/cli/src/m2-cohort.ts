import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  M2AuthorizedPartialCohort,
  type M2AuthorizedPartialCohort as AuthorizedPartialCohort,
  type M2CohortEvidencePointer,
} from "@hone/schema";
import { UsageError } from "./args.js";

export const M2_AUTHORIZED_PARTIAL_COHORT_FILE = "plans/m2-authorized-partial-cohort.v1.json";

function verifyEvidencePointer(root: string, pointer: M2CohortEvidencePointer): void {
  const pathname = resolve(root, pointer.path);
  let content: Buffer;
  try {
    content = readFileSync(pathname);
  } catch (error) {
    throw new UsageError(
      `authorized partial cohort evidence ${pointer.path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== pointer.digest) {
    throw new UsageError(
      `authorized partial cohort evidence ${pointer.path} drifted: ${digest} != ${pointer.digest}`,
    );
  }
}

/** Parse the exact 21+6 owner record and verify every cited repository byte. */
export function verifyM2AuthorizedPartialCohort(
  root: string,
  input: unknown,
): AuthorizedPartialCohort {
  const cohort = M2AuthorizedPartialCohort.parse(input);
  for (const pointer of cohort.authorization.evidence) verifyEvidencePointer(root, pointer);
  for (const deferred of cohort.deferred) {
    for (const pointer of deferred.evidence) verifyEvidencePointer(root, pointer);
  }
  return cohort;
}

/** Load the committed, owner-authorized M2 partial-cohort record. */
export function readM2AuthorizedPartialCohort(
  root: string,
  pathname = join(root, M2_AUTHORIZED_PARTIAL_COHORT_FILE),
): AuthorizedPartialCohort {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(pathname, "utf8"));
  } catch (error) {
    throw new UsageError(
      `authorized partial cohort record ${pathname} is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return verifyM2AuthorizedPartialCohort(root, input);
}
