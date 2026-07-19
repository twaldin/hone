import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type DurableIo } from "./durable-io.js";
import { DurableLineLog } from "./tracelog.js";
import {
  M2_INNER_MODEL_ROUTE,
  M2_OUTER_MODEL_ROUTE,
  type CampaignPauseReason,
  type CampaignPauseSignal,
  type ProviderAttemptClassification,
  type ProxyPreflightObservation,
} from "@hone/schema";

/**
 * Versioned durable dispatch journal — the proxy's crash-safe budget/trace
 * authority. One NDJSON file per run (`proxy-dispatch.ndjson`), appended
 * through {@link DurableLineLog} (strictly ordered, fsync-per-line, torn-tail
 * recovery, fail-closed poison).
 *
 * STATE MACHINE (per dispatch id):
 *
 *   (admitted) --intent fsynced--> INTENDED --settle fsynced--> SETTLED
 *                                     |
 *                    crash / lost settle (journal replay)
 *                                     v
 *                                RECOVERED  (charged at the full reserved
 *                                            ceiling; trace missing forever)
 *
 * INVARIANTS:
 * - An `intent` record is durable (written + fsynced) BEFORE the upstream
 *   fetch it describes is attempted. A dispatch with no journal presence
 *   therefore PROVABLY never reached the upstream.
 * - Every intent is terminally matched by exactly one `settle` (normal
 *   operation) or exactly one `recovered` record (crash recovery). Charges
 *   are delivered to the broker once per dispatch: at settle time for live
 *   requests, or at the full reserved ceiling during recovery.
 * - Recovery writes its durable facts (`poison`, then per-intent
 *   `recovered`) BEFORE delivering the corresponding charge, so replaying
 *   recovery over the same journal never charges twice.
 * - Any unmatched intent, any settle with `traced: false` (CAS/trace
 *   publication failed), any `recovered` record, any `poison` record, any
 *   corrupt terminated line, and any unsupported version is a TERMINAL
 *   poison fact: the journal can never again be treated as a healthy log,
 *   across arbitrarily many restarts.
 * - A torn (unterminated) final fragment is NOT poison: its append never
 *   resolved, so the dispatch it described never proceeded past the intent
 *   barrier. It is dropped on read and truncated by the underlying log
 *   before any new append.
 */
export const DISPATCH_JOURNAL_VERSION = 1;
export const DISPATCH_JOURNAL_FILE = "proxy-dispatch.ndjson";

/** Pre-dispatch reservation fact: identity + admitted worst-case ceiling. */
export interface DispatchIntentRecord {
  v: number;
  kind: "intent";
  /** Unique dispatch id correlating intent and settlement. */
  id: string;
  runId: string;
  role: string;
  /** Legacy requested-route alias retained for version-1 journal readers. */
  model: string;
  /** Frozen route requested from the provider. */
  requestedRoute: string;
  /** One-based provider attempt within the client request or trusted preflight. */
  attempt: number;
  /** ISO timestamp the attempt arrived at the proxy. */
  requestAt: string;
  /** sha256 (hex) of the exact forwarded request body — reconciliation identity. */
  requestSha256: string;
  /** Byte-level prompt-token upper bound the reservation was priced at. */
  promptTokens: number;
  /** Admitted completion-token ceiling forwarded upstream. */
  completionTokens: number;
  /** Worst-case token charge if the outcome is never learned. */
  ceilTokens: number;
  /** Worst-case USD charge if the outcome is never learned. */
  ceilUsd: number;
}

export type DispatchSettleOutcome =
  /** Trustworthy upstream-reported usage. */
  | "usage"
  /** Fail-closed full-ceiling charge (missing/zero/malformed usage, ambiguous transport failure). */
  | "ceiling"
  /** PROVEN the upstream never accepted a connection — zero charge. */
  | "no-upstream"
  /** Unexpected handler failure after admission — full-ceiling charge. */
  | "error";

/** Terminal settlement: the actual charge delivered for one intent. */
export interface DispatchSettleRecord {
  v: number;
  kind: "settle";
  id: string;
  tokens: number;
  usd: number;
  /** Returned provider identity, null when no response identity was available. */
  returnedModel: string | null;
  classification: ProviderAttemptClassification;
  outcome: DispatchSettleOutcome;
  /**
   * True iff the dispatch's trace obligation was met: its CAS bodies and
   * trace line are durable, or provably no obligation existed
   * (`no-upstream`). False is a TERMINAL poison fact that survives restart.
   */
  traced: boolean;
  traceError?: string;
}

/** Crash-recovery settlement: an unmatched intent charged at its full ceiling. */
export interface DispatchRecoveredRecord {
  v: number;
  kind: "recovered";
  id: string;
  tokens: number;
  usd: number;
  at: string;
}

/** Durable terminal poison fact — the run's dispatch/corpus authority failed. */
export interface DispatchPoisonRecord {
  v: number;
  kind: "poison";
  reason: string;
  at: string;
}

/** Durable, resumable campaign seal. Unlike poison, a successful frozen-route preflight may clear it. */
export interface DispatchPauseRecord extends CampaignPauseSignal {
  v: number;
  kind: "pause";
}

/** Durable proof that the active pause was cleared only after both frozen routes passed preflight. */
export interface DispatchResumeRecord {
  v: number;
  kind: "resume";
  pauseId: string;
  at: string;
  observations: [ProxyPreflightObservation, ProxyPreflightObservation];
}

export type DispatchRecord =
  | DispatchIntentRecord
  | DispatchSettleRecord
  | DispatchRecoveredRecord
  | DispatchPoisonRecord
  | DispatchPauseRecord
  | DispatchResumeRecord;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonNegNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

const M2_PREFLIGHT_ROLES: Record<ProxyPreflightObservation["role"], true> = {
  "outer-optimizer": true,
  "capsule-author": true,
  "inner-capsule-improvement": true,
};

function parsePreflightObservation(value: unknown): ProxyPreflightObservation | undefined {
  if (!isRecord(value)) return undefined;
  const role = value["role"];
  if (
    typeof role !== "string" ||
    M2_PREFLIGHT_ROLES[role as ProxyPreflightObservation["role"]] !== true ||
    !nonEmptyString(value["requestedRoute"]) ||
    !(value["returnedModel"] === null || nonEmptyString(value["returnedModel"])) ||
    !(value["status"] === null || (typeof value["status"] === "number" && Number.isInteger(value["status"]))) ||
    typeof value["passed"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    role: role as ProxyPreflightObservation["role"],
    requestedRoute: value["requestedRoute"],
    returnedModel: value["returnedModel"],
    status: value["status"],
    passed: value["passed"],
  };
}

const SETTLE_OUTCOMES: Record<string, true> = { usage: true, ceiling: true, "no-upstream": true, error: true };
const ATTEMPT_CLASSIFICATIONS: Record<ProviderAttemptClassification, true> = {
  success: true,
  "candidate-invalidity": true,
  "client-invalidity": true,
  retry: true,
  "campaign-pause": true,
};

const PAUSE_REASONS: Record<CampaignPauseReason, true> = {
  "proxy-failover": true,
  "provider-auth": true,
  "provider-payment": true,
  "provider-rate-limit": true,
  "provider-transport": true,
  "provider-5xx": true,
  "returned-model-drift": true,
};

/**
 * Strict parse of one terminated journal line. Throws with a reason on ANY
 * deviation — an unreadable record means the journal's history is unknown,
 * and the caller must fail closed rather than guess.
 */
export function parseDispatchRecord(line: string): DispatchRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("not valid JSON");
  }
  if (!isRecord(raw)) throw new Error("not a JSON object");
  if (raw["v"] !== DISPATCH_JOURNAL_VERSION) {
    throw new Error(
      typeof raw["v"] === "number"
        ? `unsupported dispatch journal version ${raw["v"]}`
        : "missing journal version",
    );
  }
  const kind = raw["kind"];
  switch (kind) {
    case "intent": {
      const requestedRoute = raw["requestedRoute"] ?? raw["model"];
      const attempt = raw["attempt"] ?? 1;
      if (
        !nonEmptyString(raw["id"]) ||
        !nonEmptyString(raw["runId"]) ||
        !nonEmptyString(raw["role"]) ||
        !nonEmptyString(raw["model"]) ||
        !nonEmptyString(requestedRoute) ||
        !positiveInt(attempt) ||
        !nonEmptyString(raw["requestAt"]) ||
        !nonEmptyString(raw["requestSha256"]) ||
        !nonNegInt(raw["promptTokens"]) ||
        !nonNegInt(raw["completionTokens"]) ||
        !nonNegInt(raw["ceilTokens"]) ||
        !nonNegNum(raw["ceilUsd"])
      ) {
        throw new Error("malformed intent record");
      }
      return {
        v: DISPATCH_JOURNAL_VERSION,
        kind: "intent",
        id: raw["id"],
        runId: raw["runId"],
        role: raw["role"],
        model: raw["model"],
        requestedRoute,
        attempt,
        requestAt: raw["requestAt"],
        requestSha256: raw["requestSha256"],
        promptTokens: raw["promptTokens"],
        completionTokens: raw["completionTokens"],
        ceilTokens: raw["ceilTokens"],
        ceilUsd: raw["ceilUsd"],
      };
    }
    case "settle": {
      const outcome = raw["outcome"];
      const returnedModel = raw["returnedModel"] ?? null;
      const classification = raw["classification"] ?? "success";
      if (
        !nonEmptyString(raw["id"]) ||
        !nonNegInt(raw["tokens"]) ||
        !nonNegNum(raw["usd"]) ||
        !(returnedModel === null || nonEmptyString(returnedModel)) ||
        typeof classification !== "string" ||
        ATTEMPT_CLASSIFICATIONS[classification as ProviderAttemptClassification] !== true ||
        typeof outcome !== "string" ||
        SETTLE_OUTCOMES[outcome] !== true ||
        typeof raw["traced"] !== "boolean" ||
        (raw["traceError"] !== undefined && typeof raw["traceError"] !== "string")
      ) {
        throw new Error("malformed settle record");
      }
      return {
        v: DISPATCH_JOURNAL_VERSION,
        kind: "settle",
        id: raw["id"],
        tokens: raw["tokens"],
        usd: raw["usd"],
        returnedModel,
        classification: classification as ProviderAttemptClassification,
        outcome: outcome as DispatchSettleOutcome,
        traced: raw["traced"],
        ...(typeof raw["traceError"] === "string" ? { traceError: raw["traceError"] } : {}),
      };
    }
    case "recovered": {
      if (
        !nonEmptyString(raw["id"]) ||
        !nonNegInt(raw["tokens"]) ||
        !nonNegNum(raw["usd"]) ||
        !nonEmptyString(raw["at"])
      ) {
        throw new Error("malformed recovered record");
      }
      return {
        v: DISPATCH_JOURNAL_VERSION,
        kind: "recovered",
        id: raw["id"],
        tokens: raw["tokens"],
        usd: raw["usd"],
        at: raw["at"],
      };
    }
    case "poison": {
      if (!nonEmptyString(raw["reason"]) || !nonEmptyString(raw["at"])) {
        throw new Error("malformed poison record");
      }
      return { v: DISPATCH_JOURNAL_VERSION, kind: "poison", reason: raw["reason"], at: raw["at"] };
    }
    case "pause": {
      const reason = raw["reason"];
      if (
        !nonEmptyString(raw["pauseId"]) ||
        !nonEmptyString(raw["runId"]) ||
        typeof reason !== "string" ||
        PAUSE_REASONS[reason as CampaignPauseReason] !== true ||
        !nonEmptyString(raw["at"]) ||
        !nonEmptyString(raw["role"]) ||
        !nonEmptyString(raw["requestedRoute"]) ||
        !(raw["returnedModel"] === null || nonEmptyString(raw["returnedModel"])) ||
        !(raw["status"] === null || (typeof raw["status"] === "number" && Number.isInteger(raw["status"]))) ||
        !positiveInt(raw["attempt"])
      ) {
        throw new Error("malformed pause record");
      }
      return {
        v: DISPATCH_JOURNAL_VERSION,
        kind: "pause",
        version: 1,
        pauseId: raw["pauseId"],
        runId: raw["runId"],
        reason: reason as CampaignPauseReason,
        at: raw["at"],
        role: raw["role"],
        requestedRoute: raw["requestedRoute"],
        returnedModel: raw["returnedModel"],
        status: raw["status"],
        attempt: raw["attempt"],
      };
    }
    case "resume": {
      if (
        !nonEmptyString(raw["pauseId"]) ||
        !nonEmptyString(raw["at"]) ||
        !Array.isArray(raw["observations"]) ||
        raw["observations"].length !== 2
      ) {
        throw new Error("malformed resume record");
      }
      const first = parsePreflightObservation(raw["observations"][0]);
      const second = parsePreflightObservation(raw["observations"][1]);
      if (first === undefined || second === undefined || !first.passed || !second.passed) {
        throw new Error("malformed resume observations");
      }
      return {
        v: DISPATCH_JOURNAL_VERSION,
        kind: "resume",
        pauseId: raw["pauseId"],
        at: raw["at"],
        observations: [first, second],
      };
    }
    default:
      throw new Error(`unknown record kind ${JSON.stringify(kind)}`);
  }
}

/** Replayed journal state — everything recovery and the poison gate need. */
export interface DispatchJournalState {
  /** Every parseable record, in journal order. */
  records: DispatchRecord[];
  /** First durable terminal poison fact, if any. */
  poisoned: string | undefined;
  /** Intents with no settle/recovered match — pre-dispatch charges a crash orphaned. */
  unmatched: DispatchIntentRecord[];
  /** Sum of every settled + recovered charge in the journal. */
  chargedTotals: { tokens: number; usd: number };
  /** Active durable provider pause, if the latest pause has no valid resume. */
  pause: CampaignPauseSignal | undefined;
}

/**
 * Read terminated journal lines. A final unterminated fragment is a torn
 * tail from a crash mid-append: that append never resolved, so the dispatch
 * it described never proceeded — it is dropped, exactly mirroring the
 * truncation {@link DurableLineLog} performs before its first new append.
 */
async function readJournalLines(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n");
  // For a fully terminated file the final element is ""; otherwise it is the
  // torn fragment. Either way it is not a durable record.
  lines.pop();
  return lines.filter((l) => l !== "");
}

/** Replay the journal into its terminal state. Never writes. */
export async function readDispatchJournalState(filePath: string): Promise<DispatchJournalState> {
  const lines = await readJournalLines(filePath);
  const records: DispatchRecord[] = [];
  const intents = new Map<string, DispatchIntentRecord>();
  const settlements = new Map<string, DispatchSettleRecord | DispatchRecoveredRecord>();
  let poisoned: string | undefined;
  let activePause: CampaignPauseSignal | undefined;
  const poison = (reason: string): void => {
    poisoned ??= reason;
  };
  for (const [index, line] of lines.entries()) {
    let record: DispatchRecord;
    try {
      record = parseDispatchRecord(line);
    } catch (err) {
      // Unknown history = fail closed. Parseable records BEFORE the corrupt
      // line still reconcile (more charging, never less).
      poison(
        `corrupt dispatch journal line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    records.push(record);
    switch (record.kind) {
      case "intent":
        if (intents.has(record.id)) poison(`duplicate intent ${record.id}`);
        else intents.set(record.id, record);
        break;
      case "settle":
        if (!intents.has(record.id)) poison(`settle without intent ${record.id}`);
        if (settlements.has(record.id)) poison(`duplicate settlement for ${record.id}`);
        else settlements.set(record.id, record);
        if (!record.traced) {
          poison(
            `trace/CAS publication failed for dispatch ${record.id}${
              record.traceError === undefined ? "" : `: ${record.traceError}`
            }`,
          );
        }
        break;
      case "recovered":
        if (!intents.has(record.id)) poison(`recovered record without intent ${record.id}`);
        if (settlements.has(record.id)) poison(`duplicate settlement for ${record.id}`);
        else settlements.set(record.id, record);
        poison(`dispatch ${record.id} was recovered at its ceiling; its trace is missing`);
        break;
      case "poison":
        poison(record.reason);
        break;
      case "pause":
        activePause = {
          version: record.version,
          pauseId: record.pauseId,
          runId: record.runId,
          reason: record.reason,
          at: record.at,
          role: record.role,
          requestedRoute: record.requestedRoute,
          returnedModel: record.returnedModel,
          status: record.status,
          attempt: record.attempt,
        };
        break;
      case "resume": {
        const outer = record.observations.find((observation) => observation.role === "outer-optimizer");
        const inner = record.observations.find(
          (observation) => observation.role === "inner-capsule-improvement",
        );
        if (activePause === undefined) {
          poison(`resume without active pause ${record.pauseId}`);
        } else if (record.pauseId !== activePause.pauseId) {
          poison(`resume ${record.pauseId} does not match active pause ${activePause.pauseId}`);
        } else if (
          outer?.requestedRoute !== M2_OUTER_MODEL_ROUTE ||
          outer.returnedModel !== M2_OUTER_MODEL_ROUTE ||
          !outer.passed ||
          inner?.requestedRoute !== M2_INNER_MODEL_ROUTE ||
          inner.returnedModel !== M2_INNER_MODEL_ROUTE ||
          !inner.passed
        ) {
          poison(`resume ${record.pauseId} lacks both frozen-route identity proofs`);
        } else {
          activePause = undefined;
        }
        break;
      }
    }
  }
  let tokens = 0;
  let usd = 0;
  for (const s of settlements.values()) {
    tokens += s.tokens;
    usd += s.usd;
  }
  return {
    records,
    poisoned,
    unmatched: [...intents.values()].filter((i) => !settlements.has(i.id)),
    pause: activePause,
    chargedTotals: { tokens, usd },
  };
}

/** One ceiling charge delivered by crash recovery. */
export interface RecoveredCharge {
  id: string;
  role: string;
  model: string;
  requestAt: string;
  tokens: number;
  usd: number;
}

export interface DispatchRecoveryReport {
  /** Terminal poison reason — set iff the run may never forward again. */
  poisoned: string | undefined;
  /** Ceiling charges delivered by THIS recovery pass (already recordSpend-ed). */
  recovered: RecoveredCharge[];
  /** Sum of every settled + recovered charge, including this pass. */
  chargedTotals: { tokens: number; usd: number };
  /** Active durable provider pause. It seals dispatch but is resumable after trusted preflight. */
  pause?: CampaignPauseSignal | undefined;
}

/**
 * Append-side handle over the journal. All appends are serialized and
 * fsynced by the underlying {@link DurableLineLog}; any append failure
 * permanently poisons the log (fail closed).
 */
export class DispatchJournal {
  readonly filePath: string;
  private readonly log: DurableLineLog;

  constructor(filePath: string, io?: Partial<DurableIo>) {
    this.filePath = resolve(filePath);
    this.log = new DurableLineLog(this.filePath, io);
  }

  /** Live (in-memory) poison of the underlying log, if any append/open ever failed. */
  get poisoned(): Error | undefined {
    return this.log.poisoned;
  }

  /** Externally poison the journal — first error wins. */
  fail(err: Error): void {
    this.log.fail(err);
  }

  /**
   * Durably record a pre-dispatch intent. Resolution means the complete
   * record is on disk and fsynced — only then may the upstream fetch start.
   */
  intent(fields: Omit<DispatchIntentRecord, "v" | "kind">): Promise<void> {
    return this.append({ v: DISPATCH_JOURNAL_VERSION, kind: "intent", ...fields });
  }

  /** Durably record the terminal settlement for an intent. */
  settle(fields: Omit<DispatchSettleRecord, "v" | "kind">): Promise<void> {
    return this.append({ v: DISPATCH_JOURNAL_VERSION, kind: "settle", ...fields });
  }

  /** Durably seal all new model dispatches. Resolution means the pause survives restart. */
  pause(fields: Omit<DispatchPauseRecord, "v" | "kind">): Promise<void> {
    return this.append({ v: DISPATCH_JOURNAL_VERSION, kind: "pause", ...fields });
  }

  /** Durably clear exactly the active pause after both frozen routes passed trusted preflight. */
  resume(fields: Omit<DispatchResumeRecord, "v" | "kind">): Promise<void> {
    return this.append({ v: DISPATCH_JOURNAL_VERSION, kind: "resume", ...fields });
  }

  /**
   * Startup reconciliation. MUST complete before any new intent is appended
   * and before any admission decision.
   *
   * Every unmatched intent is charged at its FULL reserved ceiling, exactly
   * once across arbitrarily many replays: the durable `poison` and
   * per-intent `recovered` facts are fsynced BEFORE the corresponding
   * `recordSpend` is delivered, so a replay sees the intent matched and
   * never re-charges. Any poison found or created here is terminal — the
   * caller must refuse all further dispatch.
   */
  async recover(
    recordSpend: (spend: { tokens: number; usd: number }) => void | Promise<void>,
  ): Promise<DispatchRecoveryReport> {
    const state = await readDispatchJournalState(this.filePath);
    let poisoned = state.poisoned;
    const recovered: RecoveredCharge[] = [];
    let tokens = state.chargedTotals.tokens;
    let usd = state.chargedTotals.usd;
    if (state.unmatched.length > 0) {
      const ids = state.unmatched.map((i) => i.id).join(", ");
      const reason =
        `crash recovery: ${state.unmatched.length} dispatch intent(s) had no settlement (${ids}); ` +
        `each is charged at its full reserved ceiling and its trace is missing forever`;
      // Durable terminal poison FIRST: even a crash inside the loop below
      // leaves the journal explicitly failed, never silently healthy.
      await this.append({
        v: DISPATCH_JOURNAL_VERSION,
        kind: "poison",
        reason,
        at: new Date().toISOString(),
      });
      poisoned ??= reason;
      for (const intent of state.unmatched) {
        // Recovered fact durable BEFORE the charge: replay-safe exactly-once.
        await this.append({
          v: DISPATCH_JOURNAL_VERSION,
          kind: "recovered",
          id: intent.id,
          tokens: intent.ceilTokens,
          usd: intent.ceilUsd,
          at: new Date().toISOString(),
        });
        await recordSpend({ tokens: intent.ceilTokens, usd: intent.ceilUsd });
        recovered.push({
          id: intent.id,
          role: intent.role,
          model: intent.model,
          requestAt: intent.requestAt,
          tokens: intent.ceilTokens,
          usd: intent.ceilUsd,
        });
        tokens += intent.ceilTokens;
        usd += intent.ceilUsd;
      }
    }
    return { poisoned, pause: state.pause, recovered, chargedTotals: { tokens, usd } };
  }

  /** Drain queued appends and close; rejects if the journal was ever poisoned. */
  close(): Promise<void> {
    return this.log.close();
  }

  private append(record: DispatchRecord): Promise<void> {
    return this.log.append(JSON.stringify(record));
  }
}
