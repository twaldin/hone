/** Normalized OpenAI usage block. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Accepts an OpenAI wire-format `usage` object; undefined when absent/malformed. */
export function normalizeUsage(value: unknown): Usage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const prompt = rec["prompt_tokens"];
  const completion = rec["completion_tokens"];
  if (typeof prompt !== "number" || typeof completion !== "number") return undefined;
  const total = rec["total_tokens"];
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: typeof total === "number" ? total : prompt + completion,
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
    if (typeof parsed === "object" && parsed !== null) {
      const found = normalizeUsage((parsed as Record<string, unknown>)["usage"]);
      if (found) usage = found;
    }
  }
  return usage;
}
