import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/args.js";
import { casPath, writeCas } from "../src/cas.js";
import {
  MAX_CANDIDATE_OPTIMIZER_ENTRIES,
  MAX_CANDIDATE_OPTIMIZER_FILE_BYTES,
  OPTIMIZER_ARTIFACT_SEAL_FILE,
  assertOptimizerArtifactSeal,
  readOptimizerArtifactSeal,
  resolveCandidateOptimizer,
  resolveSealedCandidateOptimizer,
  writeOptimizerArtifactSeal,
} from "../src/optimizer-artifact.js";
import { collectOptimizerSnapshot, computeOptimizerDigest, repoRootFromHere, snapshotDigest, writeOptimizerStaging } from "../src/optimizer-digest.js";
import { buildTar, fakeHash, FIX_IMAGE, makeRoot, tarToCas } from "./helpers.js";
import type { RawTarEntry } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = makeRoot();
  roots.push(value);
  return value;
}

function basePackageFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [rel, file] of collectOptimizerSnapshot().files) {
    if (!rel.startsWith("optimizer/")) continue;
    const packageRel = rel.slice("optimizer/".length);
    if (
      packageRel.startsWith("src/")
      || packageRel.startsWith("assets/")
      || packageRel.startsWith("worker/")
      || packageRel === "package.json"
      || packageRel === "tsconfig.json"
    ) {
      files[packageRel] = file.bytes.toString("utf8");
    }
  }
  return files;
}

function storeRaw(rootDir: string, bytes: Buffer): string {
  return writeCas(join(rootDir, ".hone-cas"), bytes);
}

function paxPath(path: string): string {
  const body = `path=${path}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const record = `${length} ${body}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

describe("candidate optimizer CAS intake", () => {
  it("overlays changed/added/deleted src and assets deterministically onto the full captured base", async () => {
    const home = root();
    const files = basePackageFiles();
    files["src/main.ts"] = `${files["src/main.ts"] ?? ""}\n// selected candidate\n`;
    delete files["src/deferred.ts"];
    files["src/new-search.ts"] = "export const candidateSearch = 1;\n";
    files["assets/new-policy.txt"] = "candidate policy\n";
    const artifactHash = tarToCas(home, files);

    const first = await resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE });
    const second = await resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE });

    expect(first.baseDigest).toBe(computeOptimizerDigest(FIX_IMAGE));
    expect(first.mergedDigest).toBe(snapshotDigest(FIX_IMAGE, first.snapshot));
    expect(second.mergedDigest).toBe(first.mergedDigest);
    expect(second.mutablePaths).toEqual(first.mutablePaths);
    expect(first.snapshot.files.has("optimizer/src/deferred.ts")).toBe(false);
    expect(first.snapshot.files.get("optimizer/src/new-search.ts")?.bytes.toString("utf8")).toContain("candidateSearch");
    expect(first.snapshot.files.get("optimizer/assets/new-policy.txt")?.mode).toBe(0o644);
    expect(first.snapshot.files.get("schema/src/index.ts")?.bytes).toEqual(collectOptimizerSnapshot().files.get("schema/src/index.ts")?.bytes);
    expect(first.mutablePaths["src/main.ts"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.mutablePaths["src/deferred.ts"]).toBeUndefined();
  });

  it.each([
    ["worker/mutate.ts", "// hostile worker\n", /mutates immutable file.*worker\/mutate\.ts/],
    ["package.json", "{}\n", /mutates immutable file.*package\.json/],
    ["schema/src/index.ts", "export {};\n", /outside src\/\*\*/],
  ])("refuses immutable package or dependency mutation at %s", async (path, content, error) => {
    const home = root();
    const files = basePackageFiles();
    files[path] = content;
    const artifactHash = tarToCas(home, files);
    await expect(resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE })).rejects.toThrow(error);
  });

  it("refuses a candidate without src/main.ts", async () => {
    const home = root();
    const files = basePackageFiles();
    delete files["src/main.ts"];
    const artifactHash = tarToCas(home, files);
    await expect(resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE })).rejects.toThrow(/missing required src\/main\.ts/);
  });

  it.each([
    ["traversal", [{ name: "workspace/", type: "5" }, { name: "workspace/../escape", content: "x" }], /traversal|path/],
    ["symlink", [{ name: "workspace/", type: "5" }, { name: "workspace/src", type: "2", linkname: "/etc" }], /symlink|unsupported entry type/],
    ["device", [{ name: "workspace/", type: "5" }, { name: "workspace/dev", type: "3" }], /device|unsupported entry type/],
    ["duplicate", [{ name: "workspace/", type: "5" }, { name: "workspace/src/main.ts", content: "a" }, { name: "workspace/src/main.ts", content: "b" }], /duplicate/],
  ])("refuses %s tar structure before candidate merge", async (_label, entries, error) => {
    const home = root();
    const artifactHash = storeRaw(home, buildTar(entries));
    await expect(resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE })).rejects.toThrow(error);
  });

  it.each([
    [
      "case-only files",
      [
        { name: "workspace/", type: "5" },
        { name: "workspace/src/Foo.ts", content: "a" },
        { name: "workspace/src/foo.ts", content: "b" },
      ],
    ],
    [
      "Unicode normalization-equivalent files",
      [
        { name: "workspace/", type: "5" },
        { name: "workspace/src/caf\u00e9.ts", content: "a" },
        { name: "workspace/src/cafe\u0301.ts", content: "b" },
      ],
    ],
    [
      "Unicode case-fold-equivalent files",
      [
        { name: "workspace/", type: "5" },
        { name: "workspace/src/stra\u00dfe.ts", content: "a" },
        { name: "workspace/src/STRASSE.ts", content: "b" },
      ],
    ],
    [
      "case-fold ancestor/type collisions",
      [
        { name: "workspace/", type: "5" },
        { name: "workspace/src/Policy", content: "file" },
        { name: "workspace/src/policy/main.ts", content: "child" },
      ],
    ],
    [
      "case-fold directory/type collisions",
      [
        { name: "workspace/", type: "5" },
        { name: "workspace/src/Rules/", type: "5" },
        { name: "workspace/src/rules", content: "file" },
      ],
    ],
    [
      "pax-overridden case collisions",
      [
        { name: "PaxHeader", type: "x", content: paxPath("workspace/src/PaxName.ts") },
        { name: "placeholder-a", content: "a" },
        { name: "PaxHeader", type: "x", content: paxPath("workspace/src/paxname.ts") },
        { name: "placeholder-b", content: "b" },
        { name: "workspace/", type: "5" },
      ],
    ],
  ] as const)("refuses %s before extraction on every host", async (_label, entries) => {
    const home = root();
    const artifactHash = storeRaw(home, buildTar([...entries]));
    await expect(
      resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE }),
    ).rejects.toThrow(/portable .*collision/);
  });

  it("applies the per-file and entry-count bounds before extraction", async () => {
    const oversizedRoot = root();
    const oversized = buildTar([
      { name: "workspace/", type: "5" },
      { name: "workspace/src/main.ts", content: "x".repeat(MAX_CANDIDATE_OPTIMIZER_FILE_BYTES + 1) },
    ]);
    const oversizedHash = storeRaw(oversizedRoot, oversized);
    await expect(resolveCandidateOptimizer({ casDir: join(oversizedRoot, ".hone-cas"), artifactHash: oversizedHash, image: FIX_IMAGE })).rejects.toThrow(/file larger/);

    const countRoot = root();
    const entries: RawTarEntry[] = [{ name: "workspace/", type: "5" }];
    for (let i = 0; i < MAX_CANDIDATE_OPTIMIZER_ENTRIES; i += 1) entries.push({ name: `workspace/f${i}`, content: "" });
    const countHash = storeRaw(countRoot, buildTar(entries));
    await expect(resolveCandidateOptimizer({ casDir: join(countRoot, ".hone-cas"), artifactHash: countHash, image: FIX_IMAGE })).rejects.toThrow(/exceeds 2048 entries/);
  });

  it("refuses missing and content-mismatched CAS bytes", async () => {
    const home = root();
    await expect(resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash: fakeHash("1"), image: FIX_IMAGE })).rejects.toThrow(/missing from CAS/);

    const requested = fakeHash("2");
    const path = casPath(join(home, ".hone-cas"), requested);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, buildTar([{ name: "workspace/", type: "5" }]));
    await expect(resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash: requested, image: FIX_IMAGE })).rejects.toThrow(/CAS hash mismatch/);
  });

  it("stages only captured merged bytes even if the source CAS path drifts later", async () => {
    const home = root();
    const files = basePackageFiles();
    files["src/main.ts"] = "export const captured = 'before';\n";
    const artifactHash = tarToCas(home, files);
    const resolved = await resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE });

    const path = casPath(join(home, ".hone-cas"), artifactHash);
    writeFileSync(path, Buffer.from("replaced after capture", "utf8"));
    const stage = join(home, "stage");
    writeOptimizerStaging(resolved.snapshot, stage);
    expect(readFileSync(join(stage, "optimizer", "src", "main.ts"), "utf8")).toBe("export const captured = 'before';\n");
  });
});

describe("candidate optimizer selection seal and resume", () => {
  it("publishes an atomic owner-only seal and authenticates the exact receipt", async () => {
    const home = root();
    const runDir = join(home, ".hone-runs", "run_artifact");
    mkdirSync(runDir, { recursive: true });
    const artifactHash = tarToCas(home, basePackageFiles());
    const resolved = await resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE });

    const seal = writeOptimizerArtifactSeal(runDir, "run_artifact", resolved);
    expect(statSync(join(runDir, OPTIMIZER_ARTIFACT_SEAL_FILE)).mode & 0o777).toBe(0o600);
    expect(readOptimizerArtifactSeal(runDir)).toEqual(seal);
    expect(readdirSync(runDir)).toEqual([OPTIMIZER_ARTIFACT_SEAL_FILE]);
    expect(() => assertOptimizerArtifactSeal(runDir, seal)).not.toThrow();
    expect(() => writeOptimizerArtifactSeal(runDir, "run_artifact", resolved)).toThrow(/already exists/);
  });

  it("reuses the sealed artifact without a flag or with an equal restatement, and refuses conflict or missing bytes", async () => {
    const home = root();
    const runId = "run_resume_artifact";
    const runDir = join(home, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactHash = tarToCas(home, basePackageFiles());
    const resolved = await resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE });
    writeOptimizerArtifactSeal(runDir, runId, resolved);

    const implicit = await resolveSealedCandidateOptimizer({ runDir, runId, casDir: join(home, ".hone-cas"), image: FIX_IMAGE });
    const explicit = await resolveSealedCandidateOptimizer({ runDir, runId, artifactHash, casDir: join(home, ".hone-cas"), image: FIX_IMAGE });
    expect(implicit?.mergedDigest).toBe(resolved.mergedDigest);
    expect(explicit?.mutablePaths).toEqual(resolved.mutablePaths);
    await expect(resolveSealedCandidateOptimizer({ runDir, runId, artifactHash: fakeHash("f"), casDir: join(home, ".hone-cas"), image: FIX_IMAGE })).rejects.toThrow(/conflicts/);

    rmSync(casPath(join(home, ".hone-cas"), artifactHash));
    await expect(resolveSealedCandidateOptimizer({ runDir, runId, casDir: join(home, ".hone-cas"), image: FIX_IMAGE })).rejects.toThrow(/missing from CAS/);
  });

  it("uses an exact supplied base on fresh and resume without touching repoRoot, and verifies its sealed digest", async () => {
    const home = root();
    const runId = "run_captured_base";
    const runDir = join(home, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactHash = tarToCas(home, basePackageFiles());
    const baseSnapshot = collectOptimizerSnapshot();
    const unreachableRepoRoot = join(home, "repo-root-must-not-be-read");
    const resolved = await resolveCandidateOptimizer({
      casDir: join(home, ".hone-cas"),
      artifactHash,
      image: FIX_IMAGE,
      repoRoot: unreachableRepoRoot,
      baseSnapshot,
    });
    writeOptimizerArtifactSeal(runDir, runId, resolved);

    const resumed = await resolveSealedCandidateOptimizer({
      runDir,
      runId,
      casDir: join(home, ".hone-cas"),
      image: FIX_IMAGE,
      repoRoot: unreachableRepoRoot,
      baseSnapshot,
    });
    expect(resumed?.baseDigest).toBe(snapshotDigest(FIX_IMAGE, baseSnapshot));

    const drifted = { files: new Map(baseSnapshot.files) };
    const schemaEntry = drifted.files.get("schema/src/index.ts");
    if (schemaEntry === undefined) throw new Error("fixture optimizer closure has no schema/src/index.ts");
    drifted.files.set("schema/src/index.ts", { ...schemaEntry, bytes: Buffer.from("export {};\n") });
    await expect(resolveSealedCandidateOptimizer({
      runDir,
      runId,
      casDir: join(home, ".hone-cas"),
      image: FIX_IMAGE,
      repoRoot: unreachableRepoRoot,
      baseSnapshot: drifted,
    })).rejects.toThrow(/base optimizer drift/);
  });

  it("refuses base-digest drift and non-owner-only seal permissions", async () => {
    const home = root();
    const runId = "run_resume_drift";
    const runDir = join(home, ".hone-runs", runId);
    mkdirSync(runDir, { recursive: true });
    const artifactHash = tarToCas(home, basePackageFiles());
    const resolved = await resolveCandidateOptimizer({ casDir: join(home, ".hone-cas"), artifactHash, image: FIX_IMAGE });
    writeOptimizerArtifactSeal(runDir, runId, { ...resolved, baseDigest: fakeHash("d") });
    await expect(resolveSealedCandidateOptimizer({ runDir, runId, casDir: join(home, ".hone-cas"), image: FIX_IMAGE })).rejects.toThrow(/base optimizer drift/);

    chmodSync(join(runDir, OPTIMIZER_ARTIFACT_SEAL_FILE), 0o644);
    expect(() => readOptimizerArtifactSeal(runDir)).toThrow(/inaccessible to group\/other/);
  });

  it("refuses an artifact flag when resuming a default run", async () => {
    const home = root();
    const runDir = join(home, ".hone-runs", "run_default");
    mkdirSync(runDir, { recursive: true });
    await expect(resolveSealedCandidateOptimizer({ runDir, runId: "run_default", artifactHash: fakeHash("a"), casDir: join(home, ".hone-cas"), image: FIX_IMAGE })).rejects.toBeInstanceOf(UsageError);
  });

  it("leaves the default optimizer digest unchanged", () => {
    expect(snapshotDigest(FIX_IMAGE, collectOptimizerSnapshot(repoRootFromHere()))).toBe(computeOptimizerDigest(FIX_IMAGE));
  });
});
