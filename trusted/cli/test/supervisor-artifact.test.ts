import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { casPath } from "../src/cas.js";
import { OPTIMIZER_ARTIFACT_SEAL_FILE, readOptimizerArtifactSeal } from "../src/optimizer-artifact.js";
import { collectOptimizerSnapshot } from "../src/optimizer-digest.js";
import { readEvents } from "../src/eventlog.js";
import { runCommand } from "../src/supervisor.js";
import { fakeHash, FIX_IMAGE, makeCapsule, makeIo, makeRoot, tarToCas } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testRoot(): string {
  const root = makeRoot();
  roots.push(root);
  return root;
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

describe("run --optimizer-artifact", () => {
  it("refuses HONE_OPTIMIZER_CMD before minting run state", async () => {
    const root = testRoot();
    makeCapsule(root, { image: FIX_IMAGE });
    const { io } = makeIo(root, { HONE_OPTIMIZER_CMD: "node /unsealed.mjs", HONE_OPTIMIZER_DIGEST: fakeHash("9") });
    await expect(
      runCommand(["capsule", "--headless", "--backend", "stub", "--optimizer-artifact", fakeHash("8")], io),
    ).rejects.toThrow(/cannot be combined with HONE_OPTIMIZER_CMD/);
    expect(readdirSync(root)).not.toContain(".hone-runs");
  });

  it("seals a new selection, resumes it exactly, and refuses conflict or missing source bytes before appending", async () => {
    const root = testRoot();
    makeCapsule(root, { image: FIX_IMAGE });
    const files = basePackageFiles();
    files["src/main.ts"] = `${files["src/main.ts"] ?? ""}\n// supervisor-selected\n`;
    const artifactHash = tarToCas(root, files);
    const backend = join(root, "unfinished-backend.mjs");
    writeFileSync(
      backend,
      "export default { async start(ctx) { if (!ctx.optimizerSnapshot) throw new Error('candidate snapshot missing'); ctx.registerCleanupBarrier(Promise.reject(new Error('intentional unfinished run'))); } };\n",
    );
    const captured = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "0" });

    expect(await runCommand(["capsule", "--headless", "--backend", "./unfinished-backend.mjs", "--optimizer-artifact", artifactHash], captured.io)).toBe(1);
    const runNames = readdirSync(join(root, ".hone-runs"));
    expect(runNames).toHaveLength(1);
    const runDir = join(root, ".hone-runs", runNames[0] ?? "");
    const seal = readOptimizerArtifactSeal(runDir);
    expect(seal?.sourceArtifact).toBe(artifactHash);
    expect(seal?.mergedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(runDir, OPTIMIZER_ARTIFACT_SEAL_FILE), "utf8")).toContain(artifactHash);

    expect(await runCommand(["capsule", "--headless", "--resume", "--optimizer-artifact", artifactHash], captured.io)).toBe(1);
    expect(await runCommand(["capsule", "--headless", "--resume"], captured.io)).toBe(1);
    const afterExact = readEvents(runDir);
    expect(afterExact.filter((event) => event.type === "run.resumed")).toHaveLength(2);

    await expect(
      runCommand(["capsule", "--headless", "--resume", "--optimizer-artifact", fakeHash("f")], captured.io),
    ).rejects.toThrow(/conflicts with the run's sealed optimizer artifact/);
    expect(readEvents(runDir)).toHaveLength(afterExact.length);

    rmSync(casPath(join(root, ".hone-cas"), artifactHash));
    await expect(runCommand(["capsule", "--headless", "--resume"], captured.io)).rejects.toThrow(/missing from CAS/);
    expect(readEvents(runDir)).toHaveLength(afterExact.length);
  });

  it("threads one supplied campaign base through candidate fresh/resume and verifies its sealed digest", async () => {
    const root = testRoot();
    makeCapsule(root, { image: FIX_IMAGE });
    const artifactHash = tarToCas(root, basePackageFiles());
    const captured = collectOptimizerSnapshot();
    const capturedFiles = new Map(captured.files);
    const main = capturedFiles.get("optimizer/src/main.ts");
    if (main === undefined) throw new Error("optimizer fixture has no main.ts");
    const marker = "export const campaignBaseSnapshot = 'captured-once';\n";
    capturedFiles.set("optimizer/src/main.ts", { ...main, bytes: Buffer.from(marker) });
    const optimizerBaseSnapshot = { files: capturedFiles };
    const backend = join(root, "base-observer.mjs");
    writeFileSync(
      backend,
      `export default { async start(ctx) {
        const base = ctx.optimizerBaseSnapshot?.files.get("optimizer/src/main.ts")?.bytes.toString("utf8");
        if (base !== ${JSON.stringify(marker)}) throw new Error("campaign base snapshot missing or recollected");
        if (!ctx.optimizerSnapshot) throw new Error("candidate merged snapshot missing");
        ctx.registerCleanupBarrier(Promise.reject(new Error("intentional unfinished run")));
      } };\n`,
    );
    const capturedIo = makeIo(root, { HONE_UNSAFE_BACKEND: "1", HONE_KILL_GRACE_MS: "0" });
    const trusted = { optimizerBaseSnapshot };

    expect(await runCommand(
      ["capsule", "--headless", "--backend", "./base-observer.mjs", "--optimizer-artifact", artifactHash],
      capturedIo.io,
      trusted,
    )).toBe(1);
    expect(await runCommand(
      ["capsule", "--headless", "--resume", "--optimizer-artifact", artifactHash],
      capturedIo.io,
      trusted,
    )).toBe(1);
    await expect(
      runCommand(["capsule", "--headless", "--resume", "--optimizer-artifact", artifactHash], capturedIo.io),
    ).rejects.toThrow(/base optimizer drift/);
  });
});
