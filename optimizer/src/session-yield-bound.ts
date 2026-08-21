/**
 * Calibrated to more than twice the largest successful-yield segment in the
 * 80-run M2 saturation corpus: 721,625 tokens
 * (run_calibration_6de9863750b31cbec690b5b9, episode 0).
 */
export const DEFAULT_SESSION_NO_YIELD_MAX_TOKENS = 1_500_000;
export const SESSION_NO_YIELD_RECORD_TYPE = "hone.mutation.no-yield-bound.v1" as const;
export const SESSION_NO_YIELD_EXIT_CODE = 4;

export interface SessionTurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SessionNoYieldSnapshot {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  consumedTokens: number;
}

export interface SessionNoYieldRecord extends SessionNoYieldSnapshot {
  type: typeof SESSION_NO_YIELD_RECORD_TYPE;
  limitTokens: number;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer, got ${String(value)}`);
  }
  return value;
}

/** Parse the trusted optimizer-to-worker override; unset uses the safe engine default. */
export function parseSessionNoYieldMaxTokens(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SESSION_NO_YIELD_MAX_TOKENS;
  if (raw.trim().length === 0) {
    throw new Error(`HONE_SESSION_NO_YIELD_MAX_TOKENS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`HONE_SESSION_NO_YIELD_MAX_TOKENS must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Counts provider-reported usage until the session successfully invokes yield.
 * Observation happens at turn_end, after tools ran, so a yield on the turn that
 * crosses the ceiling always wins and can never be mistaken for non-yielding.
 */
export class SessionNoYieldCounter {
  private readonly limitTokens: number;
  private modelCalls = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private consumedTokens = 0;
  private bounded: SessionNoYieldRecord | null = null;

  constructor(limitTokens: number) {
    this.limitTokens = positiveSafeInteger(limitTokens, "session no-yield token limit");
  }

  observe(usage: SessionTurnUsage, yielded: boolean): SessionNoYieldRecord | null {
    if (this.bounded !== null) return this.bounded;
    const promptTokens = nonnegativeSafeInteger(usage.promptTokens, "session prompt tokens");
    const completionTokens = nonnegativeSafeInteger(usage.completionTokens, "session completion tokens");
    const totalTokens = nonnegativeSafeInteger(usage.totalTokens, "session total tokens");
    if (totalTokens < promptTokens + completionTokens) {
      throw new Error("session total tokens cannot be less than prompt plus completion tokens");
    }

    this.modelCalls += 1;
    this.promptTokens += promptTokens;
    this.completionTokens += completionTokens;
    this.consumedTokens += totalTokens;
    for (const [label, value] of Object.entries(this.snapshot())) {
      if (!Number.isSafeInteger(value)) throw new Error(`session ${label} exceeds the safe integer range`);
    }

    if (yielded || this.consumedTokens < this.limitTokens) return null;
    this.bounded = {
      type: SESSION_NO_YIELD_RECORD_TYPE,
      limitTokens: this.limitTokens,
      ...this.snapshot(),
    };
    return this.bounded;
  }

  snapshot(): SessionNoYieldSnapshot {
    return {
      modelCalls: this.modelCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      consumedTokens: this.consumedTokens,
    };
  }
}


/** Parse the last stdout line emitted by a worker stopped at the no-yield bound. */
export function parseSessionNoYieldRecord(stdout: string): SessionNoYieldRecord | null {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.type !== SESSION_NO_YIELD_RECORD_TYPE) return null;
  const limitTokens = record.limitTokens;
  const modelCalls = record.modelCalls;
  const promptTokens = record.promptTokens;
  const completionTokens = record.completionTokens;
  const consumedTokens = record.consumedTokens;
  if (
    typeof limitTokens !== "number"
    || typeof modelCalls !== "number"
    || typeof promptTokens !== "number"
    || typeof completionTokens !== "number"
    || typeof consumedTokens !== "number"
  ) return null;
  try {
    positiveSafeInteger(limitTokens, "session no-yield token limit");
    positiveSafeInteger(modelCalls, "session model calls");
    nonnegativeSafeInteger(promptTokens, "session prompt tokens");
    nonnegativeSafeInteger(completionTokens, "session completion tokens");
    nonnegativeSafeInteger(consumedTokens, "session consumed tokens");
  } catch {
    return null;
  }
  if (consumedTokens < limitTokens || consumedTokens < promptTokens + completionTokens) return null;
  return {
    type: SESSION_NO_YIELD_RECORD_TYPE,
    limitTokens,
    modelCalls,
    promptTokens,
    completionTokens,
    consumedTokens,
  };
}
