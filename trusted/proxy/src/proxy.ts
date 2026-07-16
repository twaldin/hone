import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  PROXY_TRACE_VERSION,
  ProxyTraceRecord,
  type BudgetExceededError,
  type ModelRouting,
} from "@hone/schema";
import { casWrite } from "./cas.js";
import { DispatchJournal, DISPATCH_JOURNAL_FILE, type DispatchRecoveryReport, type DispatchSettleOutcome } from "./dispatch-journal.js";
import { type DurableIo } from "./durable-io.js";
import { DurableLineLog } from "./tracelog.js";
import { extractSseUsage, isJsonObject, normalizeUsage, ZERO_USAGE, type Usage } from "./sse.js";

export const DEFAULT_UPSTREAM = "http://127.0.0.1:8317";

/** Per-run trace log file name, appended under `runDir`. */
export const PROXY_TRACE_FILE = "proxy-trace.ndjson";

/** Per-run bearer identity handed to a sandbox. Never contains upstream credentials. */
export interface ProxyAuthToken {
  token: string;
  runId: string;
  role: string;
}

/** Static pricing entry, USD per million tokens. Models absent from the table cost 0 (subscription upstream). */
export interface PricingEntry {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}
export type PricingTable = Record<string, PricingEntry>;

export type BudgetDimension = BudgetExceededError["error"]["dimension"];

/**
 * Quantitative budget snapshot. `remaining` is the run envelope minus spend
 * already recorded broker-side. The proxy layers its own in-flight
 * reservations on top of `remaining`, so the wiring MUST NOT try to
 * pre-subtract proxy activity — report exactly `envelope - spent`.
 */
export type BudgetDecision =
  | { allowed: true; remaining: SpendRecord }
  | { allowed: false; dimension: BudgetDimension; message?: string };

export interface SpendRecord {
  tokens: number;
  usd: number;
}

/** Hard resource bounds. Every field has a safe default (DEFAULT_LIMITS). */
export interface ProxyLimits {
  /** Inbound request bodies above this many bytes are rejected 413; buffering stops at the cap. */
  maxRequestBytes: number;
  /** Upstream response accumulation cap; the upstream connection is ABORTED above it. */
  maxResponseBytes: number;
  /** Hard per-request completion-token ceiling, and the default ceiling when the client omits one. */
  maxCompletionTokens: number;
  /**
   * Global ceiling on concurrently handled requests (completions AND
   * /v1/models). The slot is acquired BEFORE any body byte is buffered or
   * any upstream work starts; excess requests are rejected 503 with
   * `connection: close` and their body is never drained. This makes the
   * per-request byte caps aggregate bounds: proxy buffering never exceeds
   * maxActiveRequests * (maxRequestBytes + maxResponseBytes).
   */
  maxActiveRequests: number;
  /** Socket-level connection ceiling — fd/header-buffer backstop behind maxActiveRequests. */
  maxConnections: number;
}

export const DEFAULT_LIMITS: ProxyLimits = {
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024,
  maxCompletionTokens: 32_768,
  maxActiveRequests: 16,
  maxConnections: 256,
};

/**
 * Config in, callbacks out — no global state. The runner (WP7) wires
 * `checkBudget`/`recordSpend` to the broker admin socket; tests inject stubs.
 */
export interface ProxyConfig {
  runId: string;
  /** Per-role model routing (@hone/schema). The proxy OVERWRITES the request's model field. */
  routing: ModelRouting;
  /** Per-run dir (`.hone-runs/<runId>`); `proxy-trace.ndjson` is appended here. */
  runDir: string;
  /** CAS root (the `.hone-cas` directory): `sha256/<first2>/<fullhash>`. */
  casDir: string;
  /** Default vibeproxy at :8317. Sandboxes never see this URL or the key. */
  upstreamBaseUrl?: string;
  /** Injected as `Authorization: Bearer <key>` upstream; never surfaces client-side. */
  upstreamApiKey?: string;
  pricing?: PricingTable;
  /** Byte/token hard caps; unset fields fall back to DEFAULT_LIMITS. */
  limits?: Partial<ProxyLimits>;
  /**
   * Consulted inside the admission lock before every completion forward.
   * Must report `remaining = envelope - recordedSpend`; denial → 402, no
   * upstream call. The proxy admits a request only if its WORST-CASE spend
   * fits in `remaining` minus all currently held reservations.
   */
  checkBudget: () => BudgetDecision | Promise<BudgetDecision>;
  /**
   * Called exactly once per admitted request with the settled charge:
   * trustworthy actual usage when the upstream reported it, otherwise the
   * full reservation ceiling (fail closed — never zero for a request that
   * may have consumed upstream capacity).
   */
  recordSpend: (spend: SpendRecord) => void | Promise<void>;
  /**
   * Trusted notification that admission refused because the requested work
   * cannot fit in the remaining envelope. The broker persists this as an
   * exhausted boundary so an unbounded optimizer cannot retry 402 forever.
   */
  recordBudgetExhaustion?: (dimension: BudgetDimension) => void | Promise<void>;
  /**
   * TEST-ONLY fault injection for the durable trace log (short writes,
   * fsync failures). Production wiring must leave this unset.
   */
  traceIo?: Partial<DurableIo>;
  /**
   * TEST-ONLY fault injection for CAS publication. Production wiring must
   * leave this unset.
   */
  casIo?: Partial<DurableIo>;
  /**
   * TEST-ONLY fault injection for the durable dispatch journal. Production
   * wiring must leave this unset.
   */
  journalIo?: Partial<DurableIo>;
}

export interface ProxyHandle {
  /** Tokens minted at construction, one per role in the routing table. */
  readonly tokens: readonly ProxyAuthToken[];
  /** Bearer token for a role; throws on unknown role. */
  tokenFor(role: string): string;
  /** Bind the unix socket (`proxy.sock`). Removes a stale socket file first. */
  listenUnix(socketPath: string): Promise<void>;
  /** Bind 127.0.0.1 TCP (tests); returns the bound port. */
  listenTcp(port: number, host?: string): Promise<number>;
  /**
   * Startup dispatch-journal reconciliation (kicked off at construction).
   * Resolves — never rejects — with the recovery report: recovered ceiling
   * charges (already delivered through `recordSpend`) and the terminal
   * poison reason, if the run may never forward again.
   */
  dispatchRecovery(): Promise<DispatchRecoveryReport>;
  /**
   * True handler-quiescence barrier: stops accepting, aborts every in-flight
   * upstream exchange, destroys client connections, and resolves only after
   * every admitted handler has settled its reservation, recorded spend, and
   * appended its journal/CAS/trace records. No recordSpend call, reservation
   * change, journal append, CAS write, or trace append can occur after
   * resolution. If the trace log or the dispatch journal was ever poisoned
   * (this process or a prior one), close REJECTS (idempotently, after full
   * quiescence) with that failure — a run whose corpus/dispatch authority
   * failed never reports a clean shutdown. Idempotent.
   */
  close(): Promise<void>;
}

interface TraceInput {
  role: string;
  model: string;
  requestAt: string;
  startedAt: number;
  status: number;
  usage: Usage;
  estimatedUsd: number;
  requestText: string;
  responseText: string;
}

/** Worst-case capacity held for one in-flight request. */
interface Reservation {
  tokens: number;
  usd: number;
  promptTokens: number;
  completionTokens: number;
}

type Admission =
  | { ok: true; reservation: Reservation }
  | { ok: false; dimension: BudgetDimension; message: string; terminal: boolean };

/** Positive safe integer (client-supplied token ceilings). */
function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Non-finite or negative headroom from the wiring is treated as exhausted. */
function saneHeadroom(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Framing allowance added to the byte-count prompt bound: tokens the
 * upstream may charge for that are NOT bytes of the forwarded JSON —
 * chat-template preamble, BOS/EOS markers, and the admitted ceiling field
 * injected after admission (`"max_tokens":NNNNN,` is well under 64 bytes).
 */
export const PROMPT_FRAMING_BASE_TOKENS = 64;
/** Per-message wrapper allowance (role/name markers a chat template adds around each message). */
export const PROMPT_FRAMING_PER_MESSAGE_TOKENS = 8;

/**
 * TRUE upper bound on prompt tokens, used for admission reservations and
 * for the missing-usage settlement ceiling.
 *
 * INVARIANT: a byte-level tokenizer (BPE and every derivative the routed
 * providers use) cannot emit more than one token per input byte — every
 * token consumes at least one byte. The raw UTF-8 byte count of the request
 * is therefore an upper bound on honestly reported prompt tokens for that
 * text; the bounded framing terms cover provider chat-template overhead.
 * Unlike an average bytes-per-token ratio, honest usage can never exceed
 * this reservation, so an admitted request cannot cross the token or
 * priced-USD envelope in a single upstream call.
 *
 * `rawBytes` is the exact client-sent body byte count; `forwardBytes` the
 * rewritten upstream payload (model overwrite, stream_options injection,
 * ceiling fields stripped) — the max of the two bounds whichever text the
 * provider actually tokenizes.
 */
export function promptTokenUpperBound(
  rawBytes: number,
  forwardBytes: number,
  messageCount: number,
): number {
  return (
    Math.max(1, rawBytes, forwardBytes) +
    PROMPT_FRAMING_BASE_TOKENS +
    PROMPT_FRAMING_PER_MESSAGE_TOKENS * messageCount
  );
}

type CompletionBounds =
  | { ok: true; requested: number | undefined; field: "max_tokens" | "max_completion_tokens" }
  | { ok: false; message: string };

/**
 * M0 multiplicity policy: exactly one completion per request. `n` other than
 * 1 and any `best_of` are rejected — both multiply completion output per
 * unit of admitted budget. `max_tokens`/`max_completion_tokens` collapse to
 * ONE trusted ceiling (conflicts rejected, values clamped to the hard cap).
 */
function completionBounds(body: Record<string, unknown>, hardCap: number): CompletionBounds {
  const n = body["n"];
  if (n !== undefined && n !== null && n !== 1) {
    return { ok: false, message: "n must be exactly 1" };
  }
  const bestOf = body["best_of"];
  if (bestOf !== undefined && bestOf !== null) {
    return { ok: false, message: "best_of is not permitted" };
  }
  const ceilingField = (key: "max_tokens" | "max_completion_tokens"): { value?: number; err?: string } => {
    const raw = body[key];
    if (raw === undefined || raw === null) return {};
    if (!positiveInt(raw)) return { err: `${key} must be a positive integer` };
    return { value: raw };
  };
  const mt = ceilingField("max_tokens");
  if (mt.err !== undefined) return { ok: false, message: mt.err };
  const mct = ceilingField("max_completion_tokens");
  if (mct.err !== undefined) return { ok: false, message: mct.err };
  if (mt.value !== undefined && mct.value !== undefined && mt.value !== mct.value) {
    return {
      ok: false,
      message: "conflicting max_tokens and max_completion_tokens (one completion ceiling per request)",
    };
  }
  const requestedRaw = mt.value ?? mct.value;
  return {
    ok: true,
    requested: requestedRaw === undefined ? undefined : Math.min(requestedRaw, hardCap),
    // Preserve the client's field so o-series-style upstreams that reject
    // legacy max_tokens keep working; default injection uses max_tokens.
    field: mt.value === undefined && mct.value !== undefined ? "max_completion_tokens" : "max_tokens",
  };
}

/** Transport-error codes that PROVE no upstream request was accepted (no connection was ever established). */
const NO_UPSTREAM_ACCEPT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function collectErrorCodes(err: unknown, out: Set<string>, depth: number): void {
  if (depth > 4 || typeof err !== "object" || err === null) return;
  if ("code" in err && typeof err.code === "string") out.add(err.code);
  if ("cause" in err) collectErrorCodes(err.cause, out, depth + 1);
  if ("errors" in err && Array.isArray(err.errors)) {
    for (const inner of err.errors) collectErrorCodes(inner, out, depth + 1);
  }
}

/**
 * True only when EVERY failure code proves the connection was never
 * established (refused / unresolvable / connect timeout). Anything
 * ambiguous (reset mid-flight, protocol error, unknown) is treated as
 * "the upstream may have accepted the request" → charge conservatively.
 */
function provenNoUpstreamAccept(err: unknown): boolean {
  const codes = new Set<string>();
  collectErrorCodes(err, codes, 0);
  if (codes.size === 0) return false;
  for (const code of codes) {
    if (!NO_UPSTREAM_ACCEPT_CODES.has(code)) return false;
  }
  return true;
}

type BodyRead = { tooLarge: true } | { tooLarge: false; text: string };

/** Buffer the inbound body, stopping the moment the cap is crossed — no unbounded arrays. */
function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.resolve({ tooLarge: true });
  }
  return new Promise<BodyRead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) {
        done = true;
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve({ tooLarge: false, text: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
    // A client that vanishes mid-body emits 'close' WITHOUT 'end' (and not
    // always 'error'); the promise must still settle or the caller's
    // request slot would be pinned forever.
    req.on("close", () => {
      if (done) return;
      done = true;
      reject(new Error("client closed the connection before the request body completed"));
    });
  });
}

export function createProxy(config: ProxyConfig): ProxyHandle {
  const limits: ProxyLimits = { ...DEFAULT_LIMITS, ...config.limits };

  const tokens: ProxyAuthToken[] = Object.keys(config.routing).map((role) => ({
    token: `hone_${randomBytes(24).toString("hex")}`,
    runId: config.runId,
    role,
  }));
  const byToken = new Map(tokens.map((t) => [t.token, t]));

  // -------------------------------------------------------------------------
  // Reservation ledger.
  //
  // INVARIANT: with envelope E and broker-recorded spend S (surfaced as
  // `checkBudget().remaining = E - S`), at every instant
  //     S + Σ reservations(in-flight) + worstCase(candidate) <= E
  // is required for the candidate to be admitted. Admission (checkBudget +
  // reserve) is serialized through `admissionQueue`, so two parallel requests
  // can never both be admitted against the same headroom. Settlement records
  // the charge FIRST (broker spend grows) and releases the reservation only
  // after `recordSpend` resolves, so the sum above is conservatively
  // double-counted — never under-counted — during the handover window.
  // -------------------------------------------------------------------------
  let reservedTokens = 0;
  let reservedUsd = 0;
  let admissionQueue: Promise<void> = Promise.resolve();

  function admitSerialized(
    promptTokens: number,
    requested: number | undefined,
    pricing: PricingEntry | undefined,
  ): Promise<Admission> {
    const run = admissionQueue.then(() => admit(promptTokens, requested, pricing));
    admissionQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function admit(
    promptTokens: number,
    requested: number | undefined,
    pricing: PricingEntry | undefined,
  ): Promise<Admission> {
    const decision = await config.checkBudget();
    if (!decision.allowed) {
      return {
        ok: false,
        dimension: decision.dimension,
        message: decision.message ?? `run budget exceeded (${decision.dimension})`,
        terminal: true,
      };
    }
    const rawTokenHeadroom = saneHeadroom(decision.remaining.tokens);
    const rawUsdHeadroom = saneHeadroom(decision.remaining.usd);
    const tokenHeadroom = rawTokenHeadroom - reservedTokens;
    const usdHeadroom = rawUsdHeadroom - reservedUsd;
    const inUsd = pricing === undefined ? 0 : (promptTokens / 1e6) * pricing.inputUsdPerMTok;
    const outUsdPerTok = pricing === undefined ? 0 : pricing.outputUsdPerMTok / 1e6;

    let completion: number;
    if (requested !== undefined) {
      completion = requested;
    } else {
      // Client omitted a ceiling: derive one that fits the remaining
      // envelope, bounded by the hard cap. Never derive for an EXPLICIT
      // request — those get 402 below rather than silent shrinking.
      const tokenBound = Math.floor(tokenHeadroom) - promptTokens;
      completion = Math.min(limits.maxCompletionTokens, tokenBound);
      if (outUsdPerTok > 0) {
        completion = Math.min(completion, Math.floor((usdHeadroom - inUsd) / outUsdPerTok));
      }
      if (completion < 1) {
        let rawCompletion = Math.min(limits.maxCompletionTokens, Math.floor(rawTokenHeadroom) - promptTokens);
        if (outUsdPerTok > 0) {
          rawCompletion = Math.min(rawCompletion, Math.floor((rawUsdHeadroom - inUsd) / outUsdPerTok));
        }
        return {
          ok: false,
          dimension: tokenBound < 1 ? "tokens" : "usd",
          message: "no completion budget remains for this request",
          terminal: rawCompletion < 1,
        };
      }
    }

    const wcTokens = promptTokens + completion;
    const wcUsd = inUsd + completion * outUsdPerTok;
    if (wcTokens > tokenHeadroom) {
      return {
        ok: false,
        dimension: "tokens",
        message: `worst-case ${wcTokens} tokens exceeds remaining token headroom`,
        terminal: wcTokens > rawTokenHeadroom,
      };
    }
    if (wcUsd > usdHeadroom) {
      return {
        ok: false,
        dimension: "usd",
        message: `worst-case $${wcUsd.toFixed(6)} exceeds remaining usd headroom`,
        terminal: wcUsd > rawUsdHeadroom,
      };
    }
    reservedTokens += wcTokens;
    reservedUsd += wcUsd;
    return {
      ok: true,
      reservation: { tokens: wcTokens, usd: wcUsd, promptTokens, completionTokens: completion },
    };
  }


  const traceLog = new DurableLineLog(join(config.runDir, PROXY_TRACE_FILE), config.traceIo);

  // -------------------------------------------------------------------------
  // Durable dispatch authority.
  //
  // INVARIANT: no upstream fetch is attempted before an intent record —
  // request identity plus the admitted worst-case token/USD ceiling — is
  // written AND fsynced to the dispatch journal. Settlement durably records
  // the actual charge (and whether the trace obligation was met) after
  // `recordSpend`. A SIGKILL at ANY point therefore leaves one of:
  //   - no intent  → the upstream was provably never contacted; nothing owed;
  //   - unmatched intent → recovery charges the FULL reserved ceiling exactly
  //     once (replay-safe) and durably poisons the run (its trace is missing);
  //   - matched intent → the recorded charge stands; a `traced: false`
  //     settlement re-poisons every restart (CAS/trace failure is permanent).
  // Recovery runs eagerly at construction and is awaited before ANY
  // completion is admitted, so recovered charges are in the broker before
  // new headroom is computed and a poisoned journal can never silently
  // restart as a healthy log.
  // -------------------------------------------------------------------------
  const journal = new DispatchJournal(join(config.runDir, DISPATCH_JOURNAL_FILE), config.journalIo);
  let dispatchPoison: string | undefined;
  // Durable intents whose terminal journal record is not yet durable. Any
  // id still here after handler quiescence is a settlement that failed
  // part-way — close() must reject rather than report a clean shutdown.
  const openDispatches = new Set<string>();
  const recoveryPromise: Promise<DispatchRecoveryReport> = (async () => {
    try {
      const report = await journal.recover(config.recordSpend);
      if (report.poisoned !== undefined) dispatchPoison = report.poisoned;
      return report;
    } catch (err) {
      // Recovery could not establish (or repair) the journal's history —
      // fail closed: nothing may be forwarded over an unknown ledger.
      const failure = err instanceof Error ? err : new Error(String(err));
      const reason = `dispatch journal recovery failed: ${failure.message}`;
      dispatchPoison = reason;
      journal.fail(failure);
      return { poisoned: reason, recovered: [], chargedTotals: { tokens: 0, usd: 0 } };
    }
  })();

  async function trace(t: TraceInput): Promise<void> {
    // A poisoned authority never publishes MORE content: fail before CAS.
    const already = traceLog.poisoned;
    if (already !== undefined) {
      throw new Error(`trace authority poisoned: ${already.message}`, { cause: already });
    }
    // CAS bodies MUST be durable before the line referencing them exists:
    // both writes resolve before the record is even constructed. A CAS
    // publication failure is a corpus-authority failure exactly like a log
    // write failure — poison the log (first error wins) so later requests
    // fail closed and close() rejects, then fail this request.
    let requestBody: string;
    let responseBody: string;
    try {
      [requestBody, responseBody] = await Promise.all([
        casWrite(config.casDir, t.requestText, config.casIo),
        casWrite(config.casDir, t.responseText, config.casIo),
      ]);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      traceLog.fail(failure);
      throw failure;
    }
    const record = ProxyTraceRecord.parse({
      version: PROXY_TRACE_VERSION,
      runId: config.runId,
      role: t.role,
      model: t.model,
      requestAt: t.requestAt,
      durationMs: Date.now() - t.startedAt,
      status: t.status,
      usage: t.usage,
      estimatedUsd: t.estimatedUsd,
      requestBody,
      responseBody,
    });
    // Resolution = the complete line is on disk and fsynced, ordered after
    // every earlier trace. Failure poisons the log: this and every later
    // request fails closed rather than continuing with an unrecorded corpus.
    await traceLog.append(JSON.stringify(record));
  }

  function upstreamHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.upstreamApiKey !== undefined) {
      headers["authorization"] = `Bearer ${config.upstreamApiKey}`;
    }
    return headers;
  }

  function sendJson(res: ServerResponse, status: number, body: string): void {
    // The socket may already be gone (client abort, shutdown teardown);
    // accounting must not be disturbed by an unwritable response.
    if (res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  async function writeResponseChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
    if (res.destroyed) throw new Error("client connection closed");
    if (res.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        res.off("drain", onDrain);
        res.off("close", onClose);
        res.off("error", onError);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("client connection closed during response"));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      res.once("drain", onDrain);
      res.once("close", onClose);
      res.once("error", onError);
    });
  }

  function sendClientError(res: ServerResponse, status: number, type: string, message: string): void {
    sendJson(res, status, JSON.stringify({ error: { type, message } }));
  }

  async function handleCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    identity: ProxyAuthToken,
  ): Promise<void> {
    const requestAt = new Date().toISOString();
    const startedAt = Date.now();

    // Corpus-authority gate: once the trace log (or a CAS publication) has
    // failed, NOTHING more may be forwarded — the request is refused before
    // any body buffering, budget check, reservation, or upstream dispatch.
    const poison = traceLog.poisoned;
    if (poison !== undefined) {
      if (!res.destroyed) {
        res.writeHead(503, { "content-type": "application/json", connection: "close" });
        res.end(
          JSON.stringify({
            error: {
              type: "hone_trace_authority_failed",
              message: `trace authority poisoned: ${poison.message}`,
            },
          }),
        );
      }
      return;
    }

    // Dispatch-authority gate: startup recovery must have reconciled every
    // prior intent before ANY new dispatch, and a poisoned journal — a crash
    // orphaned an intent, a prior CAS/trace publication failed durably, the
    // file is corrupt, or a live append failed — refuses everything. A run
    // whose ledger authority failed can never silently restart healthy.
    await recoveryPromise;
    const journalPoison = dispatchPoison ?? journal.poisoned?.message;
    if (journalPoison !== undefined) {
      if (!res.destroyed) {
        res.writeHead(503, { "content-type": "application/json", connection: "close" });
        res.end(
          JSON.stringify({
            error: {
              type: "hone_dispatch_authority_failed",
              message: `dispatch authority poisoned: ${journalPoison}`,
            },
          }),
        );
      }
      return;
    }

    const route = config.routing[identity.role];
    if (route === undefined) {
      sendClientError(res, 403, "hone_no_route", `no routing for role "${identity.role}"`);
      return;
    }

    const body = await readRequestBody(req, limits.maxRequestBytes);
    if (body.tooLarge) {
      // Reject, then tear the connection down only after the 413 has been
      // flushed — the client must observe a deterministic error, and the
      // socket must not keep draining an unbounded upload.
      res.writeHead(413, { "content-type": "application/json", connection: "close" });
      res.end(
        JSON.stringify({
          error: {
            type: "hone_request_too_large",
            message: `request body exceeds ${limits.maxRequestBytes} bytes`,
          },
        }),
        () => req.destroy(),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text === "" ? "{}" : body.text);
    } catch {
      sendClientError(res, 400, "hone_bad_request", "request body is not valid JSON");
      return;
    }
    if (!isJsonObject(parsed)) {
      sendClientError(res, 400, "hone_bad_request", "request body must be a JSON object");
      return;
    }

    const bounds = completionBounds(parsed, limits.maxCompletionTokens);
    if (!bounds.ok) {
      sendClientError(res, 400, "hone_bad_request", bounds.message);
      return;
    }

    // The mutable side cannot choose its own model: overwrite with the role's route.
    const forward: Record<string, unknown> = { ...parsed, model: route.model };
    delete forward["max_tokens"];
    delete forward["max_completion_tokens"];
    if (forward["stream"] === true) {
      const supplied = forward["stream_options"];
      forward["stream_options"] = {
        ...(isJsonObject(supplied) ? supplied : {}),
        include_usage: true,
      };
    }

    const pricing = config.pricing?.[route.model];
    const messagesRaw = parsed["messages"];
    const promptTokens = promptTokenUpperBound(
      Buffer.byteLength(body.text, "utf8"),
      Buffer.byteLength(JSON.stringify(forward), "utf8"),
      Array.isArray(messagesRaw) ? messagesRaw.length : 0,
    );

    // Recursion guard + double-spend guard: atomic worst-case reservation
    // BEFORE any upstream call. Nothing fits → 402, upstream never sees it.
    const admission = await admitSerialized(promptTokens, bounds.requested, pricing);
    if (!admission.ok) {
      if (admission.terminal) await config.recordBudgetExhaustion?.(admission.dimension);
      const errBody: BudgetExceededError = {
        error: {
          type: "hone_budget_exceeded",
          message: admission.message,
          dimension: admission.dimension,
        },
      };
      const errText = JSON.stringify(errBody);
      // A concurrent in-flight reservation is temporary: 429 lets the
      // mutation worker back off and retry after settlement. Only a request
      // that cannot fit even with zero in-flight reservations is a terminal
      // 402 and burns the trusted exhaustion latch above.
      sendJson(res, admission.terminal ? 402 : 429, errText);
      return;
    }
    const reservation = admission.reservation;

    // The forwarded payload carries the ADMITTED ceiling — the upstream is
    // contractually bound to the same bound the reservation was priced at.
    forward[bounds.field] = reservation.completionTokens;
    const forwardText = JSON.stringify(forward);

    const ceilingCharge: SpendRecord = { tokens: reservation.tokens, usd: reservation.usd };
    const ceilingUsage: Usage = {
      promptTokens: reservation.promptTokens,
      completionTokens: reservation.completionTokens,
      totalTokens: reservation.tokens,
    };

    // Settlement is an explicit idempotent state machine driven to completion
    // exactly once per admitted request, phases strictly in this order:
    //   1. `recordSpend` — the broker charge. Crashing after it but before
    //      the journal settle lands means restart recovery re-charges the
    //      ceiling: an over-count in an irreducible window, never an
    //      under-count.
    //   2. the trace obligation (CAS bodies + trace line), when one exists;
    //   3. the durable journal `settle` record matching the intent, carrying
    //      the actual charge and whether the trace obligation was met — a
    //      `traced: false` settlement is a terminal poison fact that
    //      survives restart;
    //   4. release of the in-memory reservation, ONLY when the settlement
    //      left the dispatch authority clean.
    // "Settled" means phase 3's terminal record is DURABLE (or no durable
    // intent exists to match) — never that settlement merely began. The
    // first settle() call fixes ONE immutable plan (charge, outcome, trace
    // input); a later call — the handler's finally — resumes that SAME plan
    // from the first incomplete phase, so a throw mid-settlement can neither
    // be silently skipped nor substitute a different charge. A phase that
    // fails permanently poisons the dispatch authority (the gate refuses new
    // requests, close() rejects) and the reservation is retained forever
    // (fail closed) rather than silently refunded.
    const dispatchId = `d_${randomBytes(9).toString("hex")}`;
    let intentDurable = false;
    let plan: { charge: SpendRecord; outcome: DispatchSettleOutcome; traceInput: TraceInput | undefined } | undefined;
    // Phase 1 state. A throw inside `recordSpend` leaves the broker state
    // UNKNOWN: `spendFailure` latches and the phase is never retried — a
    // retry could deliberately double-charge. The durable intent then stays
    // unmatched, so restart recovery charges the full ceiling (over-count,
    // never under-count).
    let spendRecorded = false;
    let spendFailure: Error | undefined;
    // Phase 2 state. The trace obligation gets ONE attempt: a failure
    // permanently poisons the trace log, so a retry would only fail at its
    // poison gate.
    let traceAttempted = false;
    let traceFailure: Error | undefined;
    // Phase 3 state — THIS is "settled".
    let journalSettled = false;
    const settle = async (
      charge: SpendRecord,
      outcome: DispatchSettleOutcome,
      traceInput?: TraceInput,
    ): Promise<void> => {
      if (journalSettled) return;
      // One immutable settlement plan per request: the first call fixes it;
      // retries resume it and their own arguments are ignored.
      plan ??= { charge, outcome, traceInput };
      const p = plan;
      if (!spendRecorded) {
        if (spendFailure !== undefined) throw spendFailure;
        // A proven-unaccepted transport failure settles at zero: nothing to
        // record, just release. Everything else records BEFORE releasing.
        if (p.charge.tokens > 0 || p.charge.usd > 0) {
          try {
            await config.recordSpend(p.charge);
          } catch (err) {
            spendFailure = err instanceof Error ? err : new Error(String(err));
            dispatchPoison ??= `broker charge for dispatch ${dispatchId} did not settle (broker state unknown): ${spendFailure.message}`;
            throw spendFailure;
          }
        }
        spendRecorded = true;
      }
      if (p.traceInput !== undefined && !traceAttempted) {
        traceAttempted = true;
        try {
          await trace(p.traceInput);
        } catch (err) {
          traceFailure = err instanceof Error ? err : new Error(String(err));
        }
      }
      // `traced` is true only when the trace obligation was met, or none
      // existed (`no-upstream`: the upstream provably never saw the
      // request, so there is no exchange to record).
      const traced = p.outcome === "no-upstream" || (p.traceInput !== undefined && traceFailure === undefined);
      if (intentDurable) {
        // Resolution = the terminal record is on disk and fsynced. A throw
        // here leaves `journalSettled` false: the journal is poisoned by the
        // failed append, the finally resumes (and fails closed again), and
        // close() rejects over the unsettled intent.
        await journal.settle({
          id: dispatchId,
          tokens: p.charge.tokens,
          usd: p.charge.usd,
          outcome: p.outcome,
          traced,
          ...(traceFailure !== undefined ? { traceError: traceFailure.message } : {}),
        });
        if (!traced) {
          dispatchPoison ??=
            traceFailure !== undefined
              ? `trace/CAS publication failed for dispatch ${dispatchId}: ${traceFailure.message}`
              : `dispatch ${dispatchId} settled without a trace record`;
        }
      }
      journalSettled = true;
      openDispatches.delete(dispatchId);
      // Fail closed: a settlement that poisoned the dispatch authority keeps
      // its reservation forever — retention only ever OVER-constrains later
      // admissions, and the poison gate refuses them anyway.
      if (traced || !intentDurable) {
        reservedTokens -= reservation.tokens;
        reservedUsd -= reservation.usd;
      }
      if (traceFailure !== undefined) throw traceFailure;
    };

    const controller = new AbortController();
    upstreamControllers.add(controller);
    try {
      if (closing) {
        // Admitted after shutdown began but before any upstream dispatch:
        // the upstream is provably untouched, so release the reservation
        // without charge and record the deterministic refusal.
        await settle({ tokens: 0, usd: 0 }, "no-upstream");
        const errText = JSON.stringify({
          error: { type: "hone_shutting_down", message: "proxy is shutting down" },
        });
        sendJson(res, 503, errText);
        return;
      }
      // DISPATCH INVARIANT: the intent — request identity plus the admitted
      // worst-case ceiling — is written AND fsynced before any upstream byte
      // is sent. A crash beyond this point can never yield an unaccounted
      // upstream request: restart recovery charges the full ceiling and
      // durably poisons the run.
      try {
        await journal.intent({
          id: dispatchId,
          runId: config.runId,
          role: identity.role,
          model: route.model,
          requestAt,
          requestSha256: createHash("sha256").update(forwardText).digest("hex"),
          promptTokens: reservation.promptTokens,
          completionTokens: reservation.completionTokens,
          ceilTokens: reservation.tokens,
          ceilUsd: reservation.usd,
        });
        intentDurable = true;
        openDispatches.add(dispatchId);
      } catch (err) {
        // The append failed BEFORE any fetch attempt, so the upstream is
        // provably untouched and the reservation is released without charge.
        // The journal is now poisoned (fail closed): every later request is
        // refused at the gate. If the line did reach disk despite the
        // failure, restart recovery charges the ceiling — over-count, never
        // under-count.
        await settle({ tokens: 0, usd: 0 }, "no-upstream");
        sendClientError(
          res,
          503,
          "hone_dispatch_authority_failed",
          `dispatch intent not durable: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      // POISON FENCE (post-intent, pre-fetch): the gate checks at the top of
      // this handler ran before body buffering and admission — a concurrent
      // request may have poisoned the trace or dispatch authority while this
      // one stalled (slow body upload, admission queue). Re-check AFTER the
      // intent fsync resolved; there is NO await between a passing check and
      // the fetch invocation below, so a poison observed by any other
      // request strictly-before this segment can never be followed by an
      // untraceable billable dispatch from this one. A latched poison
      // durably settles this intent at zero (`no-upstream`: the fetch below
      // was provably never invoked) and refuses the request.
      const latePoison = traceLog.poisoned?.message ?? dispatchPoison ?? journal.poisoned?.message;
      if (latePoison !== undefined) {
        try {
          await settle({ tokens: 0, usd: 0 }, "no-upstream");
        } catch {
          // The zero settle could not become durable over the failed
          // authority: the intent stays unmatched (restart recovery charges
          // its ceiling — over-count, never under-count) and the handler
          // finally resumes the plan and latches the dispatch poison.
        }
        sendClientError(
          res,
          503,
          traceLog.poisoned !== undefined ? "hone_trace_authority_failed" : "hone_dispatch_authority_failed",
          `authority poisoned before dispatch: ${latePoison}`,
        );
        return;
      }
      const base = route.upstreamBaseUrl ?? config.upstreamBaseUrl ?? DEFAULT_UPSTREAM;
      let upstream: Response;
      try {
        upstream = await fetch(new URL("/v1/chat/completions", base), {
          method: "POST",
          headers: upstreamHeaders(),
          body: forwardText,
          signal: controller.signal,
        });
      } catch (err) {
        // Transport failure. Only a PROVEN never-connected error releases the
        // reservation without charge; anything ambiguous charges the ceiling.
        const noAccept = provenNoUpstreamAccept(err);
        const errText = JSON.stringify({
          error: {
            type: "hone_upstream_unreachable",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        if (noAccept) {
          await settle({ tokens: 0, usd: 0 }, "no-upstream");
        } else {
          try {
            await settle(ceilingCharge, "ceiling", {
              role: identity.role,
              model: route.model,
              requestAt,
              startedAt,
              status: 502,
              usage: ceilingUsage,
              estimatedUsd: ceilingCharge.usd,
              requestText: forwardText,
              responseText: errText,
            });
          } catch (settleErr) {
            // Charged and journaled, but the trace obligation failed: the
            // client must fail closed rather than observe a clean 502.
            res.destroy();
            throw settleErr;
          }
        }
        sendJson(res, 502, errText);
        return;
      }

      // Pass the body through (SSE chunks flush as they arrive) while
      // accumulating the concatenated stream for usage capture + trace.
      // Streams and non-streams share the same accumulation cap; crossing it
      // aborts the upstream connection instead of buffering without bound.
      if (!res.destroyed) {
        res.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
        });
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;
      let streamFailed = false;
      try {
        if (upstream.body !== null) {
          for await (const chunk of upstream.body) {
            const buf = Buffer.from(chunk);
            if (received + buf.length > limits.maxResponseBytes) {
              truncated = true;
              controller.abort();
              break;
            }
            received += buf.length;
            chunks.push(buf);
            await writeResponseChunk(res, buf);
          }
        }
      } catch {
        // Upstream failure or downstream backpressure/abort. Terminate the
        // other half immediately; never keep consuming work nobody can read.
        controller.abort();
        streamFailed = true;
      }
      const responseText = Buffer.concat(chunks).toString("utf8");

      let usage: Usage | undefined;
      if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
        usage = extractSseUsage(responseText);
      } else {
        try {
          const responseJson: unknown = JSON.parse(responseText);
          if (isJsonObject(responseJson)) {
            usage = normalizeUsage(responseJson["usage"]);
          }
        } catch {
          usage = undefined;
        }
      }

      // Fail closed: missing, malformed, or all-zero usage charges the FULL
      // reservation ceiling. Zero is not a believable cost for a request the
      // upstream accepted, and a refund-to-zero would let the mutable side
      // spend the same headroom repeatedly by provoking usage suppression.
      let charge: SpendRecord;
      let tracedUsage: Usage;
      let outcome: DispatchSettleOutcome;
      if (usage !== undefined && usage.totalTokens > 0) {
        const actualUsd =
          pricing === undefined
            ? 0
            : (usage.promptTokens / 1e6) * pricing.inputUsdPerMTok +
              (usage.completionTokens / 1e6) * pricing.outputUsdPerMTok;
        charge = { tokens: usage.totalTokens, usd: actualUsd };
        tracedUsage = usage;
        outcome = "usage";
      } else {
        charge = ceilingCharge;
        tracedUsage = ceilingUsage;
        outcome = "ceiling";
      }

      // Account (charge → trace → durable journal settle) BEFORE ending the
      // client response, so a client that has consumed the full body observes
      // fully-recorded spend AND a durably-indexed trace. A trace or journal
      // failure must not let the response complete cleanly: destroy the
      // socket so the client fails closed.
      try {
        await settle(charge, outcome, {
          role: identity.role,
          model: route.model,
          requestAt,
          startedAt,
          status: upstream.status,
          usage: tracedUsage,
          estimatedUsd: charge.usd,
          requestText: forwardText,
          responseText,
        });
      } catch (err) {
        res.destroy();
        throw err;
      }
      if (truncated || streamFailed) {
        // Deterministic client-side failure: the response is incomplete by
        // construction; never pretend it ended cleanly.
        res.destroy();
      } else if (!res.destroyed) {
        res.end();
      }
    } finally {
      upstreamControllers.delete(controller);
      if (!journalSettled) {
        // Unexpected error path after admission, or a settlement that threw
        // part-way: resume the state machine. A FIRST call here plans the
        // full ceiling with no trace to publish — the `traced: false`
        // settlement is a terminal poison fact; a resumed plan keeps its
        // exact original charge and never re-runs a completed (or failed)
        // spend phase. Failures are swallowed, never silently skipped: every
        // failing phase has already poisoned the dispatch authority (the
        // gate refuses new requests and close() rejects) and the reservation
        // is retained, which only ever OVER-constrains future admissions
        // (and an unmatched intent re-charges the ceiling on restart:
        // over-count, never under-count).
        await settle(ceilingCharge, "error").catch(() => undefined);
        if (!journalSettled) {
          dispatchPoison ??= `dispatch ${dispatchId} has no durable terminal record (settlement incomplete)`;
        }
      }
    }
  }

  type CachedModelsResponse = { status: number; contentType: string; body: Buffer };
  let modelsResponse: Promise<CachedModelsResponse> | undefined;

  const loadModels = (): Promise<CachedModelsResponse> => {
    modelsResponse ??= (async () => {
      const base = config.upstreamBaseUrl ?? DEFAULT_UPSTREAM;
      const controller = new AbortController();
      upstreamControllers.add(controller);
      try {
        const upstream = await fetch(new URL("/v1/models", base), {
          headers: upstreamHeaders(),
          signal: controller.signal,
        });
        const chunks: Buffer[] = [];
        let received = 0;
        if (upstream.body !== null) {
          for await (const chunk of upstream.body) {
            const buf = Buffer.from(chunk);
            received += buf.length;
            if (received > limits.maxResponseBytes) {
              controller.abort();
              return {
                status: 502,
                contentType: "application/json",
                body: Buffer.from(JSON.stringify({
                  error: { type: "hone_upstream_too_large", message: "models response exceeds cap" },
                })),
              };
            }
            chunks.push(buf);
          }
        }
        return {
          status: upstream.status,
          contentType: upstream.headers.get("content-type") ?? "application/json",
          body: Buffer.concat(chunks),
        };
      } catch {
        return {
          status: 502,
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({
            error: { type: "hone_upstream_unreachable", message: "models upstream unavailable" },
          })),
        };
      } finally {
        upstreamControllers.delete(controller);
      }
    })();
    return modelsResponse;
  };

  async function handleModels(res: ServerResponse, _identity: ProxyAuthToken): Promise<void> {
    const response = await loadModels();
    if (res.destroyed) return;
    res.writeHead(response.status, { "content-type": response.contentType });
    await writeResponseChunk(res, response.body);
    res.end();
  }

  // -------------------------------------------------------------------------
  // Active-request slots.
  //
  // INVARIANT: at most `limits.maxActiveRequests` requests are past this gate
  // at any instant, and no body byte is buffered nor any upstream fetch
  // started before a slot is held. Combined with the per-request byte caps,
  // aggregate proxy buffering is bounded by
  //     maxActiveRequests * (maxRequestBytes + maxResponseBytes).
  // Check + increment are synchronous (no await between them), so parallel
  // requests cannot race past the gate; release happens in `finally` on
  // every path — settlement, thrown errors, client aborts, upstream resets.
  // This gate is deliberately SEPARATE from the reservation/admission lock:
  // slots bound memory and sockets, reservations bound spend.
  // -------------------------------------------------------------------------
  let activeRequests = 0;

  /**
   * Deterministic overload rejection: nothing buffered, nothing forwarded.
   * The inbound body is DISCARDED via resume() — no data listener, so no
   * user-space accumulation — and the 503 is written once the request ends:
   * Node destroys (RSTs) the socket when a response finishes against an
   * incomplete request, which would clobber the in-flight 503 for clients
   * still uploading. Stalled uploads are reaped by the server request
   * timeout; sockets are bounded by maxConnections.
   */
  function rejectOverloaded(req: IncomingMessage, res: ServerResponse): void {
    const finish = (): void => {
      if (res.destroyed) return;
      res.writeHead(503, {
        "content-type": "application/json",
        connection: "close",
        "retry-after": "1",
      });
      res.end(
        JSON.stringify({
          error: {
            type: "hone_overloaded",
            message: `proxy at capacity (${limits.maxActiveRequests} concurrent requests)`,
          },
        }),
      );
    };
    if (req.readableEnded) {
      finish();
      return;
    }
    req.on("end", finish);
    req.on("error", () => res.destroy());
    req.resume();
  }

  // -------------------------------------------------------------------------
  // Shutdown quiescence.
  //
  // INVARIANT: once `close()` resolves, no recordSpend call, reservation
  // mutation, CAS write, or trace append can ever run again. Achieved by
  // (1) `closing` — new requests are refused before ANY accounting work,
  // (2) aborting every registered upstream exchange so a hung upstream can
  //     never stall a handler, (3) destroying client sockets so stalled
  //     uploads/downloads cannot pin handlers, and (4) awaiting every
  //     tracked handler promise — settlement, CAS writes, and the trace
  //     append are awaited INSIDE each handler before it resolves, so
  //     handler completion implies accounting completion.
  // -------------------------------------------------------------------------
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const inflightHandlers = new Set<Promise<void>>();
  const upstreamControllers = new Set<AbortController>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closing) {
      // Shutdown refusal precedes ALL work — no auth, no buffering, no
      // accounting. Covers the narrow window where a request was already
      // parsed on a keep-alive socket before teardown destroys it.
      if (!res.destroyed) {
        res.writeHead(503, { "content-type": "application/json", connection: "close" });
        res.end(
          JSON.stringify({
            error: { type: "hone_shutting_down", message: "proxy is shutting down" },
          }),
        );
      }
      return;
    }
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") === true ? auth.slice("Bearer ".length) : undefined;
    const identity = bearer !== undefined ? byToken.get(bearer) : undefined;
    if (identity === undefined) {
      sendClientError(res, 401, "hone_unauthorized", "unknown or missing bearer token");
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    const isCompletions = req.method === "POST" && path === "/v1/chat/completions";
    const isModels = req.method === "GET" && path === "/v1/models";
    if (!isCompletions && !isModels) {
      sendClientError(res, 404, "hone_not_found", `no route: ${req.method} ${path}`);
      return;
    }

    if (activeRequests >= limits.maxActiveRequests) {
      rejectOverloaded(req, res);
      return;
    }
    activeRequests += 1;
    try {
      if (isCompletions) {
        await handleCompletions(req, res, identity);
      } else {
        await handleModels(res, identity);
      }
    } finally {
      activeRequests -= 1;
    }
  }

  const server: Server = createServer((req, res) => {
    // Shutdown destroys client sockets while handlers finish accounting; a
    // late write against a destroyed response must never crash the process.
    res.on("error", () => undefined);
    const done = handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      try {
        if (!res.headersSent) {
          sendClientError(res, 500, "hone_internal", message);
        } else if (!res.destroyed) {
          res.end();
        }
      } catch {
        res.destroy();
      }
    });
    inflightHandlers.add(done);
    void done.finally(() => inflightHandlers.delete(done));
  });
  // Socket-layer ingress bounds behind the slot gate: connection count, header
  // count, and slow-client header/body deadlines are capped so pre-slot work
  // (header parsing, keep-alive sockets) cannot grow without bound either.
  server.maxConnections = limits.maxConnections;
  server.maxHeadersCount = 128;
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.setTimeout(300_000, (socket) => socket.destroy());

  function bound(listenArgs: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      listenArgs();
      server.once("listening", () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  return {
    tokens,
    tokenFor(role: string): string {
      const found = tokens.find((t) => t.role === role);
      if (found === undefined) throw new Error(`no token minted for role "${role}"`);
      return found.token;
    },
    dispatchRecovery(): Promise<DispatchRecoveryReport> {
      return recoveryPromise;
    },
    async listenUnix(socketPath: string): Promise<void> {
      await rm(socketPath, { force: true });
      await bound(() => server.listen(socketPath));
    },
    async listenTcp(port: number, host = "127.0.0.1"): Promise<number> {
      await bound(() => server.listen(port, host));
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) return addr.port;
      throw new Error("tcp listen did not yield an address");
    },
    async close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        // Stop accepting new connections. The close error (if any) is
        // captured rather than rejected immediately so it cannot become an
        // unhandled rejection while quiescence is still being awaited.
        let closeErr: Error | undefined;
        const serverClosed = new Promise<void>((resolve) => {
          server.close((err) => {
            closeErr = err;
            resolve();
          });
        });
        // Abort every in-flight upstream exchange: a hung or slow upstream
        // must not stall shutdown. Handlers observe the abort and settle via
        // the existing conservative failure policy (captured usage if
        // trustworthy, otherwise the full reservation ceiling — never
        // fabricated, never zero for a possibly-accepted request).
        for (const controller of upstreamControllers) controller.abort();
        // Destroy client sockets: stalled uploads/downloads cannot pin
        // handlers, and keep-alive sockets stop holding the server open.
        server.closeAllConnections();
        // Handler quiescence: every tracked handler has settled its
        // reservation, recorded its spend, and appended its trace. Loop
        // because requests already inside Node's parser may register after
        // the snapshot; `closing` guarantees those do no accounting.
        while (inflightHandlers.size > 0) {
          await Promise.allSettled([...inflightHandlers]);
        }
        // Every handler has drained, so any dispatch id still open reached a
        // durable intent but never a durable terminal record — its
        // settlement failed part-way. The shutdown must never look clean.
        if (openDispatches.size > 0) {
          dispatchPoison ??= `${openDispatches.size} dispatch intent(s) have no durable terminal record: ${[...openDispatches].join(", ")}`;
        }
        // Dispatch-journal quiescence: recovery (which may still be
        // delivering recovered ceiling charges) completes, every queued
        // append is drained, and the handle is closed. A poisoned journal —
        // live append failure, crash-recovered intents, or a durable poison
        // fact from a prior process — makes close reject: a run whose
        // dispatch authority failed never reports a clean shutdown.
        let journalErr: Error | undefined;
        try {
          await recoveryPromise;
          await journal.close();
        } catch (err) {
          journalErr = err instanceof Error ? err : new Error(String(err));
        }
        if (journalErr === undefined && dispatchPoison !== undefined) {
          journalErr = new Error(`dispatch authority poisoned: ${dispatchPoison}`);
        }
        // Trace-log quiescence: every queued line is drained and the handle
        // is closed; any later append attempt rejects. A poisoned log makes
        // this reject — surface that AFTER the server is fully down so the
        // shutdown is still complete, but never reported clean.
        let traceErr: Error | undefined;
        try {
          await traceLog.close();
        } catch (err) {
          traceErr = err instanceof Error ? err : new Error(String(err));
        }
        await serverClosed;
        if (traceErr !== undefined) throw traceErr;
        if (journalErr !== undefined) throw journalErr;
        if (closeErr !== undefined) throw closeErr;
      })();
      return closePromise;
    },
  };
}
