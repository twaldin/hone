import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  M2AuthorizedPartialCohort,
  canonicalJson,
  type AdmissionApprovalBasis,
  type M2AuthorizedAdmittedCapsule,
  type M2AuthorizedPartialCohort as AuthorizedPartialCohort,
  type M2CohortEvidencePointer,
} from "@hone/schema";
import { UsageError } from "./args.js";
import { resolveRepoPath, type CapsulePaths } from "./capsules-root.js";

/**
 * Match a Gate-2 receipt to the authority frozen for this admitted identity.
 * The original cohort inherits its one cohort-wide ruling; later re-admissions
 * carry their exact owner approval basis on the individual binding.
 */
export function gate2ReceiptCitesAuthorizedBasis(
  cohort: AuthorizedPartialCohort,
  capsule: M2AuthorizedAdmittedCapsule,
  basis: AdmissionApprovalBasis | undefined,
): boolean {
  if (basis === undefined) return false;
  if (capsule.gate2Authorization !== undefined) {
    return canonicalJson(basis) === canonicalJson(capsule.gate2Authorization);
  }
  return basis.authorizationKey === cohort.authorization.decisionKey
    && basis.authorizedBy.identity === cohort.authorization.owner.identity
    && basis.authorizedBy.kind === cohort.authorization.owner.kind
    && basis.authorizedAt === cohort.authorization.decidedAt
    && basis.deliveredVia === cohort.authorization.deliveredVia;
}


function verifyEvidencePointer(paths: CapsulePaths, pointer: M2CohortEvidencePointer): void {
  const pathname = resolveRepoPath(paths, pointer.path);
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

/**
 * Parse the exact 21+6 owner record and verify every cited repository byte.
 * `capsules/...` evidence resolves inside the capsules root; other paths
 * resolve against the state root.
 */
export function verifyM2AuthorizedPartialCohort(
  paths: CapsulePaths,
  input: unknown,
): AuthorizedPartialCohort {
  const cohort = M2AuthorizedPartialCohort.parse(input);
  for (const pointer of cohort.authorization.evidence) verifyEvidencePointer(paths, pointer);
  for (const deferred of cohort.deferred) {
    for (const pointer of deferred.evidence) verifyEvidencePointer(paths, pointer);
  }
  return cohort;
}
