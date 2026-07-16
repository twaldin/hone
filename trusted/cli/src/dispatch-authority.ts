import { existsSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_JOURNAL_FILE, PROXY_TRACE_FILE, readDispatchJournalState } from "@hone/proxy";
import { replayRun } from "./eventlog.js";
import type { CmdIo } from "./io.js";

/**
 * Allowance for floating-point summation noise when comparing the journal's
 * cumulative usd charge against broker-summed spend (the two sides add the
 * same charges, but resume's deficit reconcile computes `journal - spent`
 * and re-adds it, which need not round-trip bit-exactly). Tokens are safe
 * integers and compared exactly.
 */
const USD_EPSILON = 1e-6;

/**
 * Terminal gate over the proxy's durable dispatch authority
 * (`proxy-dispatch.ndjson`). A run may only be finalized (or applied) when
 * every dispatch the proxy ever durably intended has a durable, traced
 * terminal record AND the trusted budget authority has recorded at least the
 * journal's cumulative charge. Everything else fails closed:
 *
 * - a corrupt terminated line, a durable poison fact, a `traced: false`
 *   settlement, or a `recovered` fact means the run's dispatch/corpus
 *   authority failed — it can never terminalize;
 * - an unmatched intent means upstream charges are unreconciled — only a
 *   resume (live broker) may reconcile them; this gate NEVER mutates or
 *   recovers the journal;
 * - a cumulative journal charge above the trusted broker/public spend means
 *   the spend authority is behind the dispatch authority — resume required;
 * - a MISSING journal is acceptable only when the trusted spend/trace state
 *   proves no dispatch ever occurred (no token/usd spend recorded, no trace
 *   log): a dispatch always writes a durable intent before any upstream
 *   byte, and every proxy charge/trace implies a dispatch.
 *
 * Read-only by construction: `readDispatchJournalState` never writes.
 */
export async function dispatchAuthorityAligned(runId: string, runDir: string, io: CmdIo): Promise<boolean> {
  const refuse = (detail: string): false => {
    io.err(`run ${runId}: ${detail}`);
    return false;
  };
  const spent = replayRun(runDir).lastBudget?.spent ?? null;
  const journalPath = join(runDir, DISPATCH_JOURNAL_FILE);
  if (!existsSync(journalPath)) {
    if (existsSync(join(runDir, PROXY_TRACE_FILE))) {
      return refuse(
        `the proxy dispatch journal is missing but ${PROXY_TRACE_FILE} exists — dispatch authority lost; refusing to finalize or apply (resume with \`hone run --resume\`)`,
      );
    }
    if (spent !== null && (spent.tokens > 0 || spent.usd > 0)) {
      return refuse(
        `the proxy dispatch journal is missing but the trusted budget authority recorded ${spent.tokens} tokens / $${spent.usd} of proxy spend — dispatch authority lost; refusing to finalize or apply (resume with \`hone run --resume\`)`,
      );
    }
    return true;
  }
  let state;
  try {
    state = await readDispatchJournalState(journalPath);
  } catch (e) {
    return refuse(
      `the proxy dispatch journal is unreadable: ${e instanceof Error ? e.message : String(e)} — dispatch authority failure; resume required (\`hone run --resume\`) before stop or apply`,
    );
  }
  if (state.poisoned !== undefined) {
    return refuse(
      `proxy dispatch authority failed: ${state.poisoned} — refusing to finalize or apply (resume with \`hone run --resume\` to reconcile charges; the poison is terminal)`,
    );
  }
  if (state.unmatched.length > 0) {
    const ids = state.unmatched.map((i) => i.id).join(", ");
    return refuse(
      `${state.unmatched.length} proxy dispatch intent(s) have no settlement (${ids}) — upstream charges are unreconciled; resume required (\`hone run --resume\`) before stop or apply`,
    );
  }
  const spentTokens = spent?.tokens ?? 0;
  const spentUsd = spent?.usd ?? 0;
  if (state.chargedTotals.tokens > spentTokens || state.chargedTotals.usd > spentUsd + USD_EPSILON) {
    return refuse(
      `the proxy dispatch journal charged ${state.chargedTotals.tokens} tokens / $${state.chargedTotals.usd} but the trusted budget authority recorded only ${spentTokens} tokens / $${spentUsd} — broker spend authority is behind the dispatch authority; resume required (\`hone run --resume\`) before stop or apply`,
    );
  }
  return true;
}
