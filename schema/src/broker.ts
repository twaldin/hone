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

export const RunDepth = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type RunDepth = z.infer<typeof RunDepth>;

/** Componentwise trusted resource accounting for recursive child runs. */
export const ResourceUsage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  wallClockSec: z.number().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
});
export type ResourceUsage = z.infer<typeof ResourceUsage>;

export const ChildRunSpec = z.object({
  /** Durable identity: retries and crash recovery reuse this exact run id. */
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  capsuleId: z.string().min(1),
  sourceArtifact: ArtifactRef,
  optimizerArtifact: ArtifactRef,
  purpose: z.enum(["capsule", "delegated", "self-ab"]),
});
export type ChildRunSpec = z.infer<typeof ChildRunSpec>;

export const SpawnRunParams = z.object({
  child: ChildRunSpec,
  /** Requested child depth. Trusted broker state, not this value, decides whether it is admissible. */
  depth: z.union([z.literal(1), z.literal(2)]),
  /** Reserved atomically from every ancestor before the child launcher is called. */
  reservation: BudgetEnvelope,
});
export type SpawnRunParams = z.infer<typeof SpawnRunParams>;

export const ChildRunTerminal = z.object({
  runId: z.string().min(1),
  cursor: z.number().int().nonnegative(),
  eventDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  status: z.enum(["completed", "stopped", "failed", "budget"]),
});
export type ChildRunTerminal = z.infer<typeof ChildRunTerminal>;

export const SpawnRunResult = z.object({
  child: ChildRunSpec,
  depth: z.union([z.literal(1), z.literal(2)]),
  reservation: BudgetEnvelope,
  /** Direct usage of this run; nested descendant usage is accounted by its own ancestor settlement. */
  usage: ResourceUsage,
  terminal: ChildRunTerminal,
});
export type SpawnRunResult = z.infer<typeof SpawnRunResult>;

export const CorpusSource = z.enum(["public-snapshot", "panel-evidence"]);
export type CorpusSource = z.infer<typeof CorpusSource>;

export const CorpusCursor = z.string().regex(/^corpus_[0-9a-f]{64}_[0-9]+$/);
export type CorpusCursor = z.infer<typeof CorpusCursor>;

export const CorpusQuery = z.object({
  text: z.string().max(4_096).default(""),
  sources: z.array(CorpusSource).min(1).max(2).default(["public-snapshot", "panel-evidence"]),
});
export type CorpusQuery = z.infer<typeof CorpusQuery>;

export const QueryCorpusParams = z.object({
  query: CorpusQuery,
  cursor: CorpusCursor.nullable().default(null),
  pageSize: z.number().int().positive().max(100).default(50),
});
export type QueryCorpusParams = z.infer<typeof QueryCorpusParams>;

export const CorpusPublicDocument = z.object({
  source: z.literal("public-snapshot"),
  id: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  content: z.string(),
});
export type CorpusPublicDocument = z.infer<typeof CorpusPublicDocument>;

export const CorpusPanelEvidence = z.object({
  source: z.literal("panel-evidence"),
  id: z.string().min(1),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  content: z.string(),
  usage: ResourceUsage,
});
export type CorpusPanelEvidence = z.infer<typeof CorpusPanelEvidence>;

/** No terminal source variant exists: terminal identities/evidence cannot be represented on this wire. */
export const CorpusDocument = z.discriminatedUnion("source", [CorpusPublicDocument, CorpusPanelEvidence]);
export type CorpusDocument = z.infer<typeof CorpusDocument>;

export const QueryCorpusResult = z.object({
  snapshotHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  cursor: CorpusCursor,
  nextCursor: CorpusCursor.nullable(),
  documents: z.array(CorpusDocument),
});
export type QueryCorpusResult = z.infer<typeof QueryCorpusResult>;

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
  spawnRun: { params: SpawnRunParams, result: SpawnRunResult },
  queryCorpus: { params: QueryCorpusParams, result: QueryCorpusResult },
} as const;
export type BrokerMethodName = keyof typeof BrokerMethods;

export const BrokerErrorCode = z.enum([
  "BUDGET_EXCEEDED",
  "SANDBOX_NOT_FOUND",
  "PROTECTED_PATH_VIOLATION",
  "HOLDOUT_ACCESS_DENIED",
  "DEPTH_EXCEEDED",
  "RESERVATION_EXCEEDED",
  "CORPUS_UNAVAILABLE",
  "CURSOR_INVALID",
  "NOT_IMPLEMENTED",
  "QUOTA_EXCEEDED",
  "INTERNAL",
]);
export type BrokerErrorCode = z.infer<typeof BrokerErrorCode>;
