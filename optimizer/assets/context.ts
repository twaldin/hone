import type { BudgetState, EvaluationRecord } from "@hone/schema";
import {
  DEFAULT_MUTATE_OUTPUT_SCHEMA,
  EPISODE_CONTEXT_VERSION,
  type EpisodeContext,
} from "../src/episode.js";
import { maxFeedbackChars } from "./policy.js";
import { MUTATION_SYSTEM_PROMPT, REPAIR_SYSTEM_PROMPT } from "./prompts.js";

/**
 * Large evaluator populations otherwise dominate every provider request.
 * Eight examples from each score tail retain the highest-value failure and
 * success signals while keeping even worst-case truncated feedback bounded.
 * Capsules at or below this limit retain their legacy byte shape exactly.
 */
export const MAX_INLINE_PER_EXAMPLE_RESULTS = 16;
const PER_EXAMPLE_TAIL_RESULTS = MAX_INLINE_PER_EXAMPLE_RESULTS / 2;
export const EVALUATOR_RECORD_PATH = "/scratch/hone/evaluator-record.json";

/**
 * Reflective context assembly — what the mutation session gets to see.
 * Everything the loop knows flows through here: the objective, the parent's
 * trusted evaluation, the lineage of prior episodes, and the remaining
 * budget. Large per-example populations are summarized here and remain
 * available in full at EVALUATOR_RECORD_PATH.
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
  /** Provider-reported tokens available to this mutation session before it must yield. */
  sessionNoYieldMaxTokens: number;
  /** Present => repair episode: fix the invalid candidate instead of mutating. */
  failure?: FailureEvidence;
}

function renderFeedback(feedback: unknown): string {
  const text = typeof feedback === "string" ? feedback : JSON.stringify(feedback);
  if (text === undefined) return "(none)";
  return text.length > maxFeedbackChars ? `${text.slice(0, maxFeedbackChars)}… [truncated]` : text;
}

function appendExample(
  lines: string[],
  [id, result]: [string, EvaluationRecord["output"]["perExample"][string]],
): void {
  lines.push(`- ${id}: score=${result.score}`);
  if (result.feedback !== undefined) {
    lines.push(`  feedback: ${renderFeedback(result.feedback)}`);
  }
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
    if (perExample.length <= MAX_INLINE_PER_EXAMPLE_RESULTS) {
      lines.push("", "Per-example results:");
      for (const entry of perExample) appendExample(lines, entry);
    } else {
      const ranked = [...perExample].sort(
        ([leftId, left], [rightId, right]) => left.score - right.score || leftId.localeCompare(rightId),
      );
      const lowest = ranked.slice(0, PER_EXAMPLE_TAIL_RESULTS);
      const highest = ranked.slice(-PER_EXAMPLE_TAIL_RESULTS).reverse();
      const omitted = ranked.slice(PER_EXAMPLE_TAIL_RESULTS, -PER_EXAMPLE_TAIL_RESULTS);
      const omittedScores = omitted.map(([, result]) => result.score);
      const omittedMean = omittedScores.reduce((sum, score) => sum + score, 0) / omittedScores.length;

      lines.push(
        "",
        `Per-example results (${MAX_INLINE_PER_EXAMPLE_RESULTS} of ${perExample.length} shown; ` +
          `${PER_EXAMPLE_TAIL_RESULTS} lowest-score and ${PER_EXAMPLE_TAIL_RESULTS} highest-score):`,
        "Lowest-score examples:",
      );
      for (const entry of lowest) appendExample(lines, entry);
      lines.push("Highest-score examples:");
      for (const entry of highest) appendExample(lines, entry);
      lines.push(
        `Omitted ${omitted.length} middle-score examples: ` +
          `min=${omittedScores[0]}, mean=${omittedMean}, max=${omittedScores[omittedScores.length - 1]}`,
        `Full evaluator record (all ${perExample.length} per-example results): ${EVALUATOR_RECORD_PATH}`,
      );
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
    `# Session yield budget\n\n` +
      `session no-yield token bound: ${input.sessionNoYieldMaxTokens}\n` +
      `session no-yield tokens remaining: ${input.sessionNoYieldMaxTokens} (at session start)`,
  );

  sections.push(
    mode === "repair"
      ? "Fix this candidate with the smallest coherent change, run one bounded smoke check, then yield immediately."
      : "Implement ONE coherent improvement, run one bounded smoke check, then yield immediately.",
  );

  return {
    version: EPISODE_CONTEXT_VERSION,
    episode: input.episode,
    mode,
    role: mode === "repair" ? "repair" : "inner-improver",
    systemPrompt: mode === "repair" ? REPAIR_SYSTEM_PROMPT : MUTATION_SYSTEM_PROMPT,
    userPrompt: sections.join("\n\n"),
    tools: ["read", "bash", "write", "edit"],
    outputSchema: DEFAULT_MUTATE_OUTPUT_SCHEMA,
  };
}
