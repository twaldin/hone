import { execFileSync } from "node:child_process";
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { metaCampaignConfigHash } from "@hone/meta";
import { MetaCampaignConfigV2, type MetaCampaignConfigV2 as RecursiveConfig } from "@hone/schema";
import {
  migrateCampaignSource,
  recursiveOptimizerBaseSnapshot,
  recursiveMutationWorkerPreflightContract,
  recursiveCommand,
} from "../src/commands/hone.js";
import { main } from "../src/main.js";
import { writeOptimizerArtifactSeal } from "../src/optimizer-artifact.js";
import { collectOptimizerSnapshot, snapshotDigest } from "../src/optimizer-digest.js";
import type * as OptimizerDigest from "../src/optimizer-digest.js";
import { verifiedBootRuntimeDigest } from "../src/runtime-digest.js";
import type { CmdIo } from "../src/io.js";
import { syntheticFrozenCampaign, writeSyntheticFrozenCampaign } from "./support/synthetic-campaign.js";

// The engine pins Campaign 11's reviewed optimizer base by digest
// (LEGACY_CAMPAIGN11_* in commands/hone.ts). Those historical bytes are not
// part of this repository, so a small synthetic base closure stands in for
// them: its true snapshot digest is aliased to the pinned Campaign 11 digest.
// Every other snapshot — including any mutated copy of the stand-in — keeps
// its real digest, so seal authentication and allowlist arms stay exercised.
const standIn = vi.hoisted(() => ({
  campaign11BaseDigest: "sha256:fe92e17955adebe53c9ed4076ae1dcdfb2e328d19818d7273fb4f4d850f0d6dc",
  digest: undefined as string | undefined,
}));
vi.mock("../src/optimizer-digest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof OptimizerDigest>();
  return {
    ...actual,
    snapshotDigest: (...args: Parameters<typeof actual.snapshotDigest>): string => {
      const digest = actual.snapshotDigest(...args);
      return digest === standIn.digest ? standIn.campaign11BaseDigest : digest;
    },
  };
});
const campaign11BaseDigest = standIn.campaign11BaseDigest;
const campaign11SourceArtifact = "sha256:499ee208f5b7376a3cfc583e44b7971f7b1b9d378499429ddd67caf04d5f36e2";

const scratchRoots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function initializeGitRoot(): { root: string; head: string } {
  const root = scratch("hone-migrated-base-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "migrated-base@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Migrated Base Test"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".hone-runs/\n.hone-cas/\n");
  writeFileSync(join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  return { root, head };
}

function commandIo(root: string, lines: { out: string[]; err: string[] }): CmdIo {
  return {
    root,
    env: { ...process.env, USER: "migrated-base-test" },
    isTTY: false,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
  };
}

/**
 * Fresh copy of the stand-in sealed optimizer base: optimizer sources, sealed
 * schema, lockfile, and a pnpm-shaped store holding the zod and Pi closures.
 */
function sealedBaseCopy(): string {
  const base = scratch("hone-sealed-base-copy-");
  const write = (rel: string, bytes: string): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), bytes);
  };
  const link = (target: string, rel: string): void => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    symlinkSync(relative(dirname(join(base, rel)), join(base, target)), join(base, rel), "dir");
  };
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("optimizer/package.json", JSON.stringify({ name: "@hone/optimizer", type: "module" }));
  write("optimizer/tsconfig.json", "{}\n");
  // Every frozen mutable and protected optimizer source path must select a sealed file.
  const { mutablePaths, protectedPaths } = syntheticFrozenCampaign();
  for (const rel of [...mutablePaths, ...protectedPaths]) {
    if (/^optimizer\/(src|assets)\/.+\.ts$/.test(rel)) write(rel, `export const surface = ${JSON.stringify(rel)};\n`);
  }
  write("optimizer/worker/mutate.ts", "export const mutate = 'legacy selftest worker';\n");
  write("schema/package.json", JSON.stringify({ name: "@hone/schema", type: "module" }));
  write("schema/src/index.ts", "export const schema = true;\n");
  const zod = "node_modules/.pnpm/zod@3.25.76/node_modules/zod";
  write(`${zod}/package.json`, JSON.stringify({ name: "zod", version: "3.25.76" }));
  write(`${zod}/index.js`, "export const z = 1;\n");
  const pi = "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent";
  write(`${pi}/package.json`, JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "1.0.0" }));
  write(`${pi}/index.js`, "export const pi = 1;\n");
  link(zod, "optimizer/node_modules/zod");
  link(pi, "optimizer/node_modules/@oh-my-pi/pi-coding-agent");
  return base;
}

beforeAll(() => {
  // Real digest of the stand-in base under the campaign's optimizer image.
  standIn.digest = snapshotDigest(
    syntheticFrozenCampaign().optimizerRuntime.image,
    collectOptimizerSnapshot(sealedBaseCopy()),
  );
});

async function migratedFixture(campaign11Identity = false): Promise<{
  root: string;
  configPath: string;
  config: RecursiveConfig;
  outerRunDir: string;
}> {
  const { root, head } = initializeGitRoot();
  const configPath = join(scratch("hone-migrated-config-"), "campaign.json");
  const original = syntheticFrozenCampaign();
  if (campaign11Identity) {
    original.seedOptimizer.sourceArtifact = campaign11SourceArtifact;
    original.seedOptimizer.bundleDigest = campaign11BaseDigest;
    original.controllerOptimizer.sourceArtifact = campaign11SourceArtifact;
    original.controllerOptimizer.bundleDigest = campaign11BaseDigest;
  }
  writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`);
  await migrateCampaignSource({
    root,
    campaignPath: configPath,
    from: original.trustedRuntime.sourceCommit,
    to: head,
    reason: "migrated optimizer base fixture",
    at: "2026-08-26T20:30:00.000Z",
    bootDigest: verifiedBootRuntimeDigest() as `sha256:${string}`,
  });
  const config = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(configPath, "utf8")));
  const hashBody = metaCampaignConfigHash(config).slice("sha256:".length);
  const outerRunId = `run_recursive_outer_${hashBody}`;
  const outerRunDir = join(root, ".hone-runs", outerRunId);
  mkdirSync(outerRunDir, { recursive: true });
  writeOptimizerArtifactSeal(outerRunDir, outerRunId, {
    sourceArtifact: config.controllerOptimizer.sourceArtifact,
    baseDigest: campaign11BaseDigest,
    mergedDigest: config.controllerOptimizer.bundleDigest,
    mutablePaths: {},
  });
  return { root, configPath, config, outerRunDir };
}

describe("migrated recursive optimizer base", () => {
  test("requires an explicit sealed base and never falls back to the new engine tree", async () => {
    const fixture = await migratedFixture();
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await main([
      "recursive",
      "--campaign",
      fixture.configPath,
      "--headless",
    ], commandIo(fixture.root, lines));

    expect(code).toBe(2);
    expect(lines.err.join("\n")).toContain(
      "migrated recursive campaigns require --sealed-base <dir>; refusing to fall back to the current source tree",
    );
  });

  test("coordinator refuses --sealed-base when the campaign has no migration record", async () => {
    const { root, head } = initializeGitRoot();
    const config = syntheticFrozenCampaign();
    config.seedOptimizer.sourceCommit = head;
    config.controllerOptimizer.sourceCommit = head;
    config.trustedRuntime.sourceCommit = head;
    config.trustedRuntime.digest = verifiedBootRuntimeDigest();
    const configPath = join(scratch("hone-unmigrated-config-"), "campaign.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await main([
      "recursive",
      "--campaign",
      configPath,
      "--sealed-base",
      sealedBaseCopy(),
      "--headless",
    ], commandIo(root, lines));

    expect(code).toBe(2);
    expect(lines.err.join("\n")).toContain(
      "--sealed-base is valid only after an explicit campaign source migration",
    );
  });

  test("freeze refuses the migrated-only sealed-base flag", async () => {
    const { root } = initializeGitRoot();
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await main([
      "recursive",
      "--campaign",
      writeSyntheticFrozenCampaign(join(scratch("hone-frozen-config-"), "campaign.json")),
      "--phase",
      "freeze",
      "--out",
      ".hone-runs/refrozen.json",
      "--sealed-base",
      sealedBaseCopy(),
      "--headless",
    ], commandIo(root, lines));

    expect(code).toBe(2);
    expect(lines.err.join("\n")).toContain(
      "--sealed-base is valid only after an explicit campaign source migration",
    );
  });

  test("authenticates a copied sealed base against the campaign-bound outer run seal", async () => {
    const fixture = await migratedFixture();
    const sealedBase = sealedBaseCopy();
    const snapshot = recursiveOptimizerBaseSnapshot(
      fixture.config,
      fixture.root,
      fixture.outerRunDir,
      sealedBase,
    );

    expect(snapshotDigest(fixture.config.optimizerRuntime.image, snapshot)).toBe(campaign11BaseDigest);
  });

  test("coordinator uses an authenticated preserved base instead of live optimizer bytes", async () => {
    const fixture = await migratedFixture();
    const sealedBase = sealedBaseCopy();
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await main([
      "recursive",
      "--campaign",
      fixture.configPath,
      "--sealed-base",
      sealedBase,
      "--headless",
    ], commandIo(fixture.root, lines));

    expect(code).toBe(2);
    expect(lines.err.join("\n")).toContain(
      `optimizer artifact ${fixture.config.seedOptimizer.sourceArtifact} is missing from CAS`,
    );
    expect(lines.err.join("\n")).not.toContain("default optimizer not found");
    expect(lines.err.join("\n")).not.toContain("sealed optimizer base digest mismatch");
  });

  test("coordinator refuses base bytes that do not reproduce the campaign digest", async () => {
    const fixture = await migratedFixture();
    const sealedBase = sealedBaseCopy();
    appendFileSync(join(sealedBase, "optimizer", "worker", "mutate.ts"), "\n// digest mutant\n");
    const lines = { out: [] as string[], err: [] as string[] };

    const code = await main([
      "recursive",
      "--campaign",
      fixture.configPath,
      "--sealed-base",
      sealedBase,
      "--headless",
    ], commandIo(fixture.root, lines));

    expect(code).toBe(2);
    expect(lines.err.join("\n")).toContain("sealed optimizer base digest mismatch");
  });

  test("refuses a self-consistent base seal that is foreign to the frozen controller", async () => {
    const fixture = await migratedFixture();
    const sealedBase = sealedBaseCopy();
    rmSync(join(fixture.outerRunDir, "optimizer-artifact.json"));
    writeOptimizerArtifactSeal(fixture.outerRunDir, basename(fixture.outerRunDir), {
      sourceArtifact: `sha256:${"a".repeat(64)}`,
      baseDigest: campaign11BaseDigest,
      mergedDigest: `sha256:${"b".repeat(64)}`,
      mutablePaths: {},
    });

    expect(() => recursiveOptimizerBaseSnapshot(
      fixture.config,
      fixture.root,
      fixture.outerRunDir,
      sealedBase,
    )).toThrow("sealed outer optimizer identity does not match the frozen campaign controller");
  });

  test("refuses a correctly identified base seal borrowed from a foreign run", async () => {
    const fixture = await migratedFixture();
    const sealedBase = sealedBaseCopy();
    rmSync(join(fixture.outerRunDir, "optimizer-artifact.json"));
    writeOptimizerArtifactSeal(fixture.outerRunDir, "run_recursive_outer_foreign", {
      sourceArtifact: fixture.config.controllerOptimizer.sourceArtifact,
      baseDigest: campaign11BaseDigest,
      mergedDigest: fixture.config.controllerOptimizer.bundleDigest,
      mutablePaths: {},
    });

    expect(() => recursiveOptimizerBaseSnapshot(
      fixture.config,
      fixture.root,
      fixture.outerRunDir,
      sealedBase,
    )).toThrow("sealed outer optimizer identity does not match the frozen campaign controller");
  });

  test("legacy worker compatibility requires migration plus every exact Campaign 11 identity", async () => {
    const fixture = await migratedFixture();
    const sealedBase = sealedBaseCopy();
    const snapshot = recursiveOptimizerBaseSnapshot(
      fixture.config,
      fixture.root,
      fixture.outerRunDir,
      sealedBase,
    );
    const exact = structuredClone(fixture.config);
    exact.seedOptimizer.sourceArtifact = campaign11SourceArtifact;
    exact.seedOptimizer.bundleDigest = campaign11BaseDigest;
    exact.controllerOptimizer.sourceArtifact = campaign11SourceArtifact;
    exact.controllerOptimizer.bundleDigest = campaign11BaseDigest;
    expect(recursiveMutationWorkerPreflightContract(exact, snapshot)).toBe("legacy-selftest");

    const unmigrated = structuredClone(exact);
    delete unmigrated.sourceMigrationJournal;
    expect(recursiveMutationWorkerPreflightContract(unmigrated, snapshot)).toBeUndefined();

    for (const mutate of [
      (config: RecursiveConfig) => {
        config.seedOptimizer.sourceArtifact = `sha256:${"a".repeat(64)}`;
      },
      (config: RecursiveConfig) => {
        config.seedOptimizer.bundleDigest = `sha256:${"a".repeat(64)}`;
      },
      (config: RecursiveConfig) => {
        config.controllerOptimizer.sourceArtifact = `sha256:${"a".repeat(64)}`;
      },
      (config: RecursiveConfig) => {
        config.controllerOptimizer.bundleDigest = `sha256:${"a".repeat(64)}`;
      },
    ]) {
      const foreign = structuredClone(exact);
      mutate(foreign);
      expect(recursiveMutationWorkerPreflightContract(foreign, snapshot)).toBeUndefined();
    }

    const mutatedBase = sealedBaseCopy();
    appendFileSync(join(mutatedBase, "optimizer", "worker", "mutate.ts"), "\n// identity mismatch\n");
    expect(recursiveMutationWorkerPreflightContract(
      exact,
      collectOptimizerSnapshot(mutatedBase),
    )).toBeUndefined();
  });

  test("recursive dispatch receives the exact legacy compatibility contract", async () => {
    const fixture = await migratedFixture(true);
    const sealedBase = sealedBaseCopy();
    let observed: string | undefined;

    await expect(recursiveCommand([
      "--campaign",
      fixture.configPath,
      "--sealed-base",
      sealedBase,
      "--headless",
    ], commandIo(fixture.root, { out: [], err: [] }), {
      observeMutationWorkerPreflightContract: (contract) => {
        observed = contract;
        throw new Error("dispatch-contract-observed");
      },
    })).rejects.toThrow("dispatch-contract-observed");
    expect(observed).toBe("legacy-selftest");
  });
});
