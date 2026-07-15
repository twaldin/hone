import { describe, expect, it } from "vitest";
import { RunConfig } from "@hone/schema";
import { contractHash, renderContract } from "../src/contract.js";
import { manifestObject } from "./helpers.js";

function config(overrides: Record<string, unknown> = {}): RunConfig {
  const manifest = manifestObject();
  return RunConfig.parse({
    version: 1,
    capsuleId: manifest.id,
    objective: manifest.objective,
    budget: manifest.budget,
    routing: { mutation: { model: "gpt-5.6-terra" } },
    apply: "branch",
    headless: false,
    improverSeat: false,
    seed: 7,
    ...overrides,
  });
}

describe("contract checkpoint rendering", () => {
  it("renders every reviewable dimension of the run", () => {
    const manifest = manifestObject();
    const text = renderContract("run_c1", config(), manifest);
    // objective verbatim
    expect(text).toContain(manifest.objective);
    // baseline
    expect(text).toContain("0123456789abcdef0123456789abcdef01234567");
    // evaluator entrypoint
    expect(text).toContain("python3 /capsule/eval.py");
    // asset groups + visibility
    expect(text).toContain("train");
    expect(text).toContain("public");
    expect(text).toContain("validation");
    expect(text).toContain("protected");
    // budget with USD cap
    expect(text).toMatch(/\$25/);
    expect(text).toContain("1000000");
    // routing
    expect(text).toContain("gpt-5.6-terra");
    // apply mode
    expect(text).toContain("branch");
    // protected paths
    expect(text).toContain("protected/keep.txt");
  });

  it("hash is deterministic and content-addressed", () => {
    const manifest = manifestObject();
    const a = renderContract("run_c1", config(), manifest);
    const b = renderContract("run_c1", config(), manifest);
    expect(contractHash(a)).toBe(contractHash(b));
    expect(contractHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contractHash(renderContract("run_c1", config({ apply: "none" }), manifest))).not.toBe(contractHash(a));
  });
});
