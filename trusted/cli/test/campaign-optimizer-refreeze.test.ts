// r1 adversarial probes: every refreeze journal-binding arm must FIRE.
// Runs against the preserved campaign-11 frozen config fixture.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  MetaCampaignConfigV2,
  type CampaignSourceMigrationV1,
  type CampaignOptimizerRunRefreezeV1,
} from "@hone/schema";
import {
  campaignSourceMigrationRecordDigest,
  metaCampaignConfigHash,
} from "@hone/meta";
import {
  applyOptimizerRunRefreezes,
  type PlannedOptimizerRunRefreeze,
} from "../src/commands/hone.js";
import { contractHash } from "../src/contract.js";
import { readEvents } from "../src/eventlog.js";
import {
  readOptimizerArtifactSeal,
  writeOptimizerArtifactSeal,
} from "../src/optimizer-artifact.js";
import { makeRoot, writeEvents } from "./helpers.js";

const preservedPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen.json",
  import.meta.url,
));
const digest = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;
const TO_COMMIT = "f".repeat(40);
const TO_BOOT_DIGEST = digest("9");

interface BundleIdentity {
  sourceArtifact: string;
  bundleDigest: string;
}
interface BundleTransition {
  from: BundleIdentity;
  to: BundleIdentity;
}
interface RunTransitionSide extends BundleIdentity {
  baseDigest: string;
  contractHash: string;
}
interface RunRefreezeRecord {
  runId: string;
  image: string;
  from: RunTransitionSide;
  to: RunTransitionSide;
}
interface RefreezePayload {
  optimizerImage: string;
  fromOptimizerBaseDigest: string;
  optimizerBaseDigest: string;
  seed: BundleTransition;
  controller: BundleTransition;
  controls: { broken: BundleTransition; degraded: BundleTransition };
  runs: RunRefreezeRecord[];
}
interface MigrationRecord {
  version: 1;
  at: string;
  from: string;
  to: string;
  fromBootDigest: string;
  bootDigest: string;
  reason: string;
  optimizerRefreeze?: RefreezePayload;
  previousRecordDigest: string | null;
  recordDigest: string;
}
/** Loose JSON view of the frozen config for probe mutation only. */
interface JsonConfig {
  seedOptimizer: { sourceCommit: string } & BundleIdentity;
  controllerOptimizer: { sourceCommit: string } & BundleIdentity;
  trustedRuntime: { sourceCommit: string; digest: string };
  optimizerRuntime: { image: string };
  generation: { stage: string; controllerGeneration: number };
  controls: {
    brokenSourceArtifact: string;
    brokenBundleDigest: string;
    degradedSourceArtifact: string;
    degradedBundleDigest: string;
  };
  sourceMigrationJournal?: {
    version: 1;
    campaignConfigHash: string;
    migrations: MigrationRecord[];
  };
}

const parseJson = (config: JsonConfig) =>
  MetaCampaignConfigV2.parse(JSON.parse(JSON.stringify(config)));
const hashJson = (config: JsonConfig) => metaCampaignConfigHash(parseJson(config));

const preservedJson = (): JsonConfig =>
  JSON.parse(readFileSync(preservedPath, "utf8")) as JsonConfig;

function rehash(record: MigrationRecord): void {
  const { recordDigest: _dropped, ...body } = record;
  record.recordDigest = campaignSourceMigrationRecordDigest(
    body as Parameters<typeof campaignSourceMigrationRecordDigest>[0],
  );
}

function runRecord(runId: string, to?: RunTransitionSide): RunRefreezeRecord {
  return {
    runId,
    image: `hone-optimizer@sha256:${"0".repeat(64)}`,
    from: {
      sourceArtifact: digest("a"),
      baseDigest: digest("1"),
      bundleDigest: digest("b"),
      contractHash: digest("c"),
    },
    to: to ?? {
      sourceArtifact: digest("d"),
      baseDigest: digest("1"),
      bundleDigest: digest("e"),
      contractHash: digest("f"),
    },
  };
}

function refrozenCampaign(mutate?: (refreeze: RefreezePayload, migrated: JsonConfig) => void): JsonConfig {
  const before = preservedJson();
  const configHash = hashJson(before);
  const optimizerRefreeze: RefreezePayload = {
    optimizerImage: before.optimizerRuntime.image,
    fromOptimizerBaseDigest: digest("1"),
    optimizerBaseDigest: digest("1"),
    seed: {
      from: {
        sourceArtifact: before.seedOptimizer.sourceArtifact,
        bundleDigest: before.seedOptimizer.bundleDigest,
      },
      to: { sourceArtifact: digest("3"), bundleDigest: digest("4") },
    },
    controller: {
      from: {
        sourceArtifact: before.controllerOptimizer.sourceArtifact,
        bundleDigest: before.controllerOptimizer.bundleDigest,
      },
      to: { sourceArtifact: digest("3"), bundleDigest: digest("4") },
    },
    controls: {
      broken: {
        from: {
          sourceArtifact: before.controls.brokenSourceArtifact,
          bundleDigest: before.controls.brokenBundleDigest,
        },
        to: { sourceArtifact: digest("5"), bundleDigest: digest("6") },
      },
      degraded: {
        from: {
          sourceArtifact: before.controls.degradedSourceArtifact,
          bundleDigest: before.controls.degradedBundleDigest,
        },
        to: { sourceArtifact: digest("7"), bundleDigest: digest("8") },
      },
    },
    runs: [runRecord("run_a"), runRecord("run_b")],
  };
  const migrated: JsonConfig = {
    ...before,
    seedOptimizer: { sourceCommit: TO_COMMIT, ...optimizerRefreeze.seed.to },
    controllerOptimizer: { sourceCommit: TO_COMMIT, ...optimizerRefreeze.controller.to },
    trustedRuntime: { ...before.trustedRuntime, sourceCommit: TO_COMMIT, digest: TO_BOOT_DIGEST },
    controls: {
      brokenSourceArtifact: optimizerRefreeze.controls.broken.to.sourceArtifact,
      brokenBundleDigest: optimizerRefreeze.controls.broken.to.bundleDigest,
      degradedSourceArtifact: optimizerRefreeze.controls.degraded.to.sourceArtifact,
      degradedBundleDigest: optimizerRefreeze.controls.degraded.to.bundleDigest,
    },
  };
  mutate?.(optimizerRefreeze, migrated);
  const body = {
    version: 1 as const,
    at: "2026-08-27T09:00:00.000Z",
    from: before.trustedRuntime.sourceCommit,
    to: TO_COMMIT,
    fromBootDigest: before.trustedRuntime.digest,
    bootDigest: TO_BOOT_DIGEST,
    reason: "refreeze engine bundle",
    optimizerRefreeze,
    previousRecordDigest: null,
  };
  migrated.sourceMigrationJournal = {
    version: 1,
    campaignConfigHash: configHash,
    migrations: [{
      ...body,
      recordDigest: campaignSourceMigrationRecordDigest(
        body as Parameters<typeof campaignSourceMigrationRecordDigest>[0],
      ),
    }],
  };
  return migrated;
}

describe("refreeze journal binding arms", () => {
  test("baseline refrozen config with run records retains identity", () => {
    expect(hashJson(refrozenCampaign())).toBe(hashJson(preservedJson()));
  });

  test("mutating a refreeze field without rehash dies on record digest", () => {
    const config = refrozenCampaign();
    const refreeze = config.sourceMigrationJournal!.migrations[0]!.optimizerRefreeze!;
    refreeze.seed.to.bundleDigest = digest("0");
    refreeze.controller.to.bundleDigest = digest("0");
    config.seedOptimizer.bundleDigest = digest("0"); // keep head in sync so digest arm is reached
    config.controllerOptimizer.bundleDigest = digest("0"); // stage A: controller must mirror seed
    expect(() => hashJson(config)).toThrow("source migration journal record digest mismatch");
  });

  test("forged controls head dies on discontinuity", () => {
    const config = refrozenCampaign();
    config.controls.brokenBundleDigest = digest("0");
    expect(() => hashJson(config)).toThrow("optimizer refreeze journal provenance is discontinuous");
  });

  test("stripping optimizerRefreeze with rehash dies on frozen-field alteration", () => {
    const config = refrozenCampaign();
    const record = config.sourceMigrationJournal!.migrations[0]!;
    delete record.optimizerRefreeze;
    rehash(record);
    expect(() => hashJson(config))
      .toThrow("altered frozen campaign fields outside the sanctioned source identity");
  });

  test("unsorted run records refuse", () => {
    expect(() => hashJson(refrozenCampaign((refreeze) => {
      refreeze.runs = [runRecord("run_b"), runRecord("run_a")];
    }))).toThrow("must be unique and sorted");
  });

  test("duplicate run records refuse", () => {
    expect(() => hashJson(refrozenCampaign((refreeze) => {
      refreeze.runs = [runRecord("run_a"), runRecord("run_a")];
    }))).toThrow("must be unique and sorted");
  });

  test("no-op run record refuses", () => {
    expect(() => hashJson(refrozenCampaign((refreeze) => {
      refreeze.runs = [runRecord("run_a", {
        sourceArtifact: digest("d"),
        baseDigest: digest("1"),
        bundleDigest: digest("b"),
        contractHash: digest("c"),
      })];
    }))).toThrow("must retain its base and change its bundle and contract digests");
  });

  test("changed optimizer base digest refuses", () => {
    expect(() => hashJson(refrozenCampaign((refreeze) => {
      refreeze.optimizerBaseDigest = digest("2");
    }))).toThrow("must retain the authenticated optimizer base digest");
  });

  test("foreign optimizer image refuses", () => {
    expect(() => hashJson(refrozenCampaign((refreeze) => {
      refreeze.optimizerImage = `hone-other@sha256:${"9".repeat(64)}`;
    }))).toThrow("does not match the recursive campaign runtime");
  });

  test("refreeze also flipping an unbound frozen field refuses", () => {
    const config = refrozenCampaign();
    config.generation = {
      ...config.generation,
      controllerGeneration: config.generation.controllerGeneration + 1,
    };
    expect(() => hashJson(config)).toThrow();
  });
});

describe("refreeze run commit path", () => {
  test("applies every journaled run transition and links each durable seal", () => {
    const root = makeRoot();
    const migration = {
      at: "2026-08-27T09:30:00.000Z",
      recordDigest: digest("9"),
    } as CampaignSourceMigrationV1;
    const plans = ["run_refreeze_a", "run_refreeze_b"].map((runId, index): PlannedOptimizerRunRefreeze => {
      const runDir = join(root, ".hone-runs", runId);
      mkdirSync(runDir, { recursive: true });
      const oldContract = `# Contract\n\n- optimizer digest: \`${digest("b")}\`\n`;
      const newContract = `# Contract\n\n- optimizer digest: \`${digest("e")}\`\n`;
      writeFileSync(join(runDir, "contract.md"), oldContract);
      writeEvents(root, runId, [{
        type: "run.started",
        runId,
        at: "2026-08-27T09:00:00.000Z",
        capsuleId: `cap_${String(index).padStart(12, "0")}`,
        contractHash: contractHash(oldContract),
        optimizerDigest: digest("b"),
      }, {
        type: "run.paused",
        runId,
        at: "2026-08-27T09:01:00.000Z",
        reason: "operator",
      }]);
      const expectedSeal = writeOptimizerArtifactSeal(runDir, runId, {
        sourceArtifact: digest("a"),
        baseDigest: digest("1"),
        mergedDigest: digest("b"),
        mutablePaths: {},
      });
      const record: CampaignOptimizerRunRefreezeV1 = {
        runId,
        image: `hone-optimizer@sha256:${"0".repeat(64)}`,
        from: {
          sourceArtifact: digest("a"),
          baseDigest: digest("1"),
          bundleDigest: digest("b"),
          contractHash: contractHash(oldContract),
        },
        to: {
          sourceArtifact: digest("d"),
          baseDigest: digest("1"),
          bundleDigest: digest("e"),
          contractHash: contractHash(newContract),
        },
      };
      return {
        runDir,
        pauseBeforeMigration: false,
        record,
        expectedSeal,
        replacement: {
          sourceArtifact: record.to.sourceArtifact,
          baseDigest: record.to.baseDigest,
          mergedDigest: record.to.bundleDigest,
          mutablePaths: {},
          snapshot: { files: new Map() },
        },
        oldContract,
        newContract,
      };
    });

    applyOptimizerRunRefreezes(plans, migration);
    for (const plan of plans) {
      expect(readFileSync(join(plan.runDir, "contract.md"), "utf8")).toBe(plan.newContract);
      expect(readOptimizerArtifactSeal(plan.runDir)).toMatchObject({
        runId: plan.record.runId,
        sourceArtifact: plan.record.to.sourceArtifact,
        baseDigest: plan.record.to.baseDigest,
        mergedDigest: plan.record.to.bundleDigest,
        sourceMigrationRecordDigest: migration.recordDigest,
      });
      expect(readEvents(plan.runDir).at(-1)).toMatchObject({
        type: "run.optimizer-migrated",
        sourceMigrationRecordDigest: migration.recordDigest,
      });
    }
  });
});
