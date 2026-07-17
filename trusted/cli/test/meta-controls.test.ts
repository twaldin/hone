import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeCas } from "../src/cas.js";
import { buildBrokenMetaControl, buildDegradedMetaControl, captureMetaControlSourceSeal } from "../src/meta-controls.js";
import { resolveCandidateOptimizer } from "../src/optimizer-artifact.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const optimizerDir = path.resolve(testDir, "../../../optimizer");
const temporaryDirectories: string[] = [];
const optimizerImage = "hone-optimizer@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("meta negative-control artifact builders", () => {
  it("builds deterministic, distinct canonical workspace tars with transformation receipts", async () => {
    const seal = await captureMetaControlSourceSeal(optimizerDir);
    const brokenA = await buildBrokenMetaControl(optimizerDir, seal);
    const brokenB = await buildBrokenMetaControl(optimizerDir, seal);
    const degradedA = await buildDegradedMetaControl(optimizerDir, seal);
    const degradedB = await buildDegradedMetaControl(optimizerDir, seal);

    expect(brokenA.bytes.equals(brokenB.bytes)).toBe(true);
    expect(degradedA.bytes.equals(degradedB.bytes)).toBe(true);
    expect(brokenA.digest).toBe(brokenB.digest);
    expect(degradedA.digest).toBe(degradedB.digest);
    expect(brokenA.digest).not.toBe(degradedA.digest);
    expect(brokenA.receipt).toMatchObject({ kind: "broken", transformation: "broken-no-candidate-v1", artifactDigest: brokenA.digest });
    expect(degradedA.receipt).toMatchObject({ kind: "degraded", transformation: "degraded-blind-restart-v1", artifactDigest: degradedA.digest });
    expect(brokenA.receipt.transformedFiles.map((file) => file.path)).toEqual(["src/main.ts"]);
    expect(degradedA.receipt.transformedFiles.map((file) => file.path)).toEqual(["assets/context.ts", "assets/policy.ts", "src/loop.ts"]);
    expect([...brokenA.bytes.subarray(0, 100).toString("utf8")].join("")).toContain("workspace/");
  });

  it("produces artifacts accepted by sealed candidate intake while preserving runnable contracts", async () => {
    const seal = await captureMetaControlSourceSeal(optimizerDir);
    const controls = [
      await buildBrokenMetaControl(optimizerDir, seal),
      await buildDegradedMetaControl(optimizerDir, seal),
    ];
    const casDir = temporaryDirectory("hone-meta-controls-cas-");
    for (const control of controls) {
      const stored = writeCas(casDir, control.bytes);
      expect(stored).toBe(control.digest);
      const resolved = await resolveCandidateOptimizer({
        casDir,
        artifactHash: control.digest,
        image: optimizerImage,
        repoRoot: path.resolve(testDir, "../../.."),
      });
      expect(resolved.sourceArtifact).toBe(control.digest);
      expect(resolved.mutablePaths["src/main.ts"]).toMatch(/^sha256:/);
      expect(resolved.snapshot.files.has("optimizer/worker/mutate.ts")).toBe(true);
      expect(resolved.snapshot.files.has("optimizer/package.json")).toBe(true);
    }
  });

  it("refuses source-hash drift and never mutates the source tree", async () => {
    const root = temporaryDirectory("hone-meta-controls-source-");
    const copy = path.join(root, "optimizer");
    cpSync(optimizerDir, copy, { recursive: true });
    const seal = await captureMetaControlSourceSeal(copy);
    const before = await buildBrokenMetaControl(copy, seal);
    writeFileSync(path.join(copy, "assets", "policy.ts"), "export const epsilonRestart = 1;\n", "utf8");
    await expect(buildBrokenMetaControl(copy, seal)).rejects.toThrow(/source drift/);
    expect(before.receipt.sourceSealHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("refuses links and files outside the sealed candidate tree", async () => {
    const root = temporaryDirectory("hone-meta-controls-extra-");
    const copy = path.join(root, "optimizer");
    cpSync(optimizerDir, copy, { recursive: true });
    const seal = await captureMetaControlSourceSeal(copy);
    mkdirSync(path.join(copy, "src", "unexpected"));
    writeFileSync(path.join(copy, "src", "unexpected", "extra.ts"), "export {};\n", "utf8");
    await expect(buildDegradedMetaControl(copy, seal)).rejects.toThrow(/file set drift/);
  });
});
