/**
 * Environment seam for the trusted ordering check: HONE_CAPSULE_DIR selects
 * the capsule directory the check targets. These tests pin the resolver
 * contract (default, canonicalization, and every refusal path) and prove
 * that an invalid override can never reach the CAS/Docker seam — the whole
 * "@hone/broker" surface the tool consumes is mocked to record and throw.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluatorOutput } from "@hone/schema";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OrderingReport } from "../tools/ordering-check.js";
import {
  CAPSULE_DIR_ENV_VAR,
  TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR,
  TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG,
  serializeOrderingReport,
  summarizeOrderingReport,
  runOrderingCheck,
  resolveCapsuleDir,
  resolveTerminalHoldoutDiagnosticMode,
} from "../tools/ordering-check.js";

const seam = vi.hoisted(() => ({ touched: [] as string[] }));

// Everything ordering-check.ts imports from @hone/broker IS its CAS/Docker
// seam. Each entry records the touch and throws, so any resolution path that
// reaches CAS or Docker setup fails loudly and leaves evidence in `seam`.
vi.mock("@hone/broker", () => {
  const touch = (name: string): never => {
    seam.touched.push(name);
    throw new Error(`CAS/Docker seam reached: ${name}`);
  };
  return {
    Broker: class {
      constructor() {
        touch("new Broker()");
      }
    },
    CasStore: class {
      constructor() {
        touch("new CasStore()");
      }
    },
    packDirAsArtifact: () => touch("packDirAsArtifact()"),
    runCommand: () => touch("runCommand()"),
  };
});

const DIAGNOSTIC_NAMES = ["broken", "naive", "shortcut", "improved"] as const;
const SEEDED_ASTAR_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "seeded-astar",
);

let root: string;

/** Fresh, structurally valid capsule directory under the test temp root. */
function makeCapsule(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "baseline"), { recursive: true });
  for (const diagnostic of DIAGNOSTIC_NAMES) {
    mkdirSync(join(dir, "diagnostics", diagnostic), { recursive: true });
  }
  writeFileSync(join(dir, "capsule.config.json"), '{"objective":"test"}\n');
  return dir;
}
function writeOrderingConfig(
  dir: string,
  assetGroups: { id: string; visibility: string; paths: string[] }[],
): void {
  writeFileSync(
    join(dir, "capsule.config.json"),
    `${JSON.stringify({
      objective: "test ordering",
      image: "hone-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      evalEntrypoint: ["python3", "-I", "-B", "eval.py"],
      protectedPaths: [],
      assetGroups,
      budget: {
        maxTokens: 100,
        maxUsd: 1,
        maxWallClockSec: 60,
        maxEvaluatorInvocations: 20,
      },
      diagnosticOrdering: { path: "diagnostics/ordering-report.json" },
    })}\n`,
  );
}

async function withDiagnosticArgv(action: () => Promise<void>): Promise<void> {
  const original = process.argv;
  process.argv = ["node", "vitest", TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG];
  try {
    await action();
  } finally {
    process.argv = original;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hone-capsule-dir-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveCapsuleDir", () => {
  it("returns the seeded-astar default when the override is unset", () => {
    expect(resolveCapsuleDir({})).toBe(SEEDED_ASTAR_DIR);
    expect(resolveCapsuleDir({ UNRELATED_VAR: "x" })).toBe(SEEDED_ASTAR_DIR);
  });

  it("accepts a valid capsule structure, from env object or raw string", () => {
    const dir = makeCapsule("valid");
    expect(resolveCapsuleDir({ [CAPSULE_DIR_ENV_VAR]: dir })).toBe(dir);
    expect(resolveCapsuleDir(dir)).toBe(dir);
  });

  it("canonicalizes trailing separators and '.' segments", () => {
    const dir = makeCapsule("canonical");
    expect(resolveCapsuleDir(`${dir}/`)).toBe(dir);
    expect(resolveCapsuleDir(`${dir}/./`)).toBe(dir);
  });

  it("refuses an empty override", () => {
    expect(() => resolveCapsuleDir({ [CAPSULE_DIR_ENV_VAR]: "" })).toThrow(
      new RegExp(`${CAPSULE_DIR_ENV_VAR} is set but empty`),
    );
  });

  it("refuses relative paths", () => {
    expect(() => resolveCapsuleDir("capsules/seeded-astar")).toThrow(
      /must be an absolute path.*capsules\/seeded-astar/,
    );
    expect(() => resolveCapsuleDir({ [CAPSULE_DIR_ENV_VAR]: "./x" })).toThrow(
      /must be an absolute path/,
    );
  });

  it('refuses ".." traversal segments even when the result would be valid', () => {
    const dir = makeCapsule("traversal");
    const detour = `${dir}/../${basename(dir)}`;
    expect(() => resolveCapsuleDir(detour)).toThrow(/traversal segments/);
  });

  it("refuses a nonexistent path, naming it", () => {
    const missing = join(root, "no-such-capsule");
    expect(() => resolveCapsuleDir(missing)).toThrow(
      new RegExp(`does not exist: ${missing}`),
    );
  });

  it("refuses a path that is not a directory", () => {
    const dir = makeCapsule("file-target");
    expect(() => resolveCapsuleDir(join(dir, "capsule.config.json"))).toThrow(
      /requires a directory/,
    );
  });

  it("refuses a symlink to an otherwise valid capsule directory", () => {
    const real = makeCapsule("symlink-target");
    const link = join(root, "symlink-capsule");
    symlinkSync(real, link);
    expect(() => resolveCapsuleDir(link)).toThrow(/symlink/);
  });

  it("refuses a capsule missing capsule.config.json", () => {
    const dir = makeCapsule("no-config");
    rmSync(join(dir, "capsule.config.json"));
    expect(() => resolveCapsuleDir(dir)).toThrow(
      /missing required file.*capsule\.config\.json/,
    );
  });

  it("refuses a capsule whose config is a symlink instead of a regular file", () => {
    const dir = makeCapsule("symlink-config");
    const real = join(dir, "real-config.json");
    writeFileSync(real, "{}\n");
    rmSync(join(dir, "capsule.config.json"));
    symlinkSync(real, join(dir, "capsule.config.json"));
    expect(() => resolveCapsuleDir(dir)).toThrow(/regular file/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses a capsule whose config is unreadable",
    () => {
      const dir = makeCapsule("unreadable-config");
      chmodSync(join(dir, "capsule.config.json"), 0o000);
      try {
        expect(() => resolveCapsuleDir(dir)).toThrow(/not readable/);
      } finally {
        chmodSync(join(dir, "capsule.config.json"), 0o644);
      }
    },
  );

  it("refuses a capsule missing baseline/", () => {
    const dir = makeCapsule("no-baseline");
    rmSync(join(dir, "baseline"), { recursive: true });
    expect(() => resolveCapsuleDir(dir)).toThrow(new RegExp(`does not exist: ${join(dir, "baseline")}`));
  });

  it("refuses a capsule missing any required diagnostic variant, naming it", () => {
    for (const diagnostic of DIAGNOSTIC_NAMES) {
      const dir = makeCapsule(`no-${diagnostic}`);
      rmSync(join(dir, "diagnostics", diagnostic), { recursive: true });
      expect(() => resolveCapsuleDir(dir)).toThrow(
        new RegExp(`does not exist: ${join(dir, "diagnostics", diagnostic)}`),
      );
    }
  });

  it("never leaks file contents into error messages", () => {
    const dir = makeCapsule("content-leak");
    writeFileSync(join(dir, "capsule.config.json"), '{"secret":"DO-NOT-LEAK"}\n');
    rmSync(join(dir, "baseline"), { recursive: true });
    try {
      resolveCapsuleDir(dir);
      expect.unreachable("resolution must fail");
    } catch (err) {
      expect(String(err)).not.toContain("DO-NOT-LEAK");
      expect(String(err)).toContain(dir);
    }
  });
});

describe("terminal holdout diagnostic admission", () => {
  it("requires the CLI flag and trusted environment gate together", () => {
    expect(resolveTerminalHoldoutDiagnosticMode([], {})).toBe(false);
    expect(
      resolveTerminalHoldoutDiagnosticMode(
        [TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG],
        { [TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR]: "1" },
      ),
    ).toBe(true);
    expect(() =>
      resolveTerminalHoldoutDiagnosticMode(
        [TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG],
        {},
      ),
    ).toThrow(/requires both/);
    expect(() =>
      resolveTerminalHoldoutDiagnosticMode(
        [],
        { [TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR]: "1" },
      ),
    ).toThrow(/requires both/);
    expect(() =>
      resolveTerminalHoldoutDiagnosticMode(
        [TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG],
        { [TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR]: "true" },
      ),
    ).toThrow(/must be exactly "1"/);
  });

  it("a one-sided gate fails before any CAS or Docker seam", async () => {
    await withDiagnosticArgv(async () => {
      await expect(runOrderingCheck()).rejects.toThrow(/requires both/);
    });
    expect(seam.touched).toEqual([]);

    vi.stubEnv(TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR, "1");
    const original = process.argv;
    process.argv = ["node", "vitest"];
    try {
      await expect(runOrderingCheck()).rejects.toThrow(/requires both/);
    } finally {
      process.argv = original;
    }
    expect(seam.touched).toEqual([]);
  });

  it("persists aggregate ordering only, never per-example holdout content", () => {
    const holdoutSecret = "SEALED-ASSET-CONTENT-MUST-NOT-PERSIST";
    const output = (score: number): EvaluatorOutput => ({
      valid: true,
      objectives: { score },
      constraints: { tests_pass: true },
      perExample: {
        sealed: { score, feedback: holdoutSecret },
      },
      diagnostics: { summary: holdoutSecret, quality: 1 },
    });
    const variant = (score: number) => ({
      bySplit: {
        train: output(score),
        validation: output(score),
      },
      train: score,
      validation: score,
      combined: score,
    });
    const report: OrderingReport = {
      results: {
        baseline: variant(0.5),
        broken: variant(0),
        naive: variant(0.25),
        shortcut: variant(0.4),
        improved: variant(1),
      },
      stabilityAggregates: [0.5, 0.5, 0.5],
      stabilitySpread: 0,
      failures: [],
      evalInvocations: 14,
      wallMs: 1,
    };

    const bytes = serializeOrderingReport(summarizeOrderingReport(report));
    expect(bytes).not.toContain(holdoutSecret);
    expect(bytes).not.toContain("perExample");
    expect(bytes).not.toContain("diagnostics");
    expect(JSON.parse(bytes)).toMatchObject({
      failures: [],
      variants: {
        baseline: { train: 0.5, validation: 0.5, combined: 0.5 },
      },
    });
  });

  it("rejects missing validation before any CAS or Docker seam", async () => {
    const dir = makeCapsule("holdout-missing-validation");
    writeOrderingConfig(dir, [
      { id: "train", visibility: "holdout", paths: ["ASSET-CONTENT-MUST-NOT-LEAK"] },
    ]);
    vi.stubEnv(CAPSULE_DIR_ENV_VAR, dir);
    vi.stubEnv(TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR, "1");
    vi.resetModules();

    await withDiagnosticArgv(async () => {
      // Intentional dynamic import: this test exercises module initialization
      // against a per-case HONE_CAPSULE_DIR after resetting the module cache.
      const tool = await import("../tools/ordering-check.js");
      await expect(tool.runOrderingCheck()).rejects.toThrow(/missing holdout asset group "validation"/);
    });
    expect(seam.touched).toEqual([]);
  });

  it("rejects public and mixed selected groups before any CAS or Docker seam", async () => {
    for (const [name, assetGroups] of [
      [
        "holdout-public",
        [
          { id: "train", visibility: "public", paths: ["ASSET-CONTENT-MUST-NOT-LEAK"] },
          { id: "validation", visibility: "public", paths: ["ASSET-CONTENT-MUST-NOT-LEAK"] },
        ],
      ],
      [
        "holdout-mixed",
        [
          { id: "train", visibility: "holdout", paths: ["ASSET-CONTENT-MUST-NOT-LEAK"] },
          { id: "validation", visibility: "protected", paths: ["ASSET-CONTENT-MUST-NOT-LEAK"] },
        ],
      ],
    ] as const) {
      const dir = makeCapsule(name);
      writeOrderingConfig(dir, assetGroups.map((group) => ({ ...group, paths: [...group.paths] })));
      vi.stubEnv(CAPSULE_DIR_ENV_VAR, dir);
      vi.stubEnv(TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR, "1");
      vi.resetModules();

      await withDiagnosticArgv(async () => {
        // Intentional dynamic import: each loop iteration supplies a distinct
        // capsule config to the module-level directory resolver.
        const tool = await import("../tools/ordering-check.js");
        try {
          await tool.runOrderingCheck();
          expect.unreachable("terminal diagnostic preflight must reject non-holdout visibility");
        } catch (err) {
          expect(String(err)).toMatch(/rejects public\/mixed visibility/);
          expect(String(err)).not.toContain("ASSET-CONTENT-MUST-NOT-LEAK");
        }
      });
      expect(seam.touched).toEqual([]);
      vi.unstubAllEnvs();
    }
  });
});

describe("invalid resolution never reaches the CAS/Docker seam", () => {
  // The override is validated when the tool module initializes, so each case
  // needs a fresh module load under a different env state — a boundary only
  // dynamic import (after vi.resetModules) can exercise; a static import
  // would be evaluated once, before any env stub exists.
  it("a relative override fails module init before any seam call", async () => {
    vi.stubEnv(CAPSULE_DIR_ENV_VAR, "relative/capsule");
    await expect(import("../tools/ordering-check.js")).rejects.toThrow(
      /must be an absolute path/,
    );
    expect(seam.touched).toEqual([]);
  });

  it("a structurally invalid override fails module init before any seam call", async () => {
    const dir = makeCapsule("seam-invalid");
    rmSync(join(dir, "diagnostics", "improved"), { recursive: true });
    vi.stubEnv(CAPSULE_DIR_ENV_VAR, dir);
    await expect(import("../tools/ordering-check.js")).rejects.toThrow(
      new RegExp(`does not exist: ${join(dir, "diagnostics", "improved")}`),
    );
    expect(seam.touched).toEqual([]);
  });

  it("a valid override resolves without touching the seam", async () => {
    const dir = makeCapsule("seam-valid");
    vi.stubEnv(CAPSULE_DIR_ENV_VAR, dir);
    const tool = await import("../tools/ordering-check.js");
    expect(typeof tool.runOrderingCheck).toBe("function");
    expect(seam.touched).toEqual([]);
  });
});
