import { createHash } from "node:crypto";
import type { CapsuleManifest, RunConfig } from "@hone/schema";

/**
 * Contract checkpoint (review VI.4): everything the owner is approving, as a
 * single on-disk markdown artifact. The sha256 of the approved text is sealed
 * into run.started.contractHash.
 */
export function renderContract(runId: string, config: RunConfig, manifest: CapsuleManifest): string {
  const lines: string[] = [];
  lines.push("# Hone Run Contract");
  lines.push("");
  lines.push(`- run: \`${runId}\``);
  lines.push(`- capsule: \`${manifest.id}\``);
  lines.push(`- image: \`${manifest.image}\``);
  lines.push("");
  lines.push("## Objective (verbatim)");
  lines.push("");
  lines.push(manifest.objective);
  lines.push("");
  lines.push("## Baseline");
  lines.push("");
  if (manifest.baseline.kind === "git") {
    lines.push(`- git commit \`${manifest.baseline.commit}\``);
  } else {
    lines.push(`- cas artifact \`${manifest.baseline.hash}\``);
  }
  lines.push("");
  lines.push("## Evaluator");
  lines.push("");
  lines.push(`- entrypoint: \`${manifest.evalEntrypoint.join(" ")}\``);
  lines.push("");
  lines.push("## Asset groups");
  lines.push("");
  lines.push("| id | visibility | paths |");
  lines.push("|---|---|---|");
  for (const group of manifest.assetGroups) {
    lines.push(`| ${group.id} | ${group.visibility} | ${group.paths.join(", ")} |`);
  }
  lines.push("");
  lines.push("## Protected paths");
  lines.push("");
  if (manifest.protectedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of manifest.protectedPaths) lines.push(`- \`${p}\``);
  }
  lines.push("");
  lines.push("## Budget");
  lines.push("");
  lines.push(`- **hard USD cap: $${config.budget.maxUsd}**`);
  lines.push(`- tokens: ${config.budget.maxTokens}`);
  lines.push(`- wall clock: ${config.budget.maxWallClockSec}s`);
  lines.push(`- evaluator invocations: ${config.budget.maxEvaluatorInvocations}`);
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
  lines.push(`- apply mode: **${config.apply}**`);
  lines.push(`- improver seat: ${config.improverSeat ? "yes (apply:auto additionally requires HONE_LADDER_OK=1)" : "no"}`);
  lines.push(`- headless: ${config.headless ? "yes" : "no"}`);
  lines.push(`- seed: ${config.seed}`);
  lines.push("");
  return lines.join("\n");
}

export function contractHash(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
