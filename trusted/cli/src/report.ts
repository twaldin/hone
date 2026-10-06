import type { BudgetState } from "@hone/schema";
import { bestArtifact } from "./eventlog.js";
import type { RunState } from "./eventlog.js";
import type { SearchReport } from "./search.js";

/** Machine-readable exit report — the final stdout line of a headless run. */
export interface ExitReport {
  runId: string;
  status: string;
  best: string | null;
  aggregate: number | null;
  deltaVsBaseline: number | null;
  spend: { tokens: number; usd: number; wallClockSec: number; evaluatorInvocations: number } | null;
  lifetimeSec: number | null;
  /** Present only on sealed search runs. */
  search?: SearchReport;
}

export function exitReport(runId: string, state: RunState, search?: SearchReport): ExitReport {
  return {
    runId,
    status: state.finished?.status ?? state.status,
    best: bestArtifact(state)?.hash ?? null,
    aggregate: state.incumbent?.aggregate ?? null,
    deltaVsBaseline: state.incumbent?.deltaVsBaseline ?? null,
    spend: state.lastBudget?.spent ?? null,
    lifetimeSec: state.lastBudget?.lifetimeSec ?? null,
    ...(search === undefined ? {} : { search }),
  };
}

export function formatSpend(budget: BudgetState | null): string {
  if (budget === null) return "(no budget.snapshot yet)";
  const { spent, envelope } = budget;
  const lifetime = budget.lifetimeSec === undefined
    ? ""
    : ` · ${Math.round(budget.lifetimeSec)}s lifetime · ${Math.round(Math.max(0, budget.lifetimeSec - spent.wallClockSec))}s paused/offline`;
  return `$${spent.usd.toFixed(2)} of $${envelope.maxUsd} · ${spent.tokens} tokens · ${Math.round(spent.wallClockSec)}s active wall${lifetime} · ${spent.evaluatorInvocations} evals`;
}

export function formatDelta(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

export function formatHumanReport(report: ExitReport, budget: BudgetState | null): string[] {
  const lines = [`run ${report.runId} finished: ${report.status}`];
  if (report.best !== null) lines.push(`best: ${report.best}`);
  if (report.aggregate !== null) lines.push(`aggregate: ${report.aggregate} (non-holdout search score)`);
  if (report.deltaVsBaseline !== null) lines.push(`delta vs baseline: ${formatDelta(report.deltaVsBaseline)}`);
  if (report.search !== undefined) lines.push(...formatSearchReport(report.search));
  lines.push(`spend: ${formatSpend(budget)}`);
  return lines;
}

function formatSearchReport(search: SearchReport): string[] {
  const lines = [
    `search: ${search.episodes.completed}/${search.episodes.planned} episodes in epoch ${JSON.stringify(search.measurementEpoch)} on ${search.assetGroupId}`,
  ];
  const gates = Object.entries(search.gates).map(([decision, count]) => `${decision} ${count}`);
  lines.push(`gates: ${gates.length === 0 ? "none paired" : gates.join(", ")}`);
  if (search.lineage.length === 0) {
    lines.push("lineage: no promotion — the baseline remains best");
  } else {
    lines.push("lineage (baseline → best, broker-paired deltas):");
    for (const step of search.lineage) {
      const paired = step.delta === null
        ? "paired delta unavailable"
        : `paired Δ ${formatDelta(step.delta)} vs parent (envelope ${step.noiseEnvelope ?? "n/a"}, ${step.decision ?? "promote"})`;
      lines.push(`  episode ${step.episode}: ${step.parent} → ${step.artifact} — ${paired}; Δ vs baseline ${formatDelta(step.deltaVsBaseline)}`);
    }
  }
  if (search.note !== null) lines.push(`note: ${search.note}`);
  return lines;
}
