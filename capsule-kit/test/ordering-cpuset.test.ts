import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Broker, CasStore, operatorSandboxCpuset, packDirAsArtifact, runCommand } from "@hone/broker";
import type { CmdResult, RunCommand } from "@hone/broker";
import { capsuleDigest } from "@hone/schema";
import { loadCapsuleConfig, orderingBrokerResources, provisionalManifest } from "../tools/ordering-check.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function launches(env: NodeJS.ProcessEnv, commands: string[][] = []): Promise<string[][]> {
  const root = mkdtempSync(join(tmpdir(), "ordering-cpuset-"));
  dirs.push(root);
  for (const dir of ["baseline", "assets/train", "assets/validation"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "baseline/eval.py"), "pass\n");
  writeFileSync(join(root, "assets/train/a.json"), "{}\n");
  writeFileSync(join(root, "assets/validation/b.json"), "{}\n");
  writeFileSync(join(root, "capsule.config.json"), JSON.stringify({
    objective: "placement fixture", image: `hone-fixture@sha256:${"b".repeat(64)}`,
    evalEntrypoint: ["python3", "eval.py"], evalPhases: ["encode", "decode"], protectedPaths: ["eval.py"],
    assetGroups: [{ id: "train", visibility: "public", paths: ["assets/train"] },
      { id: "validation", visibility: "protected", paths: ["assets/validation"] }],
    budget: { maxTokens: 1000, maxUsd: 1, maxWallClockSec: 7200, maxEvaluatorInvocations: 10 },
    diagnosticOrdering: { path: "diagnostics/ordering-report.json" },
  }));
  const casDir = join(root, "cas"), cas = new CasStore(casDir);
  const hash = await packDirAsArtifact(join(root, "baseline"), cas);
  const manifest = provisionalManifest(loadCapsuleConfig(root), hash, [
    { id: "train", visibility: "public", paths: ["assets/train/a.json"] },
    { id: "validation", visibility: "protected", paths: ["assets/validation/b.json"] },
  ], root);
  const ok = (stdout = ""): CmdResult => ({ exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, truncated: false });
  const docker: RunCommand = async (argv, opts) => {
    commands.push([...argv]);
    if (argv[0] !== "docker") return runCommand(argv, opts);
    if (argv[1] === "run" && argv.includes("-d")) return ok("keeper\n");
    if (argv[1] === "run" && argv.includes("HONE_EVAL_PHASE=encode")) {
      const mount = argv.find(arg => arg.endsWith(":/capsule/handoff:rw"))!;
      writeFileSync(join(mount.split(":")[0]!, "archive.bin"), "archive");
      return ok(JSON.stringify({ honeEvalContinue: "decode" }));
    }
    if (argv[1] === "run") return ok(JSON.stringify({ valid: true, objectives: { score: 1 } }));
    return ok();
  };
  const broker = new Broker({
    runId: "ordering-placement", manifest, capsuleRootDir: root, baselineArtifactHash: hash,
    admittedCapsuleDigest: capsuleDigest(manifest), optimizerDigest: `sha256:${"c".repeat(64)}`,
    holdoutLedgerPath: join(root, "holdout.ndjson"), runDir: join(root, "run"), casDir,
    executionImage: manifest.image, onEvent: () => {}, runCommand: docker,
    ...orderingBrokerResources(manifest, operatorSandboxCpuset(env)),
  });
  try {
    await broker.init();
    await broker.evaluate({ artifact: { hash }, assetGroupId: "train", seed: 0 }, { privileged: true });
  } finally { await broker.close(); }
  return commands.filter(argv => argv[0] === "docker" && argv[1] === "run");
}

describe("ordering operator CPU placement", () => {
  it("pins both fresh evaluator phases with exactly one cpuset pair", async () => {
    const runs = await launches({ HONE_SANDBOX_CPUSET: "1-4" });
    expect(runs.map(argv => argv.find(arg => arg.startsWith("HONE_EVAL_PHASE="))))
      .toEqual(["HONE_EVAL_PHASE=encode", "HONE_EVAL_PHASE=decode"]);
    for (const argv of runs) {
      expect(argv.filter(arg => arg === "--cpuset-cpus")).toEqual(["--cpuset-cpus"]);
      expect(argv[argv.indexOf("--cpuset-cpus") + 1]).toBe("1-4");
    }
  });

  it("leaves both evaluator phases unpinned when operator placement is unset", async () => {
    const runs = await launches({});
    expect(runs.map(argv => argv.find(arg => arg.startsWith("HONE_EVAL_PHASE="))))
      .toEqual(["HONE_EVAL_PHASE=encode", "HONE_EVAL_PHASE=decode"]);
    for (const argv of runs) expect(argv).not.toContain("--cpuset-cpus");
  });

  it.each(["1-4; --privileged", "4-1"])("rejects invalid operator placement %s before Docker", async cpuset => {
    const commands: string[][] = [];
    await expect(launches({ HONE_SANDBOX_CPUSET: cpuset }, commands)).rejects.toThrow("cpuset list");
    expect(commands).toEqual([]);
  });
});
