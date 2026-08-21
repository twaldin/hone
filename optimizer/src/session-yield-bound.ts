import {
  SESSION_NO_YIELD_EXIT_CODE,
  SESSION_NO_YIELD_RECORD_TYPE,
  SESSION_USAGE_ANOMALY_RECORD_TYPE,
  SessionNoYieldRecord as SessionNoYieldRecordSchema,
  type SessionNoYieldRecord,
} from "@hone/schema";

export {
  SESSION_NO_YIELD_EXIT_CODE,
  SESSION_USAGE_ANOMALY_RECORD_TYPE,
  SESSION_NO_YIELD_RECORD_TYPE,
  type SessionNoYieldRecord,
};

/**
 * Calibrated to more than twice the largest successful-yield segment in the
 * 80-run M2 saturation corpus: 721,625 tokens
 * (run_calibration_6de9863750b31cbec690b5b9, episode 0).
 */
export const DEFAULT_SESSION_NO_YIELD_MAX_TOKENS = 1_500_000;

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

export type SessionUsageAnomalyKind = "zero-usage" | "normalized";


function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function defensiveTokenCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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

  constructor(
    limitTokens: number,
    private readonly onUsageAnomaly?: (kind: SessionUsageAnomalyKind) => void,
  ) {
    this.limitTokens = positiveSafeInteger(limitTokens, "session no-yield token limit");
  }

  observe(usage: SessionTurnUsage, yielded: boolean): SessionNoYieldRecord | null {
    if (this.bounded !== null) return this.bounded;
    const promptTokens = defensiveTokenCount(usage.promptTokens);
    const completionTokens = defensiveTokenCount(usage.completionTokens);
    const componentTotal = Math.min(Number.MAX_SAFE_INTEGER, promptTokens + completionTokens);
    const reportedTotal = defensiveTokenCount(usage.totalTokens);
    const totalTokens = Math.max(reportedTotal, componentTotal);
    const normalized =
      promptTokens !== usage.promptTokens
      || completionTokens !== usage.completionTokens
      || totalTokens !== usage.totalTokens;
    // The SDK exposes the same all-zero tuple for genuinely absent usage and
    // a true zero-token turn. Preserve that ambiguity as durable telemetry;
    // never silently pretend the accumulator observed billable usage.
    const zeroUsage =
      usage.promptTokens === 0
      && usage.completionTokens === 0
      && usage.totalTokens === 0;
    if (zeroUsage) this.onUsageAnomaly?.("zero-usage");
    else if (normalized) this.onUsageAnomaly?.("normalized");

    this.modelCalls = Math.min(Number.MAX_SAFE_INTEGER, this.modelCalls + 1);
    this.promptTokens = Math.min(Number.MAX_SAFE_INTEGER, this.promptTokens + promptTokens);
    this.completionTokens = Math.min(Number.MAX_SAFE_INTEGER, this.completionTokens + completionTokens);
    this.consumedTokens = Math.min(Number.MAX_SAFE_INTEGER, this.consumedTokens + totalTokens);

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
  try {
    const parsed = SessionNoYieldRecordSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
