import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CapsuleManifest,
  ChildRunLaunchReceipt,
  EvaluationRecord,
  MetaCampaignConfigV2,
  canonicalJson,
  capsuleDigest,
} from "@hone/schema";
import type {
  BudgetEnvelope,
  ChildRunAdmission,
  MetaCampaignConfigV2 as RecursiveMetaCampaignConfig,
  RunEvent,
  SpawnRunParams as SpawnRunRequest,
} from "@hone/schema";
import {
  Broker,
  CasStore,
  RecursiveResourceLedger,
  hashChildRunLaunchReceipt,
  packDirAsArtifact,
  runCommand,
  startBroker,
} from "@hone/broker";
import type {
  MetaCandidateGate,
  MetaMeasurement,
  MetaResourceEnvelopeLedger,
  MetaWorkIdentity,
  Sha256Digest,
} from "@hone/meta";
import {
  RecursiveSearchChildLauncher,
  assertM2OuterAncestorCapacity,
  imageBoundCandidateBundleDigest,
} from "../src/commands/hone.js";
import type { CliChildSupervisor } from "../src/commands/hone.js";
import { metaWorkKey } from "../src/meta-journal.js";
import type { MetaJournalV1 } from "../src/meta-journal.js";
import { computeTrustedRuntimeDigest } from "../src/runtime-digest.js";
import type { CampaignPauseAuthority } from "../src/types.js";
import { runEpisodeLoop } from "../../../optimizer/src/loop.js";

const ENABLED = process.env["HONE_RECURSIVE_SEARCH_SMOKE"] === "1";
const MUTATION_IMAGE = "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10";
const OUTER_CAPSULE_ID = "cap_000000000000";
const CHILD_BUDGET: BudgetEnvelope = {
  maxTokens: 1,
  maxUsd: 1,
  maxWallClockSec: 300,
  maxEvaluatorInvocations: 1,
};

function sha256(content: string | Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function workIdentity(request: SpawnRunRequest): MetaWorkIdentity {
  const schedule = request.child.schedule;
  if (schedule === undefined) throw new Error("recursive smoke child has no schedule");
  return {
    phase: "search",
    arm: "candidate",
    sourceArtifact: request.child.sourceArtifact.hash as Sha256Digest,
    bundleDigest: request.child.optimizerArtifact.hash as Sha256Digest,
    capsuleId: request.child.capsuleId,
    replicate: 0,
    measurementEpoch: `m2:${sha256(canonicalJson({
      candidateOrdinal: schedule.candidateOrdinal,
      allocationOrdinal: schedule.allocationOrdinal,
      innerEpisodesMax: schedule.innerEpisodesMax,
      reserved: request.reservation,
    })).slice("sha256:".length)}`,
  };
}

function childEvidence(
  root: string,
  request: SpawnRunRequest,
  admission: ChildRunAdmission,
): { launchReceiptPath: string; terminalEventPath: string } {
  const runDir = join(root, request.child.runId);
  mkdirSync(runDir, { recursive: true });
  const body = {
    child: request.child,
    depth: request.depth,
    admission,
    launchedAt: "2026-08-15T00:00:00.000Z",
  };
  const receipt = ChildRunLaunchReceipt.parse({
    ...body,
    receiptDigest: hashChildRunLaunchReceipt(body),
  });
  const launchReceiptPath = join(runDir, "launch-receipt.json");
  writeFileSync(launchReceiptPath, `${canonicalJson(receipt)}\n`);
  const terminalEventPath = join(runDir, "events.ndjson");
  const events: RunEvent[] = [
    {
      runId: request.child.runId,
      at: "2026-08-15T00:00:00.000Z",
      type: "run.started",
      capsuleId: request.child.capsuleId,
      contractHash: sha256("recursive-smoke-contract"),
      optimizerDigest: request.child.optimizerArtifact.hash,
      campaignConfigHash: admission.campaignConfigHash,
    },
    {
      runId: request.child.runId,
      at: "2026-08-15T00:00:01.000Z",
      type: "run.finished",
      status: "completed",
    },
  ];
  writeFileSync(terminalEventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { launchReceiptPath, terminalEventPath };
}

describe.skipIf(!ENABLED)("recursive search real-evaluator smoke", () => {
  it("starts search episode zero, dispatches a real inner evaluation, and scores without executing /bin/false", async () => {
    const repoRoot = process.env["HONE_REPO_ROOT"];
    const evidencePath = process.env["HONE_RECURSIVE_SMOKE_EVIDENCE"];
    const campaignPath = process.env["HONE_RECURSIVE_SMOKE_CAMPAIGN"];
    if (repoRoot === undefined || evidencePath === undefined || campaignPath === undefined) {
      throw new Error(
        "smoke requires HONE_REPO_ROOT, HONE_RECURSIVE_SMOKE_EVIDENCE, and HONE_RECURSIVE_SMOKE_CAMPAIGN",
      );
    }
    const campaignConfig = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const outerAncestorCapacity = assertM2OuterAncestorCapacity(campaignConfig);
    expect(outerAncestorCapacity.requiredEnvelope).toEqual(campaignConfig.budgets.campaign);
    const executedSourceCommit = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD^{commit}"], {
      encoding: "utf8",
    }).trim();
    const executedRuntimeDigest = computeTrustedRuntimeDigest();
    expect(executedRuntimeDigest).toBe(campaignConfig.trustedRuntime.digest);
    const configHash = sha256(canonicalJson(campaignConfig));
    if (!("mode" in campaignConfig.corpusCohort)) {
      throw new Error("smoke campaign must carry the owner-authorized partial cohort");
    }
    const selectedMember = campaignConfig.developmentPanel.members.find((member) => member.taskId === "OSS-T05");
    if (selectedMember === undefined) throw new Error("smoke campaign panel has no OSS-T05 member");
    const selectedAuthority = campaignConfig.corpusCohort.partialCohort.admitted.find(
      (entry) => entry.capsuleId === selectedMember.capsule.capsuleId,
    );
    if (selectedAuthority === undefined) throw new Error("smoke panel member is absent from the admitted cohort");
    const smokeBudget = { ...CHILD_BUDGET, maxWallClockSec: campaignConfig.evaluatorTimeoutSec };
    const smokeRoot = join(repoRoot, ".hone-runs", "m2-recursive-search-smoke");
    rmSync(smokeRoot, { recursive: true, force: true });
    mkdirSync(smokeRoot, { recursive: true });

    const childCapsuleDir = join(repoRoot, "capsules", selectedAuthority.label);
    const childManifest = CapsuleManifest.parse(
      JSON.parse(readFileSync(join(childCapsuleDir, "manifest.json"), "utf8")),
    );
    if (
      childManifest.id !== selectedAuthority.capsuleId
      || capsuleDigest(childManifest) !== selectedAuthority.capsuleDigest
    ) {
      throw new Error("smoke child identity does not reproduce the frozen cohort authority");
    }
    const candidateSnapshot = {
      files: new Map([
        ["optimizer/src/smoke-candidate.ts", {
          bytes: Buffer.from("image-bound recursive smoke candidate\n", "utf8"),
          mode: 0o644,
        }],
      ]),
    };
    const comparisonBundleDigest = imageBoundCandidateBundleDigest(candidateSnapshot, MUTATION_IMAGE);
    const childBundleDigest = imageBoundCandidateBundleDigest(candidateSnapshot, childManifest.image);
    expect(childManifest.image).not.toBe(MUTATION_IMAGE);
    expect(childBundleDigest).not.toBe(comparisonBundleDigest);
    const childCas = new CasStore(join(smokeRoot, "inner-cas"));
    const childBaseline = await packDirAsArtifact(join(childCapsuleDir, "baseline"), childCas) as Sha256Digest;
    const childEvents: RunEvent[] = [];
    let innerRecord: EvaluationRecord | undefined;
    let childTerminalEventPath: string | undefined;
    const rows: MetaMeasurement[] = [];
    const journal = {
      queryTrainMeasurements: () => [...rows],
      queryFailureSettlements: () => [],
    } as unknown as MetaJournalV1;
    const gate = {
      check: async (request: Parameters<MetaCandidateGate["check"]>[0]) => ({
        ok: true as const,
        sourceArtifact: request.sourceArtifact,
        bundleDigest: comparisonBundleDigest,
        transformationReceiptHash: null,
        feedback: "smoke candidate accepted by trusted fixture gate",
      }),
      bundleDigestForImage: (_sourceArtifact: Sha256Digest, image: string) =>
        imageBoundCandidateBundleDigest(candidateSnapshot, image),
    };
    const adapterConfig = {
      ...campaignConfig,
      developmentPanel: {
        ...campaignConfig.developmentPanel,
        members: [{
          ...selectedMember,
          calibratedInnerCeiling: smokeBudget,
        }],
      },
    } as RecursiveMetaCampaignConfig;
    const adapter = new RecursiveSearchChildLauncher(
      repoRoot,
      smokeRoot,
      adapterConfig,
      configHash,
      journal,
      gate,
      {} as CliChildSupervisor,
      {} as MetaResourceEnvelopeLedger,
      {} as CampaignPauseAuthority,
    );
    const ledger = RecursiveResourceLedger.open(join(smokeRoot, "recursive-resource.ndjson"));

    const metaTask = "trusted recursive smoke; no corpus or terminal coordinates\n";
    const outerCapsuleRoot = join(smokeRoot, "outer-capsule");
    mkdirSync(outerCapsuleRoot, { recursive: true });
    writeFileSync(join(outerCapsuleRoot, "meta-task.txt"), metaTask);
    const outerBaselineDir = join(smokeRoot, "outer-baseline");
    mkdirSync(outerBaselineDir, { recursive: true });
    writeFileSync(join(outerBaselineDir, "package.json"), `${canonicalJson({ name: "recursive-smoke" })}\n`);
    const outerCasDir = join(smokeRoot, "outer-cas");
    const outerBaseline = await packDirAsArtifact(outerBaselineDir, new CasStore(outerCasDir)) as Sha256Digest;
    const admission: ChildRunAdmission = {
      campaignConfigHash: configHash,
      cohort: "panel-a",
      capsuleProvenanceHash: capsuleDigest(childManifest),
      sourceProvenanceHash: outerBaseline,
      optimizerProvenanceHash: childBundleDigest,
    };
    const outerManifest = CapsuleManifest.parse({
      schemaVersion: 2,
      id: OUTER_CAPSULE_ID,
      objective: "prove recursive candidate evaluation starts and scores",
      baseline: { kind: "cas", hash: outerBaseline },
      image: MUTATION_IMAGE,
      evalEntrypoint: ["/bin/false"],
      protectedPaths: [],
      assetGroups: [{ id: "meta-train", visibility: "public", paths: ["meta-task.txt"] }],
      budget: { ...smokeBudget, maxWallClockSec: smokeBudget.maxWallClockSec + 300, maxEvaluatorInvocations: 2 },
      diagnosticOrdering: { path: "ordering.json", hash: sha256("smoke-ordering") },
      contentHashes: { "meta-task.txt": sha256(metaTask) },
      meta: { evaluatorSource: "meta", provenance: "bounded recursive wiring smoke" },
    });
    const outerDockerCalls: string[][] = [];
    const controller = new AbortController();
    let scored: EvaluationRecord | undefined;
    const trustedStrategy = adapter.evaluationStrategy();
    const running = await startBroker({
      runId: "run_recursive_outer_smoke",
      manifest: outerManifest,
      capsuleRootDir: outerCapsuleRoot,
      baselineArtifactHash: outerBaseline,
      capsuleDigest: capsuleDigest(outerManifest),
      optimizerDigest: comparisonBundleDigest,
      holdoutLedgerPath: join(smokeRoot, "outer-holdout.ndjson"),
      image: outerManifest.image,
      runDir: join(smokeRoot, "outer-run"),
      casDir: outerCasDir,
      onEvent: () => {},
      runCommand: async (argv, opts) => {
        outerDockerCalls.push([...argv]);
        return runCommand(argv, opts);
      },
      evaluationStrategy: async (input) => {
        try {
          scored = await trustedStrategy(input);
          controller.abort();
          return scored;
        } catch (error) {
          writeFileSync(
            join(smokeRoot, "trusted-strategy-error.txt"),
            `${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)}\n`,
          );
          throw error;
        }
      },
      recursive: {
        depth: 0,
        ancestors: [],
        resourceEnvelope: outerAncestorCapacity.ancestorEnvelope,
        ledger,
        evaluationTask: {
          depth: 0,
          innerEpisodesMax: 1,
          members: [{ capsuleId: childManifest.id, calibratedInnerCeiling: smokeBudget }],
        },
        admitChildRun: ({ request }) =>
          request.child.capsuleId === childManifest.id
            && request.child.sourceArtifact.hash === outerBaseline
            && request.child.optimizerArtifact.hash === childBundleDigest
            ? admission
            : undefined,
        launchChildRun: async ({ request, admission: admitted }) => {
          const inner = new Broker({
            runId: request.child.runId,
            manifest: childManifest,
            capsuleRootDir: childCapsuleDir,
            baselineArtifactHash: childBaseline,
            capsuleDigest: capsuleDigest(childManifest),
            optimizerDigest: childBundleDigest,
            measurementEpoch: "m2-recursive-smoke-inner",
            holdoutLedgerPath: join(smokeRoot, "inner-holdout.ndjson"),
            image: childManifest.image,
            runDir: join(smokeRoot, "inner-run"),
            casDir: join(smokeRoot, "inner-cas"),
            onEvent: (event) => childEvents.push(event),
            evalTimeoutSec: campaignConfig.evaluatorTimeoutSec,
          });
          try {
            await inner.init();
            innerRecord = await inner.evaluate(
              { artifact: { hash: childBaseline }, assetGroupId: "train", seed: 0 },
              { privileged: true },
            );
          } finally {
            await inner.close();
          }
          const record = innerRecord;
          if (record === undefined) throw new Error("inner evaluator produced no record");
          const objectives = Object.values(record.output.objectives);
          const qRaw = objectives[0];
          if (
            !record.output.valid
            || !Object.values(record.output.constraints).every(Boolean)
            || objectives.length !== 1
            || qRaw === undefined
            || !Number.isFinite(qRaw)
          ) {
            throw new Error("inner evaluator did not produce one valid finite score");
          }
          const identity = workIdentity(request);
          const measurement = {
            ...identity,
            workKey: metaWorkKey(configHash, identity),
            qNormalized: qRaw,
            observed: { tokens: 0, usd: 0, wallClockSec: record.durationMs / 1000, evaluatorInvocations: 1 },
          } as unknown as MetaMeasurement;
          const evidence = childEvidence(smokeRoot, request, admitted);
          childTerminalEventPath = evidence.terminalEventPath;
          return {
            ...evidence,
            usage: { tokens: 0, usd: 0, wallClockSec: record.durationMs / 1000, evaluatorInvocations: 1 },
            finalizeSettlement: () => rows.push(measurement),
          };
        },
      },
    }, { socketPath: join(smokeRoot, "broker.sock"), publicToken: "s".repeat(64) });

    const searchEvents: RunEvent[] = [];
    const workerBundlePath = join(smokeRoot, "worker.mjs");
    writeFileSync(workerBundlePath, "throw new Error('smoke worker must not execute');\n");
    const bunRuntime = Buffer.from("sealed Bun runtime fixture; mutation is forbidden in this smoke", "utf8");
    const piRuntime = Buffer.from("sealed Pi native fixture; mutation is forbidden in this smoke", "utf8");
    const contentHash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(smokeRoot, "mutation-runtime.json"), `${canonicalJson({
      version: 1,
      bun: {
        version: "1.3.14",
        sourceName: "bun",
        bundleName: "bun.gz",
        sandboxName: "bun",
        sha256: contentHash(bunRuntime),
        mode: 0o500,
      },
      pi: {
        version: "16.5.2",
        files: [{
          sourceName: "pi_natives.linux-x64-baseline.node",
          bundleName: "pi_natives.linux-x64-baseline.node.gz",
          sandboxName: "pi_natives.linux-x64-baseline.node",
          sha256: contentHash(piRuntime),
          mode: 0o400,
        }],
      },
    })}\n`);
    writeFileSync(join(smokeRoot, "bun.gz"), gzipSync(bunRuntime, { level: 1 }));
    writeFileSync(join(smokeRoot, "pi_natives.linux-x64-baseline.node.gz"), gzipSync(piRuntime, { level: 1 }));
    const previousToken = process.env["HONE_BROKER_TOKEN"];
    process.env["HONE_BROKER_TOKEN"] = running.publicToken;
    try {
      await runEpisodeLoop({
        brokerSocket: running.socketPath,
        runId: "run_recursive_outer_smoke",
        workerBundlePath,
        signal: controller.signal,
        maxEpisodes: 1,
        emit: (event) => {
          searchEvents.push(event);
          return event;
        },
      });
    } finally {
      if (previousToken === undefined) delete process.env["HONE_BROKER_TOKEN"];
      else process.env["HONE_BROKER_TOKEN"] = previousToken;
      await running.close();
      ledger.close();
    }
    const searchEventsPath = join(smokeRoot, "search-events.ndjson");
    writeFileSync(searchEventsPath, `${searchEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const recursiveScore = scored;
    if (recursiveScore === undefined) {
      throw new Error(`search phase completed without a recursive score: ${canonicalJson(searchEvents)}`);
    }

    const record = innerRecord;
    if (record === undefined) throw new Error("smoke completed without inner evaluation evidence");
    if (childTerminalEventPath === undefined) throw new Error("smoke completed without durable child terminal evidence");
    expect(recursiveScore.output.valid).toBe(true);
    expect(record.costUsd).toBe(0);
    expect(recursiveScore.costUsd).toBe(0);
    expect(recursiveScore.output.constraints).toEqual({ allChildrenValid: true, fullPanel: true });
    expect(recursiveScore.output.objectives.normalizedGain).toBe(Object.values(record.output.objectives)[0]);
    const started = searchEvents.filter((event) => event.type === "episode.started");
    const evaluations = searchEvents.filter((event) => event.type === "eval.completed");
    expect(started).toHaveLength(1);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({
      episode: 0,
      artifact: { hash: outerBaseline },
      aggregate: recursiveScore.output.objectives.normalizedGain,
    });
    expect(outerDockerCalls.some((argv) => argv.includes("/bin/false"))).toBe(false);
    expect(outerDockerCalls.some((argv) => argv.includes("bun"))).toBe(false);
    const durableEvents = readFileSync(childTerminalEventPath);
    const evidence = {
      version: "m2-refreeze-final-smoke.v1",
      recordedAt: new Date().toISOString(),
      command:
        `sg docker -c 'HONE_RECURSIVE_SEARCH_SMOKE=1 HONE_REPO_ROOT=${repoRoot} HONE_RECURSIVE_SMOKE_CAMPAIGN=${campaignPath} HONE_RECURSIVE_SMOKE_EVIDENCE=${evidencePath} ./node_modules/.bin/vitest run --root trusted/cli test/recursive-search.smoke.test.ts'`,
      result: "passed: config-bound search episode 0 dispatched one recursive child to a real Docker evaluator and emitted its trusted score",
      smokeRoot,
      executedRuntime: {
        sourceCommit: executedSourceCommit,
        digest: executedRuntimeDigest,
      },
      campaign: {
        draftPath: campaignPath,
        configHash,
        evaluatorTimeoutSec: campaignConfig.evaluatorTimeoutSec,
        cohortAdmittedCount: campaignConfig.corpusCohort.partialCohort.admitted.length,
        configuredDevelopmentPanelCount: campaignConfig.developmentPanel.members.length,
        smokePanelFixtureCount: adapterConfig.developmentPanel.members.length,
        selectedTaskId: selectedMember.taskId,
        selectedLabel: selectedAuthority.label,
        selectedCapsuleId: selectedAuthority.capsuleId,
        routing: campaignConfig.routing,
        campaignBudget: campaignConfig.budgets.campaign,
        outerAncestorCapacity,
      },
      fixtureSubstitutions: [
        "The six-member configured development panel is reduced to its authorized OSS-T05 member for a bounded zero-model smoke; the production allocation validation, recursive spawn, settlement lookup, and panel arithmetic still run.",
        "The candidate gate accepts the smoke artifact and smoke-only qBase=0/scale=1 normalization makes the trusted settlement trace explicit; neither has campaign or promotion authority.",
        "The MetaJournalV1 query surface is in memory and child lifecycle files are fixture-authored with production schemas and receipt hashing; the production Broker validates those durable files before the trusted strategy accepts the matching settlement.",
        "The synthetic outer /bin/false evaluator, throwing mutation worker, and integrity-checked synthetic Bun/Pi pack are deliberate non-executed tripwires/initialization fixtures; the selected authorized cohort capsule runs its real train evaluator in Docker.",
        "The smoke candidate uses the production image-bound digest helper: its non-executed comparison image and real child target image differ, and therefore seal distinct optimizer bundle digests before trusted reservation and launch.",
      ],
      syntheticOuterEntrypoint: outerManifest.evalEntrypoint,
      syntheticOuterEntrypointExecuted: false,
      outerMutationImage: MUTATION_IMAGE,
      outerMutationWorkerExecuted: false,
      imageBoundOptimizerIdentity: {
        comparisonImage: outerManifest.image,
        comparisonBundleDigest,
        childTargetImage: childManifest.image,
        childBundleDigest,
        targetImageDiffers: childManifest.image !== outerManifest.image,
        bundleDigestDiffers: childBundleDigest !== comparisonBundleDigest,
      },
      searchPhase: {
        episode: 0,
        candidateArtifact: outerBaseline,
        eventTypes: searchEvents.map((event) => event.type),
        scoredAggregate: recursiveScore.output.objectives.normalizedGain,
      },
      childCapsule: {
        id: childManifest.id,
        digest: capsuleDigest(childManifest),
        image: childManifest.image,
        assetGroupId: "train",
      },
      childEvaluation: record,
      smokeNormalization: {
        qBase: 0,
        scale: 1,
        formula: "(qRaw - qBase) / scale",
        scope: "smoke-only; no campaign or promotion authority",
      },
      modelCalls: 0,
      recursiveScore,
      recursiveResourceLedger: join(smokeRoot, "recursive-resource.ndjson"),
      childTerminalEventsSha256: sha256(durableEvents),
      childBrokerEventCount: childEvents.length,
    };
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${canonicalJson(evidence)}\n`);
  }, 600_000);
});
