import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
const COMPRESSED_LEGACY_SANDBOX_TTL_SEC = 1;
const COMPRESSED_PANEL_HOLD_MS = 1_500;

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
  it("scores a real recursive panel, survives the legacy sandbox TTL, reuses episode-local continuation bytes, and continues after null", async () => {
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
    expect(executedSourceCommit).toBe(campaignConfig.trustedRuntime.sourceCommit);
    const configHash = sha256(canonicalJson(campaignConfig));
    if (!("mode" in campaignConfig.corpusCohort)) {
      throw new Error("smoke campaign must carry the owner-authorized partial cohort");
    }
    const partialCohort = campaignConfig.corpusCohort.partialCohort;
    const smokeBudget = { ...CHILD_BUDGET, maxWallClockSec: campaignConfig.evaluatorTimeoutSec };
    const smokeTaskIds = ["OWN-T03", "OWN-T06", "OSS-T05"] as const;
    const smokeMembers = smokeTaskIds.map((taskId) => {
      const member = campaignConfig.developmentPanel.members.find((candidate) => candidate.taskId === taskId);
      if (member === undefined) throw new Error(`smoke campaign panel has no ${taskId} member`);
      return { ...member, calibratedInnerCeiling: smokeBudget };
    });
    const smokeCapsuleIds = new Set(smokeMembers.map((member) => member.capsule.capsuleId));
    const smokeAuthorities = smokeMembers.map((member) => {
      const authority = partialCohort.admitted.find(
        (entry) => entry.capsuleId === member.capsule.capsuleId,
      );
      if (authority === undefined) {
        throw new Error(`smoke panel member ${member.taskId} is absent from the admitted cohort`);
      }
      return authority;
    });
    const smokeRoot = join(repoRoot, ".hone-runs", "m2-recursive-search-smoke");
    rmSync(smokeRoot, { recursive: true, force: true });
    mkdirSync(smokeRoot, { recursive: true });

    const candidateSnapshot = {
      files: new Map([
        ["optimizer/src/smoke-candidate.ts", {
          bytes: Buffer.from("image-bound recursive smoke candidate\n", "utf8"),
          mode: 0o644,
        }],
      ]),
    };
    const comparisonBundleDigest = imageBoundCandidateBundleDigest(candidateSnapshot, MUTATION_IMAGE);
    const childExecutionByCapsule = new Map<string, {
      baseline: Sha256Digest;
      bundleDigest: Sha256Digest;
      capsuleDir: string;
      casDir: string;
      manifest: CapsuleManifest;
    }>();
    for (const [index, member] of smokeMembers.entries()) {
      const authority = smokeAuthorities[index]!;
      const capsuleDir = join(repoRoot, "capsules", authority.label);
      const manifest = CapsuleManifest.parse(
        JSON.parse(readFileSync(join(capsuleDir, "manifest.json"), "utf8")),
      );
      if (
        manifest.id !== authority.capsuleId
        || capsuleDigest(manifest) !== authority.capsuleDigest
      ) {
        throw new Error(`smoke child ${member.taskId} does not reproduce the frozen cohort authority`);
      }
      const bundleDigest = imageBoundCandidateBundleDigest(candidateSnapshot, manifest.image);
      const casDir = join(smokeRoot, `inner-cas-${manifest.id}`);
      const baseline = await packDirAsArtifact(
        join(capsuleDir, "baseline"),
        new CasStore(casDir),
      ) as Sha256Digest;
      childExecutionByCapsule.set(manifest.id, {
        baseline,
        bundleDigest,
        capsuleDir,
        casDir,
        manifest,
      });
    }
    expect([...childExecutionByCapsule.values()].some(
      (execution) => execution.manifest.image !== MUTATION_IMAGE,
    )).toBe(true);
    expect([...childExecutionByCapsule.values()].some(
      (execution) => execution.bundleDigest !== comparisonBundleDigest,
    )).toBe(true);
    const childEvents: RunEvent[] = [];
    const innerRecords = new Map<string, EvaluationRecord>();
    const childTerminalEventPaths: string[] = [];
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
      counts: {
        ...campaignConfig.counts,
        searchChildConcurrency: 3,
      },
      developmentPanel: {
        ...campaignConfig.developmentPanel,
        members: smokeMembers,
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
    let enteredChildren = 0;
    let peakOpenRecursiveReservations = 0;
    let releaseConcurrentChildren!: () => void;
    const allConcurrentChildrenEntered = new Promise<void>((resolve) => {
      releaseConcurrentChildren = resolve;
    });

    const metaTask = "trusted recursive smoke; no corpus or terminal coordinates\n";
    const outerCapsuleRoot = join(smokeRoot, "outer-capsule");
    mkdirSync(outerCapsuleRoot, { recursive: true });
    writeFileSync(join(outerCapsuleRoot, "meta-task.txt"), metaTask);
    const outerBaselineDir = join(smokeRoot, "outer-baseline");
    mkdirSync(outerBaselineDir, { recursive: true });
    writeFileSync(join(outerBaselineDir, "package.json"), `${canonicalJson({ name: "recursive-smoke" })}\n`);
    const outerCasDir = join(smokeRoot, "outer-cas");
    const outerBaseline = await packDirAsArtifact(outerBaselineDir, new CasStore(outerCasDir)) as Sha256Digest;
    const outerManifest = CapsuleManifest.parse({
      schemaVersion: 2,
      id: OUTER_CAPSULE_ID,
      objective: "prove recursive candidate evaluation starts and scores",
      baseline: { kind: "cas", hash: outerBaseline },
      image: MUTATION_IMAGE,
      evalEntrypoint: ["/bin/false"],
      protectedPaths: [],
      assetGroups: [{ id: "meta-train", visibility: "public", paths: ["meta-task.txt"] }],
      budget: { ...smokeBudget, maxWallClockSec: smokeBudget.maxWallClockSec + 300, maxEvaluatorInvocations: 5 },
      diagnosticOrdering: { path: "ordering.json", hash: sha256("smoke-ordering") },
      contentHashes: { "meta-task.txt": sha256(metaTask) },
      meta: { evaluatorSource: "meta", provenance: "bounded recursive wiring smoke" },
    });
    const outerDockerCalls: string[][] = [];
    const outerMutationExecutions: { exitCode: number; stdoutSha256: Sha256Digest }[] = [];
    const outerBrokerEvents: RunEvent[] = [];
    const controller = new AbortController();
    let scored: EvaluationRecord | undefined;
    let trustedStrategyCalls = 0;
    let nullAggregateEvaluations = 0;
    let firstPanelElapsedMs = 0;
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
      onEvent: (event) => outerBrokerEvents.push(event),
      runCommand: async (argv, opts) => {
        outerDockerCalls.push([...argv]);
        const result = await runCommand(argv, opts);
        if (argv.includes("/scratch/.hone-runtime/bun") && argv.includes("/scratch/hone-worker.mjs")) {
          outerMutationExecutions.push({
            exitCode: result.exitCode,
            stdoutSha256: sha256(result.stdout),
          });
        }
        if (
          outerMutationExecutions.length === 4
          && outerMutationExecutions[3]?.exitCode === 0
        ) {
          // Stop after the later episode has successfully repaired from the
          // exact aliased continuation bytes, before M0's one-candidate
          // evaluator authority would be asked to score that candidate again.
          controller.abort();
        }
        return result;
      },
      defaultTtlSec: COMPRESSED_LEGACY_SANDBOX_TTL_SEC,
      reaperIntervalMs: 50,
      evaluationStrategy: async (input) => {
        trustedStrategyCalls += 1;
        if (trustedStrategyCalls === 1) {
          const startedAt = Date.now();
          try {
            scored = await trustedStrategy(input);
            const remainingHoldMs = COMPRESSED_PANEL_HOLD_MS - (Date.now() - startedAt);
            if (remainingHoldMs > 0) {
              // Integration-only real-clock seam: the production broker reaper must actually tick past its compressed old TTL.
              await delay(remainingHoldMs);
            }
            firstPanelElapsedMs = Date.now() - startedAt;
            return scored;
          } catch (error) {
            writeFileSync(
              join(smokeRoot, "trusted-strategy-error.txt"),
              `${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error)}\n`,
            );
            throw error;
          }
        }
        const firstAggregate = scored?.output.objectives.normalizedGain;
        if (trustedStrategyCalls === 2 || trustedStrategyCalls === 4) {
          if (firstAggregate === undefined) {
            throw new Error("smoke fixture cannot score a later episode before the trusted panel");
          }
          return EvaluationRecord.parse({
            capsuleId: input.capsuleId,
            artifactHash: input.artifact.hash,
            assetGroupId: input.assetGroupId,
            seed: input.seed,
            output: {
              valid: true,
              objectives: { normalizedGain: firstAggregate - (trustedStrategyCalls === 2 ? 1 : 0) },
              constraints: { allChildrenValid: true, fullPanel: true },
              perExample: {},
              diagnostics: {
                summary: trustedStrategyCalls === 2
                  ? "smoke fixture: repaired alias candidate remains below its parent"
                  : "smoke fixture: post-null parent remains eligible for the alias reproduction",
              },
            },
            costUsd: 0,
            durationMs: 0,
            cached: false,
            evaluatedAt: new Date().toISOString(),
          });
        }
        if (trustedStrategyCalls !== 3) {
          throw new Error(`unexpected smoke trusted strategy call ${trustedStrategyCalls}`);
        }
        nullAggregateEvaluations += 1;
        return EvaluationRecord.parse({
          capsuleId: input.capsuleId,
          artifactHash: input.artifact.hash,
          assetGroupId: input.assetGroupId,
          seed: input.seed,
          output: {
            valid: false,
            objectives: {},
            constraints: { allChildrenValid: false, fullPanel: false },
            perExample: {},
            diagnostics: { summary: "smoke fixture: settled recursive panel contains no eligible aggregate" },
          },
          costUsd: 0,
          durationMs: 0,
          cached: false,
          evaluatedAt: new Date().toISOString(),
        });
      },
      recursive: {
        depth: 0,
        ancestors: [],
        resourceEnvelope: outerAncestorCapacity.ancestorEnvelope,
        ledger,
        evaluationTask: {
          depth: 0,
          innerEpisodesMax: 1,
          members: smokeMembers.map((member) => ({
            capsuleId: member.capsule.capsuleId,
            calibratedInnerCeiling: smokeBudget,
          })),
        },
        admitChildRun: ({ request }) => {
          const execution = childExecutionByCapsule.get(request.child.capsuleId);
          if (
            execution === undefined
            || request.child.sourceArtifact.hash !== outerBaseline
            || request.child.optimizerArtifact.hash !== execution.bundleDigest
          ) {
            return undefined;
          }
          return {
            campaignConfigHash: configHash,
            cohort: "panel-a",
            capsuleProvenanceHash: capsuleDigest(execution.manifest),
            sourceProvenanceHash: outerBaseline,
            optimizerProvenanceHash: execution.bundleDigest,
          };
        },
        launchChildRun: async ({ request, admission: admitted }) => {
          enteredChildren += 1;
          peakOpenRecursiveReservations = Math.max(
            peakOpenRecursiveReservations,
            ledger.budgetState("run_recursive_outer_smoke").openReservations,
          );
          if (enteredChildren === smokeMembers.length) releaseConcurrentChildren();
          await allConcurrentChildrenEntered;

          const execution = childExecutionByCapsule.get(request.child.capsuleId);
          if (execution === undefined) throw new Error("smoke child has no evaluator execution fixture");
          const innerManifest = execution.manifest;
          const inner = new Broker({
            runId: request.child.runId,
            manifest: innerManifest,
            capsuleRootDir: execution.capsuleDir,
            baselineArtifactHash: execution.baseline,
            capsuleDigest: capsuleDigest(innerManifest),
            optimizerDigest: execution.bundleDigest,
            measurementEpoch: `m2-recursive-smoke-inner:${request.child.runId}`,
            holdoutLedgerPath: join(smokeRoot, `inner-holdout-${request.child.runId}.ndjson`),
            image: innerManifest.image,
            runDir: join(smokeRoot, `inner-run-${request.child.runId}`),
            casDir: execution.casDir,
            onEvent: (event) => childEvents.push(event),
            evalTimeoutSec: campaignConfig.evaluatorTimeoutSec,
          });
          let record: EvaluationRecord;
          try {
            await inner.init();
            record = await inner.evaluate(
              { artifact: { hash: execution.baseline }, assetGroupId: "train", seed: 0 },
              { privileged: true },
            );
          } finally {
            await inner.close();
          }
          innerRecords.set(request.child.runId, record);
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
          childTerminalEventPaths.push(evidence.terminalEventPath);
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
    writeFileSync(workerBundlePath, "throw new Error('smoke worker argument must not be executed by the lifecycle shim');\n");
    const bunRuntime = Buffer.from(
      [
        "#!/bin/sh",
        "if [ ! -f /workspace/episode-alias.txt ]; then",
        "  printf '%s\\n' 'canonical cross-episode continuation bytes' > /workspace/episode-alias.txt",
        "  printf '%s\\n' 'smoke fixture: first mutation attempt fails after producing canonical bytes' >&2",
        "  exit 1",
        "fi",
        "printf '%s\\n' '{\"summary\":\"zero-provider lifecycle shim\",\"approach\":\"episode-local-alias-repair\",\"filesChanged\":[]}'",
        "",
      ].join("\n"),
      "utf8",
    );
    const piRuntime = Buffer.from("sealed Pi native fixture; provider-backed mutation is forbidden in this smoke", "utf8");
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
        maxEpisodes: 3,
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
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.observed.usd === 0)).toBe(true);
    expect(new Set(rows.map((row) => row.capsuleId))).toEqual(smokeCapsuleIds);
    expect(innerRecords.size).toBe(3);
    expect(childTerminalEventPaths).toHaveLength(3);
    expect(recursiveScore.output.valid).toBe(true);
    expect([...innerRecords.values()].every((record) => record.costUsd === 0)).toBe(true);
    expect(recursiveScore.costUsd).toBe(0);
    expect(recursiveScore.output.constraints).toEqual({ allChildrenValid: true, fullPanel: true });
    const normalizedScores = rows.map((row) => row.qNormalized);
    expect(recursiveScore.output.objectives.normalizedGain).toBe(
      normalizedScores.reduce((sum, score) => sum + score, 0) / normalizedScores.length,
    );
    const started = searchEvents.filter((event) => event.type === "episode.started");
    const evaluations = searchEvents.filter((event) => event.type === "eval.completed");
    const nullEvaluations = evaluations.filter((event) => event.aggregate === null);
    const invalidEpisodes = searchEvents.filter((event) => event.type === "episode.invalid");
    const repairedCandidates = searchEvents.filter((event) => event.type === "episode.candidate");
    const brokerStartedEpisodes = outerBrokerEvents
      .filter((event) => event.type === "episode.started")
      .map((event) => event.episode);
    const brokerCompletedEpisodes = outerBrokerEvents
      .filter((event) => event.type === "episode.completed")
      .map((event) => event.episode);
    const mutationShimCalls = outerDockerCalls.filter(
      (argv) => argv.includes("/scratch/.hone-runtime/bun") && argv.includes("/scratch/hone-worker.mjs"),
    );
    const repairedCandidateHashes = repairedCandidates.map((event) => event.candidate.hash);
    const brokerStatePath = join(smokeRoot, "outer-run", "broker-state.ndjson");
    const continuationFacts = readFileSync(brokerStatePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line["t"] === "continuation");
    expect(started.map((event) => event.episode)).toEqual([0, 1, 2]);
    expect(evaluations[0]).toMatchObject({
      episode: 0,
      artifact: { hash: outerBaseline },
      aggregate: recursiveScore.output.objectives.normalizedGain,
      cached: false,
    });
    expect(repairedCandidates.map((event) => event.episode)).toEqual([0]);
    expect(repairedCandidateHashes).toHaveLength(1);
    expect(repairedCandidateHashes[0]).not.toBe(outerBaseline);
    expect(continuationFacts).toEqual([
      expect.objectContaining({
        t: "continuation",
        hash: repairedCandidateHashes[0],
        parent: outerBaseline,
        episode: 2,
      }),
    ]);
    expect(nullEvaluations.map((event) => event.episode)).toEqual([1]);
    expect(invalidEpisodes).toEqual([
      expect.objectContaining({ episode: 0, repaired: true, reason: expect.stringContaining("mutation session failed") }),
      expect.objectContaining({ episode: 1, repaired: false, reason: expect.stringContaining("null aggregate") }),
    ]);
    expect(brokerStartedEpisodes).toEqual([0, 1, 2]);
    expect(brokerCompletedEpisodes).toEqual([0, 1]);
    expect(trustedStrategyCalls).toBe(4);
    expect(nullAggregateEvaluations).toBe(1);
    expect(firstPanelElapsedMs).toBeGreaterThan(COMPRESSED_LEGACY_SANDBOX_TTL_SEC * 1_000);
    expect(mutationShimCalls).toHaveLength(4);
    expect(outerMutationExecutions.map((execution) => execution.exitCode)).toEqual([1, 0, 1, 0]);
    expect(outerDockerCalls.some((argv) => argv.includes("/bin/false"))).toBe(false);
    const isolationEvents = childEvents.filter((event) => event.type === "evaluator.isolation");
    expect(isolationEvents).toHaveLength(3);
    expect(isolationEvents.every((event) => event.isolation.mode === "reserved-uid")).toBe(true);
    expect(new Set(isolationEvents.map((event) => event.isolation.workerUid))).toHaveLength(3);
    expect(peakOpenRecursiveReservations).toBe(3);
    const durableEvents = Buffer.concat(
      childTerminalEventPaths.sort().map((eventPath) => readFileSync(eventPath)),
    );
    const evidence = {
      version: "m2-search-concurrency-smoke.v1",
      recordedAt: new Date().toISOString(),
      command:
        `sg docker -c 'HONE_RECURSIVE_SEARCH_SMOKE=1 HONE_REPO_ROOT=${repoRoot} HONE_RECURSIVE_SMOKE_CAMPAIGN=${campaignPath} HONE_RECURSIVE_SMOKE_EVIDENCE=${evidencePath} ./node_modules/.bin/vitest run --root trusted/cli test/recursive-search.smoke.test.ts'`,
      result: "passed: config-bound SEARCH ran three overlapping real evaluators on distinct reserved UIDs, then continued through the null/repair lifecycle",
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
        selectedMembers: smokeMembers.map((member, index) => ({
          taskId: member.taskId,
          label: smokeAuthorities[index]!.label,
          capsuleId: member.capsule.capsuleId,
        })),
        routing: campaignConfig.routing,
        campaignBudget: campaignConfig.budgets.campaign,
        outerAncestorCapacity,
      },
      fixtureSubstitutions: [
        "The six-member configured development panel is reduced to three distinct allocation identities backed by the same authorized OSS-T05 runtime for a bounded zero-model concurrency smoke. This covers dispatch overlap, reservation/settlement ordering, and real evaluator isolation; it does not claim three-capsule scientific diversity.",
        "The candidate gate accepts the smoke artifact and smoke-only qBase=0/scale=1 normalization makes the trusted settlement trace explicit; neither has campaign or promotion authority.",
        "The MetaJournalV1 query surface is in memory and child lifecycle files are fixture-authored with production schemas and receipt hashing; separate durable journal regressions cover interleaved pending replay. The production Broker validates these files before the trusted strategy accepts each matching settlement.",
        "The broker's historical 3,600-second default sandbox TTL is compressed to one second while the optimizer still derives the episode claim from the campaign wall envelope. The trusted recursive panel is held beyond that compressed boundary before a real Docker sandbox executes the post-evaluation mutation shim; the pre-fix TTL runtime would reap that sandbox and fail with SANDBOX_NOT_FOUND.",
        "The executable Bun fixture makes each eligible fresh mutation attempt write the same canonical file and fail, then makes the one-repair sandbox succeed without changing those bytes. Episode 0 graduates that hash; after the null episode, episode 2 reproduces the hash, persists an episode-local continuation fact, and repairs from it. This matches the production failure seam without executing a provider-backed worker.",
        "One smoke-only trusted strategy record deliberately returns valid=false with no objectives and zero cost. That null aggregate is durably completed and the next episode starts. Two other smoke-only strategy records preserve eligible parent/candidate ordering at zero cost. None can mint a promotion or calibration gain.",
        "The synthetic outer /bin/false evaluator and throwing mutation worker remain tripwires. An integrity-checked executable Bun fixture deliberately ignores the worker argument and drives the bounded fail/repair lifecycle, exercising post-evaluation mutation plumbing with zero provider/model calls. The harness aborts only after the later episode's repair save succeeds, before M0's one-public-candidate evaluation authority would be consumed a second time.",
        "The smoke candidate uses the production image-bound digest helper: its non-executed comparison image and real child target image differ, and therefore seal distinct optimizer bundle digests before trusted reservation and launch.",
      ],
      syntheticOuterEntrypoint: outerManifest.evalEntrypoint,
      syntheticOuterEntrypointExecuted: false,
      outerMutationImage: MUTATION_IMAGE,
      outerMutationWorkerExecuted: false,
      outerMutationShimExecuted: mutationShimCalls.length > 0,
      imageBoundOptimizerIdentity: {
        comparisonImage: outerManifest.image,
        comparisonBundleDigest,
        childTargets: [...childExecutionByCapsule.values()].map((execution) => ({
          image: execution.manifest.image,
          bundleDigest: execution.bundleDigest,
          targetImageDiffers: execution.manifest.image !== outerManifest.image,
          bundleDigestDiffers: execution.bundleDigest !== comparisonBundleDigest,
        })),
      },
      searchPhase: {
        episode: 0,
        parentArtifact: outerBaseline,
        repairedCandidateArtifact: repairedCandidateHashes[0],
        eventTypes: searchEvents.map((event) => event.type),
        scoredAggregate: recursiveScore.output.objectives.normalizedGain,
        searchChildConcurrency: adapterConfig.counts.searchChildConcurrency,
        peakOpenRecursiveReservations,
        evaluatorIsolation: isolationEvents.map((event) => event.isolation),
      },
      episodeLifecycle: {
        productionLegacySandboxTtlSec: 3_600,
        compressedLegacySandboxTtlSec: COMPRESSED_LEGACY_SANDBOX_TTL_SEC,
        optimizerEpisodeClaimTtlSec: outerManifest.budget.maxWallClockSec,
        compressedPanelHoldMs: COMPRESSED_PANEL_HOLD_MS,
        observedFirstPanelElapsedMs: firstPanelElapsedMs,
        postEvaluationMutationShimExecuted: mutationShimCalls.length > 0,
        brokerStartedEpisodes,
        brokerCompletedEpisodes,
      },
      continuationArtifactLifecycle: {
        mutationExecutions: outerMutationExecutions,
        repairedCandidateHashes,
        continuationFacts,
        exactCrossEpisodeAlias: repairedCandidateHashes.length === 1
          && continuationFacts.length === 1
          && continuationFacts[0]?.["hash"] === repairedCandidateHashes[0],
        laterEpisodeRepairCompletedBeforeAbort: outerMutationExecutions.length === 4
          && outerMutationExecutions[3]?.exitCode === 0,
      },
      nullAggregateLifecycle: {
        trustedStrategyCalls,
        nullAggregateEvaluations,
        optimizerNullEvaluationEpisodes: nullEvaluations.map((event) => event.episode),
        optimizerInvalidEpisodes: invalidEpisodes.map((event) => event.episode),
        nextEpisodeStarted: brokerStartedEpisodes.includes(2),
        promotionEvents: searchEvents.filter((event) => event.type === "incumbent.new").length,
      },
      childCapsules: [...childExecutionByCapsule.values()].map((execution) => ({
        id: execution.manifest.id,
        digest: capsuleDigest(execution.manifest),
        image: execution.manifest.image,
        assetGroupId: "train",
      })),
      childEvaluations: [...innerRecords.values()],
      smokeNormalization: {
        qBase: 0,
        scale: 1,
        formula: "(qRaw - qBase) / scale",
        scope: "smoke-only; no campaign or promotion authority",
      },
      trustedMeasurementRows: rows,
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
