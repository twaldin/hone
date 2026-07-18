import { z } from "zod";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ResourceUsage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().finite().nonnegative(),
  wallClockSec: z.number().finite().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
}).strict();

/** One trusted observation on an inner or outer anytime curve. */
export const AnytimeSearchPointV1 = z.object({
  ordinal: z.number().int().nonnegative(),
  eventCursor: z.number().int().nonnegative(),
  episode: z.number().int().nonnegative().nullable(),
  candidateArtifact: SHA256.nullable(),
  status: z.enum(["evaluated", "invalid"]),
  score: z.number().finite().nullable(),
  bestScore: z.number().finite().nullable(),
  cached: z.boolean().nullable(),
  spent: ResourceUsage,
}).strict();
export type AnytimeSearchPointV1 = z.infer<typeof AnytimeSearchPointV1>;

export const MetaChildTrajectoryV1 = z.object({
  workKey: SHA256,
  childRunId: z.string().min(1),
  sourceArtifact: SHA256,
  capsuleId: z.string().min(1),
  replicate: z.number().int().nonnegative(),
  measurementEpoch: z.string().min(1),
  status: z.enum(["completed", "budget", "candidate_failed", "infrastructure_not_run"]),
  qRaw: z.number().finite().nullable(),
  qBase: z.number().finite().nullable(),
  scale: z.number().finite().positive().nullable(),
  qNormalized: z.number().finite().nullable(),
  observed: ResourceUsage,
  evidenceHash: SHA256,
  eventLogHash: SHA256.nullable(),
  points: z.array(AnytimeSearchPointV1),
}).strict();
export type MetaChildTrajectoryV1 = z.infer<typeof MetaChildTrajectoryV1>;

export const MetaOuterTrajectoryPointV1 = AnytimeSearchPointV1.extend({
  perCapsule: z.record(z.number().finite().nullable()),
  childRunIds: z.array(z.string().min(1)),
  evaluationSpent: ResourceUsage,
  cumulativeEvaluationSpent: ResourceUsage,
}).strict();
export type MetaOuterTrajectoryPointV1 = z.infer<typeof MetaOuterTrajectoryPointV1>;

/**
 * Contract 7 — complete trusted search trajectory for one meta outer run.
 *
 * Controller spend and nested child-evaluation spend remain separate so an
 * analysis cannot silently trade one resource class for the other. Every
 * evaluated or invalid outer attempt and every inner child curve is retained.
 */
export const MetaSearchTrajectoryV1 = z.object({
  version: z.literal(1),
  configHash: SHA256,
  outerRunId: z.string().min(1),
  controllerBundleDigest: SHA256,
  targetSourceArtifact: SHA256,
  targetBundleDigest: SHA256,
  createdAt: z.string().datetime(),
  outerEventLogHash: SHA256,
  points: z.array(MetaOuterTrajectoryPointV1).min(1),
  children: z.array(MetaChildTrajectoryV1),
}).strict();
export type MetaSearchTrajectoryV1 = z.infer<typeof MetaSearchTrajectoryV1>;
