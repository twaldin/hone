import {
  MetaChildTrajectoryV1 as MetaChildTrajectoryV1Schema,
  MetaOuterTrajectoryPointV2 as MetaOuterTrajectoryPointV2Schema,
  type MetaChildTrajectoryV1,
  type MetaOuterTrajectoryPointV2,
} from "@hone/schema";
import { z } from "zod";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ResourceUsage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().finite().nonnegative(),
  wallClockSec: z.number().finite().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
}).strict();
const CandidateEvent = z.object({
  candidateOrdinal: z.number().int().nonnegative(),
  eventCursor: z.number().int().nonnegative(),
  candidateArtifact: SHA256.nullable(),
  childRunIds: z.array(z.string().min(1)),
  controllerSpent: ResourceUsage,
}).strict();

export interface TrustedMetaCandidateEvent {
  readonly candidateOrdinal: number;
  readonly eventCursor: number;
  readonly candidateArtifact: `sha256:${string}` | null;
  readonly childRunIds: readonly string[];
  readonly controllerSpent: {
    readonly tokens: number;
    readonly usd: number;
    readonly wallClockSec: number;
    readonly evaluatorInvocations: number;
  };
}

/**
 * Derives the complete series from trusted candidate-admission events and
 * authenticated child rows. Event cursor order controls chronology; j must be
 * the complete 0..terminal ordinal mapping, so an event cannot be reordered,
 * duplicated, or omitted without failing closed.
 */
export function buildMetaCandidateTrajectoryPoints(
  expectedCapsuleIdsInput: readonly string[],
  eventsInput: readonly TrustedMetaCandidateEvent[],
  childrenInput: readonly MetaChildTrajectoryV1[],
  terminalCandidateOrdinalInput: number,
): MetaOuterTrajectoryPointV2[] {
  const expectedCapsuleIds = z.array(z.string().regex(/^cap_[0-9a-f]{12}$/)).length(8).parse(expectedCapsuleIdsInput);
  if (new Set(expectedCapsuleIds).size !== expectedCapsuleIds.length) {
    throw new Error("trajectory panel requires eight distinct capsule identities");
  }
  const terminalCandidateOrdinal = z.number().int().nonnegative().parse(terminalCandidateOrdinalInput);
  const events = eventsInput.map((event) => CandidateEvent.parse(event));
  events.sort((left, right) => left.eventCursor - right.eventCursor);
  if (events.length !== terminalCandidateOrdinal + 1) {
    throw new Error(
      `candidate event stream is incomplete: expected ${terminalCandidateOrdinal + 1}, got ${events.length}`,
    );
  }

  const children = childrenInput.map((child) => MetaChildTrajectoryV1Schema.parse(child));
  const childById = new Map<string, MetaChildTrajectoryV1>();
  for (const child of children) {
    if (childById.has(child.childRunId)) {
      throw new Error(`authenticated child ${child.childRunId} is duplicated`);
    }
    childById.set(child.childRunId, child);
  }
  const attributedChildren = new Set<string>();
  let bestSoFarPanelMean: number | null = null;
  const cumulativeSpent = { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
  const resourceDimensions = ["tokens", "usd", "wallClockSec", "evaluatorInvocations"] as const;

  const points = events.map((event, index) => {
    if (event.candidateOrdinal !== index) {
      throw new Error(
        `candidate cursor ${event.eventCursor} maps to ordinal ${event.candidateOrdinal}; expected ${index}`,
      );
    }
    if (index > 0 && event.eventCursor <= events[index - 1]!.eventCursor) {
      throw new Error(`candidate event cursor ${event.eventCursor} is duplicated`);
    }
    const eventChildren = event.childRunIds.map((childRunId) => {
      if (attributedChildren.has(childRunId)) {
        throw new Error(`authenticated child ${childRunId} is attributed more than once`);
      }
      const child = childById.get(childRunId);
      if (child === undefined) throw new Error(`candidate ${event.candidateOrdinal} references missing child ${childRunId}`);
      attributedChildren.add(childRunId);
      if (event.candidateArtifact === null || child.sourceArtifact !== event.candidateArtifact) {
        throw new Error(`candidate ${event.candidateOrdinal} does not bind child ${childRunId}`);
      }
      if (!expectedCapsuleIds.includes(child.capsuleId)) {
        throw new Error(`candidate ${event.candidateOrdinal} child ${childRunId} is outside the panel`);
      }
      return child;
    });

    const perCapsule = expectedCapsuleIds.map((capsuleId) => {
      const scores = eventChildren
        .filter((child) => child.capsuleId === capsuleId && child.status === "completed")
        .map((child) => child.qNormalized)
        .filter((score): score is number => score !== null);
      return {
        capsuleId,
        normalizedScore:
          scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
      };
    });
    const valid =
      event.candidateArtifact !== null &&
      eventChildren.length === event.childRunIds.length &&
      eventChildren.every(
        (child) =>
          child.status === "completed" &&
          child.qNormalized !== null &&
          child.sourceArtifact === event.candidateArtifact,
      ) &&
      perCapsule.every((row) => row.normalizedScore !== null);
    const panelMean = valid
      ? perCapsule.reduce((sum, row) => sum + (row.normalizedScore ?? 0), 0) / perCapsule.length
      : null;
    if (panelMean !== null) {
      bestSoFarPanelMean = bestSoFarPanelMean === null
        ? panelMean
        : Math.max(bestSoFarPanelMean, panelMean);
    }

    const evaluationSpent = { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
    for (const child of eventChildren) {
      for (const dimension of resourceDimensions) {
        evaluationSpent[dimension] += child.observed[dimension];
      }
    }
    const spent = {
      tokens: event.controllerSpent.tokens + evaluationSpent.tokens,
      usd: event.controllerSpent.usd + evaluationSpent.usd,
      wallClockSec: event.controllerSpent.wallClockSec + evaluationSpent.wallClockSec,
      evaluatorInvocations:
        event.controllerSpent.evaluatorInvocations + evaluationSpent.evaluatorInvocations,
    };
    for (const dimension of resourceDimensions) {
      cumulativeSpent[dimension] += spent[dimension];
    }

    return MetaOuterTrajectoryPointV2Schema.parse({
      candidateOrdinal: event.candidateOrdinal,
      eventCursor: event.eventCursor,
      candidateArtifact: event.candidateArtifact,
      childRunIds: event.childRunIds,
      valid,
      perCapsule,
      panelMean,
      controllerSpent: event.controllerSpent,
      evaluationSpent,
      spent,
      cumulativeSpent: { ...cumulativeSpent },
      bestSoFarPanelMean,
    });
  });

  const omitted = children.find((child) => !attributedChildren.has(child.childRunId));
  if (omitted !== undefined) {
    throw new Error(`authenticated child ${omitted.childRunId} is omitted from candidate events`);
  }
  return points;
}
