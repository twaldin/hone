import {
  type CampaignPauseReason,
  type ProviderAttemptClassification,
} from "@hone/schema";
import { isJsonObject } from "./sse.js";

/** One initial provider attempt plus at most three trusted retries. */
export const MAX_PROVIDER_RETRIES = 3;
export const MAX_PROVIDER_ATTEMPTS = MAX_PROVIDER_RETRIES + 1;

/** Bounded exponential jitter window. The retry ordinal is one-based. */
export function providerRetryDelayMs(retryOrdinal: number, randomUnit = Math.random()): number {
  const ordinal = Math.max(1, Math.min(MAX_PROVIDER_RETRIES, Math.trunc(retryOrdinal)));
  const floor = 50 * 2 ** (ordinal - 1);
  const unit = Number.isFinite(randomUnit) ? Math.max(0, Math.min(1, randomUnit)) : 0.5;
  return floor + Math.floor(unit * floor);
}

export interface ProviderAttemptFacts {
  attempt: number;
  status: number | null;
  transportError: boolean;
  explicitUpstreamError: boolean;
  proxyFailover: boolean;
  requestedRoute: string;
  returnedModels: readonly string[];
  /** Upstream-resolved model id from RESOLVED_MODEL_HEADER; null when the upstream sends none. */
  resolvedModel?: string | null;
  malformedSuccessfulOutput: boolean;
  noQuota: boolean;
}

/**
 * Response header naming the model the gateway actually resolved. The omp
 * auth gateway echoes the requested id verbatim in the body, so this header
 * is the only independent identity observation it offers.
 */
export const RESOLVED_MODEL_HEADER = "x-litellm-model-id";

/**
 * A resolved id matches the route exactly, or equals the route's bare model
 * name after its provider prefix (`openai-codex/gpt-6.1-sol` → `gpt-6.1-sol`).
 */
export function resolvedModelMatchesRoute(resolvedModel: string, route: string): boolean {
  const resolved = resolvedModel.trim();
  return resolved === route || resolved === route.slice(route.lastIndexOf("/") + 1);
}

/** Exact protocol code in a buffered JSON error envelope, never message text. */
export function isNoQuotaResponse(responseText: string): boolean {
  try {
    const body: unknown = JSON.parse(responseText);
    return isJsonObject(body) &&
      isJsonObject(body["error"]) &&
      body["error"]["code"] === "NO_QUOTA";
  } catch {
    return false;
  }
}

/**
 * Read only complete SSE error events, never agent-authored delta content.
 * The first explicit error terminates the provider attempt. Its status comes
 * from a structured HTTP error number when the upstream supplies one;
 * otherwise from the gateway's structured error type or, for its generic
 * `upstream_error`, from the provider text it relays (see
 * gatewayStreamErrorStatus). Agent delta content never reaches this parser.
 */
export function streamedUpstreamError(
  responseText: string,
  contentType: string,
): { status: number | null } | undefined {
  if (!contentType.includes("text/event-stream")) return undefined;
  const events = responseText.split(/\r?\n\r?\n/);
  // SSE dispatch requires a blank line, including when the connection ends.
  events.pop();
  for (const event of events) {
    let errorEvent = false;
    const data: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("event:")) errorEvent = line.slice(6).trim() === "error";
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    let value: unknown;
    try {
      value = JSON.parse(data.join("\n"));
    } catch {
      if (errorEvent) return { status: null };
      continue;
    }
    const envelope = isJsonObject(value) ? value : undefined;
    const error = envelope?.["error"];
    if (!errorEvent && !isJsonObject(error) && !(typeof error === "string" && error.length > 0)) {
      continue;
    }
    const detail = isJsonObject(error) ? error : undefined;
    const status = [
      detail?.["status"], detail?.["status_code"], detail?.["code"],
      envelope?.["status"], envelope?.["status_code"],
    ].find((candidate): candidate is number =>
      typeof candidate === "number" && Number.isInteger(candidate) &&
      candidate >= 400 && candidate <= 599,
    );
    return { status: status ?? gatewayStreamErrorStatus(detail) };
  }
  return undefined;
}

const STREAM_ERROR_TYPE_STATUS: Readonly<Record<string, number>> = {
  rate_limit_error: 429,
  authentication_error: 401,
  permission_error: 403,
};
const STREAM_RATE_LIMIT_TEXT = /usage limit|rate[- _]?limit|quota|too many requests/i;
const STREAM_AUTH_TEXT = /unauthori[sz]ed|forbidden|\b401\b|\b403\b/i;

/**
 * The omp auth gateway cannot put a status into an SSE error: once its 200
 * headers are out, an exhausted or rejected account surfaces as
 * `{"error":{"type":"upstream_error","message":<provider text>}}` after the
 * gateway has already failed over across every account. Map that envelope
 * to the HTTP status it stands for so quota exhaustion pauses the campaign
 * as a rate limit instead of being retried as a transport failure.
 */
function gatewayStreamErrorStatus(detail: Record<string, unknown> | undefined): number | null {
  if (detail === undefined) return null;
  const type = typeof detail["type"] === "string" ? detail["type"] : "";
  const mapped = STREAM_ERROR_TYPE_STATUS[type];
  if (mapped !== undefined) return mapped;
  if (detail["code"] === "NO_QUOTA") return 429;
  if (type !== "upstream_error" || typeof detail["message"] !== "string") return null;
  if (STREAM_RATE_LIMIT_TEXT.test(detail["message"])) return 429;
  if (STREAM_AUTH_TEXT.test(detail["message"])) return 401;
  return null;
}

export interface ProviderAttemptDecision {
  classification: ProviderAttemptClassification;
  pauseReason?: CampaignPauseReason;
}

/** Frozen provider policy. Mutable request data never selects the action or retry count. */
export function classifyProviderAttempt(facts: ProviderAttemptFacts): ProviderAttemptDecision {
  if (facts.proxyFailover) {
    return { classification: "campaign-pause", pauseReason: "proxy-failover" };
  }
  switch (facts.status) {
    case 401:
    case 403:
      return { classification: "campaign-pause", pauseReason: "provider-auth" };
    case 402:
      return { classification: "campaign-pause", pauseReason: "provider-payment" };
    case 429:
      return { classification: "campaign-pause", pauseReason: "provider-rate-limit" };
  }
  const drifted = facts.returnedModels.some((identity) => identity !== facts.requestedRoute) ||
    (facts.resolvedModel !== undefined && facts.resolvedModel !== null &&
      !resolvedModelMatchesRoute(facts.resolvedModel, facts.requestedRoute));
  if (drifted) {
    return { classification: "campaign-pause", pauseReason: "returned-model-drift" };
  }
  if (facts.transportError) {
    return facts.attempt < MAX_PROVIDER_ATTEMPTS
      ? { classification: "retry" }
      : { classification: "campaign-pause", pauseReason: "provider-transport" };
  }
  if (facts.status === 503 && facts.noQuota) {
    return { classification: "campaign-pause", pauseReason: "provider-rate-limit" };
  }
  if (facts.status !== null && facts.status >= 500 && facts.status <= 599) {
    return facts.attempt < MAX_PROVIDER_ATTEMPTS
      ? { classification: "retry" }
      : { classification: "campaign-pause", pauseReason: "provider-5xx" };
  }
  if (facts.explicitUpstreamError) {
    // An upstream operation failed without a status handled above. Reuse the
    // bounded transport-failure policy, not candidate/client invalidity.
    return facts.attempt < MAX_PROVIDER_ATTEMPTS
      ? { classification: "retry" }
      : { classification: "campaign-pause", pauseReason: "provider-transport" };
  }
  if (facts.status !== null && facts.status >= 200 && facts.status <= 299) {
    if (facts.returnedModels.length === 0) {
      return { classification: "campaign-pause", pauseReason: "returned-model-drift" };
    }
    return {
      classification: facts.malformedSuccessfulOutput ? "candidate-invalidity" : "success",
    };
  }
  return { classification: "client-invalidity" };
}

/** Provider model identities observed in a JSON response or across all SSE chunks. */
export function responseModelIdentities(responseText: string, contentType: string): string[] {
  const identities: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of responseText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const value: unknown = JSON.parse(payload);
        if (isJsonObject(value) && typeof value["model"] === "string" && value["model"].length > 0) {
          identities.push(value["model"]);
        }
      } catch {
        // Malformed successful output is handled as invalidity, never synthesized into an identity.
      }
    }
    return identities;
  }
  try {
    const value: unknown = JSON.parse(responseText);
    if (isJsonObject(value) && typeof value["model"] === "string" && value["model"].length > 0) {
      identities.push(value["model"]);
    }
  } catch {
    return identities;
  }
  return identities;
}

/** OpenAI success-envelope validity only; agent-authored content remains opaque to trusted routing. */
export function isMalformedSuccessfulAgentResponse(responseText: string, contentType: string): boolean {
  if (contentType.includes("text/event-stream")) {
    let sawChoice = false;
    let sawDone = false;
    for (const line of responseText.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      if (payload === "") continue;
      try {
        const value: unknown = JSON.parse(payload);
        if (!isJsonObject(value) || !Array.isArray(value["choices"])) return true;
        if (value["choices"].length > 0) {
          for (const choice of value["choices"]) {
            if (!isJsonObject(choice) || !isJsonObject(choice["delta"])) return true;
          }
          sawChoice = true;
        }
      } catch {
        return true;
      }
    }
    return !sawChoice || !sawDone;
  }
  try {
    const value: unknown = JSON.parse(responseText);
    if (!isJsonObject(value) || !Array.isArray(value["choices"]) || value["choices"].length !== 1) {
      return true;
    }
    const choice = value["choices"][0];
    if (!isJsonObject(choice) || !isJsonObject(choice["message"])) return true;
    const message = choice["message"];
    if (typeof message["content"] === "string") return false;
    // A tool-call turn legitimately carries `content: null`.
    return !(message["content"] === null && Array.isArray(message["tool_calls"]) && message["tool_calls"].length > 0);
  } catch {
    return true;
  }
}

const FAILOVER_HEADERS = [
  "x-hone-proxy-failover",
  "x-vibeproxy-failover",
  "x-cliproxy-failover",
] as const;

/** Detect the explicit failover sentinel emitted by the trusted upstream proxy chain. */
export function isProxyFailover(headers: Headers, responseText: string): boolean {
  for (const name of FAILOVER_HEADERS) {
    const value = headers.get(name)?.trim().toLowerCase();
    if (value === "1" || value === "true" || value === "yes") return true;
  }
  try {
    const value: unknown = JSON.parse(responseText);
    if (!isJsonObject(value)) return false;
    const error = value["error"];
    if (!isJsonObject(error) || typeof error["type"] !== "string") return false;
    return error["type"] === "proxy_failover" || error["type"] === "upstream_failover";
  } catch {
    return false;
  }
}
