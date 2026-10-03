import {
  acquireHostEvaluatorGate,
  acquireReservedEvaluatorUid,
  type HostEvaluatorGateLease,
  type UidClaimRecovery,
} from "./host-evaluator-gate.js";

/**
 * Frozen evaluator identities whose protected entrypoint consumes
 * CAPSULE_WORKER_UID for every setuid/setgid, cleanup, and ownership decision.
 * Unknown/new capsules fail closed to the shared-uid FIFO until their exact
 * frozen evaluator contract is reviewed and added here.
 */
const RESERVED_UID_CAPSULES = new Set<string>([
  "cap_4f56f03866d9", // tradeup-query-latency
  "cap_8aac8ef72670", // esbuild-bundling
  "cap_8ac06369aa07", // calibration-interval-merge
  "cap_11077c26eb25", // hone-optimizer-mode-canonicalization
  "cap_d413ec4d77c5", // calibration-byte-escape
  "cap_f11c10c3fc15", // floyd-block-search-render
  "cap_4757a0336938", // leduc-cfr-exploitability
  "cap_0588ff00ef4c", // seeded-astar
  "cap_7cd6e3af94d7", // calibration-varint-decode
  "cap_c50f80b4b6f1", // tradeup-profit
  "cap_8f9e7e1e1f22", // agentelo-scoring
  "cap_9a029a976783", // harness-pi-readiness
  "cap_45be0b5ac26d", // bun-module-loader
  "cap_21e8600c6f5a", // flt-text-input
  "cap_c09ffd33ce1d", // calibration-bitset-rank
  "cap_ad1361023a83", // flt-workflow-parser
  "cap_56c626b4aa52", // flt-dag-orphan-recovery
  "cap_56f5925c694b", // ripgrep-search
  "cap_8b3fc6a17b7a", // floyd-custom-scoreboard-render
  "cap_63630c40b876", // harness-session-log-normalization
  "cap_8edec9fee323", // monoagent-context-retention
  "cap_23de71dd36fa", // simdjson-parse
  "cap_9ab675d0d490", // mimalloc-allocator
  "cap_8ec52f0e2f1f", // brotli-codec
  "cap_c0dd82eba84a", // quickjs-interpreter
  "cap_6562f788bdd5", // duckdb-tpch
  "cap_93f9f6942024", // biome-parser-formatter
  "cap_21b5bcaacf49", // uv-resolver
  "cap_5565a76628a9", // simdutf-validate
]);

export type EvaluatorIsolationMode = "reserved-uid" | "shared-uid-lease";

export interface EvaluatorIsolationLease extends HostEvaluatorGateLease {
  mode: EvaluatorIsolationMode;
  workerUid: number;
}

export function evaluatorSupportsReservedUid(capsuleId: string): boolean {
  return RESERVED_UID_CAPSULES.has(capsuleId);
}

export async function acquireEvaluatorIsolation(
  capsuleId: string,
  evaluatorContainer: string,
  signal?: AbortSignal,
  onSharedQueueEntered?: (allocationId: string) => void | Promise<void>,
  recovery?: UidClaimRecovery,
): Promise<EvaluatorIsolationLease> {
  const options = {
    evaluatorContainer,
    ...(signal === undefined ? {} : { signal }),
    ...(recovery === undefined ? {} : { recovery }),
  };
  if (evaluatorSupportsReservedUid(capsuleId)) {
    const lease = await acquireReservedEvaluatorUid(options);
    return { ...lease, mode: "reserved-uid", workerUid: lease.uid };
  }
  const lease = await acquireHostEvaluatorGate({
    ...options,
    ...(onSharedQueueEntered === undefined ? {} : { onQueued: onSharedQueueEntered }),
  });
  return { ...lease, mode: "shared-uid-lease", workerUid: 2000 };
}
