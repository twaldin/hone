/**
 * A-A probe for the tree-sitter-parse capsule: run N baseline-variant evals
 * through the SAME trusted broker path as ordering-check and print each
 * eval's score/raw_q/reference_q, to measure the estimator's A-A spread
 * cheaply before spending full ordering passes. Trusted admission-side
 * debugging tool only; never optimizer-facing.
 *
 * Usage: npx tsx .campaign/round7/ts-aa-probe.mts <variant> <split> <reps>
 */
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Broker,
  CasStore,
  packDirAsArtifact,
  runCommand,
  type CallContext,
  type RunCommand,
} from "@hone/broker";
import { CapsuleManifest, SCHEMA_VERSION, capsuleDigest, deriveCapsuleId } from "@hone/schema";

const CAPSULE_DIR = resolve("capsules/tree-sitter-parse");
const TMP_ROOT = resolve("tmp");
const variant = process.argv[2] ?? "baseline";
const split = process.argv[3] ?? "train";
const reps = Number.parseInt(process.argv[4] ?? "3", 10);

const SKIP: Record<string, true> = { ".git": true, ".gitdir": true, __pycache__: true, ".pytest_cache": true };

function walkFiles(root: string, rel: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel)).sort()) {
    const relPath = `${rel}/${entry}`;
    const st = statSync(join(root, relPath));
    if (st.isDirectory()) out.push(...walkFiles(root, relPath));
    else if (st.isFile()) out.push(relPath);
  }
  return out;
}

function composeArtifact(v: string): string {
  const artifact = mkdtempSync(join(tmpdir(), `hone-tsp-${v}-`));
  for (const entry of readdirSync(join(CAPSULE_DIR, "baseline"))) {
    if (SKIP[entry]) continue;
    cpSync(join(CAPSULE_DIR, "baseline", entry), join(artifact, entry), { recursive: true });
  }
  if (v !== "baseline") {
    for (const entry of readdirSync(join(CAPSULE_DIR, "diagnostics", v))) {
      cpSync(join(CAPSULE_DIR, "diagnostics", v, entry), join(artifact, entry), { recursive: true });
    }
  }
  return artifact;
}

const TRUSTED_CTX: CallContext = { privileged: true };
const ORDERING_TOOL_DIGEST = `sha256:${createHash("sha256")
  .update("hone ordering-check: trusted admission tool (no optimizer)")
  .digest("hex")}`;

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(join(CAPSULE_DIR, "capsule.config.json"), "utf8"));
  const groups = (config.assetGroups as { id: string; visibility: string; paths: string[] }[])
    .filter((g) => g.id === "train" || g.id === "validation")
    .map((g) => ({
      ...g,
      paths: g.paths.flatMap((p) => walkFiles(CAPSULE_DIR, p)),
    }));

  mkdirSync(TMP_ROOT, { recursive: true });
  const tempRoot = mkdtempSync(join(TMP_ROOT, "ts-aa-probe-"));
  const runId = `tsaa-${randomBytes(4).toString("hex")}`;
  const guardedRun: RunCommand = (argv, opts) => {
    const head = argv[0] ?? "";
    if (head !== "docker" && head !== "tar") {
      return Promise.reject(new Error(`blocked host command: ${argv.join(" ")}`));
    }
    return runCommand(argv, opts);
  };

  let broker: Broker | undefined;
  try {
    const casDir = join(tempRoot, "cas");
    const cas = new CasStore(casDir);
    const baselineHash = await packDirAsArtifact(join(CAPSULE_DIR, "baseline"), cas);
    const contentHashes: Record<string, string> = {};
    for (const group of groups) {
      for (const rel of group.paths) {
        contentHashes[rel] = `sha256:${createHash("sha256").update(readFileSync(join(CAPSULE_DIR, rel))).digest("hex")}`;
      }
    }
    const sansId: Record<string, unknown> = {
      schemaVersion: SCHEMA_VERSION,
      objective: config.objective,
      baseline: { kind: "cas", hash: baselineHash },
      image: config.image,
      evalEntrypoint: config.evalEntrypoint,
      protectedPaths: config.protectedPaths ?? [],
      assetGroups: groups,
      budget: config.budget,
      ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
      diagnosticOrdering: {
        path: config.diagnosticOrdering.path,
        hash: `sha256:${createHash("sha256").update("hone ordering-check: provisional diagnosticOrdering placeholder").digest("hex")}`,
      },
      contentHashes,
    };
    const manifest = CapsuleManifest.parse({ ...sansId, id: deriveCapsuleId(sansId) });
    broker = new Broker({
      runId,
      manifest,
      capsuleRootDir: CAPSULE_DIR,
      baselineArtifactHash: baselineHash,
      capsuleDigest: capsuleDigest(manifest),
      optimizerDigest: ORDERING_TOOL_DIGEST,
      holdoutLedgerPath: join(tempRoot, "holdout-ledger.ndjson"),
      holdoutBudget: reps * 2 + 2,
      ...(config.sandbox === undefined
        ? {}
        : {
            sandboxMemoryBytes: config.sandbox.memoryBytes,
            ...(config.sandbox.cpus === undefined ? {} : { sandboxCpus: config.sandbox.cpus }),
          }),
      image: manifest.image,
      runDir: join(tempRoot, "run"),
      casDir,
      onEvent: () => {},
      runCommand: guardedRun,
    });
    await broker.init();

    const artifactDir = composeArtifact(variant);
    let hash: string;
    try {
      hash = await packDirAsArtifact(artifactDir, cas);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }

    for (let i = 0; i < reps; i += 1) {
      const seed = 4200 + i;
      const started = Date.now();
      const record = await broker.evaluate({ artifact: { hash }, assetGroupId: split, seed }, TRUSTED_CTX);
      const out = record.output as {
        valid: boolean;
        objectives: Record<string, number>;
        diagnostics?: Record<string, unknown>;
        perExample?: Record<string, { score: number; feedback?: string }>;
      };
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const d = out.diagnostics ?? {};
      console.log(
        `probe ${variant}/${split} rep ${i}: valid=${out.valid} score=${out.objectives?.score} ` +
          `raw_q=${(d as Record<string, unknown>).raw_q} reference_q=${(d as Record<string, unknown>).reference_q} ` +
          `eval_sec=${(d as Record<string, unknown>).eval_sec} wall=${secs}s cached=${record.cached}`,
      );
      if (!out.valid) {
        console.log("feedback:", JSON.stringify(out.perExample ?? {}, null, 1));
      }
    }
  } finally {
    if (broker !== undefined) {
      try {
        await broker.close();
      } catch (err) {
        console.error("broker close failed:", String(err));
      }
    }
    const ps = await runCommand(["docker", "ps", "-aq", "--filter", `label=hone.runId=${runId}`]);
    for (const id of String(ps.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) {
      await runCommand(["docker", "rm", "-f", id]);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
