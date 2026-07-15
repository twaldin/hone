/** Normalized OpenAI usage block. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Runtime guard: a plain JSON object (not null, not an array). */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A usage field is only meaningful as a non-negative safe integer. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Accepts an OpenAI wire-format `usage` object; undefined when absent/malformed.
 * Fail-closed hardening: negative, fractional, or non-numeric counts are
 * MALFORMED (undefined), never coerced — a provider (or tampered upstream)
 * must not be able to shrink recorded spend below its own component counts,
 * so `totalTokens` is never less than prompt+completion.
 */
export function normalizeUsage(value: unknown): Usage | undefined {
  if (!isJsonObject(value)) return undefined;
  const prompt = tokenCount(value["prompt_tokens"]);
  const completion = tokenCount(value["completion_tokens"]);
  if (prompt === undefined || completion === undefined) return undefined;
  const reportedTotal = tokenCount(value["total_tokens"]) ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: Math.max(reportedTotal, prompt + completion),
  };
}

/**
 * Scan a concatenated SSE stream for the final usage chunk (the one
 * `stream_options: {include_usage: true}` makes the upstream emit).
 * Last usage-bearing chunk wins.
 */
export function extractSseUsage(raw: string): Usage | undefined {
  let usage: Usage | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (isJsonObject(parsed)) {
      const found = normalizeUsage(parsed["usage"]);
      if (found) usage = found;
    }
  }
  return usage;
}
