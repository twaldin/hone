import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CasStore, packDirAsArtifact } from "@hone/broker";
import { MetaCampaignConfigV1 } from "@hone/schema";
import {
  assertMutablePathsResolve,
  assertOptimizerProtectedPathsResolve,
  createSyntheticCapsule,
} from "../src/commands/hone.js";
import { hone, makeRoot } from "./helpers.js";

describe("hone hone campaign command", () => {
  test("requires the explicit campaign and headless flags", async () => {
    const root = makeRoot();
    const result = await hone(["hone", "--campaign", "campaign.json"], { cwd: root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: hone hone --campaign <path> --headless");
  });

  test("refuses mutable paths that select no sealed optimizer file", () => {
    const snapshot = {
      files: new Map([
        ["optimizer/assets/prompts.ts", { bytes: Buffer.from("prompt"), mode: 0o644 }],
        ["optimizer/assets/policy.ts", { bytes: Buffer.from("policy"), mode: 0o644 }],
      ]),
    };
    expect(() => assertMutablePathsResolve(["optimizer/assets/prompts"], snapshot))
      .toThrow("mutable paths do not select a sealed optimizer file: optimizer/assets/prompts");
    expect(() => assertMutablePathsResolve(["optimizer/assets"], snapshot)).not.toThrow();
    expect(() => assertMutablePathsResolve(["optimizer/assets/prompts.ts"], snapshot)).not.toThrow();
  });

  test("refuses stale optimizer-local protected paths", () => {
    const snapshot = {
      files: new Map([
        ["optimizer/src/loop.ts", { bytes: Buffer.from("loop"), mode: 0o644 }],
        ["optimizer/worker/mutate.ts", { bytes: Buffer.from("worker"), mode: 0o644 }],
      ]),
    };
    expect(() => assertOptimizerProtectedPathsResolve(["optimizer/src/mutate.ts"], snapshot))
      .toThrow("protected paths do not select a sealed optimizer file: optimizer/src/mutate.ts");
    expect(() => assertOptimizerProtectedPathsResolve(["optimizer/src", "optimizer/worker"], snapshot)).not.toThrow();
    expect(() => assertOptimizerProtectedPathsResolve(["trusted", "schema"], snapshot)).not.toThrow();
  });

  test("the official path refuses HONE_OPTIMIZER_CMD before campaign state is created", async () => {
    const root = makeRoot();
    const result = await hone(["hone", "--campaign", "does-not-exist.json", "--headless"], {
      cwd: root,
      env: { HONE_OPTIMIZER_CMD: "node untrusted.js" },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("official meta campaigns refuse HONE_OPTIMIZER_CMD");
  });

  test("refuses a campaign whose registered outer envelope cannot cover fixed candidate evaluation work", async () => {
    const root = makeRoot();
    const campaign = readFileSync(new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url));
    writeFileSync(join(root, "campaign.json"), campaign);
    const result = await hone(["hone", "--campaign", "campaign.json", "--headless"], { cwd: root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("outer maxEvaluatorInvocations 1 cannot cover");
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  test("materializes the synthetic outer task and its sealed CAS baseline", async () => {
    const root = makeRoot();
    const config = MetaCampaignConfigV1.parse(JSON.parse(
      readFileSync(new URL("../../../schema/fixtures/meta-campaign.m1.json", import.meta.url), "utf8"),
    ));
    const seedDir = join(root, "seed");
    const casDir = join(root, "cas");
    mkdirSync(seedDir);
    writeFileSync(join(seedDir, "package.json"), "{}\n");
    const baseline = await packDirAsArtifact(seedDir, new CasStore(casDir));
    const capsuleDir = createSyntheticCapsule(root, config, baseline as `sha256:${string}`, casDir);
    expect(existsSync(join(capsuleDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(capsuleDir, "capsule.json"))).toBe(false);
    expect(readFileSync(join(capsuleDir, "baseline", "package.json"), "utf8")).toBe("{}\n");
  });

  test("help publishes the production campaign route", async () => {
    const result = await hone(["help"], { cwd: makeRoot() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hone hone --campaign <path> --headless");
  });
});
