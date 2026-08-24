import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  CapsuleManifest,
  ChildRunLaunchReceipt,
  EvaluationRecord,
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
  CasStore,
  RecursiveResourceLedger,
  hashChildRunLaunchReceipt,
  packDirAsArtifact,
  runCommand,
  startBroker,
} from "@hone/broker";
import type {
  MetaMeasurement,
  MetaResourceEnvelopeLedger,
  MetaWorkIdentity,
  Sha256Digest,
} from "@hone/meta";
import {
  RecursiveSearchChildLauncher,
  type CliChildSupervisor,
} from "../src/commands/hone.js";
import { metaWorkKey } from "../src/meta-journal.js";
import type { MetaJournalV1 } from "../src/meta-journal.js";
import type { CampaignPauseAuthority } from "../src/types.js";
import { runEpisodeLoop } from "../../../optimizer/src/loop.js";

const ENABLED = process.env["HONE_CAMPAIGN_SHAKEDOWN"] === "1";
const MUTATION_IMAGE =
  "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10";
const OUTER_CAPSULE_ID = "cap_000000000000";
const CHILD_BUDGET: BudgetEnvelope = {
  maxTokens: 1,
  maxUsd: 1,
  maxWallClockSec: 30,
  maxEvaluatorInvocations: 1,
};
const PANEL_SIZE = 3;
const OUTER_EPISODES = 5;

function sha256(content: string | Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
const SCORE_BY_CANDIDATE_ORDINAL: Record<number, number> = {
  0: 0.5,
  1: 0.8,
  2: 0.7,
  3: 0.6,
  4: 0.6,
  5: 0.75,
};

function workIdentity(request: SpawnRunRequest): MetaWorkIdentity {
  const schedule = request.child.schedule;
  if (schedule === undefined) throw new Error("shakedown child has no schedule");
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

function writeChildEvidence(
  root: string,
  request: SpawnRunRequest,
  admission: ChildRunAdmission,
  status: "completed" | "failed",
): { launchReceiptPath: string; terminalEventPath: string } {
  const runDir = join(root, "children", request.child.runId);
  mkdirSync(runDir, { recursive: true });
  const body = {
    child: request.child,
    depth: request.depth,
    admission,
    launchedAt: "2026-08-24T00:00:00.000Z",
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
      at: "2026-08-24T00:00:00.000Z",
      type: "run.started",
      capsuleId: request.child.capsuleId,
      contractHash: sha256("campaign-shakedown-contract"),
      optimizerDigest: request.child.optimizerArtifact.hash,
      campaignConfigHash: admission.campaignConfigHash,
    },
    {
      runId: request.child.runId,
      at: "2026-08-24T00:00:00.010Z",
      type: "run.finished",
      status,
    },
  ];
  writeFileSync(terminalEventPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return { launchReceiptPath, terminalEventPath };
}

function mutationShim(): Buffer {
  return Buffer.from(
    [
      "#!/bin/sh",
      "set -eu",
      "count_file=/scratch/campaign-shakedown-call-count",
      "count=0",
      "if [ -f \"$count_file\" ]; then count=$(cat \"$count_file\"); fi",
      "count=$((count + 1))",
      "printf '%s\\n' \"$count\" > \"$count_file\"",
      "result() { printf '%s\\n' \"{\\\"summary\\\":\\\"zero-provider campaign shakedown\\\",\\\"approach\\\":\\\"$1\\\",\\\"filesChanged\\\":[]}\"; }",
      "case \"$count\" in",
      "  1)",
      "    printf '%s\\n' promoted > /workspace/promote.txt",
      "    result legitimate-promotion",
      "    ;;",
      "  2)",
      "    printf '%s\\n' canonical-alias > /workspace/alias.txt",
      "    printf '%s\\n' 'first repaired alias attempt failed' >&2",
      "    exit 1",
      "    ;;",
      "  3)",
      "    result first-alias-repair",
      "    ;;",
      "  4)",
      "    printf '%s\\n' promoted > /workspace/promote.txt",
      "    printf '%s\\n' canonical-alias > /workspace/alias.txt",
      "    printf '%s\\n' 'repeat repaired alias attempt failed' >&2",
      "    exit 1",
      "    ;;",
      "  5)",
      "    result repeated-alias-repair",
      "    ;;",
      "  6)",
      "    printf '%s\\n' child-failure > /workspace/child-failure.txt",
      "    result child-failure-candidate",
      "    ;;",
      "  7)",
      "    printf '%s\\n' repaired-child-failure > /workspace/child-failure-repair.txt",
      "    result child-failure-repair",
      "    ;;",
      "  8)",
      "    printf '%s\\n' legitimate-non-promotion > /workspace/non-promotion.txt",
      "    result legitimate-non-promotion",
      "    ;;",
      "  *)",
      "    printf '%s\\n' \"unexpected shakedown mutation call $count\" >&2",
      "    exit 97",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Full campaign-shape smoke. It deliberately keeps provider-backed mutation,
 * real child optimizers/evaluators, frozen campaign files, and campaign run
 * directories outside the test boundary; production schemas, broker RPC,
 * recursive reservations, terminal binding, settlement lookup, optimizer
 * episodes, artifact canonicalization, promotion authority, and finish all run.
 */
describe.skipIf(!ENABLED)("compressed zero-spend full-campaign shakedown", () => {
  it("walks promotion, losing repeat-hash, alias repair, failed child/null aggregate, and non-promotion through a finished run", async () => {
    execFileSync("docker", ["image", "inspect", MUTATION_IMAGE], { stdio: "ignore" });
    const root = mkdtempSync(join(tmpdir(), "hone-campaign-shakedown-"));
    const configHash = sha256("campaign-shakedown-config-v1");
    const panelMembers = Array.from({ length: PANEL_SIZE }, (_, index) => ({
      taskId: `SHAKE-${index}`,
      capsule: {
        capsuleId: `cap_${String(index + 1).padStart(12, "0")}`,
        capsuleDigest: sha256(`shakedown-capsule-${index}`),
        image: `shakedown-child-${index}@${sha256(`child-image-${index}`)}`,
      },
      calibratedInnerCeiling: CHILD_BUDGET,
    }));
    const adapterConfig = {
      counts: { innerEpisodesMax: 1 },
      developmentPanel: { members: panelMembers },
      generation: { stage: "A" },
    } as unknown as RecursiveMetaCampaignConfig;

    const measurements = new Map<string, MetaMeasurement>();
    const failures = new Map<string, {
      workKey: Sha256Digest;
      status: "candidate_failed";
      observed: { tokens: number; usd: number; wallClockSec: number; evaluatorInvocations: number };
    }>();
    const journal = {
      queryTrainMeasurements: () => [...measurements.values()],
      queryFailureSettlements: () => [...failures.values()],
    } as unknown as MetaJournalV1;
    const gate = {
      check: async (request: { sourceArtifact: Sha256Digest }) => ({
        ok: true as const,
        sourceArtifact: request.sourceArtifact,
        bundleDigest: sha256(`${request.sourceArtifact}:comparison`),
        transformationReceiptHash: null,
        feedback: "shakedown fixture admitted",
      }),
      bundleDigestForImage: (sourceArtifact: Sha256Digest, image: string) =>
        sha256(`${sourceArtifact}:${image}`),
    };
    const adapter = new RecursiveSearchChildLauncher(
      root,
      root,
      adapterConfig,
      configHash,
      journal,
      gate,
      {} as CliChildSupervisor,
      {} as MetaResourceEnvelopeLedger,
      {} as CampaignPauseAuthority,
    );

    const outerCapsuleRoot = join(root, "outer-capsule");
    mkdirSync(outerCapsuleRoot, { recursive: true });
    const metaTask = "compressed campaign shape; no provider or protected coordinates\n";
    writeFileSync(join(outerCapsuleRoot, "meta-task.txt"), metaTask);
    const outerBaselineDir = join(root, "outer-baseline");
    mkdirSync(outerBaselineDir, { recursive: true });
    writeFileSync(join(outerBaselineDir, "baseline.txt"), "baseline\n");
    const outerCasDir = join(root, "outer-cas");
    const outerBaseline = await packDirAsArtifact(
      outerBaselineDir,
      new CasStore(outerCasDir),
    ) as Sha256Digest;
    const outerManifest = CapsuleManifest.parse({
      schemaVersion: 2,
      id: OUTER_CAPSULE_ID,
      objective: "exercise the compressed full campaign shape",
      baseline: { kind: "cas", hash: outerBaseline },
      image: MUTATION_IMAGE,
      evalEntrypoint: ["/bin/false"],
      protectedPaths: [],
      assetGroups: [{ id: "meta-train", visibility: "public", paths: ["meta-task.txt"] }],
      budget: {
        maxTokens: 1,
        maxUsd: 1,
        maxWallClockSec: 30,
        maxEvaluatorInvocations: 20,
      },
      diagnosticOrdering: { path: "ordering.json", hash: sha256("shakedown-ordering") },
      contentHashes: { "meta-task.txt": sha256(metaTask) },
      meta: { evaluatorSource: "meta", provenance: "zero-spend campaign shakedown" },
    });

    const resourceEnvelope: BudgetEnvelope = {
      maxTokens: 100,
      maxUsd: 100,
      maxWallClockSec: 1_000,
      maxEvaluatorInvocations: 100,
    };
    const ledger = RecursiveResourceLedger.open(join(root, "recursive-resource.ndjson"));
    const brokerEvents: RunEvent[] = [];
    const dockerCalls: string[][] = [];
    const mutationExitCodes: number[] = [];
    const launchedChildren: SpawnRunRequest[] = [];
    const trustedStrategy = adapter.evaluationStrategy();
    const recursivePlan = {
      depth: 0 as const,
      innerEpisodesMax: 1,
      members: panelMembers.map((member) => ({
        capsuleId: member.capsule.capsuleId,
        calibratedInnerCeiling: CHILD_BUDGET,
      })),
    };
    const running = await startBroker({
      runId: "run_campaign_shakedown",
      manifest: outerManifest,
      capsuleRootDir: outerCapsuleRoot,
      baselineArtifactHash: outerBaseline,
      capsuleDigest: capsuleDigest(outerManifest),
      optimizerDigest: sha256("campaign-shakedown-optimizer"),
      holdoutLedgerPath: join(root, "holdout.ndjson"),
      image: MUTATION_IMAGE,
      runDir: join(root, "outer-run"),
      casDir: outerCasDir,
      onEvent: (event) => brokerEvents.push(event),
      maxPublicCandidateEvaluations: 5,
      evaluationStrategy: async (input) => {
        const record = await trustedStrategy(input);
        return EvaluationRecord.parse({ ...record, costUsd: 0, durationMs: 0 });
      },
      runCommand: async (argv, options) => {
        dockerCalls.push([...argv]);
        const result = await runCommand(argv, options);
        if (argv.includes("/scratch/.hone-runtime/bun") && argv.includes("/scratch/hone-worker.mjs")) {
          mutationExitCodes.push(result.exitCode);
        }
        return result;
      },
      recursive: {
        depth: 0,
        ancestors: [],
        resourceEnvelope,
        ledger,
        evaluationTask: recursivePlan,
        admitChildRun: ({ request }) => {
          const member = panelMembers.find((entry) => entry.capsule.capsuleId === request.child.capsuleId);
          if (member === undefined || request.depth !== 1 || request.child.purpose !== "capsule") return undefined;
          return {
            campaignConfigHash: configHash,
            cohort: "panel-a",
            capsuleProvenanceHash: member.capsule.capsuleDigest,
            sourceProvenanceHash: request.child.sourceArtifact.hash,
            optimizerProvenanceHash: request.child.optimizerArtifact.hash,
          };
        },
        launchChildRun: async ({ request, admission }) => {
          launchedChildren.push(request);
          const identity = workIdentity(request);
          const schedule = request.child.schedule;
          if (schedule === undefined) throw new Error("admitted shakedown child lost its schedule");
          const workKey = metaWorkKey(configHash, identity);
          const failed = (schedule.candidateOrdinal === 3 || schedule.candidateOrdinal === 4)
            && schedule.allocationOrdinal === PANEL_SIZE - 1;
          const evidence = writeChildEvidence(root, request, admission, failed ? "failed" : "completed");
          const observed = {
            tokens: 0,
            usd: 0,
            wallClockSec: 0.01,
            evaluatorInvocations: 1,
          };
          return {
            ...evidence,
            usage: observed,
            finalizeSettlement: () => {
              if (failed) {
                failures.set(workKey, { workKey, status: "candidate_failed", observed });
                return;
              }
              const qNormalized = SCORE_BY_CANDIDATE_ORDINAL[schedule.candidateOrdinal];
              if (qNormalized === undefined) {
                throw new Error(`no shakedown score for candidate ordinal ${schedule.candidateOrdinal}`);
              }
              measurements.set(workKey, {
                ...identity,
                workKey,
                qNormalized,
                observed,
              } as MetaMeasurement);
            },
          };
        },
      },
    }, {
      socketPath: join(root, "broker.sock"),
      publicToken: "s".repeat(64),
    });
    const finish = vi.spyOn(running.broker, "finish");

    const workerBundlePath = join(root, "worker.mjs");
    writeFileSync(workerBundlePath, "throw new Error('provider-backed worker must never execute');\n");
    const bunRuntime = mutationShim();
    const piRuntime = Buffer.from("provider-backed Pi runtime forbidden in campaign shakedown", "utf8");
    const rawSha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(root, "mutation-runtime.json"), `${canonicalJson({
      version: 1,
      bun: {
        version: "1.3.14",
        sourceName: "bun",
        bundleName: "bun.gz",
        sandboxName: "bun",
        sha256: rawSha256(bunRuntime),
        mode: 0o500,
      },
      pi: {
        version: "16.5.2",
        files: [{
          sourceName: "pi_natives.linux-x64-baseline.node",
          bundleName: "pi_natives.linux-x64-baseline.node.gz",
          sandboxName: "pi_natives.linux-x64-baseline.node",
          sha256: rawSha256(piRuntime),
          mode: 0o400,
        }],
      },
    })}\n`);
    writeFileSync(join(root, "bun.gz"), gzipSync(bunRuntime, { level: 1 }));
    writeFileSync(join(root, "pi_natives.linux-x64-baseline.node.gz"), gzipSync(piRuntime, { level: 1 }));

    const searchEvents: RunEvent[] = [];
    const priorToken = process.env["HONE_BROKER_TOKEN"];
    let finalBudget;
    try {
      process.env["HONE_BROKER_TOKEN"] = running.publicToken;
      await runEpisodeLoop({
        brokerSocket: running.socketPath,
        runId: "run_campaign_shakedown",
        workerBundlePath,
        maxEpisodes: OUTER_EPISODES,
        rand: (episode) => (episode === 2 ? 0 : 0.99),
        emit: (event) => {
          searchEvents.push(event);
          return event;
        },
      });
      finalBudget = running.broker.getBudget({ privileged: true });
    } finally {
      if (priorToken === undefined) delete process.env["HONE_BROKER_TOKEN"];
      else process.env["HONE_BROKER_TOKEN"] = priorToken;
      await running.close();
      ledger.close();
    }

    const stateLines = readFileSync(join(root, "outer-run", "broker-state.ndjson"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const candidateEvents = searchEvents.filter((event) => event.type === "episode.candidate");
    const candidateHashes = candidateEvents.map((event) => event.candidate.hash);
    const promoted = searchEvents.filter((event) => event.type === "incumbent.new");
    const brokerPromoted = brokerEvents.filter((event) => event.type === "incumbent.new");
    const completed = brokerEvents
      .filter((event) => event.type === "episode.completed")
      .map((event) => event.episode);
    const nullEvaluations = searchEvents.filter(
      (event): event is Extract<RunEvent, { type: "eval.completed" }> =>
        event.type === "eval.completed" && event.aggregate === null,
    );
    const repeatedHash = candidateHashes[1];
    if (repeatedHash === undefined) throw new Error("shakedown did not produce its repaired alias");
    const repeatedEvals = stateLines.filter((line) =>
      line["t"] === "eval"
      && (line["record"] as { artifactHash?: string } | undefined)?.artifactHash === repeatedHash
    );
    const continuations = stateLines.filter((line) => line["t"] === "continuation");
    const finishCalls = finish.mock.calls;
    const localRepeatGates = searchEvents.filter(
      (event): event is Extract<RunEvent, { type: "gate.paired" }> =>
        event.type === "gate.paired" && (event.episode === 1 || event.episode === 2),
    );
    const terminalDecisionGates = searchEvents.filter(
      (event): event is Extract<RunEvent, { type: "gate.paired" }> =>
        event.type === "gate.paired" && (event.episode === 0 || event.episode === 4),
    );

    expect(searchEvents.filter((event) => event.type === "episode.started").map((event) => event.episode))
      .toEqual([0, 1, 2, 3, 4]);
    expect(completed).toEqual([0, 1, 2, 3, 4]);
    expect(mutationExitCodes).toEqual([0, 1, 0, 1, 0, 0, 0, 0]);
    expect(candidateHashes[1]).toBe(candidateHashes[2]);
    expect(localRepeatGates.map((event) => event.passed)).toEqual([false, true]);
    expect(terminalDecisionGates.map((event) => [event.episode, event.passed])).toEqual([
      [0, true],
      [4, false],
    ]);
    expect(repeatedEvals).toHaveLength(2);
    expect(repeatedEvals[0]?.["gate"]).toMatchObject({ passed: false });
    expect(repeatedEvals[1]).not.toHaveProperty("gate");
    expect(continuations).toEqual([
      expect.objectContaining({ t: "continuation", hash: repeatedHash, episode: 2 }),
    ]);
    expect(promoted).toHaveLength(1);
    expect(brokerPromoted).toHaveLength(1);
    expect(brokerPromoted[0]?.artifact.hash).toBe(promoted[0]?.artifact.hash);
    expect(nullEvaluations.map((event) => event.episode)).toEqual([3, 3]);
    expect(searchEvents.filter((event) => event.type === "episode.invalid")).toEqual([
      expect.objectContaining({ episode: 1, repaired: true }),
      expect.objectContaining({ episode: 2, repaired: true }),
      expect.objectContaining({ episode: 3, repaired: false, reason: expect.stringContaining("invalid") }),
    ]);
    expect(failures).toHaveLength(2);
    expect(launchedChildren).toHaveLength(18);
    expect(launchedChildren.every((request) => request.child.schedule !== undefined)).toBe(true);
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0]?.[0].best.hash).toBe(brokerPromoted[0]?.artifact.hash);
    expect(finalBudget).toMatchObject({ spent: { tokens: 0, usd: 0, evaluatorInvocations: 11 } });
    expect(dockerCalls.some((argv) => argv.includes("/bin/false"))).toBe(false);

    const summary = {
      target: "shakedown:campaign",
      result: "passed",
      zeroSpend: {
        modelCalls: 0,
        providerCalls: 0,
        tokens: finalBudget?.spent.tokens,
        usd: finalBudget?.spent.usd,
      },
      coverage: {
        outerEpisodes: completed.length,
        panelChildren: PANEL_SIZE,
        childLaunches: launchedChildren.length,
        failedChildSettlements: failures.size,
        nullAggregates: nullEvaluations.length,
        repairedAliasAcrossEpisodes: candidateHashes[1] === candidateHashes[2],
        repeatFirstVerdictNonPositiveLaterLocalPositive:
          localRepeatGates.map((event) => event.passed).join(",") === "false,true",
        legitimatePromotions: brokerPromoted.length,
        legitimateNonPromotionEpisode:
          terminalDecisionGates.find((event) => event.passed === false)?.episode,
        optimizerFinishCalls: finishCalls.length,
      },
      exclusions: [
        "provider-backed mutation workers and model routes are tripwires, not executed",
        "child optimizer/evaluator processes are replaced by schema-valid terminal and zero-cost settlement fixtures",
        "frozen production campaign configs, capsules, and preserved run directories are not read or written",
      ],
    };
    console.log(`campaign-shakedown assertion summary: ${canonicalJson(summary)}`);
    rmSync(root, { recursive: true, force: true });
  }, 120_000);
});
