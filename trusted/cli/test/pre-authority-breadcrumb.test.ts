import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MetaCampaignConfigV1, MetaCampaignConfigV2, canonicalJson } from "@hone/schema";
import {
  type MetaChildRunRequest,
  type Sha256Digest,
} from "@hone/meta";
import {
  CampaignModelRegistry,
  campaignChildDispatchPolicy,
  CliChildSupervisor,
  writeCampaignOuterRunConfig,
} from "../src/commands/hone.js";
import { appendEvent, readEvents } from "../src/eventlog.js";
import type { CmdIo } from "../src/io.js";
import { metaCampaignConfigHash } from "../src/meta-journal.js";
import {
  PRE_AUTHORITY_BREADCRUMB_FILE,
  PreAuthorityRefusalBreadcrumbV1,
} from "../src/pre-authority-breadcrumb.js";
import type { TrustedRunOptions } from "../src/supervisor.js";

const SESSION_NO_YIELD_MAX_TOKENS = 1_700_000;
const frozenConfigPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen-recursive-capacity.json",
  import.meta.url,
));
const m1Config = MetaCampaignConfigV1.parse({
  ...JSON.parse(readFileSync(fileURLToPath(new URL(
    "../../../schema/fixtures/meta-campaign.m1.json",
    import.meta.url,
  )), "utf8")),
  sessionNoYieldMaxTokens: SESSION_NO_YIELD_MAX_TOKENS,
});
const config = MetaCampaignConfigV2.parse({
  ...JSON.parse(readFileSync(frozenConfigPath, "utf8")),
  sessionNoYieldMaxTokens: SESSION_NO_YIELD_MAX_TOKENS,
});
const configHash = metaCampaignConfigHash(config) as Sha256Digest;
const capsule = config.developmentPanel.members[0]!.capsule;
const sourceArtifact = config.seedOptimizer.sourceArtifact as Sha256Digest;
const bundleDigest = config.seedOptimizer.bundleDigest as Sha256Digest;
const budget = {
  maxTokens: 1_000,
  maxUsd: 1,
  maxWallClockSec: 60,
  maxEvaluatorInvocations: 2,
};
const childRunId = "run_meta_preauthority_breadcrumb_fixture";
const request: MetaChildRunRequest = {
  identity: {
    phase: "search",
    arm: "candidate",
    sourceArtifact,
    bundleDigest,
    capsuleId: capsule.capsuleId,
    replicate: 0,
    measurementEpoch: "m2:preauthority-breadcrumb-fixture",
  },
  reservation: {
    configHash,
    workKey: `sha256:${"b".repeat(64)}`,
    childRunId,
    identity: {
      phase: "search",
      arm: "candidate",
      sourceArtifact,
      bundleDigest,
      capsuleId: capsule.capsuleId,
      replicate: 0,
      measurementEpoch: "m2:preauthority-breadcrumb-fixture",
    },
    reserved: budget,
    envelope: null,
  },
  sourceArtifact,
  bundleDigest,
  capsule,
  innerEpisodesMax: 1,
  requestedModel: config.routing.innerMutation,
  remainingBudget: budget,
  attempt: 0,
  resume: false,
};
const DIVERGENCE = "docker client environment diverges between the run env and this process (DOCKER_HOST, DOCKER_CONFIG) — refusing before any Docker contact";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class RefusingChildSupervisor extends CliChildSupervisor {
  readonly trustedRuns: TrustedRunOptions[] = [];

  constructor(
    private readonly root: string,
    campaignDir: string,
    outerRunDir: string,
    private readonly establishJournalAuthority: boolean,
  ) {
    const io: CmdIo = { root, env: {}, isTTY: false, out: () => {}, err: () => {} };
    super(
      io,
      campaignChildDispatchPolicy(config, { campaignConfigHash: configHash }),
      campaignDir,
      new Map([[capsule.capsuleDigest, {
        dir: "/fixture/preauthority-capsule",
        digest: capsule.capsuleDigest,
        terminalHoldoutAssetGroupIds: [],
      }]]),
      { files: new Map() },
      {} as CampaignModelRegistry,
      undefined,
      outerRunDir,
    );
  }

  protected override async runChildCommand(
    _args: string[],
    io: CmdIo,
    trusted: TrustedRunOptions,
  ): Promise<number> {
    this.trustedRuns.push(trusted);
    const runId = trusted.runId;
    if (runId === undefined) throw new Error("fixture child has no trusted run id");
    const runDir = join(this.root, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    if (readEvents(runDir).length === 0) {
      appendEvent(runDir, {
        runId,
        at: "2026-08-26T12:00:00.000Z",
        type: "run.started",
        capsuleId: capsule.capsuleId,
        contractHash: `sha256:${"c".repeat(64)}`,
        optimizerDigest: bundleDigest,
        checkpointVersion: 1,
        campaignConfigHash: configHash,
      });
    }
    if (this.establishJournalAuthority) {
      writeFileSync(join(runDir, "broker-state.ndjson"), `${JSON.stringify({ t: "start", atMs: 0 })}\n`);
    }
    io.err(DIVERGENCE);
    return 1;
  }
}

function makeSupervisor(
  blockBreadcrumbPath = false,
  establishJournalAuthority = false,
): {
  root: string;
  campaignDir: string;
  outerRunDir: string;
  supervisor: RefusingChildSupervisor;
} {
  const root = mkdtempSync(join(tmpdir(), "hone-preauthority-breadcrumb-"));
  roots.push(root);
  const campaignDir = join(root, ".hone-runs", "recursive-cell-fixture");
  const outerRunDir = join(root, ".hone-runs", "run_recursive_outer_fixture");
  mkdirSync(campaignDir, { recursive: true, mode: 0o700 });
  mkdirSync(outerRunDir, { recursive: true, mode: 0o700 });
  if (blockBreadcrumbPath) mkdirSync(join(outerRunDir, PRE_AUTHORITY_BREADCRUMB_FILE));
  return {
    root,
    campaignDir,
    outerRunDir,
    supervisor: new RefusingChildSupervisor(root, campaignDir, outerRunDir, establishJournalAuthority),
  };
}

describe("campaign outer run config", () => {
  it("writes the raised no-yield ceiling into both M1 and recursive outer sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "hone-outer-config-"));
    roots.push(root);
    const m1Path = join(root, "m1-outer-config.json");
    const recursivePath = join(root, "recursive-outer-config.json");

    writeCampaignOuterRunConfig(m1Path, m1Config);
    writeCampaignOuterRunConfig(recursivePath, config, config.generation.outerReplicate);

    const m1Outer = JSON.parse(readFileSync(m1Path, "utf8"));
    const recursiveOuter = JSON.parse(readFileSync(recursivePath, "utf8"));
    expect(m1Outer.sessionNoYieldMaxTokens).toBe(SESSION_NO_YIELD_MAX_TOKENS);
    expect(m1Outer.seed).toBeUndefined();
    expect(recursiveOuter.sessionNoYieldMaxTokens).toBe(SESSION_NO_YIELD_MAX_TOKENS);
    expect(recursiveOuter.seed).toBe(config.generation.outerReplicate);
    expect(statSync(m1Path).mode & 0o777).toBe(0o600);
    expect(statSync(recursivePath).mode & 0o777).toBe(0o600);
  });
});

describe("pre-authority child refusal breadcrumbs", () => {
  it("durably names the campaign-9 environment-divergence reason on start and resume", async () => {
    const { campaignDir, outerRunDir, supervisor } = makeSupervisor();

    const first = await supervisor.runLaunched(request, configHash);
    const resumed = await supervisor.runLaunched({ ...request, resume: true }, configHash);

    expect(first.status).toBe("infrastructure_not_run");
    expect(first.feedback).toBe("child has no durable terminal event");
    expect(resumed.status).toBe("infrastructure_not_run");
    expect(resumed.feedback).toBe("child infrastructure stopped before terminalization (exit 1)");
    expect(supervisor.trustedRuns.map((trusted) => trusted.adjudicateInterruptedChild)).toEqual([
      undefined,
      true,
    ]);
    expect(JSON.parse(
      readFileSync(join(campaignDir, `child-config-${childRunId}.json`), "utf8"),
    ).sessionNoYieldMaxTokens).toBe(SESSION_NO_YIELD_MAX_TOKENS);
    const path = join(outerRunDir, PRE_AUTHORITY_BREADCRUMB_FILE);
    const records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => PreAuthorityRefusalBreadcrumbV1.parse(JSON.parse(line)));
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.launch.mode)).toEqual(["start", "resume"]);
    expect(records[0]).toMatchObject({
      version: 1,
      childRunId,
      exitCode: 1,
      reasonClass: "docker-client-environment-divergence",
      stderrTail: `${DIVERGENCE}\n`,
      launch: {
        executionRunId: childRunId,
        attempt: 0,
        capsuleId: capsule.capsuleId,
        capsuleDigest: capsule.capsuleDigest,
        sourceArtifact,
        bundleDigest,
        campaignConfigHash: configHash,
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(campaignDir, PRE_AUTHORITY_BREADCRUMB_FILE))).toBe(false);
  });

  it("preserves an explicitly paused child's retry instead of adjudicating it as an interrupted crash", async () => {
    const { root, supervisor } = makeSupervisor();
    await supervisor.runLaunched(request, configHash);
    appendEvent(join(root, ".hone-runs", childRunId), {
      runId: childRunId,
      at: "2026-08-26T12:00:01.000Z",
      type: "run.paused",
      reason: "operator",
    });

    await supervisor.runLaunched({ ...request, resume: true }, configHash);
    expect(supervisor.trustedRuns.map((trusted) => trusted.adjudicateInterruptedChild)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not record a post-authority child failure", async () => {
    const { outerRunDir, supervisor } = makeSupervisor(false, true);

    const outcome = await supervisor.runLaunched(request, configHash);

    expect(outcome.status).toBe("infrastructure_not_run");
    expect(outcome.brokerJournalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(existsSync(join(outerRunDir, PRE_AUTHORITY_BREADCRUMB_FILE))).toBe(false);
  });

  it("keeps the settlement input byte-identical when diagnostic persistence is deleted or fails", async () => {
    const recorded = makeSupervisor();
    const unavailable = makeSupervisor(true);

    const withBreadcrumb = await recorded.supervisor.runLaunched(request, configHash);
    const withoutBreadcrumb = await unavailable.supervisor.runLaunched(request, configHash);

    expect(canonicalJson(withoutBreadcrumb)).toBe(canonicalJson(withBreadcrumb));
    expect(withoutBreadcrumb).toMatchObject({
      status: "infrastructure_not_run",
      feedback: "child has no durable terminal event",
    });
  });
});
