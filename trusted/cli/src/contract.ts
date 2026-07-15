import { createHash } from "node:crypto";
import { RunConfig } from "@hone/schema";
import type { BudgetEnvelope, CapsuleManifest, DiagnosticOrderingReport } from "@hone/schema";
import { LADDER_REFUSAL, ladderLocked } from "./deliver.js";

/**
 * Contract checkpoint (review VI.4): everything the owner is approving, as a
 * single on-disk markdown artifact. The sha256 of the approved text is sealed
 * into run.started.contractHash.
 *
 * The document is GENERATED: every section is derived from the frozen capsule,
 * the sealed digests, the hashed diagnostic ordering report, and the run
 * config. The single fenced `json hone.runconfig` block is the only editable
 * region — an interactive `E` edit is parsed back out of that block, validated,
 * and the whole contract is re-rendered from the approved config, so the
 * narrative can never drift from what actually executes. Edits anywhere else,
 * or a block that no longer parses/validates, fail closed.
 */

export interface ContractInputs {
  runId: string;
  config: RunConfig;
  manifest: CapsuleManifest;
  capsuleDigest: string;
  optimizerDigest: string;
  orderingReport: DiagnosticOrderingReport;
}

/** Unique fence info string marking the one executable/editable block. */
export const RUNCONFIG_FENCE = "json hone.runconfig";

const FENCE_RE = /^```json hone\.runconfig\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function renderContract(inputs: ContractInputs): string {
  const { runId, config, manifest, capsuleDigest, optimizerDigest, orderingReport } = inputs;
  const lines: string[] = [];
  lines.push("# Hone Run Contract");
  lines.push("");
  lines.push("_Generated document — every section is derived from the frozen capsule and the run config._");
  lines.push("");
  lines.push("## Frozen identity");
  lines.push("");
  lines.push(`- run: \`${runId}\``);
  lines.push(`- capsule: \`${manifest.id}\``);
  lines.push(`- capsule digest: \`${capsuleDigest}\``);
  lines.push(`- image (immutable, mutation + evaluation): \`${manifest.image}\``);
  lines.push(`- optimizer digest: \`${optimizerDigest}\``);
  lines.push("");
  lines.push("## Objective (verbatim)");
  lines.push("");
  lines.push(config.objective);
  lines.push("");
  lines.push("## Baseline");
  lines.push("");
  if (manifest.baseline.kind === "git") {
    lines.push(`- git commit \`${manifest.baseline.commit}\` (clean nested worktree, verified at admission)`);
  } else {
    lines.push(`- cas artifact \`${manifest.baseline.hash}\``);
  }
  lines.push("");
  lines.push("## Evaluator");
  lines.push("");
  lines.push(`- exact argv: \`${JSON.stringify(manifest.evalEntrypoint)}\``);
  lines.push("");
  lines.push("### Splits (from the frozen manifest)");
  lines.push("");
  lines.push("| split | visibility | files |");
  lines.push("|---|---|---|");
  for (const group of manifest.assetGroups) {
    lines.push(`| ${group.id} | ${group.visibility} | ${group.paths.length} |`);
  }
  lines.push("");
  lines.push("## Protected paths (diff-rejected)");
  lines.push("");
  if (manifest.protectedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of manifest.protectedPaths) lines.push(`- \`${p}\``);
  }
  lines.push("");
  lines.push("## Diagnostic ordering report (measured, hash-pinned)");
  lines.push("");
  lines.push(`_Parsed from \`${manifest.diagnosticOrdering.path}\` (sha256-pinned in the manifest; schema-validated at admission)._`);
  lines.push("");
  lines.push("| variant | train | validation | combined |");
  lines.push("|---|---|---|---|");
  for (const [variant, r] of Object.entries(orderingReport.variants)) {
    lines.push(`| ${variant} | ${r.train} | ${r.validation} | ${r.combined} |`);
  }
  lines.push("");
  lines.push(`- measured baseline aggregate: ${orderingReport.variants.baseline.combined} (train ${orderingReport.variants.baseline.train}, validation ${orderingReport.variants.baseline.validation})`);
  lines.push(`- stability: spread ${orderingReport.stability.spread} over ${orderingReport.stability.aggregates.length} baseline evals (band ${orderingReport.stability.band})`);
  lines.push(`- recorded failures: ${orderingReport.failures.length}`);
  lines.push("");
  lines.push("## Budget");
  lines.push("");
  lines.push(`- **hard USD cap: $${config.budget.maxUsd}** (trusted metering; no spend beyond it)`);
  lines.push(`- tokens: ${config.budget.maxTokens}`);
  lines.push(`- wall clock: ${config.budget.maxWallClockSec}s`);
  lines.push(`- evaluator invocations: ${config.budget.maxEvaluatorInvocations}`);
  lines.push("");
  lines.push(
    `- estimated cost: between $0 and $${config.budget.maxUsd} — an honest range, not a prediction. Spend stops at the hard USD cap; the run also terminates after ${config.budget.maxWallClockSec}s wall clock, ${config.budget.maxTokens} tokens, or ${config.budget.maxEvaluatorInvocations} evaluator invocations, whichever binds first.`,
  );
  lines.push("");
  lines.push("## Promotion rule (pre-registered — frozen at campaign start)");
  lines.push("");
  lines.push(`- paired delta must exceed **${config.promotion.minDeltaOverSe}×** its standard error`);
  lines.push(`- sign consistency: at least **${config.promotion.minSignConsistency}** of tasks improve`);
  lines.push(`- replicates per arm per task: **${config.promotion.replicates}**`);
  lines.push(`- negative controls required: **${config.promotion.requireNegativeControls ? "yes" : "no"}**`);
  lines.push("");
  lines.push(
    "_The M0 seed's inner artifact search stays greedy; this rule is sealed into the contract hash now and governs the outer champion promotion decision (M1)._",
  );
  lines.push("");
  lines.push("## Model routing");
  lines.push("");
  const roles = Object.entries(config.routing);
  if (roles.length === 0) {
    lines.push("- (none configured)");
  } else {
    for (const [role, route] of roles) {
      lines.push(`- ${role} → ${route.model}${route.upstreamBaseUrl ? ` (${route.upstreamBaseUrl})` : ""}`);
    }
  }
  lines.push("");
  lines.push("## Delivery");
  lines.push("");
  lines.push(`- apply mode: **${config.apply}**${config.apply === "pr" ? " (local-only in the M0 seed: branch + manual PR instruction; never pushes or calls gh)" : ""}`);
  lines.push(`- improver seat: ${config.improverSeat ? "yes (apply:auto additionally requires HONE_LADDER_OK=1)" : "no"}`);
  lines.push(`- headless: ${config.headless ? "yes" : "no"}`);
  lines.push(`- backend: **${config.backend}** (sealed — resume reuses it; a conflicting --backend refuses)`);
  lines.push(`- seed: ${config.seed}`);
  lines.push("");
  lines.push("## Run config (executable — the ONLY editable section)");
  lines.push("");
  lines.push("On [E]dit, change ONLY the JSON block below. It is parsed back as the");
  lines.push("executed RunConfig and the whole contract is re-rendered from it.");
  lines.push("Capsule-id changes, budget increases beyond the capsule envelope, and");
  lines.push("edits outside this block fail closed.");
  lines.push("");
  lines.push("```" + RUNCONFIG_FENCE);
  lines.push(JSON.stringify(config, null, 2));
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

export function contractHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * The frozen capsule budget is a hard upper envelope: every metered dimension
 * of `budget` must be at or under it. Returns the exact violation message, or
 * null when the budget only tightens. Shared by the initial run paths (bare
 * defaults, --config, CLI flags) and interactive contract revisions so the
 * two can never drift.
 */
export function budgetEnvelopeError(budget: BudgetEnvelope, envelope: BudgetEnvelope): string | null {
  const over: string[] = [];
  if (budget.maxUsd > envelope.maxUsd) over.push(`maxUsd ${budget.maxUsd} > ${envelope.maxUsd}`);
  if (budget.maxTokens > envelope.maxTokens) over.push(`maxTokens ${budget.maxTokens} > ${envelope.maxTokens}`);
  if (budget.maxWallClockSec > envelope.maxWallClockSec) over.push(`maxWallClockSec ${budget.maxWallClockSec} > ${envelope.maxWallClockSec}`);
  if (budget.maxEvaluatorInvocations > envelope.maxEvaluatorInvocations) {
    over.push(`maxEvaluatorInvocations ${budget.maxEvaluatorInvocations} > ${envelope.maxEvaluatorInvocations}`);
  }
  if (over.length === 0) return null;
  return `budget exceeds the capsule envelope: ${over.join(", ")}`;
}

/** The one executable block's body, or an error when it is missing/duplicated. */
export function extractRunConfigBlock(text: string): { body: string } | { error: string } {
  const bodies: string[] = [];
  for (const match of text.matchAll(FENCE_RE)) {
    const body = match[1];
    if (body !== undefined) bodies.push(body);
  }
  const body = bodies[0];
  if (body === undefined) return { error: `no \`${RUNCONFIG_FENCE}\` block found — the executable run config block must survive edits` };
  if (bodies.length > 1) return { error: `${bodies.length} \`${RUNCONFIG_FENCE}\` blocks found — the executable block must be unique` };
  return { body };
}

/** The contract text with the executable block elided — the prose that must NOT be edited. */
export function stripRunConfigBlock(text: string): string {
  return text.replace(FENCE_RE, "```" + RUNCONFIG_FENCE + "\n(elided)\n```");
}

export type RevisionOutcome = { ok: true; config: RunConfig } | { ok: false; error: string };

/**
 * Validate an interactive contract edit. The edited text must differ from the
 * pre-edit render ONLY inside the executable block; the block must parse as a
 * RunConfig; the capsule id is immutable; the budget may not exceed the
 * capsule envelope on any dimension; approval-mode fields (headless,
 * improverSeat) are not editable mid-approval; the autonomy ladder re-runs.
 * Anything else fails closed — the caller declines the run.
 */
export function applyContractRevision(opts: {
  preEdit: string;
  edited: string;
  original: RunConfig;
  manifest: CapsuleManifest;
  env: NodeJS.ProcessEnv;
}): RevisionOutcome {
  const { preEdit, edited, original, manifest, env } = opts;
  const extracted = extractRunConfigBlock(edited);
  if ("error" in extracted) return { ok: false, error: extracted.error };
  if (stripRunConfigBlock(edited) !== stripRunConfigBlock(preEdit)) {
    return { ok: false, error: "the contract was edited outside the executable run config block — generated sections are not editable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extracted.body);
  } catch (e) {
    return { ok: false, error: `run config block is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const parsed = RunConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: `run config block does not parse as a RunConfig: ${issues}` };
  }
  const config = parsed.data;
  if (config.capsuleId !== manifest.id) {
    return { ok: false, error: `capsuleId is frozen (${manifest.id}) — it cannot be edited to ${config.capsuleId}` };
  }
  const envelopeError = budgetEnvelopeError(config.budget, manifest.budget);
  if (envelopeError !== null) return { ok: false, error: envelopeError };
  if (config.headless !== original.headless) return { ok: false, error: "headless is not editable mid-approval" };
  if (config.improverSeat !== original.improverSeat) return { ok: false, error: "improverSeat is not editable mid-approval" };
  if (config.backend !== original.backend) return { ok: false, error: "backend is not editable mid-approval" };
  if (ladderLocked(config.apply, config.improverSeat, env)) return { ok: false, error: LADDER_REFUSAL };
  return { ok: true, config };
}
