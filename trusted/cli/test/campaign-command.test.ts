import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { hone, makeRoot } from "./helpers.js";

describe("hone hone campaign command", () => {
  test("requires the explicit campaign and headless flags", async () => {
    const root = makeRoot();
    const result = await hone(["hone", "--campaign", "campaign.json"], { cwd: root });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage: hone hone --campaign <path> --headless");
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

  test("help publishes the production campaign route", async () => {
    const result = await hone(["help"], { cwd: makeRoot() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hone hone --campaign <path> --headless");
  });
});
