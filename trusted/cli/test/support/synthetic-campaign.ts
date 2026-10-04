/**
 * Synthetic frozen recursive M2 campaign config.
 *
 * Shape-equivalent to a historical Stage-A frozen campaign (owner-authorized
 * 21-admitted / 6-deferred partial cohort, Panel A with six admitted tasks,
 * eight terminal capsules, no outer-budget derivation or pre-ignition gates),
 * but every identity — capsule ids/digests, images, commits, receipts, report
 * and artifact digests — is generated from a namespace label. The result is
 * parsed by the official `MetaCampaignConfigV2` schema, and `protocolHash` /
 * `analysisConfigHash` are derived with the same domains the trusted freeze
 * uses, so the fixture behaves like a real frozen config without carrying any
 * private run data.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  M2_ALLOWED_CLAIM,
  M2_EVALUATOR_TIMEOUT_SEC,
  LEGACY_M2_INNER_MODEL_ROUTE,
  LEGACY_M2_OUTER_MODEL_ROUTE,
  M2_PANEL_A_TASK_IDS,
  M2_SEARCH_CANDIDATE_EQUIVALENTS,
  MetaCampaignConfigV2,
  canonicalJson,
  m2CalibratedPanelCandidateBudget,
  type M2AuthorizedAdmittedCapsule,
  type M2AuthorizedDeferredCapsule,
  type M2PanelTaskId,
  type MetaCapsuleEntry,
} from "@hone/schema";

type Sha256 = `sha256:${string}`;
type Envelope = {
  maxTokens: number;
  maxUsd: number;
  maxWallClockSec: number;
  maxEvaluatorInvocations: number;
};

export interface SyntheticCampaignOptions {
  /**
   * Namespace for every generated identity. Two campaigns built with
   * different namespaces share no capsule, artifact, or receipt identity.
   */
  readonly namespace?: string;
  /** Pinned source commit for seed, controller, and trusted runtime. */
  readonly sourceCommit?: string;
  /** Trusted runtime boot digest. */
  readonly trustedRuntimeDigest?: string;
  /** Optimizer/controller runtime image (repo@sha256 reference). */
  readonly optimizerImage?: string;
}

export const SYNTHETIC_CAMPAIGN_NAMESPACE = "m2-frozen";

/** Development tasks deferred by the synthetic owner cohort ruling. */
const DEFERRED_DEVELOPMENT_TASKS = ["OSS-T01", "OSS-T03", "OSS-T08"] as const;
const ADMITTED_DEVELOPMENT_TASKS = [
  "OWN-T01", "OWN-T02", "OWN-T03", "OWN-T04", "OWN-T05", "OWN-T06", "OWN-T07", "OWN-T08",
  "OSS-T02", "OSS-T04", "OSS-T05", "OSS-T06", "OSS-T07",
] as const satisfies readonly M2PanelTaskId[];
const ADMITTED_TERMINAL_COUNT = 8;
const DEFERRED_TERMINAL_COUNT = 3;

/** Per-capsule normalization anchors; every scale is exactly representable. */
const ANCHORS: ReadonlyArray<readonly [qBase: number, qReference: number]> = [
  [0.5, 0.75],
  [0.25, 1],
  [0.375, 0.5],
  [12, 16],
  [1024, 1280],
  [0.0625, 0.125],
  [3, 4],
  [0.625, 1],
];

const CHILD: Envelope = {
  maxTokens: 10_000_000,
  maxUsd: 20,
  maxWallClockSec: 7_200,
  maxEvaluatorInvocations: 100,
};
const OUTER: Envelope = {
  maxTokens: 4_000_000,
  maxUsd: 20,
  maxWallClockSec: 43_200,
  maxEvaluatorInvocations: 25,
};

function hex(namespace: string, label: string): string {
  return createHash("sha256").update(`hone-synthetic-campaign:${namespace}:${label}`).digest("hex");
}

function sha256(bytes: string): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function scaleEnvelope(envelope: Envelope, factor: number): Envelope {
  return {
    maxTokens: envelope.maxTokens * factor,
    maxUsd: envelope.maxUsd * factor,
    maxWallClockSec: envelope.maxWallClockSec * factor,
    maxEvaluatorInvocations: envelope.maxEvaluatorInvocations * factor,
  };
}

function addEnvelopes(...envelopes: Envelope[]): Envelope {
  return envelopes.reduce((total, envelope) => ({
    maxTokens: total.maxTokens + envelope.maxTokens,
    maxUsd: total.maxUsd + envelope.maxUsd,
    maxWallClockSec: total.maxWallClockSec + envelope.maxWallClockSec,
    maxEvaluatorInvocations: total.maxEvaluatorInvocations + envelope.maxEvaluatorInvocations,
  }), { maxTokens: 0, maxUsd: 0, maxWallClockSec: 0, maxEvaluatorInvocations: 0 });
}

/** Build a schema-valid frozen recursive M2 campaign config with synthetic identities. */
export function syntheticFrozenCampaign(options: SyntheticCampaignOptions = {}): MetaCampaignConfigV2 {
  const namespace = options.namespace ?? SYNTHETIC_CAMPAIGN_NAMESPACE;
  const digest = (label: string): Sha256 => `sha256:${hex(namespace, label)}`;
  const capsuleId = (label: string): string => `cap_${hex(namespace, `capsule-id:${label}`).slice(0, 12)}`;
  const image = (repository: string, label: string): string => `${repository}@${digest(`image:${label}`)}`;
  const sourceCommit = options.sourceCommit ?? hex(namespace, "source-commit").slice(0, 40);
  const trustedRuntimeDigest = options.trustedRuntimeDigest ?? digest("trusted-runtime");
  const optimizerImage = options.optimizerImage ?? image("hone-mutation", "optimizer");

  const capsuleEntry = (label: string, index: number, capsuleImage: string): MetaCapsuleEntry => {
    const [qBase, qReference] = ANCHORS[index % ANCHORS.length]!;
    return {
      capsuleId: capsuleId(label),
      capsuleDigest: digest(`capsule:${label}`),
      image: capsuleImage,
      oracleDigest: digest(`oracle:${label}`),
      scalarizerDigest: digest(`scalarizer:${label}`),
      qFail: 0,
      qBase,
      qReference,
      scale: qReference - qBase,
    };
  };
  const developmentLabel = (taskId: string) => `development-${taskId.toLowerCase()}`;
  const terminalLabel = (index: number) => `terminal-${String(index + 1).padStart(2, "0")}`;
  const deferredTerminalLabel = (index: number) => `deferred-terminal-${String(index + 1).padStart(2, "0")}`;
  const evidence = (label: string) => [{
    path: `diagnostics/synthetic/${label}.json`,
    digest: digest(`evidence:${label}`),
  }];

  const admitted: M2AuthorizedAdmittedCapsule[] = [
    ...ADMITTED_DEVELOPMENT_TASKS.map((taskId): M2AuthorizedAdmittedCapsule => ({
      label: developmentLabel(taskId),
      capsuleId: capsuleId(developmentLabel(taskId)),
      capsuleDigest: digest(`capsule:${developmentLabel(taskId)}`),
      gate2ReceiptHash: digest(`gate2:${developmentLabel(taskId)}`),
      role: "development",
      taskId,
    })),
    ...Array.from({ length: ADMITTED_TERMINAL_COUNT }, (_, index): M2AuthorizedAdmittedCapsule => ({
      label: terminalLabel(index),
      capsuleId: capsuleId(terminalLabel(index)),
      capsuleDigest: digest(`capsule:${terminalLabel(index)}`),
      gate2ReceiptHash: digest(`gate2:${terminalLabel(index)}`),
      role: "terminal",
    })),
  ];
  const deferred: M2AuthorizedDeferredCapsule[] = [
    ...DEFERRED_DEVELOPMENT_TASKS.map((taskId): M2AuthorizedDeferredCapsule => ({
      label: developmentLabel(taskId),
      capsuleId: capsuleId(developmentLabel(taskId)),
      capsuleDigest: digest(`capsule:${developmentLabel(taskId)}`),
      reason: `synthetic deferral of ${taskId}`,
      evidence: evidence(`${developmentLabel(taskId)}-blocker`),
      role: "development",
      taskId,
    })),
    ...Array.from({ length: DEFERRED_TERMINAL_COUNT }, (_, index): M2AuthorizedDeferredCapsule => ({
      label: deferredTerminalLabel(index),
      capsuleId: capsuleId(deferredTerminalLabel(index)),
      capsuleDigest: digest(`capsule:${deferredTerminalLabel(index)}`),
      reason: `synthetic deferral of ${deferredTerminalLabel(index)}`,
      evidence: evidence(`${deferredTerminalLabel(index)}-blocker`),
      role: "terminal",
    })),
  ];

  const deferredTasks: readonly string[] = DEFERRED_DEVELOPMENT_TASKS;
  const panelTasks = M2_PANEL_A_TASK_IDS.filter((taskId) => !deferredTasks.includes(taskId));
  const train = panelTasks.map((taskId, index) => capsuleEntry(
    developmentLabel(taskId),
    index,
    index === 0 ? optimizerImage : image("hone-task", developmentLabel(taskId)),
  ));
  const holdout = Array.from({ length: ADMITTED_TERMINAL_COUNT }, (_, index) => capsuleEntry(
    terminalLabel(index),
    index + panelTasks.length,
    image("hone-task", terminalLabel(index)),
  ));
  const developmentPanel = {
    panel: "A" as const,
    members: panelTasks.map((taskId, index) => ({
      taskId,
      capsule: train[index]!,
      calibratedInnerCeiling: { ...CHILD },
    })),
  };
  const calibratedPanelCandidate = m2CalibratedPanelCandidateBudget(developmentPanel);
  const searchTrajectory = scaleEnvelope(calibratedPanelCandidate, M2_SEARCH_CANDIDATE_EQUIVALENTS);
  // Stage A confirmation: 4 arms x train x 3 replicates; terminal: 3 arms x holdout x 3.
  const confirmationBudget = scaleEnvelope(CHILD, 4 * train.length * 3);
  const terminalBudget = scaleEnvelope(CHILD, 3 * holdout.length * 3);

  const optimizer = {
    sourceCommit,
    sourceArtifact: digest("seed-source-artifact"),
    bundleDigest: digest("seed-bundle"),
  };
  const identified = {
    version: 2 as const,
    objective: "Synthetic frozen recursive M2 campaign: measure inner improvement, recursive controller transfer, and terminal transfer under matched resource envelopes.",
    seedOptimizer: { ...optimizer },
    trustedRuntime: { sourceCommit, digest: trustedRuntimeDigest },
    mutablePaths: [
      "optimizer/assets/prompts.ts",
      "optimizer/assets/context.ts",
      "optimizer/assets/policy.ts",
      "optimizer/src/episode.ts",
      "optimizer/src/loop.ts",
    ],
    protectedPaths: [
      "optimizer/src/client.ts",
      "optimizer/src/main.ts",
      "optimizer/src/index.ts",
      "optimizer/src/deferred.ts",
      "optimizer/package.json",
      "optimizer/tsconfig.json",
      "optimizer/worker",
      "schema",
      "trusted",
      "capsules",
    ],
    train,
    holdout,
    routing: { outerMutation: LEGACY_M2_OUTER_MODEL_ROUTE, innerMutation: LEGACY_M2_INNER_MODEL_ROUTE },
    modelObservation: {
      outerRequestedRoute: LEGACY_M2_OUTER_MODEL_ROUTE,
      innerRequestedRoute: LEGACY_M2_INNER_MODEL_ROUTE,
      identity: "alias-observation" as const,
      recordResponseModel: true as const,
      recordProviderFingerprint: true as const,
      driftSentinel: true as const,
    },
    counts: {
      candidates: 12,
      candidateAttemptsMax: 24,
      innerEpisodesMax: 4 as const,
      searchReplicates: 1,
      confirmationReplicates: 3 as const,
      holdoutReplicates: 3 as const,
      childConcurrency: 4,
    },
    budgets: {
      campaign: addEnvelopes(OUTER, searchTrajectory, confirmationBudget, terminalBudget),
      outer: { ...OUTER },
      child: { ...CHILD },
    },
    controls: {
      brokenSourceArtifact: digest("broken-source-artifact"),
      brokenBundleDigest: digest("broken-bundle"),
      degradedSourceArtifact: digest("degraded-source-artifact"),
      degradedBundleDigest: digest("degraded-bundle"),
    },
    promotion: {
      minDeltaOverSe: 2,
      minSignConsistency: 0.75,
      replicates: 3,
      requireNegativeControls: true,
    },
    measurementEpochNamespace: `m2-synthetic-${hex(namespace, "epoch").slice(0, 12)}`,
    allowedClaim: M2_ALLOWED_CLAIM,
    invariants: {
      apply: "none" as const,
      terminalHoldoutPhases: 1 as const,
      holdoutFeedbackToOptimizer: false as const,
      holdoutSearchEligible: false as const,
    },
    controllerOptimizer: { ...optimizer },
    optimizerRuntime: { image: optimizerImage },
    generation: {
      stage: "A" as const,
      panel: "A" as const,
      targetGeneration: 0 as const,
      controllerGeneration: 0 as const,
      outerReplicate: 0 as const,
    },
    evaluatorTimeoutSec: M2_EVALUATOR_TIMEOUT_SEC,
    calibration: {
      reportDigest: digest("calibration-report"),
      excludedCapsuleIds: [1, 2, 3, 4].map((index) => capsuleId(`calibration-excluded-${index}`)),
    },
    corpusCohort: {
      mode: "owner-authorized-partial" as const,
      developmentCapsuleIds: admitted
        .filter((capsule) => capsule.role === "development")
        .map((capsule) => capsule.capsuleId)
        .sort(),
      terminalCapsuleIds: admitted
        .filter((capsule) => capsule.role === "terminal")
        .map((capsule) => capsule.capsuleId)
        .sort(),
      partialCohort: {
        version: "m2-authorized-partial-cohort.v1" as const,
        authorization: {
          decisionKey: "bun-image-blocker" as const,
          decidedAt: "2026-08-12T00:00:00Z",
          owner: { identity: "captain" as const, kind: "owner" as const },
          deliveredVia: "first-mate" as const,
          ruling: "ADMIT THE 21 NOW, DEFER THE SIX EXPLICITLY" as const,
          supersedes: {
            rule: "atomic-16-development-11-terminal" as const,
            scope: "this-cohort-only" as const,
          },
          evidence: evidence("cohort-authorization"),
        },
        admitted,
        deferred,
      },
      provenanceInputsDigest: digest("corpus-provenance-inputs"),
    },
    developmentPanel,
    recursiveBudgets: {
      search: {
        identity: { envelopeId: digest("envelope:search"), purpose: "search" as const },
        calibratedPanelCandidate,
        outerTrajectory: searchTrajectory,
      },
      confirmation: {
        identity: { envelopeId: digest("envelope:confirmation"), purpose: "confirmation" as const },
        budget: confirmationBudget,
      },
      terminal: {
        identity: { envelopeId: digest("envelope:terminal"), purpose: "terminal" as const },
        budget: terminalBudget,
      },
    },
  };

  // Same identity domains as the trusted recursive freeze.
  const protocolHash = sha256(canonicalJson({ domain: "hone-m2-recursive-protocol-v1", config: identified }));
  const analysisEntry = ({ capsuleId: id, capsuleDigest, scalarizerDigest, qFail, qBase, qReference, scale }: MetaCapsuleEntry) => ({
    capsuleId: id,
    capsuleDigest,
    scalarizerDigest,
    qFail,
    qBase,
    qReference,
    scale,
  });
  const analysisConfigHash = sha256(canonicalJson({
    domain: "hone-m2-recursive-analysis-v1",
    generation: identified.generation,
    train: identified.train.map(analysisEntry),
    holdout: identified.holdout.map(analysisEntry),
    promotion: identified.promotion,
    allowedClaim: identified.allowedClaim,
    trajectoryContract: 1,
  }));
  return MetaCampaignConfigV2.parse({ ...identified, protocolHash, analysisConfigHash });
}

/** Write `syntheticFrozenCampaign(options)` as pretty JSON (creating parents); returns `path`. */
export function writeSyntheticFrozenCampaign(path: string, options: SyntheticCampaignOptions = {}): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(syntheticFrozenCampaign(options), null, 2)}\n`);
  return path;
}
