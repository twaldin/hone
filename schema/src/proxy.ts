import { z } from "zod";

/**
 * Contract 3 — LLM egress proxy.
 *
 * OpenAI-compatible POST /v1/chat/completions. Auth = per-run bearer token
 * minted by the runner (mutation sandboxes hold the token, never upstream
 * credentials). The proxy meters every request against the run budget across
 * the whole process tree — this is the recursion guard — and appends one
 * ProxyTraceRecord per request to CAS. Chain: sandbox -> hone-proxy ->
 * upstream (vibeproxy :8317) -> provider.
 */

export const PROXY_TRACE_VERSION = 1;

/** Per-role upstream routing, from run config. Role names are hone roles, not harness roles. */
export const ModelRouting = z.record(
  /** role: "mutation" | "meta" | "evaluator-author" | "validator" | custom */
  z.string(),
  z.object({
    model: z.string().min(1),
    /** Defaults to the single configured upstream; per-role override allowed. */
    upstreamBaseUrl: z.string().url().optional(),
  }),
);
export type ModelRouting = z.infer<typeof ModelRouting>;

export const ProxyTraceRecord = z.object({
  version: z.literal(PROXY_TRACE_VERSION),
  runId: z.string(),
  role: z.string(),
  model: z.string(),
  requestAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  status: z.number().int(),
  usage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }),
  estimatedUsd: z.number().nonnegative(),
  /** CAS hashes of full request/response bodies (bodies never inline in the index). */
  requestBody: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  responseBody: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type ProxyTraceRecord = z.infer<typeof ProxyTraceRecord>;

/** Error body returned when the budget hard-stops a request (HTTP 402). */
export const BudgetExceededError = z.object({
  error: z.object({
    type: z.literal("hone_budget_exceeded"),
    message: z.string(),
    dimension: z.enum(["tokens", "usd", "wallClockSec", "evaluatorInvocations"]),
  }),
});
export type BudgetExceededError = z.infer<typeof BudgetExceededError>;
