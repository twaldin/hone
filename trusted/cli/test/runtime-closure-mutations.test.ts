// Reviewer probe shapes for closure-capture r1 kill coverage (adv-r1).
// Verified 5/5 green at e1d4a7bae when placed at trusted/cli/test/ — adapt names
// freely. Mutant mapping:
//   test 1 -> N2 (record digest), N1 (chain), N6 (journal identity), N5 (image), N7 (extends prefix + divergence)
//   test 2 -> restore CAS integrity (same-length splice + truncated tree; complements shipped content-mutation test)
//   test 3 -> G2 (outer/closure agreement arm) + documents the forged-record design bound
//   test 4 -> compose order 2 (migrate AFTER closure append)
//   test 5 -> G5 (held lock blocks concurrent migrate-source) + foreign-path lock refusal
// NOT covered here (add separately):
//   G1  -> drive `recursive --phase freeze` (recursive-freeze fixture) and assert the
//          PUBLISHED frozen config parses with runtimeClosureJournal.captures length 1
//          and metaCampaignConfigHash(published without journal) == journal.campaignConfigHash.
//   G4  -> recursivePhaseReceipt(...) on a closure-carrying config: assert receipt JSON
//          has runtimeClosureJournal equal to config's (and null when absent).
//   N8/N9 -> re-sign a captured record with a flipped bootDigest (N8) or flipped
//          optimizerBaseDigest (N9) via campaignRuntimeClosureRecordDigest, rebuild the
//          matching manifest bytes in CAS (manifestForRecord shape) so binding passes,
//          then restoreRuntimeClosure must refuse "restored boot digest mismatch" /
//          "restored optimizer base digest mismatch". (Simpler equivalent: capture with
//          expectedBootDigest omitted, then hand-store a manifest whose bootDigest is
//          wrong — the point is the RECOMPUTATION arms, so the tamper must keep every
//          upstream hash consistent.)
//   N15 -> extractNodeModulesArchive path: capture with nodeModulesArchiveSha256 set to a
//          flipped digest of a real archive -> "node_modules evidence archive digest
//          mismatch" (see also the CLI-level probe I ran with a tampered sidecar).

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  campaignRecordExtends,
  campaignRuntimeClosureRecordDigest,
  metaCampaignConfigHash,
} from "@hone/meta";
import type { Sha256Digest } from "@hone/meta";
import { MetaCampaignConfigV2 } from "@hone/schema";
import type { CampaignRuntimeClosureCaptureV1, MetaCampaignConfigV2 as RecursiveMetaCampaignConfig } from "@hone/schema";
import { afterEach, describe, expect, test } from "vitest";
import { casPath } from "../src/cas.js";
import { migrateCampaignSource, recursiveOptimizerBaseSnapshot } from "../src/commands/hone.js";
import { collectOptimizerSnapshot, snapshotDigest } from "../src/optimizer-digest.js";
import { writeOptimizerArtifactSeal } from "../src/optimizer-artifact.js";
import {
  acquireCampaignRecordLock,
  appendRuntimeClosureCaptureRecord,
  captureRuntimeClosure,
  restoreRuntimeClosure,
  withRuntimeClosureCapture,
} from "../src/runtime-closure.js";
import { computeTrustedRuntimeDigestAt } from "../src/runtime-digest.js";
import { syntheticFrozenCampaign } from "./support/synthetic-campaign.js";

const roots: string[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, rel: string, bytes: string): void {
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function relativeLink(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(relative(dirname(link), target), link, "dir");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  head: string;
  config: RecursiveMetaCampaignConfig;
  configHash: Sha256Digest;
  bootDigest: Sha256Digest;
  optimizerBaseDigest: Sha256Digest;
  casDir: string;
}

function syntheticClosure(): Fixture {
  const root = scratch("adv-closure-source-");
  write(root, ".gitignore", "node_modules/\n.hone-cas/\n");
  write(root, "package.json", JSON.stringify({ name: "hone", private: true }));
  write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write(root, "pnpm-workspace.yaml", "packages:\n  - trusted/*\n  - optimizer\n  - schema\n");
  write(root, "trusted/cli/package.json", JSON.stringify({
    name: "@hone/cli",
    type: "module",
    dependencies: { zod: "3.25.76" },
  }));
  write(root, "trusted/cli/src/main.ts", "export const trusted = true;\n");
  write(root, "optimizer/package.json", JSON.stringify({ name: "@hone/optimizer", type: "module" }));
  write(root, "optimizer/tsconfig.json", "{}\n");
  write(root, "optimizer/src/main.ts", "export const optimize = true;\n");
  write(root, "optimizer/worker/mutate.ts", "export const mutate = true;\n");
  write(root, "schema/package.json", JSON.stringify({ name: "@hone/schema", type: "module" }));
  write(root, "schema/src/index.ts", "export const schema = true;\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "adv@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Adv"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "synthetic frozen source"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const zod = join(root, "node_modules/.pnpm/zod@3.25.76/node_modules/zod");
  write(root, "node_modules/.pnpm/zod@3.25.76/node_modules/zod/package.json", JSON.stringify({ name: "zod", version: "3.25.76" }));
  write(root, "node_modules/.pnpm/zod@3.25.76/node_modules/zod/index.js", "export const z = 1;\n");
  const pi = join(root, "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent");
  write(root, "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent/package.json", JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "1.0.0" }));
  write(root, "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent/index.js", "export const pi = 1;\n");
  write(root, "node_modules/.package-map.json", JSON.stringify({
    packages: {
      ".": { url: "..", dependencies: {} },
      "trusted-cli": { url: "../trusted/cli", dependencies: { zod: "zod@3.25.76" } },
      optimizer: { url: "../optimizer", dependencies: { zod: "zod@3.25.76", "@oh-my-pi/pi-coding-agent": "pi@1.0.0" } },
      "zod@3.25.76": { url: "./.pnpm/zod@3.25.76/node_modules/zod", dependencies: {} },
      "pi@1.0.0": { url: "./.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent", dependencies: {} },
    },
  }));
  relativeLink(zod, join(root, "trusted/cli/node_modules/zod"));
  relativeLink(zod, join(root, "optimizer/node_modules/zod"));
  relativeLink(pi, join(root, "optimizer/node_modules/@oh-my-pi/pi-coding-agent"));
  const config = syntheticFrozenCampaign();
  config.seedOptimizer.sourceCommit = head;
  config.controllerOptimizer.sourceCommit = head;
  config.trustedRuntime.sourceCommit = head;
  const bootDigest = computeTrustedRuntimeDigestAt(root) as Sha256Digest;
  config.trustedRuntime.digest = bootDigest;
  const optimizerBaseDigest = snapshotDigest(config.optimizerRuntime.image, collectOptimizerSnapshot(root)) as Sha256Digest;
  config.seedOptimizer.bundleDigest = optimizerBaseDigest;
  config.controllerOptimizer.bundleDigest = optimizerBaseDigest;
  return {
    root,
    head,
    config,
    configHash: metaCampaignConfigHash(config),
    bootDigest,
    optimizerBaseDigest,
    casDir: scratch("adv-closure-cas-"),
  };
}

async function capture(fixture: Fixture, at: string, previous: Sha256Digest | null = null) {
  return captureRuntimeClosure({
    sourceRoot: fixture.root,
    sourceCommit: fixture.head,
    campaignBootDigest: fixture.bootDigest,
    expectedBootDigest: fixture.bootDigest,
    optimizerImage: fixture.config.optimizerRuntime.image,
    optimizerBaseDigest: fixture.optimizerBaseDigest,
    campaignConfigHash: fixture.configHash,
    capturedAt: at,
    casDir: fixture.casDir,
    previousRecordDigest: previous,
  });
}

type Rec = CampaignRuntimeClosureCaptureV1;
function resign(record: Rec): Rec {
  const { recordDigest: _d, ...body } = record;
  return { ...record, recordDigest: campaignRuntimeClosureRecordDigest(body) };
}

describe("adversarial closure journal and restore (review r1)", () => {
  test("chain, digest, identity, image, and extends arms all fire", async () => {
    const fixture = syntheticClosure();
    const first = await capture(fixture, "2026-08-26T23:00:00.000Z");
    const second = await capture(fixture, "2026-08-26T23:01:00.000Z", first.record.recordDigest as Sha256Digest);
    const both = withRuntimeClosureCapture(
      withRuntimeClosureCapture(fixture.config, first.record),
      second.record,
    );

    const mutated = structuredClone(both);
    mutated.runtimeClosureJournal!.captures[0]!.at = "2026-08-26T23:59:59.000Z";
    expect(() => metaCampaignConfigHash(mutated)).toThrow("record digest mismatch");

    const dropped = structuredClone(both);
    dropped.runtimeClosureJournal!.captures.shift();
    expect(() => metaCampaignConfigHash(dropped)).toThrow("record chain is not append-only");

    const foreign = structuredClone(both);
    foreign.runtimeClosureJournal!.campaignConfigHash = `sha256:${"9".repeat(64)}`;
    expect(() => metaCampaignConfigHash(foreign)).toThrow("belongs to a different frozen campaign");

    const wrongImage = structuredClone(both);
    wrongImage.runtimeClosureJournal!.captures[1] = resign({
      ...wrongImage.runtimeClosureJournal!.captures[1]!,
      optimizerImage: "foreign-image@sha256:" + "0".repeat(64),
    });
    expect(() => metaCampaignConfigHash(wrongImage)).toThrow("optimizer image does not match");

    const rolledBack = structuredClone(both);
    rolledBack.runtimeClosureJournal!.captures.pop();
    expect(metaCampaignConfigHash(rolledBack)).toBe(fixture.configHash);
    expect(campaignRecordExtends(both, rolledBack)).toBe(false);
    const diverged = structuredClone(both);
    diverged.runtimeClosureJournal!.captures[1] = resign({
      ...diverged.runtimeClosureJournal!.captures[1]!,
      at: "2026-08-26T23:02:00.000Z",
    });
    expect(campaignRecordExtends(both, diverged)).toBe(false);
  });

  test("same-length spliced chunk and truncated tree refuse on restore", async () => {
    const fixture = syntheticClosure();
    const captured = await capture(fixture, "2026-08-26T23:10:00.000Z");
    const tree = JSON.parse(readFileSync(casPath(fixture.casDir, captured.record.closureDigest), "utf8")) as {
      entries: Array<{ kind: string; chunks?: Array<{ hash: string; size: number }> }>;
    };
    const chunk = tree.entries.find((entry) => entry.kind === "file" && (entry.chunks?.length ?? 0) > 0)?.chunks?.[0];
    if (chunk === undefined) throw new Error("no chunk");
    const chunkPath = casPath(fixture.casDir, chunk.hash);
    const original = readFileSync(chunkPath);
    const spliced = Buffer.from(original);
    spliced[0] = spliced[0]! ^ 0xff;
    writeFileSync(chunkPath, spliced);
    expect(() => restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: join(scratch("adv-closure-splice-"), "restore"),
      campaignConfigHash: fixture.configHash,
      record: captured.record,
    })).toThrow("CAS content hash mismatch");
    writeFileSync(chunkPath, original);

    const treePath = casPath(fixture.casDir, captured.record.closureDigest);
    const treeBytes = readFileSync(treePath);
    truncateSync(treePath, treeBytes.length - 16);
    expect(() => restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: join(scratch("adv-closure-trunc-"), "restore"),
      campaignConfigHash: fixture.configHash,
      record: captured.record,
    })).toThrow("CAS content hash mismatch");
    writeFileSync(treePath, treeBytes);
  });

  test("design bound: forged record with arbitrary base digest validates, but a live outer seal refuses it", async () => {
    const fixture = syntheticClosure();
    const captured = await capture(fixture, "2026-08-26T23:20:00.000Z");
    const forged = resign({
      ...captured.record,
      optimizerBaseDigest: `sha256:${"5".repeat(64)}`,
    });
    const config = withRuntimeClosureCapture(fixture.config, forged);
    expect(metaCampaignConfigHash(config)).toBe(fixture.configHash);

    const outerRunDir = join(scratch("adv-closure-outer-"), `run_recursive_outer_${fixture.configHash.slice("sha256:".length)}`);
    mkdirSync(outerRunDir, { recursive: true });
    writeOptimizerArtifactSeal(outerRunDir, `run_recursive_outer_${fixture.configHash.slice("sha256:".length)}`, {
      sourceArtifact: fixture.config.controllerOptimizer.sourceArtifact,
      baseDigest: fixture.optimizerBaseDigest,
      mergedDigest: fixture.config.controllerOptimizer.bundleDigest,
      mutablePaths: {},
    });
    expect(() => recursiveOptimizerBaseSnapshot(config, scratch("adv-closure-engine-"), outerRunDir, fixture.root))
      .toThrow("runtime closure optimizer identity disagrees with the sealed outer base");
  });

  test("migration after closure append preserves the closure journal and identity (compose order 2)", async () => {
    const fixture = syntheticClosure();
    const captured = await capture(fixture, "2026-08-26T23:30:00.000Z");
    const campaignPath = join(fixture.root, ".hone-campaign.json");
    writeFileSync(campaignPath, `${JSON.stringify(withRuntimeClosureCapture(fixture.config, captured.record), null, 2)}\n`);
    write(fixture.root, "engine-fix.txt", "fix\n");
    execFileSync("git", ["add", "engine-fix.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-qm", "fix"], { cwd: fixture.root });
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.root, encoding: "utf8" }).trim();
    await migrateCampaignSource({
      root: fixture.root,
      campaignPath,
      from: fixture.head,
      to: newHead,
      reason: "compose order 2",
      at: "2026-08-26T23:31:00.000Z",
      bootDigest: `sha256:${"8".repeat(64)}`,
    });
    const after = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    expect(after.runtimeClosureJournal?.captures).toHaveLength(1);
    expect(after.sourceMigrationJournal?.migrations).toHaveLength(1);
    expect(metaCampaignConfigHash(after)).toBe(fixture.configHash);
  });

  test("held record lock blocks concurrent migration and foreign-path appends", async () => {
    const fixture = syntheticClosure();
    const captured = await capture(fixture, "2026-08-26T23:40:00.000Z");
    const campaignPath = join(fixture.root, ".hone-campaign.json");
    writeFileSync(campaignPath, `${JSON.stringify(fixture.config, null, 2)}\n`);
    const held = acquireCampaignRecordLock(campaignPath);
    try {
      await expect(migrateCampaignSource({
        root: fixture.root,
        campaignPath,
        from: fixture.head,
        to: "e".repeat(40),
        reason: "must be locked out",
        at: "2026-08-26T23:41:00.000Z",
        bootDigest: `sha256:${"7".repeat(64)}`,
      })).rejects.toThrow("campaign record is locked");
      const otherPath = join(fixture.root, ".other-campaign.json");
      writeFileSync(otherPath, `${JSON.stringify(fixture.config, null, 2)}\n`);
      const other = acquireCampaignRecordLock(otherPath);
      try {
        expect(() => appendRuntimeClosureCaptureRecord(campaignPath, captured.record, other.lock))
          .toThrow("requires the matching held campaign lock");
      } finally {
        other.release();
      }
    } finally {
      held.release();
    }
  });
});
