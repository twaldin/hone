import { z } from "zod";

/**
 * Contract 3 — LLM egress proxy.
 *
 * OpenAI-compatible POST /v1/chat/completions. Auth = per-run bearer token
 * minted by the runner (mutation sandboxes hold the token, never upstream
 * credentials). The proxy meters every request against the run budget across
 * the whole process tree — this is the recursion guard — and appends one
 * ProxyTraceRecord per request to CAS. Chain: sandbox -> hone-proxy ->
 * operator-configured OpenAI-compatible upstream (`HONE_UPSTREAM_BASE_URL`)
 * -> provider.
 */

export const PROXY_TRACE_VERSION = 2;

/** Frozen M2 reasoning roles. These names are trusted proxy capabilities, not optimizer input. */
export const M2ProxyRole = z.enum([
  "outer-optimizer",
  "capsule-author",
  "inner-capsule-improvement",
]);
export type M2ProxyRole = z.infer<typeof M2ProxyRole>;

/**
 * Reasoning effort forwarded as the top-level OpenAI `reasoning_effort` field.
 * The trusted proxy sets it from the sealed route; the sandbox cannot choose it.
 */
export const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

/** One requested model route: the upstream model id plus an optional reasoning effort. */
export const ModelRoute = z.object({
  model: z.string().min(1),
  reasoningEffort: ReasoningEffort.optional(),
}).strict();
export type ModelRoute = z.infer<typeof ModelRoute>;

/** Engine default for every role when no sealed configuration names a model. */
export const DEFAULT_MODEL_ROUTE = "openai-codex/gpt-6.1-sol";

/**
 * Routes for the two reasoning tiers of a campaign. `outer` serves the
 * outer optimizer and capsule author; `inner` serves inner capsule
 * improvement. Both come from the sealed campaign (or calibration) config.
 */
export const CampaignModelRoutes = z.object({
  outer: ModelRoute,
  inner: ModelRoute,
}).strict();
export type CampaignModelRoutes = z.infer<typeof CampaignModelRoutes>;

export const DEFAULT_CAMPAIGN_MODEL_ROUTES: CampaignModelRoutes = Object.freeze({
  outer: Object.freeze({ model: DEFAULT_MODEL_ROUTE }),
  inner: Object.freeze({ model: DEFAULT_MODEL_ROUTE }),
});

/**
 * Historical M2 routes, hardcoded before routes became configuration. Frozen
 * campaign configs, calibration selections and run seals written before then
 * name (or imply) exactly these, and keep resolving to them.
 */
export const LEGACY_M2_OUTER_MODEL_ROUTE = "openai-codex/gpt-5.6-sol";
export const LEGACY_M2_INNER_MODEL_ROUTE = "openai-codex/gpt-5.6-luna";
export const LEGACY_M2_CAMPAIGN_MODEL_ROUTES: CampaignModelRoutes = Object.freeze({
  outer: Object.freeze({ model: LEGACY_M2_OUTER_MODEL_ROUTE }),
  inner: Object.freeze({ model: LEGACY_M2_INNER_MODEL_ROUTE }),
});

/** The complete M2 role-to-route authority for one campaign's sealed routes. */
export function m2ModelRouting(routes: CampaignModelRoutes): Readonly<Record<M2ProxyRole, ModelRoute>> {
  return Object.freeze({
    "outer-optimizer": routes.outer,
    "capsule-author": routes.outer,
    "inner-capsule-improvement": routes.inner,
  });
}

/** Per-role upstream routing, from trusted run config. Role names are hone roles, not harness roles. */
export const ModelRouting = z.record(
  z.string(),
  z.object({
    model: z.string().min(1),
    reasoningEffort: ReasoningEffort.optional(),
    /** Defaults to the single configured upstream; per-role override allowed outside frozen M2 roles. */
    upstreamBaseUrl: z.string().url().optional(),
  }),
);
export type ModelRouting = z.infer<typeof ModelRouting>;

export const ProviderAttemptClassification = z.enum([
  "success",
  "candidate-invalidity",
  "client-invalidity",
  "retry",
  "campaign-pause",
]);
export type ProviderAttemptClassification = z.infer<typeof ProviderAttemptClassification>;

export const CampaignPauseReason = z.enum([
  "proxy-failover",
  "provider-auth",
  "provider-payment",
  "provider-rate-limit",
  "provider-transport",
  "provider-5xx",
  "returned-model-drift",
]);
export type CampaignPauseReason = z.infer<typeof CampaignPauseReason>;

export const CampaignPauseSignal = z.object({
  version: z.literal(1),
  pauseId: z.string().min(1),
  runId: z.string().min(1),
  reason: CampaignPauseReason,
  at: z.string().datetime(),
  role: M2ProxyRole.or(z.string().min(1)),
  requestedRoute: z.string().min(1),
  returnedModel: z.string().min(1).nullable(),
  status: z.number().int().nullable(),
  attempt: z.number().int().positive(),
});
export type CampaignPauseSignal = z.infer<typeof CampaignPauseSignal>;

export const ProxyPreflightObservation = z.object({
  role: M2ProxyRole,
  /** Durable preflight dispatch proving this observation, null when no call was attempted. */
  dispatchId: z.string().min(1).nullable(),
  requestedRoute: z.string().min(1),
  returnedModel: z.string().min(1).nullable(),
  status: z.number().int().nullable(),
  passed: z.boolean(),
});
export type ProxyPreflightObservation = z.infer<typeof ProxyPreflightObservation>;

export const ProxyPreflightResult = z.object({
  passed: z.boolean(),
  observations: z.array(ProxyPreflightObservation).length(2),
});
export type ProxyPreflightResult = z.infer<typeof ProxyPreflightResult>;

export const CampaignResumeSignal = z.object({
  version: z.literal(1),
  pauseId: z.string().min(1),
  runId: z.string().min(1),
  at: z.string().datetime(),
  observations: z.array(ProxyPreflightObservation).length(2),
});
export type CampaignResumeSignal = z.infer<typeof CampaignResumeSignal>;

const ProxyTraceRecordV1 = z.object({
  version: z.literal(1),
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
  requestBody: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  responseBody: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const ProxyTraceRecord = z.discriminatedUnion("version", [
  ProxyTraceRecordV1,
  z.object({
    version: z.literal(PROXY_TRACE_VERSION),
    runId: z.string(),
    role: z.string(),
    /** Legacy requested-route alias retained so old trace readers remain useful. */
    model: z.string(),
    requestedRoute: z.string().min(1),
    returnedModel: z.string().min(1).nullable(),
    classification: ProviderAttemptClassification,
    attempt: z.number().int().positive(),
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
  }),
]);
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
