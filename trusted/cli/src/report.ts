import type { BudgetState } from "@hone/schema";
import { bestArtifact } from "./eventlog.js";
import type { RunState } from "./eventlog.js";

/** Machine-readable exit report — the final stdout line of a headless run. */
export interface ExitReport {
  runId: string;
  status: string;
  best: string | null;
  aggregate: number | null;
  deltaVsBaseline: number | null;
  spend: { tokens: number; usd: number; wallClockSec: number; evaluatorInvocations: number } | null;
}

export function exitReport(runId: string, state: RunState): ExitReport {
  return {
    runId,
    status: state.finished?.status ?? state.status,
    best: bestArtifact(state)?.hash ?? null,
    aggregate: state.incumbent?.aggregate ?? null,
    deltaVsBaseline: state.incumbent?.deltaVsBaseline ?? null,
    spend: state.lastBudget?.spent ?? null,
  };
}

export function formatSpend(budget: BudgetState | null): string {
  if (budget === null) return "(no budget.snapshot yet)";
  const { spent, envelope } = budget;
  return `$${spent.usd.toFixed(2)} of $${envelope.maxUsd} · ${spent.tokens} tokens · ${Math.round(spent.wallClockSec)}s wall · ${spent.evaluatorInvocations} evals`;
}

export function formatDelta(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

export function formatHumanReport(report: ExitReport, budget: BudgetState | null): string[] {
  const lines = [`run ${report.runId} finished: ${report.status}`];
  if (report.best !== null) lines.push(`best: ${report.best}`);
  if (report.aggregate !== null) lines.push(`aggregate: ${report.aggregate} (non-holdout search score)`);
  if (report.deltaVsBaseline !== null) lines.push(`delta vs baseline: ${formatDelta(report.deltaVsBaseline)}`);
  lines.push(`spend: ${formatSpend(budget)}`);
  return lines;
}
