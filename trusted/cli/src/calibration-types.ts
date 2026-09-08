import type { BudgetEnvelope, CapsuleManifest, DiagnosticOrderingReport } from "@hone/schema";
import type { SaturationCap, SaturationCeilingReport } from "@hone/scoring";
import type { CorpusProvenanceV1 } from "./corpus-provenance.js";

export const CALIBRATION_TASKS = [
  "calibration-postings-intersection", "calibration-sequence-diff",
  "calibration-weighted-coverage", "calibration-online-cache",
] as const;
export const CALIBRATION_CAPS = [2, 4, 8, 12] as const;
export const CALIBRATION_SEEDS = [104729, 130363, 155921, 181081, 206369] as const;
export const CALIBRATION_BUDGET: Readonly<BudgetEnvelope> = {
  maxTokens: 600_000, maxUsd: 10, maxWallClockSec: 7200, maxEvaluatorInvocations: 49,
};
export const CALIBRATION_SANDBOX = { memoryBytes: 2_147_483_648, cpus: 2 } as const;
export const CALIBRATION_BOOTSTRAP = { rngSeed: 20260907, bootstrapSamples: 10_000 } as const;

export interface CalibrationTask {
  task: typeof CALIBRATION_TASKS[number];
  capsuleDir: string;
  manifest: CapsuleManifest;
  manifestDigest: string;
  orderingReport: DiagnosticOrderingReport;
  admission: "draft" | "admitted";
}
export interface CalibrationPlanInputs {
  tasks: CalibrationTask[];
  corpus: CorpusProvenanceV1;
  image: string;
  optimizerDigest: string;
  runtimeDigest: string;
}
export interface CalibrationCell {
  key: string;
  capsuleId: string;
  task: typeof CALIBRATION_TASKS[number];
  cap: SaturationCap;
  seed: number;
}
export interface CalibrationPlan extends CalibrationPlanInputs {
  version: "calibration-plan.v1";
  budget: BudgetEnvelope;
  sandbox: typeof CALIBRATION_SANDBOX;
  concurrency: 1;
  bootstrap: typeof CALIBRATION_BOOTSTRAP;
  reservations: { tokens: 48000000; usd: 800; serialHours: 160 };
  cells: CalibrationCell[];
  planDigest: string;
}
export interface CalibrationUsage {
  tokens: number;
  usd: number;
  wallClockSec: number;
  evaluatorInvocations: number;
}
export interface CalibrationOutcome {
  status: "valid" | "invalid" | "incomplete";
  /** Only interrupted same-run work can resume; terminal failures never restart implicitly. */
  resumable: boolean;
  reason: string;
  /** Cumulative for THIS run, including same-run resumes; null means unknown, never zero. */
  usage: CalibrationUsage | null;
  normalizedGain?: number;
  /** Digests and identities from existing run/broker/proxy records; private, not publication. */
  evidence: Record<string, unknown>;
}
export interface CalibrationAttempt {
  cellKey: string;
  ordinal: number;
  runId: string;
  reason: string;
  startedAt: string;
  /** Append every dispatch intent before invoking the runner. */
  dispatches: { at: string; resume: boolean }[];
  /** Append every observed outcome; previous incomplete evidence stays recorded. */
  outcomes: (CalibrationOutcome & { at: string })[];
  remainingBudget: BudgetEnvelope;
}
export interface CalibrationState {
  version: "calibration-state.v1";
  plan: CalibrationPlan;
  mode: "offline" | "trusted";
  attempts: CalibrationAttempt[];
  stateDigest: string;
}
export interface CalibrationRunRequest {
  plan: CalibrationPlan;
  cell: CalibrationCell;
  task: CalibrationTask;
  runId: string;
  resume: boolean;
  remainingBudget: BudgetEnvelope;
  stateDir: string;
}
export interface CalibrationRunner {
  readonly mode: "offline" | "trusted";
  run(request: CalibrationRunRequest): Promise<CalibrationOutcome>;
  /** Recompute final evidence from the run APIs; no execution or provider calls. */
  verify(request: CalibrationRunRequest, outcome: CalibrationOutcome): Promise<void>;
}
export interface CalibrationReportBundle {
  version: "calibration-report.v1";
  state: CalibrationState;
  report: SaturationCeilingReport;
  reportDigest: string;
  bundleDigest: string;
}
