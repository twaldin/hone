import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetEnvelope, IMAGE_DIGEST_REF } from "./capsule.js";
import { M2_INNER_MODEL_ROUTE, M2_OUTER_MODEL_ROUTE } from "./proxy.js";
import { canonicalJson } from "./canonical.js";
import { PromotionRule } from "./runconfig.js";

/**
 * Contract 6 — M1 meta-campaign config (WP-M1-0).
 *
 * One canonical, versioned config determines the complete official `hone
 * "hone"` campaign: corpus, normalization, identities, routing, budgets,
 * replication, controls, promotion, and claim boundary. The trusted runtime
 * freezes the canonical hash of this document before the first outer
 * candidate is generated; resume accepts only that hash. This is a NEW
 * contract — RunConfig (v1) and CapsuleManifest (v2) are unchanged.
 */

export const META_CAMPAIGN_CONFIG_VERSION = 1;

/** Frozen M1 protocol cardinalities (plan §§3, 5, 8). */
export const M1_TRAIN_CAPSULE_COUNT = 5;
export const M1_HOLDOUT_CAPSULE_COUNT = 2;
/** Confirmation arms: seed, selected winner, broken control, degraded control. */
export const M1_CONFIRMATION_ARMS = 4;
/** Holdout arms: seed and winner only, one terminal phase. */
export const M1_HOLDOUT_ARMS = 2;
/** Requested + executed route for BOTH outer and inner mutation roles in M1. */
export const M1_MODEL_ROUTE = "gpt-5.6-sol";
/** Frozen claim key for the exact M1 corpus and protocol. */
export const M1_ALLOWED_CLAIM = "directional-reversible-frozen-corpus";

const SHA256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const GIT_COMMIT = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * One registered corpus entry. Everything the trusted meta-runner needs to
 * normalize a child run is frozen here BEFORE any outer search:
 * Y_ir = (q_i(A_ir) - qBase) / scale, with scale = qReference - qBase > 0.
 */
export const MetaCapsuleEntry = z.object({
  /** Human handle; must match the pinned manifest. */
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  /** Full-strength canonical-manifest digest (the integrity anchor). */
  capsuleDigest: SHA256,
  /** Immutable OCI image ref pinned by digest — never a mutable tag. */
  image: z.string().regex(IMAGE_DIGEST_REF),
  /** Digest of the frozen case-level oracle assets. */
  oracleDigest: SHA256,
  /** Digest of the frozen scalarizer producing the single oriented q_i. */
  scalarizerDigest: SHA256,
  /** q_i for invalid output or a failed required constraint (normally 0). */
  qFail: z.number().finite().min(0).max(1),
  /** Trusted baseline measurement q_i(base). */
  qBase: z.number().finite().min(0).max(1),
  /** Trusted reference measurement q_i(ref). */
  qReference: z.number().finite().min(0).max(1),
  /** Registered scale s_i; MUST equal qReference - qBase and be > 0. */
  scale: z.number().finite().positive(),
});
export type MetaCapsuleEntry = z.infer<typeof MetaCapsuleEntry>;

/**
 * Model identity is an OBSERVATION policy, not a trust assumption: record the
 * requested route, response `model`, provider fingerprint when supplied, and
 * run start/end drift sentinels. Without provider attestation the identity is
 * an alias observation — never call it a snapshot.
 */
export const ModelObservationPolicy = z.object({
  requestedRoute: z.literal(M1_MODEL_ROUTE),
  identity: z.enum(["alias-observation", "provider-snapshot"]),
  recordResponseModel: z.literal(true),
  recordProviderFingerprint: z.literal(true),
  driftSentinel: z.literal(true),
});
export type ModelObservationPolicy = z.infer<typeof ModelObservationPolicy>;

/**
 * Campaign cardinalities. `candidates` counts unique source artifacts admitted
 * to search, including the seed. `candidateAttemptsMax` separately bounds
 * non-seed outer mutation attempts, including invalid or duplicate attempts.
 * Literals encode the rest of the frozen M1 replication design.
 */
export const MetaCampaignCounts = z.object({
  /** Total unique optimizer source artifacts, including seed; official M1 uses 20. */
  candidates: z.number().int().min(20).max(30),
  /** Maximum outer non-seed mutation attempts; bounded against candidates below. */
  candidateAttemptsMax: z.number().int(),
  /** Inner mutation episodes per child run; written range 8–12, official 8. */
  innerEpisodesMax: z.number().int().min(8).max(12),
  /** One complete inner run per candidate × train capsule. No search funnel. */
  searchReplicates: z.literal(1),
  /** Seed/winner/broken/degraded each: 3 complete runs per train capsule. */
  confirmationReplicates: z.literal(3),
  /** Seed/winner each: 3 complete runs per holdout capsule, one phase. */
  holdoutReplicates: z.literal(3),
  /** Concurrent child runs. */
  childConcurrency: z.number().int().positive(),
});
export type MetaCampaignCounts = z.infer<typeof MetaCampaignCounts>;

/**
 * Fixed four-dimensional budgets. `child` is one admitted unique candidate's
 * child-run slice (identical for search/confirmation/holdout children);
 * `outer` covers generation of at most `candidateAttemptsMax` non-seed
 * mutation attempts; `campaign` must reserve, COMPONENTWISE, outer plus every
 * admitted child slice — so aggregate spend cannot exceed the cap even when
 * child accounting reconciles late. Never collapse the vector to a scalar.
 */
export const MetaCampaignBudgets = z.object({
  campaign: BudgetEnvelope,
  outer: BudgetEnvelope,
  child: BudgetEnvelope,
});
export type MetaCampaignBudgets = z.infer<typeof MetaCampaignBudgets>;

/**
 * Non-negotiable M1 invariants, encoded as literals so any relaxation is a
 * schema (i.e. protocol) change, not a config value: delivery stays
 * `apply: none` through selection and holdout, holdouts are accessed in
 * exactly one terminal phase, and no holdout byte or score ever reaches the
 * outer optimizer's feedback or search coordinates.
 */
export const MetaCampaignInvariants = z.object({
  apply: z.literal("none"),
  terminalHoldoutPhases: z.literal(1),
  holdoutFeedbackToOptimizer: z.literal(false),
  holdoutSearchEligible: z.literal(false),
});
export type MetaCampaignInvariants = z.infer<typeof MetaCampaignInvariants>;

const BUDGET_DIMENSIONS = [
  "maxTokens",
  "maxUsd",
  "maxWallClockSec",
  "maxEvaluatorInvocations",
] as const;

const normalizePath = (p: string) => p.replace(/^\.\//, "").replace(/\/+$/, "");
const pathsOverlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

const MetaCampaignConfigShape = z.object({
  version: z.literal(META_CAMPAIGN_CONFIG_VERSION),
  /** Outer objective, verbatim (frozen; never paraphrased by tooling). */
  objective: z.string().min(1),
  /**
   * Seed optimizer identity: pinned source commit, canonical candidate CAS tar
   * digest, and the image-bound sealed bundle digest built from that source.
   */
  seedOptimizer: z.object({
    sourceCommit: GIT_COMMIT,
    sourceArtifact: SHA256,
    bundleDigest: SHA256,
  }),
  /** Trusted runtime identity the campaign runs under. */
  trustedRuntime: z.object({
    sourceCommit: GIT_COMMIT,
    digest: SHA256,
  }),
  /**
   * Immutable allowlist of optimizer paths candidates may edit. Everything
   * else — broker client, package/lock/build files, entrypoint, tests,
   * schema, trusted code, capsules — is protected.
   */
  mutablePaths: z.array(z.string().min(1)).min(1),
  /** Protected paths; may not intersect mutablePaths (either direction). */
  protectedPaths: z.array(z.string().min(1)),
  /** Ordered train partition — exactly M1_TRAIN_CAPSULE_COUNT entries. */
  train: z.array(MetaCapsuleEntry),
  /** Ordered holdout partition — exactly M1_HOLDOUT_CAPSULE_COUNT entries. */
  holdout: z.array(MetaCapsuleEntry),
  /** Requested model per mutation role; both roles fixed to one route in M1, per-role frozen routes in M2. */
  routing: z.object({
    outerMutation: z.string().min(1),
    innerMutation: z.string().min(1),
  }),
  modelObservation: ModelObservationPolicy,
  counts: MetaCampaignCounts,
  budgets: MetaCampaignBudgets,
  /** Exact canonical-source + image-bound-bundle pairs for both real controls. */
  controls: z
    .object({
      brokenSourceArtifact: SHA256,
      brokenBundleDigest: SHA256,
      degradedSourceArtifact: SHA256,
      degradedBundleDigest: SHA256,
    })
    .strict(),
  /** Pre-registered promotion rule — no default: registration is explicit. */
  promotion: PromotionRule,
  /**
   * Namespace for trusted measurement epochs. Memoization may deduplicate
   * within one child run; it must never turn a requested full-run replicate
   * into replayed output from an earlier run.
   */
  measurementEpochNamespace: z.string().min(1),
  /** Frozen claim key for this exact corpus and protocol. */
  allowedClaim: z.literal(M1_ALLOWED_CLAIM),
  /** Hash of the frozen campaign protocol document. */
  protocolHash: SHA256,
  /** Hash of the frozen analysis configuration. */
  analysisConfigHash: SHA256,
  invariants: MetaCampaignInvariants,
});

export const MetaCampaignConfigV1 = MetaCampaignConfigShape.superRefine(
  (cfg, ctx) => {
    if (cfg.train.length !== M1_TRAIN_CAPSULE_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["train"],
        message: `M1 requires exactly ${M1_TRAIN_CAPSULE_COUNT} train capsules, got ${cfg.train.length}`,
      });
    }
    if (cfg.holdout.length !== M1_HOLDOUT_CAPSULE_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["holdout"],
        message: `M1 requires exactly ${M1_HOLDOUT_CAPSULE_COUNT} holdout capsules, got ${cfg.holdout.length}`,
      });
    }

    // Global corpus uniqueness: a capsule may appear once, in one partition.
    const seenDigests = new Map<string, string>();
    const seenIds = new Map<string, string>();
    const partitions: ReadonlyArray<readonly [string, ReadonlyArray<MetaCapsuleEntry>]> = [
      ["train", cfg.train],
      ["holdout", cfg.holdout],
    ];
    for (const [partition, entries] of partitions) {
      entries.forEach((entry, i) => {
        const digestAt = seenDigests.get(entry.capsuleDigest);
        if (digestAt !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [partition, i, "capsuleDigest"],
            message: `capsule digest already registered at ${digestAt}`,
          });
        } else {
          seenDigests.set(entry.capsuleDigest, `${partition}[${i}]`);
        }
        const idAt = seenIds.get(entry.capsuleId);
        if (idAt !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [partition, i, "capsuleId"],
            message: `capsule id already registered at ${idAt}`,
          });
        } else {
          seenIds.set(entry.capsuleId, `${partition}[${i}]`);
        }

        if (entry.qFail > entry.qBase) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [partition, i, "qFail"],
            message: `qFail must be less than or equal to qBase, got ${entry.qFail} > ${entry.qBase}`,
          });
        }

        // Positive reference gap + registered scale consistency (s_i = ref - base).
        const gap = entry.qReference - entry.qBase;
        if (gap <= 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [partition, i, "qReference"],
            message: `qReference - qBase must be strictly positive, got ${gap}`,
          });
        } else if (Math.abs(entry.scale - gap) > 1e-9 * Math.max(1, Math.abs(gap))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [partition, i, "scale"],
            message: `registered scale ${entry.scale} does not equal qReference - qBase = ${gap}`,
          });
        }
      });
    }

    // Attempts are outer generation calls, not admitted search cardinality.
    // At least candidates - 1 attempts are needed to produce the non-seed
    // unique artifacts; the protocol caps retries/duplicates at 4*candidates.
    const candidateAttemptsMin = cfg.counts.candidates - 1;
    const candidateAttemptsMax = 4 * cfg.counts.candidates;
    if (cfg.counts.candidateAttemptsMax < candidateAttemptsMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counts", "candidateAttemptsMax"],
        message: `candidateAttemptsMax must be at least candidates - 1 = ${candidateAttemptsMin}`,
      });
    }
    if (cfg.counts.candidateAttemptsMax > candidateAttemptsMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["counts", "candidateAttemptsMax"],
        message: `candidateAttemptsMax must be at most 4 * candidates = ${candidateAttemptsMax}`,
      });
    }

    // Controls are real, distinct source artifacts and built bundles — neither
    // identity may alias the seed or the other control.
    if (cfg.controls.brokenSourceArtifact === cfg.controls.degradedSourceArtifact) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controls", "degradedSourceArtifact"],
        message: "broken and degraded controls must have distinct source artifacts",
      });
    }
    if (cfg.controls.brokenBundleDigest === cfg.controls.degradedBundleDigest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["controls", "degradedBundleDigest"],
        message: "broken and degraded controls must have distinct bundle digests",
      });
    }
    for (const key of ["brokenSourceArtifact", "degradedSourceArtifact"] as const) {
      if (cfg.controls[key] === cfg.seedOptimizer.sourceArtifact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controls", key],
          message: "a control source artifact must not be the seed optimizer source artifact",
        });
      }
    }
    for (const key of ["brokenBundleDigest", "degradedBundleDigest"] as const) {
      if (cfg.controls[key] === cfg.seedOptimizer.bundleDigest) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["controls", key],
          message: "a control bundle must not be the seed optimizer bundle",
        });
      }
    }

    // The mutable allowlist may not touch protected surface in either
    // direction (a mutable dir containing a protected path is still a breach).
    const protectedNorm = cfg.protectedPaths.map(normalizePath);
    cfg.mutablePaths.forEach((mutable, i) => {
      const m = normalizePath(mutable);
      const hit = protectedNorm.find((p) => pathsOverlap(m, p));
      if (hit !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mutablePaths", i],
          message: `mutable path "${mutable}" overlaps protected path "${hit}"`,
        });
      }
    });

    // One fixed route for both mutation roles, matching the observation policy.
    for (const role of ["outerMutation", "innerMutation"] as const) {
      if (cfg.routing[role] !== cfg.modelObservation.requestedRoute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["routing", role],
          message: `routing.${role} must equal modelObservation.requestedRoute ("${cfg.modelObservation.requestedRoute}")`,
        });
      }
    }

    // Componentwise campaign reservation: outer generation of at most
    // candidateAttemptsMax attempts, plus admitted unique-candidate search,
    // four-arm confirmation, and two-arm holdout child slices.
    const childRuns =
      cfg.counts.candidates * cfg.train.length * cfg.counts.searchReplicates +
      M1_CONFIRMATION_ARMS * cfg.train.length * cfg.counts.confirmationReplicates +
      M1_HOLDOUT_ARMS * cfg.holdout.length * cfg.counts.holdoutReplicates;
    for (const dim of BUDGET_DIMENSIONS) {
      const required = cfg.budgets.child[dim] * childRuns + cfg.budgets.outer[dim];
      if (cfg.budgets.campaign[dim] < required) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["budgets", "campaign", dim],
          message: `campaign ${dim} ${cfg.budgets.campaign[dim]} under-reserves ${required} (= child.${dim} × ${childRuns} child runs + outer.${dim})`,
        });
      }
    }
  },
);
export type MetaCampaignConfigV1 = z.infer<typeof MetaCampaignConfigV1>;

/** Contract 8 — one frozen trajectory cell in the recursive M2 campaign. */
export const META_CAMPAIGN_CONFIG_V2 = 2;
export const M2_PANEL_CAPSULE_COUNT = 8;
export const M2_TERMINAL_CAPSULE_COUNT = 11;
/** Search capacity is twelve complete-panel candidate equivalents, not twelve candidates. */
export const M2_SEARCH_CANDIDATE_EQUIVALENTS = 12;
/** Retained for legacy configuration readers; it is not an M2 scheduling constraint. */
export const M2_CANDIDATE_COUNT = M2_SEARCH_CANDIDATE_EQUIVALENTS;
export const M2_CANDIDATE_ATTEMPTS_MAX = 24;
export const M2_INNER_EPISODES_MAX = 4;
export const M2_ALLOWED_CLAIM = "recursive-transfer-frozen-corpus";

/**
 * M2 two-role model observation policy. The frozen contract routes outer /
 * capsule-author reasoning and inner capsule improvement to SEPARATE observed
 * routes (outer = gpt-5.6-sol, inner = gpt-5.6-terra). Requested and returned
 * model identity is recorded per role; drift fails closed. Like M1, identity
 * without provider attestation is an alias observation — never a snapshot.
 */
export const M2ModelObservationPolicy = z.object({
  outerRequestedRoute: z.literal(M2_OUTER_MODEL_ROUTE),
  innerRequestedRoute: z.literal(M2_INNER_MODEL_ROUTE),
  identity: z.enum(["alias-observation", "provider-snapshot"]),
  recordResponseModel: z.literal(true),
  recordProviderFingerprint: z.literal(true),
  driftSentinel: z.literal(true),
}).strict();
export type M2ModelObservationPolicy = z.infer<typeof M2ModelObservationPolicy>;

export const M2_PANEL_A_TASK_IDS = [
  "OWN-T01",
  "OWN-T03",
  "OWN-T06",
  "OWN-T08",
  "OSS-T01",
  "OSS-T03",
  "OSS-T05",
  "OSS-T07",
] as const;

export const M2_PANEL_B_TASK_IDS = [
  "OWN-T02",
  "OWN-T04",
  "OWN-T05",
  "OWN-T07",
  "OSS-T02",
  "OSS-T04",
  "OSS-T06",
  "OSS-T08",
] as const;

const M2_TASK_IDS = [...M2_PANEL_A_TASK_IDS, ...M2_PANEL_B_TASK_IDS] as const;
export const M2PanelTaskId = z.enum(M2_TASK_IDS);
export type M2PanelTaskId = z.infer<typeof M2PanelTaskId>;

/** Finite, safely representable M2 resource vector. */
export const M2ResourceEnvelope = z.object({
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxUsd: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxWallClockSec: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxEvaluatorInvocations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type M2ResourceEnvelope = z.infer<typeof M2ResourceEnvelope>;

const MAX_CALIBRATED_CAPSULE_COMPONENT = Number.MAX_SAFE_INTEGER /
  (M2_PANEL_CAPSULE_COUNT * M2_SEARCH_CANDIDATE_EQUIVALENTS);
const M2CalibratedCapsuleEnvelope = z.object({
  maxTokens: z.number().int().positive().max(Math.floor(MAX_CALIBRATED_CAPSULE_COMPONENT)),
  maxUsd: z.number().finite().nonnegative().max(MAX_CALIBRATED_CAPSULE_COMPONENT),
  maxWallClockSec: z.number().int().positive().max(Math.floor(MAX_CALIBRATED_CAPSULE_COMPONENT)),
  maxEvaluatorInvocations: z.number().int().positive().max(Math.floor(MAX_CALIBRATED_CAPSULE_COMPONENT)),
}).strict();

/**
 * Digest-bound saturation calibration binding carried INSIDE the frozen
 * config: the canonical-JSON digest of the trusted-recomputed ceiling report
 * plus the four designated excluded calibration capsules. Freeze revalidates
 * this block, so two distinct valid reports selecting the same ceiling are
 * still distinguishable in the frozen artifact, and the excluded capsules
 * can never be corpus members.
 */
export const M2CalibrationBinding = z.object({
  reportDigest: SHA256,
  excludedCapsuleIds: z.array(z.string().regex(/^cap_[0-9a-f]{12}$/)).length(4),
}).strict();
export type M2CalibrationBinding = z.infer<typeof M2CalibrationBinding>;

const reservedDeferredDigest = (label: string): string =>
  `sha256:${createHash("sha256").update(`hone-m2-calibration-deferred:${label}`).digest("hex")}`;

/**
 * RESERVED deferred-calibration sentinel. A draft generated before the
 * saturation report exists carries this binding, and the OFFICIAL
 * MetaCampaignConfigV2 schema (and therefore recursive freeze) REJECTS it —
 * deferred content validates only under MetaCampaignConfigV2Draft, which is
 * accepted solely inside the non-freezable m2-launch-draft wrapper.
 */
export const M2_CALIBRATION_DEFERRED_REPORT_DIGEST = reservedDeferredDigest("report");
export const M2_CALIBRATION_DEFERRED_BINDING: M2CalibrationBinding = {
  reportDigest: M2_CALIBRATION_DEFERRED_REPORT_DIGEST,
  excludedCapsuleIds: [1, 2, 3, 4].map(
    (index) => `cap_${createHash("sha256").update(`hone-m2-calibration-deferred:excluded-${index}`).digest("hex").slice(0, 12)}`,
  ),
};

/**
 * The complete frozen launch cohort, bound INTO the config from the verified
 * corpus-provenance artifact: all 16 development capsules (both panels) and
 * all 11 terminal capsules, plus the provenance self-binding digest. Freeze
 * revalidates train/holdout membership and calibration exclusion against the
 * FULL cohort — an off-panel development capsule is still a cohort member.
 */
export const M2CorpusCohort = z.object({
  developmentCapsuleIds: z.array(z.string().regex(/^cap_[0-9a-f]{12}$/)).length(16),
  terminalCapsuleIds: z.array(z.string().regex(/^cap_[0-9a-f]{12}$/)).length(M2_TERMINAL_CAPSULE_COUNT),
  /** inputsDigest of the corpus-provenance.v1 artifact these identities came from. */
  provenanceInputsDigest: SHA256,
}).strict();
export type M2CorpusCohort = z.infer<typeof M2CorpusCohort>;

export const M2PanelMember = z.object({
  taskId: M2PanelTaskId,
  capsule: MetaCapsuleEntry,
  /** Complete-run resource vector for this capsule at the frozen calibrated inner ceiling. */
  calibratedInnerCeiling: M2CalibratedCapsuleEnvelope,
}).strict();
export type M2PanelMember = z.infer<typeof M2PanelMember>;

const M2DevelopmentPanelShape = z.object({
  panel: z.enum(["A", "B"]),
  members: z.array(M2PanelMember).length(M2_PANEL_CAPSULE_COUNT),
}).strict();

/** Exact frozen Panel-A/Panel-B membership, bound to eight distinct capsule identities. */
export const M2DevelopmentPanel = M2DevelopmentPanelShape.superRefine((panel, ctx) => {
  const expected = panel.panel === "A" ? M2_PANEL_A_TASK_IDS : M2_PANEL_B_TASK_IDS;
  const expectedTasks = new Set<string>(expected);
  const seenTasks = new Set<string>();
  const seenIds = new Set<string>();
  const seenDigests = new Set<string>();
  panel.members.forEach((member, index) => {
    if (!expectedTasks.has(member.taskId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members", index, "taskId"],
        message: `${member.taskId} is not a frozen Panel-${panel.panel} task`,
      });
    }
    if (seenTasks.has(member.taskId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["members", index, "taskId"], message: "panel task is duplicated" });
    }
    if (seenIds.has(member.capsule.capsuleId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["members", index, "capsule", "capsuleId"], message: "panel capsule id is duplicated" });
    }
    if (seenDigests.has(member.capsule.capsuleDigest)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["members", index, "capsule", "capsuleDigest"], message: "panel capsule digest is duplicated" });
    }
    seenTasks.add(member.taskId);
    seenIds.add(member.capsule.capsuleId);
    seenDigests.add(member.capsule.capsuleDigest);
  });
  for (const taskId of expected) {
    if (!seenTasks.has(taskId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["members"], message: `frozen panel task ${taskId} is missing` });
    }
  }
});
export type M2DevelopmentPanel = z.infer<typeof M2DevelopmentPanel>;

export const M2CapsuleNormalizedScore = z.object({
  capsuleId: z.string().regex(/^cap_[0-9a-f]{12}$/),
  normalizedScore: z.number().finite().nullable(),
}).strict();
export type M2CapsuleNormalizedScore = z.infer<typeof M2CapsuleNormalizedScore>;

export const M2PanelAggregationShape = z.object({
  valid: z.boolean(),
  perCapsule: z.array(M2CapsuleNormalizedScore).length(M2_PANEL_CAPSULE_COUNT),
  panelMean: z.number().finite().nullable(),
}).strict();

export const M2PanelAggregation = M2PanelAggregationShape.superRefine((aggregation, ctx) => {
  const ids = new Set(aggregation.perCapsule.map((row) => row.capsuleId));
  if (ids.size !== M2_PANEL_CAPSULE_COUNT) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["perCapsule"], message: "panel scores must contain eight distinct capsule identities" });
  }
  const scores = aggregation.perCapsule.map((row) => row.normalizedScore);
  if (!aggregation.valid) {
    if (aggregation.panelMean !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["panelMean"], message: "an invalid panel cannot publish a panel mean" });
    }
    return;
  }
  if (scores.some((score) => score === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["perCapsule"], message: "a valid panel requires all eight normalized scores" });
    return;
  }
  const expected = scores.reduce<number>((sum, score) => sum + (score ?? 0), 0) / M2_PANEL_CAPSULE_COUNT;
  if (aggregation.panelMean === null || aggregation.panelMean !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["panelMean"], message: `panel mean must equal ${expected}` });
  }
});
export type M2PanelAggregation = z.infer<typeof M2PanelAggregation>;

export const M2EnvelopeIdentity = z.object({
  envelopeId: SHA256,
  purpose: z.enum(["search", "confirmation", "terminal"]),
}).strict();
export type M2EnvelopeIdentity = z.infer<typeof M2EnvelopeIdentity>;

const M2SearchEnvelope = z.object({
  identity: M2EnvelopeIdentity.extend({ purpose: z.literal("search") }).strict(),
  calibratedPanelCandidate: M2ResourceEnvelope,
  outerTrajectory: M2ResourceEnvelope,
}).strict().superRefine((search, ctx) => {
  for (const dimension of BUDGET_DIMENSIONS) {
    const candidate = search.calibratedPanelCandidate[dimension];
    const expected = candidate * M2_SEARCH_CANDIDATE_EQUIVALENTS;
    if (!Number.isFinite(expected) || expected > Number.MAX_SAFE_INTEGER || search.outerTrajectory[dimension] !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outerTrajectory", dimension],
        message: `search trajectory ${dimension} must equal ${M2_SEARCH_CANDIDATE_EQUIVALENTS} complete-panel candidate equivalents (${expected})`,
      });
    }
  }
});

const M2JudgingEnvelope = z.object({
  identity: M2EnvelopeIdentity,
  budget: M2ResourceEnvelope,
}).strict();

/** Search and fixed judging are three separately identified, non-transferable pools. */
export const M2RecursiveBudgets = z.object({
  search: M2SearchEnvelope,
  confirmation: M2JudgingEnvelope,
  terminal: M2JudgingEnvelope,
}).strict().superRefine((budgets, ctx) => {
  if (budgets.confirmation.identity.purpose !== "confirmation") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["confirmation", "identity", "purpose"], message: "confirmation resources require a confirmation envelope identity" });
  }
  if (budgets.terminal.identity.purpose !== "terminal") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["terminal", "identity", "purpose"], message: "terminal resources require a terminal envelope identity" });
  }
  const ids = [budgets.search.identity.envelopeId, budgets.confirmation.identity.envelopeId, budgets.terminal.identity.envelopeId];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: "search, confirmation, and terminal envelopes require distinct identities" });
  }
});
export type M2RecursiveBudgets = z.infer<typeof M2RecursiveBudgets>;

const RecursiveOptimizerIdentity = z.object({
  sourceCommit: GIT_COMMIT,
  sourceArtifact: SHA256,
  bundleDigest: SHA256,
}).strict();

/**
 * The optimizer/controller runs in this image. Capsule entries carry their
 * own evaluation images independently; recursive campaigns are heterogeneous.
 */
const RecursiveOptimizerRuntime = z.object({
  image: z.string().regex(IMAGE_DIGEST_REF),
}).strict();

export const RecursiveGenerationCell = z.union([
  z.object({
    stage: z.literal("A"),
    panel: z.literal("A"),
    targetGeneration: z.literal(0),
    controllerGeneration: z.literal(0),
    outerReplicate: z.literal(0),
  }).strict(),
  z.object({
    stage: z.literal("B"),
    panel: z.literal("B"),
    targetGeneration: z.literal(1),
    controllerGeneration: z.union([z.literal(0), z.literal(1)]),
    outerReplicate: z.number().int().min(0).max(2),
  }).strict(),
]);
export type RecursiveGenerationCell = z.infer<typeof RecursiveGenerationCell>;

export const RecursiveCampaignCounts = z.object({
  /**
   * Optimizer-declared schedule metadata. These are validated values, not a
   * trusted requirement to emit this many candidates or attempts.
   */
  candidates: z.number().int().positive(),
  candidateAttemptsMax: z.number().int().nonnegative(),
  /** Frozen trusted safety ceiling; an optimizer may allocate fewer episodes. */
  innerEpisodesMax: z.union([z.literal(4), z.literal(8), z.literal(12)]),
  searchReplicates: z.number().int().positive(),
  /** Fixed scientific-shell judging replication. */
  confirmationReplicates: z.literal(3),
  holdoutReplicates: z.literal(3),
  childConcurrency: z.number().int().positive(),
}).strict();
export type RecursiveCampaignCounts = z.infer<typeof RecursiveCampaignCounts>;

const MetaCampaignConfigV2Shape = MetaCampaignConfigShape.extend({
  version: z.literal(META_CAMPAIGN_CONFIG_V2),
  seedOptimizer: RecursiveOptimizerIdentity,
  controllerOptimizer: RecursiveOptimizerIdentity,
  optimizerRuntime: RecursiveOptimizerRuntime,
  generation: RecursiveGenerationCell,
  train: z.array(MetaCapsuleEntry),
  holdout: z.array(MetaCapsuleEntry),
  counts: RecursiveCampaignCounts,
  calibration: M2CalibrationBinding,
  corpusCohort: M2CorpusCohort,
  modelObservation: M2ModelObservationPolicy,
  developmentPanel: M2DevelopmentPanel,
  recursiveBudgets: M2RecursiveBudgets,
  allowedClaim: z.literal(M2_ALLOWED_CLAIM),
}).strict();

function refineMetaCampaignV2(
  cfg: z.infer<typeof MetaCampaignConfigV2Shape>,
  ctx: z.RefinementCtx,
  official: boolean,
): void {
  if (cfg.train.length !== M2_PANEL_CAPSULE_COUNT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["train"],
      message: `M2 requires exactly ${M2_PANEL_CAPSULE_COUNT} panel capsules, got ${cfg.train.length}`,
    });
  }
  if (cfg.holdout.length !== M2_TERMINAL_CAPSULE_COUNT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["holdout"],
      message: `M2 requires exactly ${M2_TERMINAL_CAPSULE_COUNT} terminal capsules, got ${cfg.holdout.length}`,
    });
  }

  const seenDigests = new Set<string>();
  const seenIds = new Set<string>();
  for (const [partition, entries] of [["train", cfg.train], ["holdout", cfg.holdout]] as const) {
    entries.forEach((entry, index) => {
      if (seenDigests.has(entry.capsuleDigest)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [partition, index, "capsuleDigest"], message: "capsule digest is duplicated across the M2 corpus" });
      }
      if (seenIds.has(entry.capsuleId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [partition, index, "capsuleId"], message: "capsule id is duplicated across the M2 corpus" });
      }
      seenDigests.add(entry.capsuleDigest);
      seenIds.add(entry.capsuleId);
      if (Math.abs(entry.scale - (entry.qReference - entry.qBase)) > 1e-9 * Math.max(1, Math.abs(entry.scale))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [partition, index, "scale"], message: "scale must equal qReference - qBase" });
      }
    });
  }

  const development = new Set(cfg.corpusCohort.developmentCapsuleIds);
  const terminal = new Set(cfg.corpusCohort.terminalCapsuleIds);
  if (development.size !== cfg.corpusCohort.developmentCapsuleIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["corpusCohort", "developmentCapsuleIds"], message: "development cohort ids are not distinct" });
  }
  if (terminal.size !== cfg.corpusCohort.terminalCapsuleIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["corpusCohort", "terminalCapsuleIds"], message: "terminal cohort ids are not distinct" });
  }
  cfg.corpusCohort.terminalCapsuleIds.forEach((capsuleId, index) => {
    if (development.has(capsuleId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["corpusCohort", "terminalCapsuleIds", index], message: "cohort capsule cannot be both development and terminal" });
    }
  });
  cfg.train.forEach((entry, index) => {
    if (!development.has(entry.capsuleId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["train", index, "capsuleId"], message: "train capsule is not a registered development cohort capsule" });
    }
  });
  cfg.holdout.forEach((entry, index) => {
    if (!terminal.has(entry.capsuleId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["holdout", index, "capsuleId"], message: "holdout capsule is not a registered terminal cohort capsule" });
    }
  });

  if (official && cfg.calibration.reportDigest === M2_CALIBRATION_DEFERRED_REPORT_DIGEST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["calibration", "reportDigest"],
      message: "deferred calibration sentinel cannot enter an official M2 config; bind the saturation calibration report first",
    });
  }
  const excludedIds = new Set(cfg.calibration.excludedCapsuleIds);
  if (excludedIds.size !== cfg.calibration.excludedCapsuleIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["calibration", "excludedCapsuleIds"], message: "excluded calibration capsules must be four distinct identities" });
  }
  // Compare against the FULL 28-capsule cohort, not just the cell's train+holdout:
  // an off-panel development capsule (the other panel) is still a cohort member.
  cfg.calibration.excludedCapsuleIds.forEach((capsuleId, index) => {
    if (development.has(capsuleId) || terminal.has(capsuleId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["calibration", "excludedCapsuleIds", index],
        message: `calibration capsule ${capsuleId} is a registered cohort capsule; calibration capsules must remain excluded`,
      });
    }
  });

  // Per-run evaluator floors: one complete child run needs 4 * innerEpisodesMax + 1
  // evaluator invocations, and the outer trajectory needs candidateAttemptsMax + 1
  // (every attempt plus the baseline). Aggregate arithmetic cannot repair a
  // per-run budget that cannot fund a single complete run.
  const perRunEvaluatorFloor = 4 * cfg.counts.innerEpisodesMax + 1;
  if (cfg.budgets.child.maxEvaluatorInvocations < perRunEvaluatorFloor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "child", "maxEvaluatorInvocations"],
      message: `child evaluator budget cannot fund one complete run (needs ${perRunEvaluatorFloor})`,
    });
  }
  const outerEvaluatorFloor = cfg.counts.candidateAttemptsMax + 1;
  if (cfg.budgets.outer.maxEvaluatorInvocations < outerEvaluatorFloor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["budgets", "outer", "maxEvaluatorInvocations"],
      message: `outer evaluator budget cannot fund candidateAttemptsMax + 1 evaluations (needs ${outerEvaluatorFloor})`,
    });
  }
  cfg.developmentPanel.members.forEach((member, index) => {
    if (member.calibratedInnerCeiling.maxEvaluatorInvocations < perRunEvaluatorFloor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["developmentPanel", "members", index, "calibratedInnerCeiling", "maxEvaluatorInvocations"],
        message: `calibrated inner ceiling cannot fund one complete run (needs ${perRunEvaluatorFloor})`,
      });
    }
  });

  if (cfg.developmentPanel.panel !== cfg.generation.panel) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["developmentPanel", "panel"], message: "development panel must match the trajectory generation cell" });
    }
    const trainById = new Map(cfg.train.map((capsule) => [capsule.capsuleId, capsule]));
    cfg.developmentPanel.members.forEach((member, index) => {
      const registered = trainById.get(member.capsule.capsuleId);
      if (registered === undefined || canonicalJson(registered) !== canonicalJson(member.capsule)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["developmentPanel", "members", index, "capsule"],
          message: "panel member must equal its exact registered train capsule identity",
        });
      }
    });
    const calibrated = m2CalibratedPanelCandidateBudget(cfg.developmentPanel);
    for (const dimension of BUDGET_DIMENSIONS) {
      if (cfg.recursiveBudgets.search.calibratedPanelCandidate[dimension] !== calibrated[dimension]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recursiveBudgets", "search", "calibratedPanelCandidate", dimension],
          message: `calibrated panel candidate ${dimension} must equal the componentwise sum ${calibrated[dimension]}`,
        });
      }
    }
    const confirmationRuns =
      (cfg.generation.stage === "A" ? 4 : 5) *
      cfg.train.length *
      cfg.counts.confirmationReplicates;
    const terminalRuns = 3 * cfg.holdout.length * cfg.counts.holdoutReplicates;
    for (const [purpose, envelope, runs] of [
      ["confirmation", cfg.recursiveBudgets.confirmation.budget, confirmationRuns],
      ["terminal", cfg.recursiveBudgets.terminal.budget, terminalRuns],
    ] as const) {
      for (const dimension of BUDGET_DIMENSIONS) {
        const required = cfg.budgets.child[dimension] * runs;
        if (envelope[dimension] < required) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["recursiveBudgets", purpose, "budget", dimension],
            message: `${purpose} ${dimension} cannot fund the fixed judging shell (${required})`,
          });
        }
      }
    }

  const protectedNorm = cfg.protectedPaths.map(normalizePath);
  cfg.mutablePaths.forEach((mutable, index) => {
    const hit = protectedNorm.find((candidate) => pathsOverlap(normalizePath(mutable), candidate));
    if (hit !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mutablePaths", index], message: `mutable path "${mutable}" overlaps protected path "${hit}"` });
    }
  });
  if (cfg.routing.outerMutation !== cfg.modelObservation.outerRequestedRoute) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["routing", "outerMutation"], message: `outer routing must match the frozen outer observation route ("${cfg.modelObservation.outerRequestedRoute}")` });
  }
  if (cfg.routing.innerMutation !== cfg.modelObservation.innerRequestedRoute) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["routing", "innerMutation"], message: `inner routing must match the frozen inner observation route ("${cfg.modelObservation.innerRequestedRoute}")` });
  }

  const target = canonicalIdentity(cfg.seedOptimizer);
  const controller = canonicalIdentity(cfg.controllerOptimizer);
  if (cfg.generation.stage === "A" && controller !== target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["controllerOptimizer"], message: "stage A controller and target must both be exact G0" });
  }
  if (cfg.generation.stage === "B" && cfg.generation.controllerGeneration === 1 && controller !== target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["controllerOptimizer"], message: "the stage-B G1 controller must equal the exact G1 target" });
  }
  if (cfg.generation.stage === "B" && cfg.generation.controllerGeneration === 0 && controller === target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["controllerOptimizer"], message: "the stage-B G0 control controller must differ from the G1 target" });
  }
  for (const key of ["brokenSourceArtifact", "degradedSourceArtifact"] as const) {
    if (cfg.controls[key] === cfg.seedOptimizer.sourceArtifact) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["controls", key], message: "a control source artifact must differ from the target optimizer" });
    }
  }

}

/** Official M2 config: the deferred-calibration sentinel is REJECTED here (and therefore at freeze). */
export const MetaCampaignConfigV2 = MetaCampaignConfigV2Shape.superRefine(
  (cfg, ctx) => refineMetaCampaignV2(cfg, ctx, true),
);
export type MetaCampaignConfigV2 = z.infer<typeof MetaCampaignConfigV2>;

/**
 * Draft-only variant: identical rules EXCEPT the deferred-calibration
 * sentinel is tolerated. Accepted solely inside the non-freezable
 * m2-launch-draft wrapper — never by freeze or any run phase.
 */
export const MetaCampaignConfigV2Draft = MetaCampaignConfigV2Shape.superRefine(
  (cfg, ctx) => refineMetaCampaignV2(cfg, ctx, false),
);
export type MetaCampaignConfigV2Draft = z.infer<typeof MetaCampaignConfigV2Draft>;

export const MetaCampaignConfig = z.union([MetaCampaignConfigV1, MetaCampaignConfigV2]);
export type MetaCampaignConfig = z.infer<typeof MetaCampaignConfig>;

function canonicalIdentity(identity: z.infer<typeof RecursiveOptimizerIdentity>): string {
  return `${identity.sourceCommit}\n${identity.sourceArtifact}\n${identity.bundleDigest}`;
}

export function m2CalibratedPanelCandidateBudget(
  panel: M2DevelopmentPanel,
): z.infer<typeof BudgetEnvelope> {
  return panel.members.reduce<z.infer<typeof BudgetEnvelope>>(
    (total, member) => ({
      maxTokens: total.maxTokens + member.calibratedInnerCeiling.maxTokens,
      maxUsd: total.maxUsd + member.calibratedInnerCeiling.maxUsd,
      maxWallClockSec: total.maxWallClockSec + member.calibratedInnerCeiling.maxWallClockSec,
      maxEvaluatorInvocations:
        total.maxEvaluatorInvocations + member.calibratedInnerCeiling.maxEvaluatorInvocations,
    }),
    { maxTokens: 0, maxUsd: 0, maxWallClockSec: 0, maxEvaluatorInvocations: 0 },
  );
}

