import { z } from "zod";
import { BudgetEnvelope } from "./capsule.js";

/**
 * Contract 2 — Broker wire protocol (JSON-RPC 2.0 over unix socket).
 *
 * The trusted daemon is a sandbox BROKER (review IV.1): the mutable optimizer
 * runs in an unprivileged container as a broker CLIENT. createSandbox/evaluate
 * spawn SIBLING containers — no nesting, no docker socket, quotas and depth
 * caps enforced centrally. This file defines method names + param/result
 * schemas; transport framing is newline-delimited JSON-RPC.
 */

export const BROKER_PROTOCOL_VERSION = 1;

// ---------- shared ----------

export const SandboxRef = z.object({ sandboxId: z.string().min(1) });
export type SandboxRef = z.infer<typeof SandboxRef>;

export const ArtifactRef = z.object({
  /** CAS hash of the artifact snapshot (tar of the candidate tree). */
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const BudgetState = z.object({
  envelope: BudgetEnvelope,
  spent: z.object({
    tokens: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
    wallClockSec: z.number().nonnegative(),
    evaluatorInvocations: z.number().int().nonnegative(),
  }),
});
export type BudgetState = z.infer<typeof BudgetState>;

// ---------- methods ----------

export const GetTaskResult = z.object({
  capsuleId: z.string(),
  objective: z.string(),
  baselineArtifact: ArtifactRef,
  /** Asset group ids visible to the optimizer (never contents of protected/holdout). */
  visibleAssetGroups: z.array(z.string()),
  budget: BudgetState,
});

export const CreateSandboxParams = z.object({
  /** Artifact to unpack into /workspace inside the sandbox. */
  artifact: ArtifactRef,
  /** "mutation" sandboxes get proxy access + writable workspace; no protected mounts ever. */
  role: z.literal("mutation"),
  ttlSec: z.number().int().positive().max(86_400).optional(),
});

export const ExecParams = z.object({
  sandboxId: z.string(),
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeoutSec: z.number().int().positive().max(3_600).optional(),
  stdin: z.string().optional(),
});
export const ExecResult = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

export const PutFileParams = z.object({
  sandboxId: z.string(),
  path: z.string(),
  contentBase64: z.string(),
});
export const GetFileParams = z.object({ sandboxId: z.string(), path: z.string() });
export const GetFileResult = z.object({ contentBase64: z.string() });

export const SaveArtifactParams = z.object({ sandboxId: z.string() });

export const EvaluateParams = z.object({
  artifact: ArtifactRef,
  assetGroupId: z.string(),
  seed: z.number().int().nonnegative(),
});

export const ReportIncumbentParams = z.object({
  artifact: ArtifactRef,
  /** Optimizer's own claimed metrics — display only; trusted scores come from EvaluationRecords. */
  claimed: z.record(z.number()).optional(),
});

export const FinishParams = z.object({ best: ArtifactRef });

/** Reserved (NotImplemented in seed): spawnRun, queryCorpus. Present so the constitution permits them. */
export const SpawnRunParams = z.object({
  subCapsuleId: z.string(),
  budgetSlice: BudgetEnvelope,
  maxDepth: z.number().int().positive().max(2),
});
export const QueryCorpusParams = z.object({ query: z.string() });

export const BrokerMethods = {
  getTask: { params: z.object({}), result: GetTaskResult },
  createSandbox: { params: CreateSandboxParams, result: SandboxRef },
  exec: { params: ExecParams, result: ExecResult },
  putFile: { params: PutFileParams, result: z.object({}) },
  getFile: { params: GetFileParams, result: GetFileResult },
  saveArtifact: { params: SaveArtifactParams, result: ArtifactRef },
  evaluate: {
    params: EvaluateParams,
    // EvaluationRecord defined in evaluator.ts; kept loose here to avoid a cycle — runner re-validates.
    result: z.object({}).passthrough(),
  },
  reportIncumbent: { params: ReportIncumbentParams, result: z.object({}) },
  getBudget: { params: z.object({}), result: BudgetState },
  finish: { params: FinishParams, result: z.object({}) },
  spawnRun: { params: SpawnRunParams, result: z.object({}).passthrough() },
  queryCorpus: { params: QueryCorpusParams, result: z.object({}).passthrough() },
} as const;
export type BrokerMethodName = keyof typeof BrokerMethods;

export const BrokerErrorCode = z.enum([
  "BUDGET_EXCEEDED",
  "SANDBOX_NOT_FOUND",
  "PROTECTED_PATH_VIOLATION",
  "HOLDOUT_ACCESS_DENIED",
  "NOT_IMPLEMENTED",
  "QUOTA_EXCEEDED",
  "INTERNAL",
]);
export type BrokerErrorCode = z.infer<typeof BrokerErrorCode>;
