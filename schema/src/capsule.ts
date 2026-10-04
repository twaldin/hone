import { z } from "zod";

/**
 * Contract 1 — Capsule manifest.
 *
 * Minimality rule (build plan §2): the required core is exactly what another
 * machine needs to RUN the task. Everything else lives in the optional,
 * droppable `meta` block. A capsule is a shareable task, not a run record.
 */

export const SCHEMA_VERSION = 2;

/**
 * Immutable OCI image reference: lowercase repo path pinned to a sha256
 * digest. Mutable tags (":latest") are rejected — a capsule that can silently
 * change its runtime image is not content-addressed.
 */
export const IMAGE_DIGEST_REF =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

/**
 * Runtime identity is deliberately mixed: admission content-addresses the
 * admitted manifest, while execution may use a separately authorised image.
 * Naming both halves prevents an overridden manifest object from erasing the
 * distinction.
 */
export const CapsuleRuntimeIdentity = z.object({
  admittedCapsuleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  executionImage: z.string().min(1).refine((value) => !/^sha256:/.test(value), "execution image cannot be an admitted digest"),
}).strict();
export type CapsuleRuntimeIdentity = z.infer<typeof CapsuleRuntimeIdentity>;

/** Visibility of an asset group relative to the mutable optimizer. */
export const AssetVisibility = z.enum([
  /** Visible to mutation sessions and evaluators. */
  "public",
  /** Evaluator-only during a run; optimizer sees scores, not contents. */
  "protected",
  /** Optimizer-invisible, trusted-runtime ledger-gated. The only visibility that is LAW. */
  "holdout",
]);
export type AssetVisibility = z.infer<typeof AssetVisibility>;

export const AssetGroup = z.object({
  /** Stable group id, e.g. "train", "validation", "holdout". Split *semantics* are policy, not law. */
  id: z.string().min(1),
  visibility: AssetVisibility,
  /** Paths relative to the capsule root. */
  paths: z.array(z.string().min(1)).min(1),
});
export type AssetGroup = z.infer<typeof AssetGroup>;

/**
 * Resource envelope. Every dimension the trusted runtime meters.
 * Whatever is unmetered becomes the free variable candidates optimize — so
 * all four dimensions are required, even if generous.
 */
export const BudgetEnvelope = z.object({
  maxTokens: z.number().int().positive(),
  maxUsd: z.number().nonnegative(),
  maxWallClockSec: z.number().int().positive(),
  maxEvaluatorInvocations: z.number().int().positive(),
});
export type BudgetEnvelope = z.infer<typeof BudgetEnvelope>;

/** Broker per-invocation evaluator wall cap when neither the capsule nor a campaign declares one. */
export const DEFAULT_EVALUATOR_TIMEOUT_SEC = 600;
/** Shortest declarable evaluator wall cap. */
export const MIN_EVALUATOR_TIMEOUT_SEC = 60;
/**
 * Longest declarable evaluator wall cap: 7 days. That covers multi-hour
 * evaluations and a ~74 h full validation, and stays far below the ~24.8-day
 * ceiling of a Node timer.
 */
export const MAX_EVALUATOR_TIMEOUT_SEC = 604_800;
/** Wall-time cap for ONE evaluator invocation, in seconds. */
export const EvaluatorTimeoutSec = z
  .number()
  .int()
  .min(MIN_EVALUATOR_TIMEOUT_SEC)
  .max(MAX_EVALUATOR_TIMEOUT_SEC);
export type EvaluatorTimeoutSec = z.infer<typeof EvaluatorTimeoutSec>;

/** Evaluator phases a two-phase capsule runs, each in its own fresh container. */
export const EvalPhase = z.enum(["encode", "decode"]);
export type EvalPhase = z.infer<typeof EvalPhase>;
/**
 * The only admitted phase protocol: an `encode` container that sees the
 * candidate workspace, then a fresh `decode` container that sees only the
 * trusted handoff files the encode phase's scorer wrote.
 */
export const EvalPhases = z.tuple([z.literal(EvalPhase.enum.encode), z.literal(EvalPhase.enum.decode)]);
export type EvalPhases = z.infer<typeof EvalPhases>;
/**
 * The exact stdout an `encode` phase emits to request the `decode` phase.
 * Anything else that is not an invalid EvaluatorOutput fails closed.
 */
export const EvalPhaseContinue = z.object({ honeEvalContinue: z.literal(EvalPhase.enum.decode) }).strict();
export type EvalPhaseContinue = z.infer<typeof EvalPhaseContinue>;

export const CapsuleManifest = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Content-addressed capsule id: "cap_" + first 12 hex of sha256 over canonical manifest sans id. */
  id: z.string().regex(/^cap_[0-9a-f]{12}$/),
  /** Exact natural-language objective. Verbatim; never paraphrased by tooling. */
  objective: z.string().min(1),
  /** Baseline artifact: git commit sha (repo capsules) or CAS hash (generated skeletons). */
  baseline: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("git"), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
    z.object({ kind: z.literal("cas"), hash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }),
  ]),
  /** Immutable OCI image ref (repo@sha256:<64>) used for BOTH mutation and evaluation sandboxes. */
  image: z.string().regex(IMAGE_DIGEST_REF),
  /** Command argv executed inside the eval sandbox; must emit EvaluatorOutput JSON on stdout. */
  evalEntrypoint: z.array(z.string().min(1)).min(1),
  /** Paths (relative to artifact root) the optimizer MUST NOT modify. Trusted runtime enforces by diff-reject. */
  protectedPaths: z.array(z.string()).default([]),
  assetGroups: z.array(AssetGroup).min(1),
  budget: BudgetEnvelope,
  /**
   * Optional per-capsule sandbox resource requirements. Trusted runtime
   * passes these to the broker's container limits (default 2 GiB / 2 cpus).
   * Core (inside the digest): a capsule that needs 6 GiB to link is a
   * different task than one that fits the default — admission gate 9
   * (bounded build with 30% headroom) is judged against THIS cap.
   */
  sandbox: z
    .object({
      memoryBytes: z.number().int().positive(),
      cpus: z.number().positive().optional(),
    })
    .strict()
    .optional(),
  /**
   * Optional wall-time cap for one evaluator invocation. Core (inside the
   * digest): an evaluation that needs hours is a different task than one
   * that fits the broker's 600 s default. Absent keeps that default. A
   * campaign's frozen `evaluatorTimeoutSec` governs its own runs instead.
   */
  evaluatorTimeoutSec: EvaluatorTimeoutSec.optional(),
  /**
   * Optional two-phase evaluation. Absent runs `evalEntrypoint` once. When
   * set, the broker runs it in an `encode` container (HONE_EVAL_PHASE=encode,
   * workspace and a writable /capsule/handoff) and, on the exact
   * EvalPhaseContinue marker, again in a fresh `decode` container
   * (HONE_EVAL_PHASE=decode, private IPC, no workspace, handoff read-only).
   * Core (inside the digest): it changes what the evaluator measures.
   */
  evalPhases: EvalPhases.optional(),
  /**
   * Reference to the persisted diagnostic-ordering report proving the
   * evaluator discriminates (broken < naive < baseline < improved, split
   * integrity, stability). `path` is capsule-root-relative; `hash` covers the
   * report file bytes. Core (inside the id/digest), not meta: a capsule
   * without evidence its evaluator orders is not a runnable task.
   */
  diagnosticOrdering: z.object({
    path: z.string().min(1),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
  /** sha256 hashes of every file referenced by assetGroups, keyed by path. */
  contentHashes: z.record(z.string().regex(/^sha256:[0-9a-f]{64}$/)),
  /**
   * Optional, droppable-without-breaking-replay metadata: provenance,
   * evaluator_source (user|inferred|meta), licensing, difficulty labels, tags.
   */
  meta: z
    .object({
      evaluatorSource: z.enum(["user", "inferred", "meta"]).optional(),
      createdAt: z.string().datetime().optional(),
      provenance: z.string().optional(),
      license: z.string().optional(),
      tags: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
});
export type CapsuleManifest = z.infer<typeof CapsuleManifest>;
