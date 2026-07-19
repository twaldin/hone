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
