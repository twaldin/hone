import { execFileSync } from "node:child_process";
import {
  afterEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { metaCampaignConfigHash } from "@hone/meta";
import { MetaCampaignConfigV2, type MetaCampaignConfigV2 as RecursiveConfig } from "@hone/schema";
import {
  migrateCampaignSource,
  recursiveOptimizerBaseSnapshot,
} from "../src/commands/hone.js";
import { main } from "../src/main.js";
import { writeOptimizerArtifactSeal } from "../src/optimizer-artifact.js";
import { collectOptimizerSnapshot, snapshotDigest } from "../src/optimizer-digest.js";
import { verifiedBootRuntimeDigest } from "../src/runtime-digest.js";
import type { CmdIo } from "../src/io.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const preservedConfigPath = join(repoRoot, "data", "m2-refreeze-final", "campaign-frozen.json");
const reviewedBaseRoot = "/home/tim/omp-firstmate/data/hone-child-terminal-crash/scratch-r1/base-124b";
const preservedRuntimeRoot = "/home/tim/omp-firstmate/worktrees/m2-exec-runtime-10";
const campaign11BaseDigest = "sha256:fe92e17955adebe53c9ed4076ae1dcdfb2e328d19818d7273fb4f4d850f0d6dc";
const reviewedBaseAvailable = existsSync(reviewedBaseRoot)
  && existsSync(join(preservedRuntimeRoot, "node_modules"))
  && existsSync(join(preservedRuntimeRoot, "optimizer", "node_modules"));
const scratchRoots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function preservedConfig(): RecursiveConfig {
  return MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedConfigPath, "utf8")));
}

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

function copyReviewedBase(): string {
  const destination = scratch("hone-reviewed-base-copy-");
  cpSync(join(reviewedBaseRoot, "optimizer"), join(destination, "optimizer"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  rmSync(join(destination, "optimizer", "node_modules"), { recursive: true, force: true });
  cpSync(
    join(preservedRuntimeRoot, "optimizer", "node_modules"),
    join(destination, "optimizer", "node_modules"),
    { recursive: true, verbatimSymlinks: true },
  );
  cpSync(join(reviewedBaseRoot, "schema"), join(destination, "schema"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  copyFileSync(join(reviewedBaseRoot, "pnpm-lock.yaml"), join(destination, "pnpm-lock.yaml"));
  symlinkSync(join(preservedRuntimeRoot, "node_modules"), join(destination, "node_modules"), "dir");
  return destination;
}

async function migratedFixture(): Promise<{
  root: string;
  configPath: string;
  config: RecursiveConfig;
  outerRunDir: string;
}> {
  const { root, head } = initializeGitRoot();
  const configPath = join(scratch("hone-migrated-config-"), "campaign.json");
  const original = preservedConfig();
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
    const config = preservedConfig();
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
      reviewedBaseRoot,
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
      preservedConfigPath,
      "--phase",
      "freeze",
      "--out",
      ".hone-runs/refrozen.json",
      "--sealed-base",
      reviewedBaseRoot,
      "--headless",
    ], commandIo(root, lines));

    expect(code).toBe(2);
    expect(lines.err.join("\n")).toContain(
      "--sealed-base is valid only after an explicit campaign source migration",
    );
  });

  test.skipIf(!reviewedBaseAvailable)("authenticates a copied sealed base against the campaign-bound outer run seal", async () => {
    const fixture = await migratedFixture();
    const sealedBase = copyReviewedBase();
    const snapshot = recursiveOptimizerBaseSnapshot(
      fixture.config,
      fixture.root,
      fixture.outerRunDir,
      sealedBase,
    );

    expect(snapshotDigest(fixture.config.optimizerRuntime.image, snapshot)).toBe(campaign11BaseDigest);
  });

  test.skipIf(!reviewedBaseAvailable)("coordinator uses an authenticated preserved base instead of live optimizer bytes", async () => {
    const fixture = await migratedFixture();
    const sealedBase = copyReviewedBase();
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

  test.skipIf(!reviewedBaseAvailable)("coordinator refuses base bytes that do not reproduce the campaign digest", async () => {
    const fixture = await migratedFixture();
    const sealedBase = copyReviewedBase();
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

  test.skipIf(!reviewedBaseAvailable)("refuses a self-consistent base seal that is foreign to the frozen controller", async () => {
    const fixture = await migratedFixture();
    const sealedBase = copyReviewedBase();
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

  test.skipIf(!reviewedBaseAvailable)("refuses a correctly identified base seal borrowed from a foreign run", async () => {
    const fixture = await migratedFixture();
    const sealedBase = copyReviewedBase();
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
});
