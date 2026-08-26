import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { metaCampaignConfigHash } from "@hone/meta";
import { MetaCampaignConfigV2, canonicalJson, type MetaCampaignConfigV2 as RecursiveConfig } from "@hone/schema";
import { describe, expect, test } from "vitest";
import {
  assertCampaignSourceMigrationOnly,
  assertRecursiveCampaignSourceIdentity,
  migrateCampaignSource,
  recursivePhaseReceipt,
} from "../src/commands/hone.js";
import { main } from "../src/main.js";
import type { CmdIo } from "../src/io.js";
import { MetaJournalV1 } from "../src/meta-journal.js";
import { makeRoot } from "./helpers.js";

const preservedPath = fileURLToPath(new URL(
  "../../../data/m2-refreeze-final/campaign-frozen.json",
  import.meta.url,
));
const TO_COMMIT = "f".repeat(40);
const NEXT_COMMIT = "e".repeat(40);
const TO_BOOT_DIGEST = `sha256:${"9".repeat(64)}` as const;
const NEXT_BOOT_DIGEST = `sha256:${"8".repeat(64)}` as const;

function preservedConfig(): RecursiveConfig {
  return MetaCampaignConfigV2.parse(JSON.parse(readFileSync(preservedPath, "utf8")));
}

function writeCampaignRun(
  root: string,
  runId: string,
  configHash: string,
  bootDigest: string,
  terminal: boolean,
): string {
  const runDir = join(root, ".hone-runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "campaign-session.v1.json"), `${JSON.stringify({
    version: 1,
    campaignConfigHash: configHash,
    authorityPath: join(root, "campaign-pause.v1.json"),
    proxyRole: "inner-capsule-improvement",
  })}\n`);
  writeFileSync(join(runDir, ".hone-version"), `${bootDigest}\n`);
  const started = {
    runId,
    at: "2026-08-26T00:00:00.000Z",
    type: "run.started",
    capsuleId: "synthetic-campaign-capsule",
    contractHash: "sha256:contract",
    optimizerDigest: "sha256:optimizer",
    campaignConfigHash: configHash,
  };
  const events = terminal
    ? [started, {
      runId,
      at: "2026-08-26T00:01:00.000Z",
      type: "run.finished",
      status: "completed",
    }]
    : [started];
  writeFileSync(join(runDir, "events.ndjson"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  return runDir;
}

function frozenFieldBytes(config: RecursiveConfig): string {
  const {
    sourceMigrationJournal: _journal,
    seedOptimizer,
    controllerOptimizer,
    trustedRuntime,
    ...frozen
  } = config;
  const { sourceCommit: _seedCommit, ...seedFrozen } = seedOptimizer;
  const { sourceCommit: _controllerCommit, ...controllerFrozen } = controllerOptimizer;
  const {
    sourceCommit: _runtimeCommit,
    digest: _runtimeDigest,
    ...runtimeFrozen
  } = trustedRuntime;
  return canonicalJson({
    ...frozen,
    seedOptimizer: seedFrozen,
    controllerOptimizer: controllerFrozen,
    trustedRuntime: runtimeFrozen,
  });
}

function commandIo(root: string, lines: { out: string[]; err: string[] }): CmdIo {
  return {
    root,
    env: { ...process.env, USER: "migration-test-operator" },
    isTTY: false,
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
  };
}

function initializeGitRoot(root: string): string {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "migration-test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Migration Test"], { cwd: root });
  writeFileSync(join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

describe("campaign migrate-source", () => {
  test("migrates a crashed recursive campaign, preserves frozen identity, and re-pins only nonterminal runs", async () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = preservedConfig();
    const from = before.trustedRuntime.sourceCommit;
    const fromBootDigest = before.trustedRuntime.digest;
    const configHash = metaCampaignConfigHash(before);
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);

    const nonterminalRun = writeCampaignRun(root, "run_crashed", configHash, fromBootDigest, false);
    const terminalRun = writeCampaignRun(root, "run_finished", configHash, fromBootDigest, true);
    const registeredPath = join(
      root,
      ".hone-runs",
      `recursive-cell-${configHash.slice("sha256:".length)}`,
      "campaign.json",
    );
    mkdirSync(dirname(registeredPath), { recursive: true });
    writeFileSync(registeredPath, `${JSON.stringify(before, null, 2)}\n`);
    const journalPath = join(dirname(registeredPath), "meta-journal.ndjson");
    MetaJournalV1.open(journalPath, before).close();

    expect(() => assertRecursiveCampaignSourceIdentity(before, TO_COMMIT, TO_BOOT_DIGEST))
      .toThrow("recursive campaign trusted runtime identity drift");

    const result = await migrateCampaignSource({
      root,
      campaignPath,
      from,
      to: TO_COMMIT,
      reason: "landed crash adjudication must carry the paused campaign forward",
      at: "2026-08-26T01:02:03.000Z",
      bootDigest: TO_BOOT_DIGEST,
      operator: "migration-test-operator",
    });
    const after = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));

    expect(result.configHash).toBe(configHash);
    expect(result.repinnedRuns).toEqual(["run_crashed"]);
    expect(metaCampaignConfigHash(after)).toBe(configHash);
    expect(() => assertRecursiveCampaignSourceIdentity(after, TO_COMMIT, TO_BOOT_DIGEST)).not.toThrow();
    expect(() => assertRecursiveCampaignSourceIdentity(after, from, fromBootDigest))
      .toThrow("recursive campaign trusted runtime identity drift");
    expect(after.seedOptimizer.sourceCommit).toBe(TO_COMMIT);
    expect(after.controllerOptimizer.sourceCommit).toBe(TO_COMMIT);
    expect(after.trustedRuntime).toMatchObject({ sourceCommit: TO_COMMIT, digest: TO_BOOT_DIGEST });
    expect(frozenFieldBytes(after)).toBe(frozenFieldBytes(before));
    expect(() => assertCampaignSourceMigrationOnly(before, after)).not.toThrow();
    expect(readFileSync(join(nonterminalRun, ".hone-version"), "utf8")).toBe(`${TO_BOOT_DIGEST}\n`);
    expect(readFileSync(join(terminalRun, ".hone-version"), "utf8")).toBe(`${fromBootDigest}\n`);
    expect(MetaCampaignConfigV2.parse(JSON.parse(readFileSync(registeredPath, "utf8"))))
      .toEqual(after);
    const reconciledJournal = MetaJournalV1.open(journalPath, after);
    expect(reconciledJournal.configHash).toBe(configHash);
    reconciledJournal.close();
    expect(after.sourceMigrationJournal).toMatchObject({
      version: 1,
      campaignConfigHash: configHash,
      migrations: [{
        version: 1,
        at: "2026-08-26T01:02:03.000Z",
        from,
        to: TO_COMMIT,
        fromBootDigest,
        bootDigest: TO_BOOT_DIGEST,
        reason: "landed crash adjudication must carry the paused campaign forward",
        operator: "migration-test-operator",
        previousRecordDigest: null,
      }],
    });
    const receiptPath = recursivePhaseReceipt(root, "search", after, { status: "synthetic" });
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      configHash,
      phase: "search",
      sourceMigrationJournal: after.sourceMigrationJournal,
    });

    await expect(migrateCampaignSource({
      root,
      campaignPath,
      from,
      to: NEXT_COMMIT,
      reason: "stale retry",
      at: "2026-08-26T02:00:00.000Z",
      bootDigest: NEXT_BOOT_DIGEST,
    })).rejects.toThrow(`--from ${from} does not exactly match`);
  });

  test("appends every migration and kills journal-integrity and frozen-field mutants", async () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = preservedConfig();
    const from = before.trustedRuntime.sourceCommit;
    writeFileSync(campaignPath, `${JSON.stringify(before, null, 2)}\n`);

    await migrateCampaignSource({
      root,
      campaignPath,
      from,
      to: TO_COMMIT,
      reason: "first engine repair",
      at: "2026-08-26T01:00:00.000Z",
      bootDigest: TO_BOOT_DIGEST,
    });
    await migrateCampaignSource({
      root,
      campaignPath,
      from: TO_COMMIT,
      to: NEXT_COMMIT,
      reason: "second engine repair",
      at: "2026-08-26T02:00:00.000Z",
      bootDigest: NEXT_BOOT_DIGEST,
    });
    const migrated = MetaCampaignConfigV2.parse(JSON.parse(readFileSync(campaignPath, "utf8")));
    const history = migrated.sourceMigrationJournal?.migrations;
    expect(history).toHaveLength(2);
    expect(history?.[1]).toMatchObject({
      from: TO_COMMIT,
      to: NEXT_COMMIT,
      fromBootDigest: TO_BOOT_DIGEST,
      bootDigest: NEXT_BOOT_DIGEST,
      previousRecordDigest: history?.[0]?.recordDigest,
    });

    const changedReason = structuredClone(migrated);
    changedReason.sourceMigrationJournal!.migrations[0]!.reason = "mutated reason";
    expect(() => metaCampaignConfigHash(changedReason)).toThrow("record digest mismatch");

    const removedRecord = structuredClone(migrated);
    removedRecord.sourceMigrationJournal!.migrations.shift();
    expect(() => metaCampaignConfigHash(removedRecord)).toThrow("record chain is not append-only");

    const alteredFrozenField = structuredClone(migrated);
    alteredFrozenField.objective = `${alteredFrozenField.objective} silently changed`;
    expect(() => metaCampaignConfigHash(alteredFrozenField))
      .toThrow("altered frozen campaign fields outside the sanctioned source identity");
    expect(() => assertCampaignSourceMigrationOnly(before, alteredFrozenField))
      .toThrow("attempted to alter frozen campaign fields");
  });

  test("refuses a foreign nonterminal runtime pin before changing the campaign", async () => {
    const root = makeRoot();
    const campaignPath = join(root, "campaign-frozen.json");
    const before = preservedConfig();
    const originalBytes = `${JSON.stringify(before, null, 2)}\n`;
    const configHash = metaCampaignConfigHash(before);
    writeFileSync(campaignPath, originalBytes);
    const runDir = writeCampaignRun(
      root,
      "run_foreign_pin",
      configHash,
      `sha256:${"7".repeat(64)}`,
      false,
    );

    await expect(migrateCampaignSource({
      root,
      campaignPath,
      from: before.trustedRuntime.sourceCommit,
      to: TO_COMMIT,
      reason: "must not cross a foreign run pin",
      at: "2026-08-26T01:00:00.000Z",
      bootDigest: TO_BOOT_DIGEST,
    })).rejects.toThrow("has foreign runtime pin");
    expect(readFileSync(campaignPath, "utf8")).toBe(originalBytes);
    expect(readFileSync(join(runDir, ".hone-version"), "utf8"))
      .toBe(`sha256:${"7".repeat(64)}\n`);
  });

  test("CLI refuses dirty trees and a --to that is not the resolved clean HEAD", async () => {
    const dirtyRoot = makeRoot();
    const dirtyHead = initializeGitRoot(dirtyRoot);
    writeFileSync(join(dirtyRoot, "untracked.txt"), "dirty\n");
    const dirtyLines = { out: [] as string[], err: [] as string[] };
    const dirtyCode = await main([
      "campaign",
      "migrate-source",
      "--campaign",
      preservedPath,
      "--from",
      preservedConfig().trustedRuntime.sourceCommit,
      "--to",
      dirtyHead,
      "--reason",
      "dirty refusal mutant",
    ], commandIo(dirtyRoot, dirtyLines));
    expect(dirtyCode).toBe(2);
    expect(dirtyLines.err.join("\n")).toContain("require a clean source worktree");

    const cleanRoot = makeRoot();
    initializeGitRoot(cleanRoot);
    const cleanLines = { out: [] as string[], err: [] as string[] };
    const cleanCode = await main([
      "campaign",
      "migrate-source",
      "--campaign",
      preservedPath,
      "--from",
      preservedConfig().trustedRuntime.sourceCommit,
      "--to",
      "a".repeat(40),
      "--reason",
      "resolved commit refusal mutant",
    ], commandIo(cleanRoot, cleanLines));
    expect(cleanCode).toBe(2);
    expect(cleanLines.err.join("\n")).toContain("does not resolve to the clean working tree HEAD");
  });

  test("help publishes the exact operator command", async () => {
    const lines = { out: [] as string[], err: [] as string[] };
    const code = await main(["help"], commandIo(resolve(dirname(preservedPath), "..", ".."), lines));
    expect(code).toBe(0);
    expect(lines.out.join("\n")).toContain(
      "hone campaign migrate-source --campaign <frozen.json> --from <oldSourceCommit> --to <newSourceCommit> --reason <text>",
    );
  });
});
