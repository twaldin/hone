import { z } from "zod";
import { BudgetEnvelope, IMAGE_DIGEST_REF } from "./capsule.js";
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
  /** Requested model per mutation role; both roles fixed to one route in M1. */
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
