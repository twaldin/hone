import {
  MetaOuterTrajectoryPointV2 as MetaOuterTrajectoryPointV2Schema,
  type MetaOuterTrajectoryPointV2,
} from "@hone/schema";
import { z } from "zod";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CapsuleScoreEvent = z.object({
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  normalizedScore: z.number().finite().nullable(),
}).strict();
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
  valid: z.boolean(),
  perCapsule: z.array(CapsuleScoreEvent).max(8),
  spent: ResourceUsage,
}).strict();

export interface TrustedMetaCandidateEvent {
  readonly candidateOrdinal: number;
  readonly eventCursor: number;
  readonly candidateArtifact: `sha256:${string}` | null;
  readonly valid: boolean;
  readonly perCapsule: readonly {
    readonly capsuleId: string;
    readonly normalizedScore: number | null;
  }[];
  readonly spent: {
    readonly tokens: number;
    readonly usd: number;
    readonly wallClockSec: number;
    readonly evaluatorInvocations: number;
  };
}

/**
 * Canonicalizes unordered candidate events into the complete trusted anytime
 * series. Candidate ordinal j, not array arrival order, determines cumulative
 * spend and best-so-far state. Invalid/partial candidates still consume spend.
 */
export function buildMetaCandidateTrajectoryPoints(
  expectedCapsuleIdsInput: readonly string[],
  eventsInput: readonly TrustedMetaCandidateEvent[],
): MetaOuterTrajectoryPointV2[] {
  const expectedCapsuleIds = z.array(z.string().regex(/^cap_[0-9a-f]{12}$/)).length(8).parse(expectedCapsuleIdsInput);
  if (new Set(expectedCapsuleIds).size !== expectedCapsuleIds.length) {
    throw new Error("trajectory panel requires eight distinct capsule identities");
  }
  const events = eventsInput.map((event) => CandidateEvent.parse(event));
  events.sort((left, right) => left.candidateOrdinal - right.candidateOrdinal);

  let bestSoFarPanelMean: number | null = null;
  const cumulativeSpent = { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
  return events.map((event, index) => {
    if (index > 0 && event.candidateOrdinal === events[index - 1]!.candidateOrdinal) {
      throw new Error(`duplicate candidate ordinal ${event.candidateOrdinal}`);
    }
    const scores = new Map<string, number | null>();
    for (const row of event.perCapsule) {
      if (!expectedCapsuleIds.includes(row.capsuleId)) {
        throw new Error(`candidate ${event.candidateOrdinal} names non-panel capsule ${row.capsuleId}`);
      }
      if (scores.has(row.capsuleId)) {
        throw new Error(`candidate ${event.candidateOrdinal} duplicates capsule ${row.capsuleId}`);
      }
      scores.set(row.capsuleId, row.normalizedScore);
    }
    const perCapsule = expectedCapsuleIds.map((capsuleId) => ({
      capsuleId,
      normalizedScore: scores.get(capsuleId) ?? null,
    }));
    const valid = event.valid && perCapsule.every((row) => row.normalizedScore !== null);
    const panelMean = valid
      ? perCapsule.reduce((sum, row) => sum + (row.normalizedScore ?? 0), 0) / perCapsule.length
      : null;
    if (panelMean !== null) {
      bestSoFarPanelMean = bestSoFarPanelMean === null
        ? panelMean
        : Math.max(bestSoFarPanelMean, panelMean);
    }
    cumulativeSpent.tokens += event.spent.tokens;
    cumulativeSpent.usd += event.spent.usd;
    cumulativeSpent.wallClockSec += event.spent.wallClockSec;
    cumulativeSpent.evaluatorInvocations += event.spent.evaluatorInvocations;

    return MetaOuterTrajectoryPointV2Schema.parse({
      candidateOrdinal: event.candidateOrdinal,
      eventCursor: event.eventCursor,
      candidateArtifact: event.candidateArtifact,
      valid,
      perCapsule,
      panelMean,
      spent: event.spent,
      cumulativeSpent: { ...cumulativeSpent },
      bestSoFarPanelMean,
    });
  });
}
