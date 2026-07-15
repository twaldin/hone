import type { BudgetState, EvaluationRecord } from "@hone/schema";
import { EPISODE_CONTEXT_VERSION, type EpisodeContext } from "../src/episode.js";
import { maxFeedbackChars } from "./policy.js";
import { MUTATION_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from "./prompts.js";

/**
 * Reflective context assembly — what the mutation session gets to see.
 * Everything the loop knows flows through here: the objective, the parent's
 * trusted evaluation (per-example scores AND the untouched feedback blobs),
 * the lineage of prior episodes, and the remaining budget. The prompt is the
 * optimizer's sensory organ; changing this file changes what hone can learn.
 */

export interface LineageEntry {
  episode: number;
  /** The `approach` label the mutating session yielded. */
  approach: string;
  /** Child aggregate minus parent aggregate at that episode's seed. */
  delta: number;
}

export interface FailureEvidence {
  reason: string;
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  /** Evaluator diagnostics summary, when the failure was an invalid evaluation. */
  evaluatorSummary?: string;
}

export interface BuildContextInput {
  episode: number;
  objective: string;
  /** Trusted evaluation of the parent artifact this episode mutates. */
  parentEvaluation: EvaluationRecord;
  lineage: LineageEntry[];
  budget: BudgetState;
  /** Present => repair episode: fix the invalid candidate instead of mutating. */
  failure?: FailureEvidence;
}

function renderFeedback(feedback: unknown): string {
  const text = typeof feedback === "string" ? feedback : JSON.stringify(feedback);
  if (text === undefined) return "(none)";
  return text.length > maxFeedbackChars ? `${text.slice(0, maxFeedbackChars)}… [truncated]` : text;
}

function renderEvaluation(record: EvaluationRecord): string {
  const lines: string[] = [];
  lines.push(`valid: ${record.output.valid}`);
  for (const [name, value] of Object.entries(record.output.objectives)) {
    lines.push(`objective ${name}: ${value}`);
  }
  const constraints = Object.entries(record.output.constraints);
  if (constraints.length > 0) {
    lines.push(`constraints: ${constraints.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  const perExample = Object.entries(record.output.perExample);
  if (perExample.length > 0) {
    lines.push("", "Per-example results:");
    for (const [id, res] of perExample) {
      lines.push(`- ${id}: score=${res.score}`);
      if (res.feedback !== undefined) {
        lines.push(`  feedback: ${renderFeedback(res.feedback)}`);
      }
    }
  }
  const summary = record.output.diagnostics?.summary;
  if (summary !== undefined) lines.push("", `Evaluator summary: ${summary}`);
  return lines.join("\n");
}

function renderBudget(budget: BudgetState): string {
  const { envelope, spent } = budget;
  return [
    `tokens: ${envelope.maxTokens - spent.tokens} of ${envelope.maxTokens} left`,
    `usd: ${(envelope.maxUsd - spent.usd).toFixed(4)} of ${envelope.maxUsd} left`,
    `wall clock: ${Math.max(0, envelope.maxWallClockSec - Math.round(spent.wallClockSec))}s of ${envelope.maxWallClockSec}s left`,
    `evaluations: ${envelope.maxEvaluatorInvocations - spent.evaluatorInvocations} of ${envelope.maxEvaluatorInvocations} left`,
  ].join("\n");
}

export function buildEpisodeContext(input: BuildContextInput): EpisodeContext {
  const mode = input.failure === undefined ? "mutation" : "repair";
  const sections: string[] = [];

  sections.push(`# Objective\n\n${input.objective}`);

  if (input.failure !== undefined) {
    const f = input.failure;
    const parts = [`reason: ${f.reason}`];
    if (f.exitCode !== null) parts.push(`exit code: ${f.exitCode}`);
    if (f.evaluatorSummary !== undefined) parts.push(`evaluator: ${f.evaluatorSummary}`);
    if (f.stdoutTail.length > 0) parts.push(`stdout tail:\n${f.stdoutTail}`);
    if (f.stderrTail.length > 0) parts.push(`stderr tail:\n${f.stderrTail}`);
    sections.push(`# Failure evidence\n\n${parts.join("\n\n")}`);
  }

  sections.push(
    `# ${mode === "repair" ? "Evaluation of the artifact the failed change was based on" : "Current evaluation of this artifact"}\n\n${renderEvaluation(input.parentEvaluation)}`,
  );

  if (input.lineage.length > 0) {
    const rows = input.lineage.map((l) => `- episode ${l.episode}: ${l.approach} (delta ${l.delta >= 0 ? "+" : ""}${l.delta.toFixed(4)})`);
    sections.push(`# Prior episodes\n\n${rows.join("\n")}`);
  }

  sections.push(`# Remaining budget\n\n${renderBudget(input.budget)}`);

  sections.push(
    mode === "repair"
      ? "Fix this candidate. Make it valid again with the smallest possible change, then yield."
      : "Implement ONE coherent improvement toward the objective, verify it locally, then yield.",
  );

  return {
    version: EPISODE_CONTEXT_VERSION,
    episode: input.episode,
    mode,
    systemPrompt: mode === "repair" ? REPAIR_SYSTEM_PROMPT : MUTATION_SYSTEM_PROMPT,
    userPrompt: sections.join("\n\n"),
  };
}
