#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest, capsuleDigest, type EvaluatorOutput } from "@hone/schema";
import {
  CasStore,
  packDirAsArtifact,
  runCommand,
  startBroker,
  type CmdOptions,
  type CmdResult,
  type RunCommand,
} from "@hone/broker";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CAMPAIGN = "data/m2-refreeze/campaign-frozen.json";
const DEFAULT_CONFIG = "data/m2-refreeze/terminal-authority-preflight.config.json";
const DEFAULT_OUTPUT = "tmp/m2-terminal-authority-preflight.evidence.v1.json";
const SYNTHETIC_GROUP_ID = "synthetic-terminal-preflight";
const WORKER_UID_MIN = 20_000;
const MAX_DIAGNOSTIC_CHARS = 16_384;
const OPERATOR_CONTAMINATION_DISCLOSURE = {
  incident: "During schema discovery, an operator-side repository grep was accidentally scoped across the Floyd capsule before assets/ was excluded.",
  observedLocations: [
    "capsules/floyd-custom-scoreboard-render/assets/validation/~reference/renderer.py:128",
    "capsules/floyd-custom-scoreboard-render/assets/validation/~reference/renderer.py:129",
    "capsules/floyd-custom-scoreboard-render/assets/validation/~reference/renderer.py:130",
    "capsules/floyd-custom-scoreboard-render/assets/validation/~reference/renderer.py:131",
  ],
  boundedEffect: "The four displayed renderer source lines were not copied, hashed, seeded into, or checked against any synthetic probe. The gate run itself mounts only generated assets and records that mount table.",
};

type Args = {
  campaign: string;
  config: string;
  output: string;
  negativeProbe?: string;
};

type ProbeDefinition = {
  frozenCapsuleId: string;
  label: string;
  generator: string;
  schema: string;
};

type ProbeConfig = {
  schemaVersion: number;
  campaign: string;
  synthetic: true;
  derivedFromHoldout: false;
  assetGroupId: string;
  capsules: ProbeDefinition[];
};

type MountEvidence = {
  observed: boolean;
  containerName?: string;
  appArmorProfile?: string;
  networkMode?: string;
  mounts: Array<{ type: string; source: string; destination: string; mode: string; rw: boolean }>;
  holdoutOrCapsuleAssetMounts: string[];
  syntheticAssetsMountedReadOnly: boolean;
  workspaceMountedReadOnly: boolean;
  baselineMountedReadOnly: boolean;
};

type CommandRecord = {
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
};

function usage(): string {
  return [
    "usage: bun capsules/tools/preflight-m2-terminal-authority.mts",
    "  [--campaign PATH] [--config PATH] [--output PATH]",
    "  [--negative-probe CAPSULE_LABEL]",
    "",
    "Runs the frozen terminal cohort through the real trusted Broker staging and",
    "Docker evaluator path using generated synthetic assets only. The probe score",
    "is structural evidence, is always marked meaningless, and is never a campaign",
    "measurement. --negative-probe corrupts the named generated probe after creation",
    "to prove that evaluator failure is reported fail-closed.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = { campaign: DEFAULT_CAMPAIGN, config: DEFAULT_CONFIG, output: DEFAULT_OUTPUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[index + 1];
    if (arg === "--campaign" || arg === "--config" || arg === "--output" || arg === "--negative-probe") {
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--campaign") parsed.campaign = value;
      if (arg === "--config") parsed.config = value;
      if (arg === "--output") parsed.output = value;
      if (arg === "--negative-probe") parsed.negativeProbe = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function repoPath(input: string, label: string): string {
  const path = resolve(REPO_ROOT, input);
  if (path !== REPO_ROOT && !path.startsWith(`${REPO_ROOT}${sep}`)) throw new Error(`${label} escapes repository root`);
  return path;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function bounded(value: unknown): string {
  const text = value instanceof Error ? value.stack ?? value.message : String(value);
  return text.length <= MAX_DIAGNOSTIC_CHARS ? text : text.slice(text.length - MAX_DIAGNOSTIC_CHARS);
}

function fileInventory(root: string): string[] {
  const output: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const rel = relative(root, absolute).split(sep).join("/");
      const stat = statSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) output.push(rel);
      else throw new Error(`synthetic generator produced non-regular entry: ${rel}`);
    }
  };
  walk(root);
  return output;
}

function writeProbeFile(root: string, rel: string, content: Buffer | string, executable = false): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}

function runGeneratorPython(source: string, argv: string[]): void {
  const result = spawnSync("python3", ["-c", source, ...argv], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`synthetic generator Python failed: ${(result.stderr || result.stdout).trim()}`);
}

function generateBrotli(root: string): void {
  const entropy = Buffer.concat(Array.from({ length: 128 }, (_, index) =>
    createHash("sha256").update(`synthetic-terminal-preflight:${index}`).digest()
  ));
  const payloads: Record<string, Buffer> = {
    binary: entropy,
    text: Buffer.from(entropy.toString("base64")),
    web: Buffer.from(`<main data-synthetic='true'><!--${entropy.toString("hex")}--></main>\n`),
  };
  const workloads = Object.entries(payloads).map(([id, bytes]) => {
    const path = `${id}.bin`;
    writeProbeFile(root, path, bytes);
    return {
      id,
      path,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      expectedCompressedBytes: { "4": bytes.length * 2, "9": bytes.length * 2 },
    };
  });
  writeProbeFile(root, "workloads.json", `${JSON.stringify({ generator: "synthetic-terminal-preflight", seed: 0, workloads })}\n`);
}

function generateMimalloc(root: string): void {
  const ids = ["single", "multithread", "small", "fragmentation"];
  const workloads = ids.map((id, index) => ({
    id,
    seed: index + 1,
    rounds: 1,
    threads: id === "multithread" ? 4 : 1,
    expectedOperations: 1,
    expectedChecksum: "0000000000000000",
    baselinePeakPageCommittedBytes: 2 ** 40,
    baselineTreePeakBytes: 2 ** 40,
    baselineFragmentationRatio: 1,
  }));
  writeProbeFile(root, "workloads.json", `${JSON.stringify({ schemaVersion: 1, driverVersion: "mimalloc-four-v1", split: "synthetic", workloads })}\n`);
}

function generateDuckdb(root: string): void {
  // The host has no DuckDB authoring binary. A valid SQLite database exercises
  // staging and the evaluator's database-format refusal without consulting any
  // sealed bytes. This is intentionally a genuine FAIL until the capsule ships
  // a synthetic fixture constructor or accepts a format-only probe mode.
  const database = join(root, "sf1.duckdb");
  runGeneratorPython("import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute('create table lineitem(l_quantity integer)');c.execute('insert into lineitem values (1)');c.commit();c.close()", [database]);
  const query = "SELECT sum(l_quantity) FROM lineitem WHERE l_quantity > 0;\n";
  writeProbeFile(root, "query.sql", query);
  writeProbeFile(root, "oracle.sha256", `${"0".repeat(64)}\n`);
  const dbBytes = readFileSync(database);
  writeProbeFile(root, "workload.json", `${JSON.stringify({
    baselinePeakRssKb: 2 ** 30,
    database: "sf1.duckdb",
    databaseBytes: dbBytes.length,
    databaseSha256: sha256Bytes(dbBytes),
    kernel: "physical-filter",
    query: "query.sql",
    querySha256: sha256Bytes(query),
    revision: "117e1a46be1c903c5a36ee3c881c125597f93c60",
    threads: 1,
    variant: "filter-validation",
  })}\n`);
}

function generateQuickjs(root: string, baselineDir: string): void {
  const benchmark = "globalThis.__hone_job = function(job){ return {operations:job.iterations,fold:job.nonce}; };\n";
  const observable = "print('synthetic-observable');\n";
  const moduleLib = "export const value = 'synthetic-module';\n";
  const moduleMain = "import { value } from './module-lib.js'; print(value);\n";
  writeProbeFile(root, "benchmark.js", benchmark);
  writeProbeFile(root, "observable.js", observable);
  writeProbeFile(root, "module-lib.js", moduleLib);
  writeProbeFile(root, "module-main.js", moduleMain);
  const harnessAssert = "var assert={sameValue:function(a,b){if(a!==b)throw new Error('sameValue');}};\n";
  writeProbeFile(root, "test262/harness/assert.js", harnessAssert);
  const cases: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const rel = `test/synthetic/case-${index}.js`;
    cases.push(rel);
    writeProbeFile(root, `test262/${rel}`, `/*---\nincludes: [assert.js]\n---*/\nassert.sameValue(${index}, ${index});\n`);
  }
  const files: Record<string, string> = {};
  for (const rel of fileInventory(root)) files[rel] = sha256File(join(root, rel));
  const workload = {
    schemaVersion: 1,
    sourceRevision: "04be246001599f5995fa2f2d8c91a0f198d3f34c",
    test262Revision: "5c8206929d81b2d3d727ca6aac56c18358c8d790",
    split: "validation",
    microbenchmarks: [
      { name: "prop_update", iterations: 2_250_000, operations: 9_000_000 },
      { name: "typed_array_read", iterations: 1_050_000, operations: 10_500_000 },
      { name: "float_arith", iterations: 8_250, operations: 8_250_000 },
      { name: "regexp_utf16", iterations: 1_625, operations: 1_625_000 },
    ],
    moduleLaunchesPerRound: 31,
    moduleRounds: 3,
    baselineBinaryBytes: 1_051_952,
    binarySizeToleranceNumerator: 101,
    binarySizeToleranceDenominator: 100,
    observableExpected: "synthetic-observable\n",
    moduleExpected: "synthetic-module\n",
    test262Cases: cases,
    microbenchScriptSha256: sha256File(join(baselineDir, "tests", "microbench.js")),
    files,
  };
  writeProbeFile(root, "workload.json", `${JSON.stringify(workload)}\n`);
}

function generateHarness(root: string): void {
  const cases = [{
    id: "synthetic-readiness",
    input: { kind: "readiness", events: [{ pane: "starting\n" }, { pane: "provider /openai ready\n>\n" }] },
    expected: { verdicts: ["loading", "ready"] },
    weight: 1,
  }];
  writeProbeFile(root, "cases.json", `${JSON.stringify(cases)}\n`);
}

function generateFlt(root: string): void {
  const groups = ["legacy", "dag", "gate", "reference", "preset", "generated"];
  const cases = groups.map((group) => ({
    id: `synthetic-${group}`,
    group,
    input: `inputs/${group}.yaml`,
    presets: `presets/${group}.json`,
    expected: { ok: false, error: { name: "SyntheticExpectation", message: "synthetic probe", line: null, column: null }, canonical: null },
  }));
  for (const group of groups) {
    writeProbeFile(root, `inputs/${group}.yaml`, `name: synthetic-${group}\nsteps: []\n`);
    writeProbeFile(root, `presets/${group}.json`, "{}\n");
  }
  writeProbeFile(root, "cases.json", `${JSON.stringify({ version: 1, declared: cases.length, cases })}\n`);
}

function generateFloyd(root: string): void {
  writeProbeFile(root, "renderer.py", [
    "def render(value):",
    "    return {'synthetic': True, 'inputType': type(value).__name__}",
    "",
  ].join("\n"));
  const scene = { entries: [{ owner: "synthetic", value: 1, hidden: false }] };
  writeProbeFile(root, "cases.json", `${JSON.stringify([{
    id: "synthetic-scoreboard",
    input: scene,
    expected: { synthetic: true, inputType: "dict" },
  }])}\n`);
}

function generateTradeup(root: string, baselineDir: string): void {
  const database = join(root, "market.sqlite3");
  runGeneratorPython([
    "import sqlite3,sys",
    "c=sqlite3.connect(sys.argv[1])",
    "c.executescript('create table skins(id integer primary key,name text,rarity text,weapon text,min_float real,max_float real,stattrak integer);create table collections(id integer primary key,name text);create table skin_collections(skin_id integer,collection_id integer);create table listings(skin_id integer,price_cents integer,float_value real,stattrak integer);create table synthetic_padding(payload blob);')",
    "c.executemany('insert into collections values(?,?)',[(1,'Synthetic')])",
    "c.executemany('insert into skins values(?,?,?,?,?,?,?)',[(1,'Alpha','Mil-Spec','Rifle',0.0,1.0,0),(2,'Beta','Restricted','Pistol',0.0,1.0,0),(3,'Gamma','Covert','Knife',0.0,1.0,0)])",
    "c.executemany('insert into skin_collections values(?,1)',[(1,),(2,),(3,)])",
    "c.executemany('insert into listings values(?,?,?,0)',[(1,100,0.1),(1,110,0.2),(2,200,0.2),(3,300,0.3)])",
    "c.execute('insert into synthetic_padding values(zeroblob(33554432))')",
    "c.commit();c.close()",
  ].join("\n"), [database]);
  const baseRequest = { stattrak: false, rarity: "", collection: "", search: "", limit: 50, page: 1 };
  const requests = [
    { ...baseRequest, id: "all" },
    { ...baseRequest, id: "page", limit: 2 },
    { ...baseRequest, id: "covert", rarity: "Covert" },
    { ...baseRequest, id: "collection", collection: "Synthetic" },
    { ...baseRequest, id: "search", search: "a" },
    { ...baseRequest, id: "offset", limit: 1, page: 2 },
    { ...baseRequest, id: "stattrak", stattrak: true },
  ];
  const workload = { schema: "tradeup-skin-data-workload-v1", fixture: "synthetic-terminal-preflight", quality: { exact: true }, queries: requests };
  writeProbeFile(root, "workload.json", `${JSON.stringify(workload)}\n`);
  cpSync(join(baselineDir, "query.py"), join(root, "reference.py"));
  const provenance = { synthetic: true, derivedFromHoldout: false, source: "terminal-authority-preflight generator" };
  writeProbeFile(root, "provenance.json", `${JSON.stringify(provenance)}\n`);
  const worker = spawnSync("python3", ["-B", join(baselineDir, "worker.py"), join(root, "reference.py"), database, join(root, "workload.json")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (worker.status !== 0) throw new Error(`synthetic tradeup reference failed: ${worker.stderr.trim()}`);
  const response = JSON.parse(worker.stdout).result;
  const responseQualityHash = sha256Bytes(Buffer.from(canonical({ response, quality: workload.quality })));
  const oracle = {
    fixture: workload.fixture,
    databaseSha256: sha256File(database),
    workloadSha256: sha256File(join(root, "workload.json")),
    referenceSha256: sha256File(join(root, "reference.py")),
    provenanceSha256: sha256File(join(root, "provenance.json")),
    responseQualityHash,
  };
  writeProbeFile(root, "oracle.json", `${JSON.stringify(oracle)}\n`);
}

function generateProbe(definition: ProbeDefinition, root: string, baselineDir: string): void {
  switch (definition.generator) {
    case "brotli-three-corpus-minimal": generateBrotli(root); break;
    case "mimalloc-four-v1-minimal": generateMimalloc(root); break;
    case "duckdb-physical-filter-minimal": generateDuckdb(root); break;
    case "quickjs-workload-v1-minimal": generateQuickjs(root, baselineDir); break;
    case "harness-readiness-minimal": generateHarness(root); break;
    case "flt-six-group-minimal": generateFlt(root); break;
    case "scoreboard-scene-minimal": generateFloyd(root); break;
    case "tradeup-sqlite-minimal": generateTradeup(root, baselineDir); break;
    default: throw new Error(`unknown synthetic generator: ${definition.generator}`);
  }
}

function mutateProbe(definition: ProbeDefinition, root: string): string {
  if (definition.label === "harness-pi-readiness") {
    writeProbeFile(root, "cases.json", "{}\n");
    return "replaced the generated cases array with an object; evaluator must refuse malformed synthetic input";
  }
  const first = fileInventory(root)[0];
  if (!first) throw new Error("cannot mutate empty probe");
  writeProbeFile(root, first, Buffer.alloc(0));
  return `emptied generated file ${first}; evaluator must refuse the corrupted synthetic input`;
}

function probeManifest(original: CapsuleManifest, root: string): CapsuleManifest {
  const paths = fileInventory(root).map((rel) => `synthetic/${rel}`);
  const hashes: Record<string, string> = { ...original.contentHashes };
  for (const rel of fileInventory(root)) hashes[`synthetic/${rel}`] = `sha256:${sha256File(join(root, rel))}`;
  return CapsuleManifest.parse({
    ...original,
    assetGroups: [{ id: SYNTHETIC_GROUP_ID, visibility: "holdout", paths }],
    contentHashes: hashes,
  });
}

function copyProbeIntoCapsule(root: string, capsuleRoot: string): void {
  const target = join(capsuleRoot, "synthetic");
  mkdirSync(target, { recursive: true });
  for (const rel of fileInventory(root)) {
    const destination = join(target, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, rel), destination);
  }
}

function inspectMount(containerName: string): MountEvidence | undefined {
  const result = spawnSync("docker", ["inspect", containerName], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) return undefined;
  try {
    const inspected = JSON.parse(result.stdout)[0] as any;
    const mounts = (inspected.Mounts ?? []).map((mount: any) => ({
      type: String(mount.Type ?? ""),
      source: String(mount.Source ?? ""),
      destination: String(mount.Destination ?? ""),
      mode: String(mount.Mode ?? ""),
      rw: Boolean(mount.RW),
    }));
    const suspicious = mounts
      .filter((mount: any) => /(^|\/)(assets|holdout|validation)(\/|$)/i.test(mount.source))
      .map((mount: any) => mount.source);
    return {
      observed: true,
      containerName,
      appArmorProfile: String(inspected.AppArmorProfile ?? ""),
      networkMode: String(inspected.HostConfig?.NetworkMode ?? ""),
      mounts,
      holdoutOrCapsuleAssetMounts: suspicious,
      syntheticAssetsMountedReadOnly: mounts.some((mount: any) => mount.destination === "/capsule/assets" && mount.rw === false),
      workspaceMountedReadOnly: mounts.some((mount: any) => mount.destination === "/workspace" && mount.rw === false),
      baselineMountedReadOnly: mounts.some((mount: any) => mount.destination === "/trusted/baseline" && mount.rw === false),
    };
  } catch {
    return undefined;
  }
}

function recordedRunner(commands: CommandRecord[], mountSink: { value?: MountEvidence }): RunCommand {
  return async (argv: readonly string[], opts?: CmdOptions): Promise<CmdResult> => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (argv[0] === "docker" && argv[1] === "run") {
      const nameIndex = argv.indexOf("--name");
      const containerName = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
      if (containerName) {
        const sample = (): void => {
          if (mountSink.value === undefined) mountSink.value = inspectMount(containerName);
        };
        sample();
        timer = setInterval(sample, 5);
      }
    }
    const pending = runCommand(argv, opts);
    try {
      const result = await pending;
      commands.push({ argv: [...argv], exitCode: result.exitCode, timedOut: result.timedOut, truncated: result.truncated });
      return result;
    } finally {
      clearInterval(timer);
    }
  };
}

function imageCitation(image: string): Record<string, unknown> {
  const inspect = spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (inspect.status !== 0) return { status: "MISSING", image, stderr: inspect.stderr.trim() };
  const row = JSON.parse(inspect.stdout)[0];
  return {
    status: "PRESENT",
    image,
    imageId: row.Id,
    repoDigests: row.RepoDigests ?? [],
    os: row.Os,
    architecture: row.Architecture,
  };
}

function finiteProbeScore(output: EvaluatorOutput): number | undefined {
  const values = Object.values(output.objectives);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function relativeCommand(command: CommandRecord): CommandRecord {
  return {
    ...command,
    argv: command.argv.map((part) => part.startsWith(REPO_ROOT) ? relative(REPO_ROOT, part) : part),
  };
}

async function runOne(
  definition: ProbeDefinition,
  negative: boolean,
  reportRoot: string,
): Promise<Record<string, unknown>> {
  const capsuleRoot = join(REPO_ROOT, "capsules", definition.label);
  const manifestPath = join(capsuleRoot, "manifest.json");
  const originalManifest = CapsuleManifest.parse(readJson<unknown>(manifestPath));
  const originalDigest = capsuleDigest(originalManifest);
  const baselineCommit = originalManifest.baseline.kind === "git" ? originalManifest.baseline.commit : null;
  const baselineDir = join(capsuleRoot, "baseline");
  const image = imageCitation(originalManifest.image);
  const probeRoot = join(reportRoot, "generated", definition.label);
  mkdirSync(probeRoot, { recursive: true });
  let mutation: string | undefined;
  generateProbe(definition, probeRoot, baselineDir);
  if (negative) mutation = mutateProbe(definition, probeRoot);
  const generatedFiles = fileInventory(probeRoot).map((path) => ({ path, sha256: `sha256:${sha256File(join(probeRoot, path))}` }));

  const syntheticCapsuleRoot = join(reportRoot, "capsules", definition.label);
  mkdirSync(syntheticCapsuleRoot, { recursive: true });
  copyProbeIntoCapsule(probeRoot, syntheticCapsuleRoot);
  const manifest = probeManifest(originalManifest, probeRoot);
  const casDir = join(reportRoot, "cas", definition.label);
  const runDir = join(reportRoot, "runs", definition.label);
  const cas = new CasStore(casDir);
  const baselineArtifactHash = await packDirAsArtifact(baselineDir, cas);
  const commands: CommandRecord[] = [];
  const mountSink: { value?: MountEvidence } = {};
  const events: unknown[] = [];
  let record: any;
  let failure: string | undefined;
  let evaluatorInvoked = false;
  let broker;

  if (image.status === "PRESENT") {
    try {
      broker = await startBroker({
        runId: `terminal-preflight-${definition.label}-${negative ? "negative" : "synthetic"}`,
        manifest,
        capsuleRootDir: syntheticCapsuleRoot,
        baselineArtifactHash,
        capsuleDigest: originalDigest,
        optimizerDigest: `sha256:${"0".repeat(64)}`,
        holdoutLedgerPath: join(runDir, "synthetic-holdout-ledger.ndjson"),
        terminalHoldoutAssetGroupIds: [SYNTHETIC_GROUP_ID],
        image: originalManifest.image,
        runDir,
        casDir,
        scratchVolume: false,
        runCommand: recordedRunner(commands, mountSink),
        onEvent: (event) => events.push(event),
      });
      record = await broker.broker.evaluate(
        { artifact: { hash: baselineArtifactHash }, assetGroupId: SYNTHETIC_GROUP_ID, seed: 730_201 },
        { privileged: true },
      );
      evaluatorInvoked = true;
    } catch (error) {
      failure = bounded(error);
      evaluatorInvoked = commands.some((command) => command.argv[0] === "docker" && command.argv[1] === "run");
    } finally {
      await broker?.close().catch((error: unknown) => { failure = `${failure ?? ""}\nbroker close: ${bounded(error)}`.trim(); });
    }
  } else {
    failure = `pinned image absent: ${originalManifest.image}`;
  }

  const output = record?.output as EvaluatorOutput | undefined;
  const probeScore = output === undefined ? undefined : finiteProbeScore(output);
  const constraintsPassed = output !== undefined && Object.values(output.constraints).every(Boolean);
  const structuralOutput = output !== undefined && probeScore !== undefined;
  const isolationEvent = (events as any[]).find((event) => event?.type === "evaluator.isolation");
  const isolation = record?.isolation ?? isolationEvent?.isolation;
  const mountEvidence: MountEvidence = mountSink.value ?? {
    observed: false,
    mounts: [],
    holdoutOrCapsuleAssetMounts: [],
    syntheticAssetsMountedReadOnly: false,
    workspaceMountedReadOnly: false,
    baselineMountedReadOnly: false,
  };
  const isolationPass = mountEvidence.observed
    && mountEvidence.networkMode === "none"
    && mountEvidence.holdoutOrCapsuleAssetMounts.length === 0
    && mountEvidence.syntheticAssetsMountedReadOnly
    && mountEvidence.workspaceMountedReadOnly
    && mountEvidence.baselineMountedReadOnly;
  const verdict = structuralOutput && output!.valid && constraintsPassed && isolationPass && record.costUsd === 0 ? "PASS" : "FAIL";
  const commandHoldoutPaths = commands.flatMap((command) => command.argv.filter((part) => /(^|\/)(holdout|validation)(\/|$)/i.test(part)));

  return {
    capsuleId: originalManifest.id,
    frozenCampaignCapsuleId: definition.frozenCapsuleId,
    label: definition.label,
    verdict,
    synthetic: true,
    derivedFromHoldout: false,
    schema: definition.schema,
    generator: definition.generator,
    negativeMutation: mutation,
    pinnedAuthority: {
      capsuleDigest: originalDigest,
      baselineCommit,
      image: originalManifest.image,
    },
    runtimeCitation: image,
    generatedAssets: generatedFiles,
    generatorReadPolicy: {
      inputs: ["checked-in generator definition", "capsule baseline source where the declared schema requires a reference or protected-script hash"],
      capsuleAssetsDirectoryPassedToGenerator: false,
      holdoutBytesPassedToGenerator: false,
    },
    assetGroup: { id: SYNTHETIC_GROUP_ID, visibility: "holdout", syntheticOverride: true },
    execution: {
      evaluatorInvoked,
      workerUid: isolation?.workerUid,
      isolationMode: isolation?.mode,
      allocationId: isolation?.allocationId,
      uidInReservedPool: typeof isolation?.workerUid === "number" && isolation.workerUid >= WORKER_UID_MIN,
      outputParsed: output !== undefined,
      outputValid: output?.valid ?? false,
      constraintsPassed,
      failure,
      costUsd: record?.costUsd,
      evaluatorDurationMs: record?.durationMs,
    },
    probeScore: probeScore === undefined ? null : { value: probeScore, meaningless: true, measurementEligible: false },
    evaluatorOutput: output,
    mountEvidence,
    zeroHoldoutReadEvidence: {
      commandHoldoutPaths,
      commandCheckPassed: commandHoldoutPaths.length === 0,
      mountCheckPassed: mountEvidence.holdoutOrCapsuleAssetMounts.length === 0,
      realCapsuleAssetsAddedToSyntheticRoot: false,
    },
    commands: commands.map(relativeCommand),
    eventTypes: events.map((event: any) => event?.type).filter((value) => typeof value === "string"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const campaignPath = repoPath(args.campaign, "campaign");
  const configPath = repoPath(args.config, "config");
  const outputPath = repoPath(args.output, "output");
  const campaign = readJson<any>(campaignPath);
  const config = readJson<ProbeConfig>(configPath);
  if (config.schemaVersion !== 1 || config.synthetic !== true || config.derivedFromHoldout !== false || config.assetGroupId !== SYNTHETIC_GROUP_ID) {
    throw new Error("terminal preflight config does not declare the synthetic/no-holdout contract");
  }
  if (config.campaign !== relative(REPO_ROOT, campaignPath).split(sep).join("/")) throw new Error("config campaign path drift");
  const terminalIds = campaign.corpusCohort?.terminalCapsuleIds;
  if (!Array.isArray(terminalIds) || terminalIds.length !== 8 || new Set(terminalIds).size !== 8) {
    throw new Error("frozen campaign must contain exactly eight unique terminal capsule ids");
  }
  const configuredIds = config.capsules.map((capsule) => capsule.frozenCapsuleId);
  if (configuredIds.length !== 8 || new Set(configuredIds).size !== 8 || configuredIds.some((id) => !terminalIds.includes(id))) {
    throw new Error("synthetic probe definitions must exactly cover the frozen eight-capsule terminal cohort");
  }
  if (args.negativeProbe !== undefined && !config.capsules.some((capsule) => capsule.label === args.negativeProbe)) {
    throw new Error(`unknown --negative-probe label: ${args.negativeProbe}`);
  }
  const selectedDefinitions = args.negativeProbe === undefined
    ? config.capsules
    : config.capsules.filter((capsule) => capsule.label === args.negativeProbe);

  const reportRoot = mkdtempSync(join(tmpdir(), "hone-terminal-preflight-"));
  const results: Record<string, unknown>[] = [];
  try {
    for (const definition of selectedDefinitions) {
      const negative = definition.label === args.negativeProbe;
      console.log(`${definition.label}: running ${negative ? "deliberately broken" : "synthetic"} terminal probe`);
      try {
        results.push(await runOne(definition, negative, reportRoot));
      } catch (error) {
        results.push({
          frozenCampaignCapsuleId: definition.frozenCapsuleId,
          label: definition.label,
          verdict: "FAIL",
          synthetic: true,
          derivedFromHoldout: false,
          generator: definition.generator,
          schema: definition.schema,
          execution: { evaluatorInvoked: false, outputParsed: false, failure: bounded(error) },
          probeScore: null,
        });
      }
    }
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }

  const count = (verdict: string): number => results.filter((row: any) => row.verdict === verdict).length;
  const negativeResult = args.negativeProbe === undefined ? undefined : results.find((row: any) => row.label === args.negativeProbe);
  const report = {
    schemaVersion: 1,
    gate: "terminal-authority-preflight",
    generatedAt: new Date().toISOString(),
    gateInvocation: "bun capsules/tools/preflight-m2-terminal-authority.mts",
    campaign: relative(REPO_ROOT, campaignPath).split(sep).join("/"),
    config: relative(REPO_ROOT, configPath).split(sep).join("/"),
    synthetic: true,
    derivedFromHoldout: false,
    zeroModelCalls: true,
    probeScoresAreMeasurements: false,
    operatorContaminationDisclosure: OPERATOR_CONTAMINATION_DISCLOSURE,
    negativeProbe: args.negativeProbe === undefined ? null : {
      label: args.negativeProbe,
      gateFailedClosed: (negativeResult as any)?.verdict === "FAIL",
    },
    results,
    summary: {
      authorizedTerminalCapsules: terminalIds.length,
      pass: count("PASS"),
      fail: count("FAIL"),
      genuineVerdicts: results.length,
      allCovered: results.length === terminalIds.length,
      terminalPreflight: `${count("PASS")}/${selectedDefinitions.length} selected PASS`,
      spendViolations: results.filter((row: any) => row.execution?.costUsd !== undefined && row.execution.costUsd !== 0).length,
      holdoutCommandOrMountViolations: results.filter((row: any) => row.zeroHoldoutReadEvidence && (!row.zeroHoldoutReadEvidence.commandCheckPassed || !row.zeroHoldoutReadEvidence.mountCheckPassed)).length,
    },
  };
  writeJson(outputPath, report);
  console.log(`report: ${relative(REPO_ROOT, outputPath)}`);
  console.log(`${report.summary.terminalPreflight}; ${report.summary.fail} FAIL; ${report.summary.spendViolations} spend violations; ${report.summary.holdoutCommandOrMountViolations} holdout command/mount violations`);
  if (args.negativeProbe !== undefined) {
    process.exitCode = report.negativeProbe?.gateFailedClosed === true ? 0 : 1;
  } else {
    process.exitCode = report.summary.pass === report.summary.authorizedTerminalCapsules ? 0 : 1;
  }
}

await main();
