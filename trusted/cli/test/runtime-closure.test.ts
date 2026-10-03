import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  campaignRuntimeClosureRecordDigest,
  metaCampaignConfigHash,
} from "@hone/meta";
import type { Sha256Digest } from "@hone/meta";
import {
  MetaCampaignConfigV2,
  canonicalJson,
} from "@hone/schema";
import type { MetaCampaignConfigV2 as RecursiveMetaCampaignConfig } from "@hone/schema";
import { afterEach, describe, expect, test } from "vitest";
import { casPath, readCas, writeCas } from "../src/cas.js";
import {
  migrateCampaignSource,
  recursiveOptimizerBaseSnapshot,
  recursivePhaseReceipt,
  writeFrozenRecursiveCampaignWithClosure,
} from "../src/commands/hone.js";
import { collectOptimizerSnapshot, snapshotDigest } from "../src/optimizer-digest.js";
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

interface SyntheticClosure {
  readonly root: string;
  readonly head: string;
  readonly config: RecursiveMetaCampaignConfig;
  readonly configHash: Sha256Digest;
  readonly bootDigest: Sha256Digest;
  readonly optimizerBaseDigest: Sha256Digest;
  readonly casDir: string;
}

function syntheticClosure(): SyntheticClosure {
  const root = scratch("hone-runtime-closure-source-");
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
  execFileSync("git", ["config", "user.email", "closure-test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Closure Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "synthetic frozen source"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  const zod = join(root, "node_modules/.pnpm/zod@3.25.76/node_modules/zod");
  write(root, "node_modules/.pnpm/zod@3.25.76/node_modules/zod/package.json", JSON.stringify({
    name: "zod",
    version: "3.25.76",
  }));
  write(root, "node_modules/.pnpm/zod@3.25.76/node_modules/zod/index.js", "export const z = 1;\n");
  const pi = join(root, "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent");
  write(root, "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent/package.json", JSON.stringify({
    name: "@oh-my-pi/pi-coding-agent",
    version: "1.0.0",
  }));
  write(root, "node_modules/.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent/index.js", "export const pi = 1;\n");
  write(root, "node_modules/.package-map.json", JSON.stringify({
    packages: {
      ".": { url: "..", dependencies: {} },
      "trusted-cli": { url: "../trusted/cli", dependencies: { zod: "zod@3.25.76" } },
      optimizer: {
        url: "../optimizer",
        dependencies: {
          zod: "zod@3.25.76",
          "@oh-my-pi/pi-coding-agent": "pi@1.0.0",
        },
      },
      "zod@3.25.76": { url: "./.pnpm/zod@3.25.76/node_modules/zod", dependencies: {} },
      "pi@1.0.0": {
        url: "./.pnpm/pi@1.0.0/node_modules/@oh-my-pi/pi-coding-agent",
        dependencies: {},
      },
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
  const optimizerBaseDigest = snapshotDigest(
    config.optimizerRuntime.image,
    collectOptimizerSnapshot(root),
  ) as Sha256Digest;
  config.seedOptimizer.bundleDigest = optimizerBaseDigest;
  config.controllerOptimizer.bundleDigest = optimizerBaseDigest;
  const configHash = metaCampaignConfigHash(config);
  return {
    root,
    head,
    config,
    configHash,
    bootDigest,
    optimizerBaseDigest,
    casDir: scratch("hone-runtime-closure-cas-"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable runtime closure", () => {
  test("captures, deduplicates, deletes the source, restores, and serves --sealed-base equivalently", async () => {
    const fixture = syntheticClosure();
    const first = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:00:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    const second = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:01:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: first.record.recordDigest as Sha256Digest,
    });
    expect(second.record.closureDigest).toBe(first.record.closureDigest);
    expect(second.marginalBytes).toBeLessThan(1_024);
    expect(first.marginalBytes).toBeGreaterThan(second.marginalBytes * 5);

    const recorded = withRuntimeClosureCapture(
      withRuntimeClosureCapture(fixture.config, first.record),
      second.record,
    );
    rmSync(fixture.root, { recursive: true, force: true });
    const restored = scratch("hone-runtime-closure-restored-");
    rmSync(restored, { recursive: true });
    const result = restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: restored,
      campaignConfigHash: fixture.configHash,
      record: second.record,
    });
    expect(result.optimizerBaseDigest).toBe(fixture.optimizerBaseDigest);
    expect(result.bootDigest).toBe(fixture.bootDigest);
    const resumed = recursiveOptimizerBaseSnapshot(
      recorded,
      scratch("hone-runtime-closure-engine-"),
      join(scratch("hone-runtime-closure-run-"), "outer"),
      restored,
    );
    expect(snapshotDigest(recorded.optimizerRuntime.image, resumed)).toBe(fixture.optimizerBaseDigest);
  });

  test("capture verification refuses dirty trees and either sealed identity mismatch", async () => {
    const fixture = syntheticClosure();
    write(fixture.root, "dirty.txt", "untracked\n");
    await expect(captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:02:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    })).rejects.toThrow("clean source worktree");
    rmSync(join(fixture.root, "dirty.txt"));

    await expect(captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: `sha256:${"1".repeat(64)}`,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:02:01.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    })).rejects.toThrow("boot digest mismatch");

    await expect(captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: `sha256:${"2".repeat(64)}`,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:02:02.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    })).rejects.toThrow("optimizer base digest mismatch");
  });

  test("capture refuses a real disk-byte mutation between verification and CAS storage", async () => {
    const fixture = syntheticClosure();
    await expect(captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:02:03.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
      beforeFileCapture: () => {
        write(fixture.root, "package.json", "{\"name\":\"mutated-after-verification\"}\n");
      },
    })).rejects.toThrow("tracked source bytes drifted during closure capture: package.json");
  });

  test("restore kills CAS-byte and manifest-binding mutations before publishing a target", async () => {
    const fixture = syntheticClosure();
    const captured = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:03:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    const tree = JSON.parse(readCas(fixture.casDir, captured.record.closureDigest).toString("utf8")) as {
      entries: Array<{ kind: string; chunks?: Array<{ hash: string }> }>;
    };
    const chunk = tree.entries.find((entry) => entry.kind === "file" && (entry.chunks?.length ?? 0) > 0)?.chunks?.[0];
    if (chunk === undefined) throw new Error("synthetic closure has no content chunk");
    writeFileSync(casPath(fixture.casDir, chunk.hash), "mutated");
    const corruptedTarget = join(scratch("hone-runtime-closure-corrupt-parent-"), "restore");
    expect(() => restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: corruptedTarget,
      campaignConfigHash: fixture.configHash,
      record: captured.record,
    })).toThrow("CAS content hash mismatch");
    expect(() => readFileSync(corruptedTarget)).toThrow();

    const rebound = structuredClone(captured.record);
    rebound.closureDigest = `sha256:${"3".repeat(64)}`;
    const { recordDigest: _recordDigest, ...body } = rebound;
    rebound.recordDigest = campaignRuntimeClosureRecordDigest(body);
    expect(() => restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: join(scratch("hone-runtime-closure-binding-parent-"), "restore"),
      campaignConfigHash: fixture.configHash,
      record: rebound,
    })).toThrow("manifest does not match");
  });

  test("record binding and the held campaign lock are mandatory append guards", async () => {
    const fixture = syntheticClosure();
    const captured = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:04:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    const foreign = structuredClone(captured.record);
    foreign.sourceCommit = "f".repeat(40);
    const { recordDigest: _recordDigest, ...foreignBody } = foreign;
    foreign.recordDigest = campaignRuntimeClosureRecordDigest(foreignBody);
    expect(() => withRuntimeClosureCapture(fixture.config, foreign)).toThrow(
      "source commit is not in the campaign lineage",
    );

    const foreignBoot = structuredClone(captured.record);
    foreignBoot.campaignBootDigest = `sha256:${"4".repeat(64)}`;
    const { recordDigest: _bootRecordDigest, ...foreignBootBody } = foreignBoot;
    foreignBoot.recordDigest = campaignRuntimeClosureRecordDigest(foreignBootBody);
    expect(() => withRuntimeClosureCapture(fixture.config, foreignBoot)).toThrow(
      "not bound to a campaign boot identity",
    );

    const campaignPath = join(fixture.root, ".hone-campaign.json");
    writeFileSync(campaignPath, `${JSON.stringify(fixture.config, null, 2)}\n`);
    const acquired = acquireCampaignRecordLock(campaignPath);
    acquired.release();
    expect(() => appendRuntimeClosureCaptureRecord(
      campaignPath,
      captured.record,
      acquired.lock,
    )).toThrow("requires the matching held campaign lock");

    const held = acquireCampaignRecordLock(campaignPath);
    try {
      const updated = appendRuntimeClosureCaptureRecord(campaignPath, captured.record, held.lock);
      expect(updated.runtimeClosureJournal?.captures).toHaveLength(1);
      expect(metaCampaignConfigHash(updated)).toBe(fixture.configHash);
    } finally {
      held.release();
    }
  });

  test("closure records append after source migration without changing campaign identity", async () => {
    const fixture = syntheticClosure();
    const captured = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:05:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    write(fixture.root, "migration-marker.txt", "new engine commit\n");
    execFileSync("git", ["add", "migration-marker.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-qm", "new engine"], { cwd: fixture.root });
    const migratedHead = execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: fixture.root, encoding: "utf8" },
    ).trim();
    const campaignPath = join(fixture.root, "campaign-runtime-state.json");
    writeFileSync(campaignPath, `${JSON.stringify(fixture.config, null, 2)}\n`);
    await migrateCampaignSource({
      root: fixture.root,
      campaignPath,
      from: fixture.head,
      to: migratedHead,
      reason: "exercise closure/source journal composition",
      at: "2026-08-26T22:05:01.000Z",
      bootDigest: fixture.bootDigest,
    });

    const held = acquireCampaignRecordLock(campaignPath);
    try {
      const updated = appendRuntimeClosureCaptureRecord(campaignPath, captured.record, held.lock);
      expect(updated.sourceMigrationJournal?.migrations).toHaveLength(1);
      expect(updated.runtimeClosureJournal?.captures).toHaveLength(1);
      expect(metaCampaignConfigHash(updated)).toBe(fixture.configHash);
    } finally {
      held.release();
    }
  });


  test("restore recomputes boot and optimizer identities after every upstream binding passes", async () => {
    const fixture = syntheticClosure();
    const captured = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:05:30.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    const originalManifest = JSON.parse(
      readCas(fixture.casDir, captured.record.manifestArtifact).toString("utf8"),
    ) as Record<string, unknown>;
    const forgedRecord = (
      field: "bootDigest" | "optimizerBaseDigest",
      digest: Sha256Digest,
    ): typeof captured.record => {
      const manifest = { ...originalManifest, [field]: digest };
      const manifestArtifact = writeCas(
        fixture.casDir,
        Buffer.from(canonicalJson(manifest), "utf8"),
      ) as Sha256Digest;
      const unsigned = { ...captured.record, [field]: digest, manifestArtifact };
      const { recordDigest: _recordDigest, ...body } = unsigned;
      return { ...unsigned, recordDigest: campaignRuntimeClosureRecordDigest(body) };
    };

    const wrongBoot = forgedRecord("bootDigest", `sha256:${"6".repeat(64)}`);
    expect(() => restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: join(scratch("hone-runtime-closure-wrong-boot-"), "restore"),
      campaignConfigHash: fixture.configHash,
      record: wrongBoot,
    })).toThrow("restored boot digest mismatch");

    const wrongOptimizer = forgedRecord("optimizerBaseDigest", `sha256:${"7".repeat(64)}`);
    expect(() => restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: join(scratch("hone-runtime-closure-wrong-optimizer-"), "restore"),
      campaignConfigHash: fixture.configHash,
      record: wrongOptimizer,
    })).toThrow("restored optimizer base digest mismatch");
  });

  test("freeze publication writes the closure journal into the published config", async () => {
    const fixture = syntheticClosure();
    const captured = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:05:31.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    const publication = writeFrozenRecursiveCampaignWithClosure(
      fixture.root,
      ".hone-cas/published-frozen.json",
      fixture.config,
      captured.record,
    );
    const published = MetaCampaignConfigV2.parse(
      JSON.parse(readFileSync(publication.outputPath, "utf8")),
    );
    expect(published.runtimeClosureJournal?.captures).toHaveLength(1);
    expect(published.runtimeClosureJournal?.campaignConfigHash).toBe(
      metaCampaignConfigHash(fixture.config),
    );
  });

  test("recursive phase receipts expose the exact closure journal and explicit absence", async () => {
    const fixture = syntheticClosure();
    const captured = await captureRuntimeClosure({
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      expectedBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:05:32.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
    });
    const recorded = withRuntimeClosureCapture(fixture.config, captured.record);
    const receipt = JSON.parse(readFileSync(
      recursivePhaseReceipt(scratch("hone-runtime-closure-receipt-"), "search", recorded, {}),
      "utf8",
    )) as Record<string, unknown>;
    expect(receipt["runtimeClosureJournal"]).toEqual(recorded.runtimeClosureJournal);

    const absentReceipt = JSON.parse(readFileSync(
      recursivePhaseReceipt(scratch("hone-runtime-closure-receipt-absent-"), "search", fixture.config, {}),
      "utf8",
    )) as Record<string, unknown>;
    expect(absentReceipt["runtimeClosureJournal"]).toBeNull();
  });

  test("historical backfill reconstructs workspace links from verified store evidence", async () => {
    const fixture = syntheticClosure();
    const archiveDir = scratch("hone-runtime-closure-archive-");
    const archive = join(archiveDir, "node_modules.tar.zst");
    execFileSync("tar", ["--zstd", "-cf", archive, "-C", fixture.root, "node_modules"]);
    const archiveDigest = `sha256:${
      createHash("sha256").update(readFileSync(archive)).digest("hex")
    }` as Sha256Digest;
    write(fixture.root, "post-freeze.txt", "later engine source\n");
    execFileSync("git", ["add", "post-freeze.txt"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-qm", "post-freeze engine"], { cwd: fixture.root });

    const historicalRequest = {
      sourceRoot: fixture.root,
      sourceCommit: fixture.head,
      campaignBootDigest: fixture.bootDigest,
      optimizerImage: fixture.config.optimizerRuntime.image,
      optimizerBaseDigest: fixture.optimizerBaseDigest,
      campaignConfigHash: fixture.configHash,
      capturedAt: "2026-08-26T22:06:00.000Z",
      casDir: fixture.casDir,
      previousRecordDigest: null,
      nodeModulesArchive: archive,
      nodeModulesArchiveSha256: archiveDigest,
    } as const;
    await expect(captureRuntimeClosure({
      ...historicalRequest,
      nodeModulesArchiveSha256: `sha256:${"8".repeat(64)}`,
    })).rejects.toThrow("node_modules evidence archive digest mismatch");
    const captured = await captureRuntimeClosure(historicalRequest);
    expect(captured.record.bootDigest).toBe(fixture.bootDigest);
    const restored = join(scratch("hone-runtime-closure-archive-restore-"), "closure");
    const result = restoreRuntimeClosure({
      casDir: fixture.casDir,
      targetDir: restored,
      campaignConfigHash: fixture.configHash,
      record: captured.record,
    });
    expect(result.optimizerBaseDigest).toBe(fixture.optimizerBaseDigest);
    expect(result.bootDigest).toBe(fixture.bootDigest);
  });
});
