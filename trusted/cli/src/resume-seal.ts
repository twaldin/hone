import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunConfig, canonicalJson } from "@hone/schema";
import type { CapsuleManifest, DiagnosticOrderingReport } from "@hone/schema";
import { contractHash, renderContract } from "./contract.js";
import type { DeliveryTarget } from "./delivery-target.js";
import { CONTRACT_FILE, RUN_CONFIG_FILE } from "./runs.js";

/**
 * Under-lock resume seal verification. A resume plan is chosen from files
 * read BEFORE the run lock is held; anything on disk could have been swapped
 * since (or tampered while no supervisor was alive). Before run.resumed is
 * appended or any backend launches, the supervisor re-reads
 * runconfig.json + contract.md UNDER the lock and requires:
 *
 *   - runconfig.json parses and is canonically identical to the plan's
 *     config (covers backend, headless, apply, budget, routing, seed, …);
 *   - the contract file hashes to run.started.contractHash — the exact text
 *     the owner approved;
 *   - the contract text equals a fresh render from the re-read config and
 *     the sealed identity (runId, manifest snapshot, capsule digest,
 *     optimizer digest, ordering report) — so the narrative, the executable
 *     block, and the config file cannot diverge;
 *   - the optimizer digest sealed by run.started still matches the digest
 *     that would relaunch.
 *
 * Any mismatch refuses: the caller emits NO event and NO terminal — the run
 * stays exactly as durable as it was, resumable once the tamper is undone.
 */
export interface ResumeSealInputs {
  runId: string;
  runDir: string;
  /** The plan's config (loaded pre-lock). */
  config: RunConfig;
  manifest: CapsuleManifest;
  capsuleDigest: string;
  optimizerDigest: string;
  orderingReport: DiagnosticOrderingReport;
  /** The sealed delivery target (re-validated by the caller), or null for apply=none — the contract re-render must bind it. */
  deliveryTarget: DeliveryTarget | null;
  /** run.started seals from the replayed log (read under the lock). */
  sealedContractHash: string | null;
  sealedOptimizerDigest: string | null;
}

/** Null = seal intact; otherwise the exact refusal reason. */
export function resumeSealError(inputs: ResumeSealInputs): string | null {
  const configPath = join(inputs.runDir, RUN_CONFIG_FILE);
  if (!existsSync(configPath)) return `run is missing ${RUN_CONFIG_FILE} under the lock — refusing to resume`;
  let diskConfig: RunConfig;
  try {
    diskConfig = RunConfig.parse(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (e) {
    return `runconfig.json no longer parses as a RunConfig: ${e instanceof Error ? e.message : String(e)} — refusing to resume`;
  }
  if (canonicalJson(diskConfig) !== canonicalJson(inputs.config)) {
    return "runconfig.json changed between plan and lock — refusing to resume (backend/headless/config seals must be unchanged)";
  }

  const contractPath = join(inputs.runDir, CONTRACT_FILE);
  if (!existsSync(contractPath)) return `run is missing ${CONTRACT_FILE} under the lock — refusing to resume`;
  const contractText = readFileSync(contractPath, "utf8");
  if (inputs.sealedContractHash === null) return "run.started sealed no contract hash — refusing to resume";
  if (contractHash(contractText) !== inputs.sealedContractHash) {
    return `contract.md hashes ${contractHash(contractText)}, run.started sealed ${inputs.sealedContractHash} — the approved contract was altered; refusing to resume`;
  }
  const rendered = renderContract({
    runId: inputs.runId,
    config: diskConfig,
    manifest: inputs.manifest,
    capsuleDigest: inputs.capsuleDigest,
    optimizerDigest: inputs.optimizerDigest,
    orderingReport: inputs.orderingReport,
    deliveryTarget: inputs.deliveryTarget,
  });
  if (rendered !== contractText) {
    return "contract.md does not re-render from the sealed run config and frozen identity — refusing to resume";
  }

  if (inputs.sealedOptimizerDigest !== null && inputs.sealedOptimizerDigest !== inputs.optimizerDigest) {
    return `optimizer digest ${inputs.optimizerDigest} != sealed ${inputs.sealedOptimizerDigest} — refusing to resume`;
  }
  return null;
}
