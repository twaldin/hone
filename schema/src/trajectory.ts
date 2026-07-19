import { z } from "zod";
import {
  M2DevelopmentPanel,
  M2EnvelopeIdentity,
  M2PanelAggregation,
  M2PanelAggregationShape,
} from "./meta.js";

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

const MetaOuterTrajectoryPointV2Shape = M2PanelAggregationShape.extend({
  /** Trusted admission ordinal j; the complete trajectory requires 0..n without gaps. */
  candidateOrdinal: z.number().int().nonnegative(),
  eventCursor: z.number().int().nonnegative(),
  candidateArtifact: SHA256.nullable(),
  /** Exact authenticated child rows attributed to this candidate event. */
  childRunIds: z.array(z.string().min(1)),
  controllerSpent: ResourceUsage,
  evaluationSpent: ResourceUsage,
  /** Incremental controller + authenticated descendant spend. */
  spent: ResourceUsage,
  cumulativeSpent: ResourceUsage,
  bestSoFarPanelMean: z.number().finite().nullable(),
}).strict();

export const MetaOuterTrajectoryPointV2 = MetaOuterTrajectoryPointV2Shape.superRefine(
  (point, ctx) => {
    const aggregation = M2PanelAggregation.safeParse({
      valid: point.valid,
      perCapsule: point.perCapsule,
      panelMean: point.panelMean,
    });
    if (!aggregation.success) {
      for (const issue of aggregation.error.issues) {
        ctx.addIssue({ ...issue, path: issue.path });
      }
    }
  },
);
export type MetaOuterTrajectoryPointV2 = z.infer<typeof MetaOuterTrajectoryPointV2>;

const MetaSearchTrajectoryV2Shape = z.object({
  version: z.literal(2),
  configHash: SHA256,
  outerRunId: z.string().min(1),
  searchEnvelope: M2EnvelopeIdentity.extend({ purpose: z.literal("search") }).strict(),
  panel: M2DevelopmentPanel,
  controllerBundleDigest: SHA256,
  targetSourceArtifact: SHA256,
  targetBundleDigest: SHA256,
  createdAt: z.string().datetime(),
  outerEventLogHash: SHA256,
  points: z.array(MetaOuterTrajectoryPointV2).min(1),
  children: z.array(MetaChildTrajectoryV1),
}).strict();

/**
 * Complete M2 outer evidence. Points are canonicalized by candidate ordinal;
 * cumulative spend and incumbent means are checked rather than trusted.
 */
export const MetaSearchTrajectoryV2 = MetaSearchTrajectoryV2Shape.superRefine((trajectory, ctx) => {
  let best: number | null = null;
  let cumulative = { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
  const resourceDimensions = ["tokens", "usd", "wallClockSec", "evaluatorInvocations"] as const;
  const panelOrder = trajectory.panel.members.map((member) => member.capsule.capsuleId);
  const panelIds = new Set(panelOrder);
  const childById = new Map<string, MetaChildTrajectoryV1>();
  trajectory.children.forEach((child, index) => {
    if (childById.has(child.childRunId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["children", index, "childRunId"],
        message: "child run is duplicated in trajectory evidence",
      });
    } else {
      childById.set(child.childRunId, child);
    }
  });
  const referencedChildren = new Set<string>();

  trajectory.points.forEach((point, index) => {
    if (point.candidateOrdinal !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "candidateOrdinal"],
        message: `complete candidate evidence requires ordinal ${index}`,
      });
    }
    if (index > 0 && point.eventCursor <= trajectory.points[index - 1]!.eventCursor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "eventCursor"],
        message: "candidate event cursors must be strictly increasing",
      });
    }

    const pointIds = new Set(point.perCapsule.map((row) => row.capsuleId));
    if (pointIds.size !== panelIds.size || [...panelIds].some((capsuleId) => !pointIds.has(capsuleId))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "perCapsule"],
        message: "candidate scores must use the exact frozen development panel",
      });
    }

    const children: MetaChildTrajectoryV1[] = [];
    point.childRunIds.forEach((childRunId, childIndex) => {
      const child = childById.get(childRunId);
      if (child === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "childRunIds", childIndex],
          message: "candidate references a missing authenticated child",
        });
        return;
      }
      if (referencedChildren.has(childRunId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "childRunIds", childIndex],
          message: "authenticated child may be attributed to only one candidate event",
        });
      }
      referencedChildren.add(childRunId);
      children.push(child);
      if (point.candidateArtifact === null || child.sourceArtifact !== point.candidateArtifact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "candidateArtifact"],
          message: "candidate artifact must bind every attributed child",
        });
      }
      if (!panelIds.has(child.capsuleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "childRunIds", childIndex],
          message: "candidate child is outside the frozen development panel",
        });
      }
    });

    const evaluationSpent = { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 };
    for (const child of children) {
      for (const dimension of resourceDimensions) {
        evaluationSpent[dimension] += child.observed[dimension];
      }
    }
    for (const dimension of resourceDimensions) {
      if (point.evaluationSpent[dimension] !== evaluationSpent[dimension]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "evaluationSpent", dimension],
          message: `evaluation ${dimension} must equal authenticated child spend ${evaluationSpent[dimension]}`,
        });
      }
      const expectedSpent = point.controllerSpent[dimension] + evaluationSpent[dimension];
      if (point.spent[dimension] !== expectedSpent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "spent", dimension],
          message: `candidate ${dimension} must equal controller plus authenticated child spend ${expectedSpent}`,
        });
      }
    }

    const scoreByCapsule = new Map<string, number | null>();
    for (const capsuleId of panelOrder) {
      const scores = children
        .filter((child) => child.capsuleId === capsuleId && child.status === "completed")
        .map((child) => child.qNormalized)
        .filter((score): score is number => score !== null);
      scoreByCapsule.set(
        capsuleId,
        scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
      );
    }
    point.perCapsule.forEach((row, scoreIndex) => {
      const expectedScore = scoreByCapsule.get(row.capsuleId) ?? null;
      if (row.normalizedScore !== expectedScore) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "perCapsule", scoreIndex, "normalizedScore"],
          message: `normalized score must equal authenticated child aggregation ${expectedScore}`,
        });
      }
    });
    const expectedValid =
      point.candidateArtifact !== null &&
      children.length === point.childRunIds.length &&
      children.every(
        (child) =>
          panelIds.has(child.capsuleId) &&
          child.sourceArtifact === point.candidateArtifact &&
          child.status === "completed" &&
          child.qNormalized !== null,
      ) &&
      panelOrder.every((capsuleId) =>
        children.some(
          (child) =>
            child.capsuleId === capsuleId &&
            child.status === "completed" &&
            child.qNormalized !== null,
        ),
      );
    if (point.valid !== expectedValid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "valid"],
        message: `candidate validity must equal authenticated panel completeness ${expectedValid}`,
      });
    }

    cumulative = {
      tokens: cumulative.tokens + point.spent.tokens,
      usd: cumulative.usd + point.spent.usd,
      wallClockSec: cumulative.wallClockSec + point.spent.wallClockSec,
      evaluatorInvocations: cumulative.evaluatorInvocations + point.spent.evaluatorInvocations,
    };
    for (const dimension of resourceDimensions) {
      if (point.cumulativeSpent[dimension] !== cumulative[dimension]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", index, "cumulativeSpent", dimension],
          message: `cumulative ${dimension} does not equal trusted event sum ${cumulative[dimension]}`,
        });
      }
    }
    if (point.valid && point.panelMean !== null) {
      best = best === null ? point.panelMean : Math.max(best, point.panelMean);
    }
    if (point.bestSoFarPanelMean !== best) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "bestSoFarPanelMean"],
        message: `best-so-far panel mean must equal ${best === null ? "null" : best}`,
      });
    }
  });

  trajectory.children.forEach((child, index) => {
    if (!referencedChildren.has(child.childRunId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["children", index, "childRunId"],
        message: "authenticated child is omitted from candidate trajectory evidence",
      });
    }
  });
});
export type MetaSearchTrajectoryV2 = z.infer<typeof MetaSearchTrajectoryV2>;
