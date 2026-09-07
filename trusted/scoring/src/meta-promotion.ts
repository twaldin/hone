import { createHash } from "node:crypto";
import type { MetaCampaignConfigV1 } from "@hone/schema";

export type MetaSha256Digest = `sha256:${string}`;
export type MetaMeasurementPhase = "search" | "confirmation" | "holdout";
export type MetaMeasurementArm = "candidate" | "seed" | "winner" | "broken-control" | "degraded-control";

export interface MetaOptimizerIdentity {
  readonly sourceArtifact: MetaSha256Digest;
  readonly bundleDigest: MetaSha256Digest;
}

export type MetaControlKind = "broken" | "degraded";

export type MetaControlFileMode = 0o644 | 0o755;

export interface MetaControlSourceFile {
  readonly path: string;
  readonly sha256: MetaSha256Digest;
  readonly mode: MetaControlFileMode;
}

export interface MetaControlSourceSeal {
  readonly version: 1;
  readonly files: readonly MetaControlSourceFile[];
}

export interface MetaControlTransformation {
  readonly path: string;
  readonly beforeSha256: MetaSha256Digest;
  readonly afterSha256: MetaSha256Digest;
  readonly mode: MetaControlFileMode;
}

/** Structural projection of the trusted control-builder receipt. */
export interface MetaControlTransformationReceipt {
  readonly version: 1;
  readonly kind: MetaControlKind;
  readonly transformation: "broken-no-candidate-v1" | "degraded-blind-restart-v1";
  readonly sourceSealHash: MetaSha256Digest;
  readonly artifactDigest: MetaSha256Digest;
  readonly files: number;
  readonly transformedFiles: readonly MetaControlTransformation[];
}

export interface MetaAuthenticatedControl extends MetaOptimizerIdentity {
  /** Exact trusted source seal whose hash the transformation receipt binds. */
  readonly sourceSeal: MetaControlSourceSeal;
  readonly receipt: MetaControlTransformationReceipt;
}

export interface MetaControlAuthentications {
  readonly broken: MetaAuthenticatedControl;
  readonly degraded: MetaAuthenticatedControl;
}

/** Structural projection of a trusted MetaJournalV1 measurement row. */
export interface TrustedMetaMeasurementRow {
  readonly configHash: MetaSha256Digest;
  readonly protocolHash: MetaSha256Digest;
  readonly analysisConfigHash: MetaSha256Digest;
  readonly phase: MetaMeasurementPhase;
  readonly arm: MetaMeasurementArm;
  readonly sourceArtifact: MetaSha256Digest;
  readonly bundleDigest: MetaSha256Digest;
  readonly capsuleId: string;
  readonly capsuleDigest: MetaSha256Digest;
  readonly replicate: number;
  readonly measurementEpoch: string;
  readonly requestedModel: string;
  readonly responseModel: string;
  readonly providerFingerprint: string | null;
  readonly modelDriftSentinel: string;
  readonly qRaw: number;
  readonly qBase: number;
  readonly scale: number;
  readonly qNormalized: number;
}

export interface MetaPromotionIdentity {
  readonly configHash: MetaSha256Digest;
  readonly protocolHash: MetaSha256Digest;
  readonly analysisConfigHash: MetaSha256Digest;
  readonly requestedModel: string;
  readonly responseModel: string;
  readonly providerFingerprint: string | null;
  readonly modelDriftSentinel: string;
}

export interface MetaMeasurementEpochs {
  /** Exact ordered epoch for replicate 0..N-1, keyed by registered capsule id. */
  readonly byCapsule: Readonly<Record<string, readonly string[]>>;
}

export type MetaPromotionReasonCode =
  | "invalid-campaign"
  | "invalid-selected-identity"
  | "selection-not-passed"
  | "selection-identity-mismatch"
  | "identity-mismatch"
  | "model-identity-mismatch"
  | "optimizer-identity-mismatch"
  | "control-authentication-mismatch"
  | "capsule-identity-mismatch"
  | "replicate-identity-mismatch"
  | "measurement-epoch-mismatch"
  | "duplicate-row"
  | "missing-row"
  | "nonfinite-row"
  | "normalization-mismatch"
  | "insufficient-positive-capsules"
  | "insufficient-sign-consistency"
  | "insufficient-standardized-delta"
  | "broken-control-not-below-seed"
  | "degraded-control-not-below-seed"
  | "holdout-regression";

export interface MetaPromotionReason {
  readonly code: MetaPromotionReasonCode;
  readonly detail: string;
}

export interface MetaCapsuleDelta {
  readonly capsuleId: string;
  readonly meanDelta: number;
}

export interface MetaTrainStatistics {
  readonly pairedRows: number;
  readonly meanDelta: number;
  readonly standardError: number;
  readonly standardizedDelta: number | "infinity" | "negative-infinity";
  readonly signConsistency: number;
  readonly positiveCapsules: number;
  readonly capsuleDeltas: readonly MetaCapsuleDelta[];
  readonly brokenDeltaVsSeed: number;
  readonly degradedDeltaVsSeed: number;
}

interface TrainSelectionBase {
  readonly identity: MetaPromotionIdentity;
  readonly selectedWinner: MetaOptimizerIdentity | null;
  readonly reasons: readonly MetaPromotionReason[];
  readonly statistics: MetaTrainStatistics | null;
}

export interface SelectedMetaTrainWinner extends TrainSelectionBase {
  readonly status: "selected";
  readonly selectedWinner: MetaOptimizerIdentity;
  readonly reasons: readonly [];
  readonly statistics: MetaTrainStatistics;
}

export interface RejectedMetaTrainWinner extends TrainSelectionBase {
  readonly status: "rejected";
}

export type MetaTrainWinnerSelection = SelectedMetaTrainWinner | RejectedMetaTrainWinner;

export interface SelectMetaTrainWinnerInput {
  readonly config: MetaCampaignConfigV1;
  readonly identity: MetaPromotionIdentity;
  readonly candidate: MetaOptimizerIdentity;
  readonly controlAuthentications: MetaControlAuthentications;
  readonly epochs: MetaMeasurementEpochs;
  /** Non-confirmation rows are deliberately invisible to selection. */
  readonly rows: readonly TrustedMetaMeasurementRow[];
}

export interface MetaHoldoutStatistics {
  readonly pairedRows: number;
  readonly meanDelta: number;
  readonly capsuleDeltas: readonly MetaCapsuleDelta[];
}

export interface MetaHoldoutDecision {
  readonly decision: "promote" | "reject";
  readonly selectedWinner: MetaOptimizerIdentity | null;
  readonly reasons: readonly MetaPromotionReason[];
  readonly statistics: MetaHoldoutStatistics | null;
  readonly claim: "No observed regression on these two frozen capsules under this exact protocol." | null;
}

export interface FinalizeMetaHoldoutInput {
  readonly config: MetaCampaignConfigV1;
  readonly identity: MetaPromotionIdentity;
  readonly selectedWinner: MetaOptimizerIdentity;
  readonly selection: MetaTrainWinnerSelection;
  readonly epochs: MetaMeasurementEpochs;
  /** Exactly the terminal holdout rows; confirmation/search evidence stays outside this phase. */
  readonly rows: readonly TrustedMetaMeasurementRow[];
}

interface RegisteredCapsule {
  readonly capsuleId: string;
  readonly capsuleDigest: string;
  readonly qBase: number;
  readonly scale: number;
}

interface RowValidationInput {
  readonly rows: readonly TrustedMetaMeasurementRow[];
  readonly phase: "confirmation" | "holdout";
  readonly arms: readonly MetaMeasurementArm[];
  readonly candidates: Readonly<Record<string, MetaOptimizerIdentity>>;
  readonly capsules: readonly RegisteredCapsule[];
  readonly replicates: number;
  readonly identity: MetaPromotionIdentity;
  readonly epochs: MetaMeasurementEpochs;
}

interface ValidatedRows {
  readonly rows: ReadonlyMap<string, TrustedMetaMeasurementRow>;
  readonly reasons: readonly MetaPromotionReason[];
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TRAIN_CAPSULES = 5;
const HOLDOUT_CAPSULES = 2;
const REGISTERED_REPLICATES = 3;

function addReason(reasons: MetaPromotionReason[], code: MetaPromotionReasonCode, detail: string): void {
  if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, detail });
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function sampleStandardError(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  let squared = 0;
  for (const value of values) squared += (value - average) ** 2;
  return Math.sqrt(squared / (values.length - 1)) / Math.sqrt(values.length);
}

function rowKey(arm: MetaMeasurementArm, capsuleId: string, replicate: number): string {
  return `${arm}\u0000${capsuleId}\u0000${replicate}`;
}

function identitiesEqual(left: MetaPromotionIdentity, right: MetaPromotionIdentity): boolean {
  return (
    left.configHash === right.configHash &&
    left.protocolHash === right.protocolHash &&
    left.analysisConfigHash === right.analysisConfigHash &&
    left.requestedModel === right.requestedModel &&
    left.responseModel === right.responseModel &&
    left.providerFingerprint === right.providerFingerprint &&
    left.modelDriftSentinel === right.modelDriftSentinel
  );
}


function validOptimizerIdentity(identity: MetaOptimizerIdentity): boolean {
  return (
    SHA256_PATTERN.test(identity.sourceArtifact) &&
    SHA256_PATTERN.test(identity.bundleDigest) &&
    identity.sourceArtifact !== identity.bundleDigest
  );
}

function registeredOptimizerIdentity(sourceArtifact: string, bundleDigest: string): MetaOptimizerIdentity {
  if (!SHA256_PATTERN.test(sourceArtifact) || !SHA256_PATTERN.test(bundleDigest)) {
    throw new Error("validated campaign contains an invalid optimizer digest");
  }
  return {
    sourceArtifact: `sha256:${sourceArtifact.slice("sha256:".length)}`,
    bundleDigest: `sha256:${bundleDigest.slice("sha256:".length)}`,
  };
}

function validateControlAuthentication(
  config: MetaCampaignConfigV1,
  authentications: MetaControlAuthentications,
  reasons: MetaPromotionReason[],
): void {
  const registrations: ReadonlyArray<{
    kind: MetaControlKind;
    authentication: MetaAuthenticatedControl;
    registered: MetaOptimizerIdentity;
    transformation: MetaControlTransformationReceipt["transformation"];
  }> = [
    {
      kind: "broken",
      authentication: authentications.broken,
      registered: registeredOptimizerIdentity(
        config.controls.brokenSourceArtifact,
        config.controls.brokenBundleDigest,
      ),
      transformation: "broken-no-candidate-v1",
    },
    {
      kind: "degraded",
      authentication: authentications.degraded,
      registered: registeredOptimizerIdentity(
        config.controls.degradedSourceArtifact,
        config.controls.degradedBundleDigest,
      ),
      transformation: "degraded-blind-restart-v1",
    },
  ];
  for (const { kind, authentication, registered, transformation } of registrations) {
    const receipt = authentication.receipt;
    const sealFiles = authentication.sourceSeal.files;
    const canonicalSeal = {
      version: 1,
      files: sealFiles.map((file) => ({ path: file.path, sha256: file.sha256, mode: file.mode })),
    };
    const sourceSealHash = `sha256:${createHash("sha256").update(JSON.stringify(canonicalSeal), "utf8").digest("hex")}`;
    let previousPath = "";
    const validSeal =
      authentication.sourceSeal.version === 1 &&
      sealFiles.length > 0 &&
      sealFiles.every((file) => {
        const valid =
          file.path.length > 0 &&
          !file.path.startsWith("/") &&
          !file.path.split("/").includes("..") &&
          file.path > previousPath &&
          SHA256_PATTERN.test(file.sha256) &&
          (file.mode === 0o644 || file.mode === 0o755);
        previousPath = file.path;
        return valid;
      });
    const sourceByPath = new Map(sealFiles.map((file) => [file.path, file]));
    const transformedPaths = new Set<string>();
    const validTransformations =
      receipt.transformedFiles.length > 0 &&
      receipt.transformedFiles.every((file) => {
        const source = sourceByPath.get(file.path);
        if (transformedPaths.has(file.path)) return false;
        transformedPaths.add(file.path);
        return (
          source !== undefined &&
          file.beforeSha256 === source.sha256 &&
          file.mode === source.mode &&
          SHA256_PATTERN.test(file.afterSha256) &&
          file.afterSha256 !== file.beforeSha256
        );
      });
    if (
      !validOptimizerIdentity(authentication) ||
      (authentication.sourceArtifact !== registered.sourceArtifact ||
        authentication.bundleDigest !== registered.bundleDigest) ||
      !validSeal ||
      receipt.version !== 1 ||
      receipt.kind !== kind ||
      receipt.transformation !== transformation ||
      receipt.artifactDigest !== registered.sourceArtifact ||
      receipt.sourceSealHash !== sourceSealHash ||
      receipt.files !== sealFiles.length ||
      !validTransformations
    ) {
      addReason(
        reasons,
        "control-authentication-mismatch",
        `${kind} control is not authenticated by its registered source artifact, bundle digest, transformation receipt, and trusted source seal`,
      );
    }
  }
}

function validateCampaignShape(config: MetaCampaignConfigV1, phase: "confirmation" | "holdout", reasons: MetaPromotionReason[]): void {
  if (
    config.train.length !== TRAIN_CAPSULES ||
    config.holdout.length !== HOLDOUT_CAPSULES ||
    config.counts.confirmationReplicates !== REGISTERED_REPLICATES ||
    config.counts.holdoutReplicates !== REGISTERED_REPLICATES ||
    config.promotion.replicates !== REGISTERED_REPLICATES ||
    config.promotion.requireNegativeControls !== true ||
    config.routing.outerMutation !== config.modelObservation.requestedRoute ||
    config.routing.innerMutation !== config.modelObservation.requestedRoute ||
    config.invariants.terminalHoldoutPhases !== 1 ||
    config.invariants.holdoutFeedbackToOptimizer !== false ||
    config.invariants.holdoutSearchEligible !== false ||
    config.invariants.apply !== "none"
  ) {
    addReason(reasons, "invalid-campaign", `${phase} promotion requires the frozen 5/2 corpus, three registered replicates, fixed model route, apply:none, and one non-adaptive holdout phase`);
  }
}

function validateEpochRegistry(
  capsules: readonly RegisteredCapsule[],
  replicates: number,
  epochs: MetaMeasurementEpochs,
  reasons: MetaPromotionReason[],
): void {
  const expectedIds = capsules.map((capsule) => capsule.capsuleId).sort();
  const actualIds = Object.keys(epochs.byCapsule).sort();
  if (expectedIds.length !== actualIds.length || expectedIds.some((id, index) => id !== actualIds[index])) {
    addReason(reasons, "measurement-epoch-mismatch", "epoch registry capsule identities do not exactly match the registered partition");
    return;
  }
  const seen = new Set<string>();
  for (const capsule of capsules) {
    const registered = epochs.byCapsule[capsule.capsuleId];
    if (registered === undefined || registered.length !== replicates) {
      addReason(reasons, "measurement-epoch-mismatch", `epoch registry for ${capsule.capsuleId} must contain exactly ${replicates} ordered epochs`);
      continue;
    }
    for (const epoch of registered) {
      if (epoch.length === 0 || seen.has(epoch)) {
        addReason(reasons, "measurement-epoch-mismatch", "measurement epochs must be nonempty and globally unique across registered replicates");
        break;
      }
      seen.add(epoch);
    }
  }
}

function validateRows(input: RowValidationInput): ValidatedRows {
  const reasons: MetaPromotionReason[] = [];
  validateEpochRegistry(input.capsules, input.replicates, input.epochs, reasons);
  const capsuleById = new Map(input.capsules.map((capsule) => [capsule.capsuleId, capsule]));
  const allowedArms = new Set<MetaMeasurementArm>(input.arms);
  const rows = new Map<string, TrustedMetaMeasurementRow>();

  for (const row of input.rows) {
    if (row.phase !== input.phase) continue;
    if (!allowedArms.has(row.arm)) {
      addReason(reasons, "optimizer-identity-mismatch", `${input.phase} contains unregistered arm ${row.arm}`);
      continue;
    }
    const capsule = capsuleById.get(row.capsuleId);
    if (capsule === undefined || row.capsuleDigest !== capsule.capsuleDigest) {
      addReason(reasons, "capsule-identity-mismatch", `${input.phase} row has an unregistered capsule identity`);
      continue;
    }
    if (!Number.isInteger(row.replicate) || row.replicate < 0 || row.replicate >= input.replicates) {
      addReason(reasons, "replicate-identity-mismatch", `${input.phase} row replicate is outside 0..${input.replicates - 1}`);
      continue;
    }
    if (
      row.configHash !== input.identity.configHash ||
      row.protocolHash !== input.identity.protocolHash ||
      row.analysisConfigHash !== input.identity.analysisConfigHash
    ) {
      addReason(reasons, "identity-mismatch", `${input.phase} row config/protocol/analysis identity differs from the frozen campaign`);
    }
    if (
      row.requestedModel !== input.identity.requestedModel ||
      row.responseModel !== input.identity.responseModel ||
      row.providerFingerprint !== input.identity.providerFingerprint ||
      row.modelDriftSentinel !== input.identity.modelDriftSentinel
    ) {
      addReason(reasons, "model-identity-mismatch", `${input.phase} row model observation differs from the registered identity`);
    }
    const expectedCandidate = input.candidates[row.arm];
    if (
      expectedCandidate === undefined ||
      row.sourceArtifact !== expectedCandidate.sourceArtifact ||
      row.bundleDigest !== expectedCandidate.bundleDigest
    ) {
      addReason(reasons, "optimizer-identity-mismatch", `${input.phase} ${row.arm} row has the wrong source artifact or bundle digest`);
    }
    const expectedEpoch = input.epochs.byCapsule[row.capsuleId]?.[row.replicate];
    if (expectedEpoch === undefined || row.measurementEpoch !== expectedEpoch) {
      addReason(reasons, "measurement-epoch-mismatch", `${input.phase} row has the wrong registered measurement epoch`);
    }
    if (![row.qRaw, row.qBase, row.scale, row.qNormalized].every(Number.isFinite) || row.scale <= 0) {
      addReason(reasons, "nonfinite-row", `${input.phase} row contains a nonfinite score or nonpositive scale`);
    } else {
      const normalized = (row.qRaw - row.qBase) / row.scale;
      const tolerance = 1e-12 * Math.max(1, Math.abs(normalized), Math.abs(row.qNormalized));
      if (row.qBase !== capsule.qBase || row.scale !== capsule.scale || Math.abs(normalized - row.qNormalized) > tolerance) {
        addReason(reasons, "normalization-mismatch", `${input.phase} row does not exactly use the registered qBase/scale normalization`);
      }
    }
    const key = rowKey(row.arm, row.capsuleId, row.replicate);
    if (rows.has(key)) addReason(reasons, "duplicate-row", `${input.phase} has a duplicate arm/capsule/replicate row`);
    else rows.set(key, row);
  }

  for (const arm of input.arms) {
    for (const capsule of input.capsules) {
      for (let replicate = 0; replicate < input.replicates; replicate += 1) {
        if (!rows.has(rowKey(arm, capsule.capsuleId, replicate))) {
          addReason(reasons, "missing-row", `${input.phase} is missing a registered arm/capsule/replicate row`);
        }
      }
    }
  }
  const expectedRows = input.arms.length * input.capsules.length * input.replicates;
  if (rows.size !== expectedRows) addReason(reasons, "missing-row", `${input.phase} requires exactly ${expectedRows} unique rows`);
  return { rows, reasons };
}

function pairedDeltas(
  rows: ReadonlyMap<string, TrustedMetaMeasurementRow>,
  capsules: readonly RegisteredCapsule[],
  replicates: number,
  arm: "winner" | "broken-control" | "degraded-control",
): number[] {
  const deltas: number[] = [];
  for (const capsule of capsules) {
    for (let replicate = 0; replicate < replicates; replicate += 1) {
      const seed = rows.get(rowKey("seed", capsule.capsuleId, replicate));
      const candidate = rows.get(rowKey(arm, capsule.capsuleId, replicate));
      if (seed === undefined || candidate === undefined) throw new Error("validated paired rows unexpectedly missing");
      deltas.push(candidate.qNormalized - seed.qNormalized);
    }
  }
  return deltas;
}

function registeredCapsules(entries: MetaCampaignConfigV1["train"] | MetaCampaignConfigV1["holdout"]): RegisteredCapsule[] {
  return entries.map((entry) => ({
    capsuleId: entry.capsuleId,
    capsuleDigest: entry.capsuleDigest,
    qBase: entry.qBase,
    scale: entry.scale,
  }));
}

/**
 * Gate the one pre-ranked candidate using confirmation rows only. Search and
 * holdout rows are never dereferenced beyond their phase discriminator.
 */
export function selectMetaTrainWinner(input: SelectMetaTrainWinnerInput): MetaTrainWinnerSelection {
  const reasons: MetaPromotionReason[] = [];
  validateCampaignShape(input.config, "confirmation", reasons);
  if (
    !validOptimizerIdentity(input.candidate) ||
    input.candidate.bundleDigest === input.config.seedOptimizer.bundleDigest
  ) {
    addReason(reasons, "invalid-selected-identity", "selected candidate identity is invalid or its bundle aliases the seed optimizer");
  }
  validateControlAuthentication(input.config, input.controlAuthentications, reasons);
  if (
    !SHA256_PATTERN.test(input.identity.configHash) ||
    !SHA256_PATTERN.test(input.identity.protocolHash) ||
    !SHA256_PATTERN.test(input.identity.analysisConfigHash) ||
    input.identity.protocolHash !== input.config.protocolHash ||
    input.identity.analysisConfigHash !== input.config.analysisConfigHash ||
    input.identity.requestedModel !== input.config.modelObservation.requestedRoute
  ) {
    addReason(reasons, "identity-mismatch", "selection identity does not match the frozen campaign protocol, analysis, and requested model route");
  }
  const capsules = registeredCapsules(input.config.train);
  const validated = validateRows({
    rows: input.rows,
    phase: "confirmation",
    arms: ["seed", "winner", "broken-control", "degraded-control"],
    candidates: {
      seed: registeredOptimizerIdentity(
        input.config.seedOptimizer.sourceArtifact,
        input.config.seedOptimizer.bundleDigest,
      ),
      winner: input.candidate,
      "broken-control": registeredOptimizerIdentity(
        input.config.controls.brokenSourceArtifact,
        input.config.controls.brokenBundleDigest,
      ),
      "degraded-control": registeredOptimizerIdentity(
        input.config.controls.degradedSourceArtifact,
        input.config.controls.degradedBundleDigest,
      ),
    },
    capsules,
    replicates: REGISTERED_REPLICATES,
    identity: input.identity,
    epochs: input.epochs,
  });
  for (const reason of validated.reasons) addReason(reasons, reason.code, reason.detail);
  if (reasons.length > 0) {
    return { status: "rejected", identity: input.identity, selectedWinner: null, reasons, statistics: null };
  }

  const winnerDeltas = pairedDeltas(validated.rows, capsules, REGISTERED_REPLICATES, "winner");
  const brokenDeltas = pairedDeltas(validated.rows, capsules, REGISTERED_REPLICATES, "broken-control");
  const degradedDeltas = pairedDeltas(validated.rows, capsules, REGISTERED_REPLICATES, "degraded-control");
  const meanDelta = mean(winnerDeltas);
  const standardError = sampleStandardError(winnerDeltas);
  const standardizedDelta: MetaTrainStatistics["standardizedDelta"] =
    standardError === 0 ? (meanDelta > 0 ? "infinity" : meanDelta < 0 ? "negative-infinity" : 0) : meanDelta / standardError;
  const signConsistency = winnerDeltas.filter((delta) => delta > 0).length / winnerDeltas.length;
  const capsuleDeltas = capsules.map((capsule): MetaCapsuleDelta => {
    const deltas: number[] = [];
    for (let replicate = 0; replicate < REGISTERED_REPLICATES; replicate += 1) {
      const seed = validated.rows.get(rowKey("seed", capsule.capsuleId, replicate));
      const winner = validated.rows.get(rowKey("winner", capsule.capsuleId, replicate));
      if (seed === undefined || winner === undefined) throw new Error("validated train rows unexpectedly missing");
      deltas.push(winner.qNormalized - seed.qNormalized);
    }
    return { capsuleId: capsule.capsuleId, meanDelta: mean(deltas) };
  });
  const positiveCapsules = capsuleDeltas.filter((capsule) => capsule.meanDelta > 0).length;
  const brokenDeltaVsSeed = mean(brokenDeltas);
  const degradedDeltaVsSeed = mean(degradedDeltas);
  const statistics: MetaTrainStatistics = {
    pairedRows: winnerDeltas.length,
    meanDelta,
    standardError,
    standardizedDelta,
    signConsistency,
    positiveCapsules,
    capsuleDeltas,
    brokenDeltaVsSeed,
    degradedDeltaVsSeed,
  };

  if (positiveCapsules < 4) addReason(reasons, "insufficient-positive-capsules", `winner has positive mean delta on ${positiveCapsules}/5 train capsules; 4/5 are required`);
  if (signConsistency < input.config.promotion.minSignConsistency) {
    addReason(reasons, "insufficient-sign-consistency", `paired sign consistency ${signConsistency} is below ${input.config.promotion.minSignConsistency}`);
  }
  const deltaGatePassed =
    meanDelta > 0 &&
    (standardizedDelta === "infinity" || (typeof standardizedDelta === "number" && standardizedDelta >= input.config.promotion.minDeltaOverSe));
  if (!deltaGatePassed) {
    addReason(reasons, "insufficient-standardized-delta", `winner mean delta does not reach the registered ${input.config.promotion.minDeltaOverSe} standard-error gate`);
  }
  if (!(brokenDeltaVsSeed < 0)) addReason(reasons, "broken-control-not-below-seed", "broken control does not rank strictly below the paired seed");
  if (!(degradedDeltaVsSeed < 0)) addReason(reasons, "degraded-control-not-below-seed", "degraded control does not rank strictly below the paired seed");
  if (reasons.length > 0) return { status: "rejected", identity: input.identity, selectedWinner: null, reasons, statistics };
  return { status: "selected", identity: input.identity, selectedWinner: input.candidate, reasons: [], statistics };
}

/**
 * One terminal decision over exactly 2 holdout capsules × 3 paired seed/winner
 * replicates. It reports only the registered directional claim, never power or
 * a model update. Seating remains a separate explicit owner action.
 */
export function finalizeMetaHoldout(input: FinalizeMetaHoldoutInput): MetaHoldoutDecision {
  const reasons: MetaPromotionReason[] = [];
  validateCampaignShape(input.config, "holdout", reasons);
  if (input.selection.status !== "selected") addReason(reasons, "selection-not-passed", "terminal holdout cannot promote a candidate that failed train selection");
  if (
    input.selection.status === "selected" &&
    (input.selection.selectedWinner.sourceArtifact !== input.selectedWinner.sourceArtifact ||
      input.selection.selectedWinner.bundleDigest !== input.selectedWinner.bundleDigest ||
      !identitiesEqual(input.selection.identity, input.identity))
  ) {
    addReason(reasons, "selection-identity-mismatch", "holdout candidate or campaign identity differs from the exact train selection");
  }
  if (
    !validOptimizerIdentity(input.selectedWinner) ||
    input.selectedWinner.bundleDigest === input.config.seedOptimizer.bundleDigest
  ) {
    addReason(reasons, "invalid-selected-identity", "holdout selected identity is invalid or its bundle aliases the seed optimizer");
  }
  if (
    input.identity.protocolHash !== input.config.protocolHash ||
    input.identity.analysisConfigHash !== input.config.analysisConfigHash ||
    input.identity.requestedModel !== input.config.modelObservation.requestedRoute
  ) {
    addReason(reasons, "identity-mismatch", "holdout identity does not match the frozen campaign protocol, analysis, and requested route");
  }
  if (input.rows.some((row) => row.phase !== "holdout")) {
    addReason(reasons, "identity-mismatch", "terminal finalization accepts only the exact registered holdout rows");
  }

  const capsules = registeredCapsules(input.config.holdout);
  const validated = validateRows({
    rows: input.rows,
    phase: "holdout",
    arms: ["seed", "winner"],
    candidates: {
      seed: registeredOptimizerIdentity(
        input.config.seedOptimizer.sourceArtifact,
        input.config.seedOptimizer.bundleDigest,
      ),
      winner: input.selectedWinner,
    },
    capsules,
    replicates: REGISTERED_REPLICATES,
    identity: input.identity,
    epochs: input.epochs,
  });
  for (const reason of validated.reasons) addReason(reasons, reason.code, reason.detail);
  if (reasons.length > 0) return { decision: "reject", selectedWinner: null, reasons, statistics: null, claim: null };

  const deltas = pairedDeltas(validated.rows, capsules, REGISTERED_REPLICATES, "winner");
  const capsuleDeltas = capsules.map((capsule): MetaCapsuleDelta => {
    const values: number[] = [];
    for (let replicate = 0; replicate < REGISTERED_REPLICATES; replicate += 1) {
      const seed = validated.rows.get(rowKey("seed", capsule.capsuleId, replicate));
      const winner = validated.rows.get(rowKey("winner", capsule.capsuleId, replicate));
      if (seed === undefined || winner === undefined) throw new Error("validated holdout rows unexpectedly missing");
      values.push(winner.qNormalized - seed.qNormalized);
    }
    return { capsuleId: capsule.capsuleId, meanDelta: mean(values) };
  });
  const statistics: MetaHoldoutStatistics = { pairedRows: deltas.length, meanDelta: mean(deltas), capsuleDeltas };
  const regressed = capsuleDeltas.find((capsule) => capsule.meanDelta < 0);
  if (regressed !== undefined) {
    addReason(reasons, "holdout-regression", `${regressed.capsuleId} has observed paired mean regression ${regressed.meanDelta}`);
    return { decision: "reject", selectedWinner: input.selectedWinner, reasons, statistics, claim: null };
  }
  return {
    decision: "promote",
    selectedWinner: input.selectedWinner,
    reasons: [],
    statistics,
    claim: "No observed regression on these two frozen capsules under this exact protocol.",
  };
}
