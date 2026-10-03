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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CapsuleManifest, MetaCampaignConfigV2, capsuleDigest, type EvaluatorOutput } from "@hone/schema";
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
const DEFAULT_CAMPAIGN = "data/m2-refreeze-final/campaign-frozen.json";
const DEFAULT_CONFIG = "data/m2-refreeze-final/terminal-authority-preflight.config.json";
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
  evaluatorTimeoutSec?: number;
  evaluatorTimeoutExplicit: boolean;
  negativeProbe?: string;
};

type ProbeDefinition = {
  frozenCapsuleId: string;
  label: string;
  generator: string;
  schema: string;
  expectedSyntheticRefusal?: string;
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
    "  [--evaluator-timeout-sec SECONDS] [--negative-probe CAPSULE_LABEL]",
    "",
    "Runs the frozen terminal cohort through the real trusted Broker staging and",
    "Docker evaluator path using generated synthetic assets only. The probe score",
    "is structural evidence, is always marked meaningless, and is never a campaign",
    "measurement. --negative-probe corrupts the named generated probe after creation",
    "to prove that evaluator failure is reported fail-closed.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    campaign: DEFAULT_CAMPAIGN,
    config: DEFAULT_CONFIG,
    output: DEFAULT_OUTPUT,
    evaluatorTimeoutExplicit: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[index + 1];
    if (
      arg === "--campaign"
      || arg === "--config"
      || arg === "--output"
      || arg === "--negative-probe"
      || arg === "--evaluator-timeout-sec"
    ) {
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--campaign") parsed.campaign = value;
      if (arg === "--config") parsed.config = value;
      if (arg === "--output") parsed.output = value;
      if (arg === "--negative-probe") parsed.negativeProbe = value;
      if (arg === "--evaluator-timeout-sec") {
        const seconds = Number(value);
        if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400) {
          throw new Error("--evaluator-timeout-sec must be an integer from 1 through 86400");
        }
        parsed.evaluatorTimeoutSec = seconds;
        parsed.evaluatorTimeoutExplicit = true;
      }
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

const U64_MASK = (1n << 64n) - 1n;

function u64(value: bigint): bigint {
  return value & U64_MASK;
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

function mimallocPrngNext(input: bigint): { state: bigint; value: bigint } {
  let state = input;
  state = u64(state ^ (state >> 12n));
  state = u64(state ^ u64(state << 25n));
  state = u64(state ^ (state >> 27n));
  return { state, value: u64(state * 2_685_821_657_736_338_717n) };
}

function mimallocChecksum(state: bigint, value: bigint): bigint {
  return u64(state ^ u64(value + 0x9e3779b97f4a7c15n + u64(state << 6n) + (state >> 2n)));
}

function mimallocPattern(seed: bigint, index: bigint): bigint {
  let state = u64(seed
    ^ 0xa0761d6478bd642fn
    ^ u64((index + 1n) * 0xe7037ed1a0b428dbn));
  if (state === 0n) state = 0x8ebc6af09c88c6e3n;
  return mimallocPrngNext(state).value;
}

function mimallocWorkloadIdentity(id: string, seedNumber: number, rounds: number): { expectedOperations: number; expectedChecksum: string } {
  const seed = BigInt(seedNumber);
  let operations = 0;
  let checksum: bigint;
  if (id === "single") {
    let state = seed ^ 0x73696e676c652d31n;
    checksum = 0xcbf29ce484222325n;
    const sizes: bigint[] = [];
    for (let index = 0; index < 2_048; index += 1) {
      const next = mimallocPrngNext(state);
      state = next.state;
      const size = 16n + next.value % 8_177n;
      sizes.push(size);
      checksum = mimallocChecksum(checksum, size ^ BigInt(index));
    }
    for (let index = 0; index < sizes.length; index += 1) {
      checksum = mimallocChecksum(checksum, mimallocPattern(seed, BigInt(index)) ^ sizes[index]!);
    }
    operations = 4_096;
  } else if (id === "multithread") {
    checksum = 0n;
    for (let thread = 0; thread < 4; thread += 1) {
      const threadSeed = u64(seed ^ u64(BigInt(thread + 1) * 0xd1b54a32d192ed03n));
      let state = threadSeed;
      let threadChecksum = 0x6a09e667f3bcc909n;
      for (let index = 0; index < 768; index += 1) {
        const next = mimallocPrngNext(state);
        state = next.state;
        const size = 16n + next.value % 4_081n;
        threadChecksum = mimallocChecksum(
          threadChecksum,
          mimallocPattern(threadSeed, BigInt(index)) ^ size,
        );
      }
      checksum = mimallocChecksum(checksum, threadChecksum ^ BigInt(thread));
    }
    operations = 6_144;
  } else if (id === "small") {
    let state = seed ^ 0x736d616c6c2d6f62n;
    checksum = 0x84222325cbf29ce4n;
    const sizes: bigint[] = [];
    for (let index = 0; index < 8_192; index += 1) {
      const next = mimallocPrngNext(state);
      state = next.state;
      const size = 8n + next.value % 249n;
      sizes.push(size);
      checksum = mimallocChecksum(checksum, size + BigInt(index) * 17n);
    }
    for (let index = 0; index < sizes.length; index += 1) {
      const replaced = index % 3 === 0;
      const liveSize = replaced ? 8n + (sizes[index]! * 5n + BigInt(index)) % 249n : sizes[index]!;
      const patternIndex = BigInt(replaced ? 8_192 + index : index);
      checksum = mimallocChecksum(checksum, mimallocPattern(seed, patternIndex) ^ liveSize);
    }
    operations = 8_192 + 2 * 2_731 + 8_192;
  } else if (id === "fragmentation") {
    let state = seed ^ 0x667261676d656e74n;
    checksum = 0x9e3779b97f4a7c15n;
    const sizes: bigint[] = [];
    for (let index = 0; index < 2_048; index += 1) {
      const next = mimallocPrngNext(state);
      state = next.state;
      const size = 64n + next.value % 65_473n;
      sizes.push(size);
      checksum = mimallocChecksum(checksum, size ^ BigInt(index) * 131n);
    }
    for (let index = 0; index < sizes.length; index += 1) {
      checksum = mimallocChecksum(checksum, mimallocPattern(seed, BigInt(index)) ^ sizes[index]!);
    }
    for (let index = 0; index < sizes.length; index += 1) {
      const replaced = index % 2 === 0;
      const liveSize = replaced ? 48n + (sizes[index]! ^ seed) % 4_049n : sizes[index]!;
      const patternIndex = BigInt(replaced ? 2_048 + index : index);
      checksum = mimallocChecksum(checksum, mimallocPattern(seed, patternIndex) ^ liveSize);
    }
    operations = 6_144;
  } else {
    throw new Error(`unknown mimalloc synthetic workload: ${id}`);
  }
  if (id === "small") {
    operations = 0;
    for (let round = 0; round < rounds; round += 1) {
      const replacements = Math.floor((8_191 - (round % 3)) / 3) + 1;
      operations += 8_192 + replacements * 2 + 8_192;
    }
  } else {
    operations *= rounds;
  }
  return { expectedOperations: operations, expectedChecksum: checksum.toString(16).padStart(16, "0") };
}

function generateMimalloc(root: string): void {
  const ids = ["single", "multithread", "small", "fragmentation"];
  const treeBaselines = [32 << 20, 32 << 20, 8 << 20, 128 << 20];
  const roundCounts = [128, 128, 32, 128];
  const workloads = ids.map((id, index) => {
    const rounds = roundCounts[index]!;
    return {
      id,
      seed: index + 1,
      rounds,
      threads: id === "multithread" ? 4 : 1,
      ...mimallocWorkloadIdentity(id, index + 1, rounds),
      baselinePeakPageCommittedBytes: 1 << 30,
      baselineTreePeakBytes: treeBaselines[index],
      baselineFragmentationRatio: 1,
    };
  });
  writeProbeFile(root, "workloads.json", `${JSON.stringify({ schemaVersion: 1, driverVersion: "mimalloc-four-v1", split: "synthetic", workloads })}\n`);
}

function generateDuckdb(root: string, baselineDir: string, image: string): void {
  const query = "SELECT sum(l_quantity) FROM lineitem WHERE l_quantity > 15;\n";
  writeProbeFile(root, "query.sql", query);
  const checkedInGenerator = join(dirname(baselineDir), "generate_sf1.cpp");
  const generatorProject = dirname(root);
  const generatorPath = join(generatorProject, "duckdb-synthetic-generator.cpp");
  const generatorSource = readFileSync(checkedInGenerator, "utf8");
  if (!generatorSource.includes("CALL dbgen(sf=1)")) throw new Error("DuckDB public SF1 constructor identity drift");
  writeFileSync(generatorPath, generatorSource);
  const probeOutput = `/probe/${basename(root)}`;
  writeFileSync(join(generatorProject, "CMakeLists.txt"), [
    "cmake_minimum_required(VERSION 3.10)",
    "project(hone_synthetic_duckdb CXX)",
    "find_package(Threads REQUIRED)",
    'set(BUILD_EXTENSIONS "tpch" CACHE STRING "" FORCE)',
    "set(BUILD_SHELL OFF CACHE BOOL \"\" FORCE)",
    "set(BUILD_UNITTESTS OFF CACHE BOOL \"\" FORCE)",
    "set(BUILD_BENCHMARKS OFF CACHE BOOL \"\" FORCE)",
    "set(ENABLE_JEMALLOC OFF CACHE BOOL \"\" FORCE)",
    'add_subdirectory("/source" "/build/duckdb")',
    "add_executable(hone_generate duckdb-synthetic-generator.cpp)",
    'target_include_directories(hone_generate PRIVATE "/source/src/include" "/source/third_party/fmt/include" "/build/duckdb/codegen/include")',
    "target_link_libraries(hone_generate duckdb_static ${DUCKDB_EXTRA_LINK_FLAGS})",
    'link_threads(hone_generate "")',
    'link_extension_libraries(hone_generate "")',
    "target_link_libraries(hone_generate tpch_extension core_functions_extension parquet_extension)",
    'add_executable(hone_query "/source/result_hash.cpp")',
    'target_include_directories(hone_query PRIVATE "/source/src/include" "/source/third_party/fmt/include" "/build/duckdb/codegen/include")',
    "target_link_libraries(hone_query duckdb)",
    "",
  ].join("\n"));
  const build = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--memory", "8589934592", "--cpus", "8",
    "--tmpfs", "/build:rw,exec,size=10g", "--tmpfs", "/tmp:rw,size=1g",
    "--mount", `type=bind,src=${baselineDir},dst=/source,readonly`,
    "--mount", `type=bind,src=${generatorProject},dst=/probe`,
    "--entrypoint", "/bin/sh", image, "-lc", [
      "set -eu",
      "cmake -S /probe -B /build/probe -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ '-DCMAKE_CXX_FLAGS_RELEASE=-O2 -DNDEBUG' -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld",
      "cmake --build /build/probe --target hone_generate hone_query -j8",
      `/build/probe/hone_generate ${probeOutput}/sf1.duckdb`,
      `/build/probe/hone_query ${probeOutput}/sf1.duckdb ${probeOutput}/query.sql > /build/query.out`,
      `sha256sum /build/query.out | cut -d' ' -f1 > ${probeOutput}/oracle.sha256`,
    ].join(" && "),
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  if (build.status !== 0) {
    throw new Error(`synthetic DuckDB constructor failed (${build.signal ?? build.status}): stdout:\n${build.stdout.trim()}\nstderr:\n${build.stderr.trim()}`);
  }
  const database = join(root, "sf1.duckdb");
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
  const benchmark = [
    "var job = JSON.parse(std.in.readAsString());",
    "var run = eval(job.program);",
    "var result = run(job.iterations, job.nonce, job.params);",
    "print(JSON.stringify({name:job.name,iterations:job.iterations,operations:result.operations,fold:result.fold}));",
    "",
  ].join("\n");
  const observable = "print('synthetic-observable');\n";
  const moduleLib = "export const value = 'synthetic-module';\n";
  const moduleMain = "import { value } from './module-lib.js'; print(value);\n";
  writeProbeFile(root, "benchmark.js", benchmark);
  writeProbeFile(root, "observable.js", observable);
  writeProbeFile(root, "module-lib.js", moduleLib);
  writeProbeFile(root, "module-main.js", moduleMain);
  const harnessAssert = "var assert={sameValue:function(a,b){if(a!==b)throw new Error('sameValue');}};\n";
  const harnessSta = "function Test262Error(message){this.message=message||'';} Test262Error.prototype=Object.create(Error.prototype); Test262Error.prototype.name='Test262Error'; function $DONOTEVALUATE(){throw new Test262Error('$DONOTEVALUATE called');}\n";
  writeProbeFile(root, "test262/harness/assert.js", harnessAssert);
  writeProbeFile(root, "test262/harness/sta.js", harnessSta);
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
  const successAst = { name: "synthetic-legacy", steps: [{ id: "one", run: "echo synthetic" }] };
  const cases = groups.map((group) => ({
    id: `synthetic-${group}`,
    group,
    input: `inputs/${group}.yaml`,
    presets: `presets/${group}.json`,
    expected: group === "legacy"
      ? { ok: true, ast: successAst, canonical: JSON.stringify(successAst) }
      : { ok: false, error: { name: "SyntheticExpectation", message: "synthetic probe", line: null, column: null }, canonical: null },
  }));
  for (const group of groups) {
    const input = group === "legacy"
      ? "name: synthetic-legacy\nsteps:\n  - id: one\n    run: echo synthetic\n"
      : `name: synthetic-${group}\nsteps: []\n`;
    writeProbeFile(root, `inputs/${group}.yaml`, input);
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
  JSON.parse(worker.stdout);
  const canonicalHash = spawnSync("python3", ["-c", [
    "import hashlib,json,sys",
    "envelope={'response':json.loads(sys.stdin.read())['result'],'quality':json.load(open(sys.argv[1]))['quality']}",
    "payload=json.dumps(envelope,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()",
    "print(hashlib.sha256(payload).hexdigest())",
  ].join("\n"), join(root, "workload.json")], {
    input: worker.stdout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (canonicalHash.status !== 0 || !/^[0-9a-f]{64}\n?$/.test(canonicalHash.stdout)) {
    throw new Error(`synthetic tradeup oracle hashing failed: ${(canonicalHash.stderr || canonicalHash.stdout).trim()}`);
  }
  const responseQualityHash = canonicalHash.stdout.trim();
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
function generatorSourceReadPaths(definition: ProbeDefinition): string[] {
  const paths = ["capsules/tools/preflight-m2-terminal-authority.mts"];
  if (definition.label === "duckdb-tpch") {
    paths.push("capsules/duckdb-tpch/generate_sf1.cpp", "capsules/duckdb-tpch/baseline/** (source build input)");
  } else if (definition.label === "quickjs-interpreter") {
    paths.push("capsules/quickjs-interpreter/baseline/eval.py (public identity constants)");
  } else if (definition.label === "brotli-codec") {
    paths.push("capsules/brotli-codec/baseline/eval.py (public identity constants)");
  } else if (definition.label === "tradeup-query-latency") {
    paths.push(
      "capsules/tradeup-query-latency/baseline/worker.py (synthetic reference execution)",
      "capsules/tradeup-query-latency/baseline/reference.py (synthetic reference candidate)",
    );
  }
  return paths;
}


function generateProbe(definition: ProbeDefinition, root: string, baselineDir: string, image: string): void {
  switch (definition.generator) {
    case "brotli-three-corpus-minimal": generateBrotli(root); break;
    case "mimalloc-four-v1-ms-calibrated": generateMimalloc(root); break;
    case "duckdb-physical-filter-sf1": generateDuckdb(root, baselineDir, image); break;
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

type StagedProbeFile = { generatedPath: string; stagedPath: string };

function stagedProbeFiles(original: CapsuleManifest, root: string): StagedProbeFile[] {
  const sourceGroup = original.assetGroups.find((group) => group.id === "validation")
    ?? original.assetGroups[original.assetGroups.length - 1];
  if (sourceGroup === undefined || sourceGroup.paths.length === 0) throw new Error("terminal capsule has no source asset layout");
  const pathParts = sourceGroup.paths.map((path) => path.split("/").slice(0, -1));
  const common = [...pathParts[0]!];
  while (common.length > 0 && pathParts.some((parts) => parts[common.length - 1] !== common[common.length - 1])) common.pop();
  if (common.length === 0) throw new Error("terminal capsule asset group has no common relative directory");
  const files = fileInventory(root).map((generatedPath) => {
    const matches = sourceGroup.paths.filter((path) => path === generatedPath || path.endsWith(`/${generatedPath}`));
    if (matches.length > 1) throw new Error(`ambiguous staged path for generated asset ${generatedPath}`);
    return {
      generatedPath,
      stagedPath: matches[0] ?? [...common, generatedPath].join("/"),
    };
  });
  if (new Set(files.map((file) => file.stagedPath)).size !== files.length) throw new Error("synthetic staging layout contains duplicate paths");
  return files;
}

function probeManifest(original: CapsuleManifest, root: string, files: StagedProbeFile[]): CapsuleManifest {
  const hashes: Record<string, string> = { ...original.contentHashes };
  for (const file of files) hashes[file.stagedPath] = `sha256:${sha256File(join(root, file.generatedPath))}`;
  return CapsuleManifest.parse({
    ...original,
    assetGroups: [{ id: SYNTHETIC_GROUP_ID, visibility: "holdout", paths: files.map((file) => file.stagedPath) }],
    contentHashes: hashes,
  });
}

function copyProbeIntoCapsule(root: string, capsuleRoot: string, files: StagedProbeFile[]): void {
  for (const file of files) {
    const destination = join(capsuleRoot, file.stagedPath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, file.generatedPath), destination);
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
          if (mountSink.value === undefined) {
            const inspected = inspectMount(containerName);
            if (inspected !== undefined) mountSink.value = inspected;
          }
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

function commandMentionsRealAssetPath(value: string): boolean {
  return value
    .split("/")
    .some((component) => component.toLowerCase() === "holdout" || component.toLowerCase() === "validation");
}

async function runOne(
  definition: ProbeDefinition,
  negative: boolean,
  reportRoot: string,
  evaluatorTimeoutSec: number,
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
  generateProbe(definition, probeRoot, baselineDir, originalManifest.image);
  if (negative) mutation = mutateProbe(definition, probeRoot);
  const stagedFiles = stagedProbeFiles(originalManifest, probeRoot);
  const generatedFiles = stagedFiles.map((file) => ({
    path: file.generatedPath,
    stagedPath: file.stagedPath,
    sha256: `sha256:${sha256File(join(probeRoot, file.generatedPath))}`,
  }));

  const syntheticCapsuleRoot = join(reportRoot, "capsules", definition.label);
  mkdirSync(syntheticCapsuleRoot, { recursive: true });
  copyProbeIntoCapsule(probeRoot, syntheticCapsuleRoot, stagedFiles);
  const manifest = probeManifest(originalManifest, probeRoot, stagedFiles);
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
  let evaluationStartedMs: number | undefined;
  let evaluatorDurationMs: number | undefined;
  let broker;

  if (image.status === "PRESENT") {
    try {
      broker = await startBroker({
        evalTimeoutSec: evaluatorTimeoutSec,
        runId: `terminal-preflight-${definition.label}-${negative ? "negative" : "synthetic"}`,
        manifest,
        capsuleRootDir: syntheticCapsuleRoot,
        baselineArtifactHash,
        admittedCapsuleDigest: originalDigest,
        optimizerDigest: `sha256:${"0".repeat(64)}`,
        holdoutLedgerPath: join(runDir, "synthetic-holdout-ledger.ndjson"),
        terminalHoldoutAssetGroupIds: [SYNTHETIC_GROUP_ID],
        ...(originalManifest.sandbox === undefined
          ? {}
          : {
              sandboxMemoryBytes: originalManifest.sandbox.memoryBytes,
              ...(originalManifest.sandbox.cpus === undefined ? {} : { sandboxCpus: originalManifest.sandbox.cpus }),
            }),
        executionImage: originalManifest.image,
        runDir,
        casDir,
        scratchVolume: false,
        runCommand: recordedRunner(commands, mountSink),
        onEvent: (event) => events.push(event),
      });
      evaluationStartedMs = performance.now();
      record = await broker.broker.evaluate(
        { artifact: { hash: baselineArtifactHash }, assetGroupId: SYNTHETIC_GROUP_ID, seed: 730_201 },
        { privileged: true },
      );
      evaluatorInvoked = true;
    } catch (error) {
      failure = bounded(error);
      evaluatorInvoked = commands.some((command) => command.argv[0] === "docker" && command.argv[1] === "run");
    } finally {
      if (evaluationStartedMs !== undefined) evaluatorDurationMs = performance.now() - evaluationStartedMs;
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
  const workerUid = isolation?.workerUid;
  const uidInReservedPool = typeof workerUid === "number" && workerUid >= WORKER_UID_MIN;
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
    && mountEvidence.baselineMountedReadOnly
    && uidInReservedPool
    && isolation?.mode === "reserved-uid";
  const expectedRefusalObserved = !negative
    && definition.expectedSyntheticRefusal !== undefined
    && failure?.includes(definition.expectedSyntheticRefusal) === true;
  const zeroCostPass = record?.costUsd === 0;
  const refusalCommandFailed = commands.some((command) =>
    command.argv[0] === "docker" && command.argv[1] === "run" && command.exitCode !== 0
  );
  const verdict = structuralOutput && output!.valid && constraintsPassed && isolationPass && zeroCostPass
    ? "PASS"
    : expectedRefusalObserved && evaluatorInvoked && refusalCommandFailed && output === undefined && isolationPass
      ? "EXECUTES-REFUSES-SYNTHETIC"
      : "FAIL";
  const failureClass = verdict === "PASS"
    ? "NONE"
    : verdict === "EXECUTES-REFUSES-SYNTHETIC"
      ? "EXPECTED_SYNTHETIC_REFUSAL"
      : !uidInReservedPool
        ? "UID_ENFORCEMENT"
        : !evaluatorInvoked
          ? "PRE_EVALUATOR_FAILURE"
          : typeof record?.costUsd === "number" && record.costUsd !== 0
            ? "SPEND_VIOLATION"
            : !isolationPass
              ? "ISOLATION_EVIDENCE_FAILURE"
              : output !== undefined && (!output.valid || !constraintsPassed)
                ? "EVALUATOR_REFUSAL"
                : "EVALUATOR_EXECUTION_FAILURE";
  const commandHoldoutPaths = commands.flatMap((command) =>
    command.argv.filter(commandMentionsRealAssetPath)
  );

  return {
    capsuleId: originalManifest.id,
    frozenCampaignCapsuleId: definition.frozenCapsuleId,
    label: definition.label,
    verdict,
    synthetic: true,
    failureClass,
    derivedFromHoldout: false,
    schema: definition.schema,
    generator: definition.generator,
    expectedSyntheticRefusal: definition.expectedSyntheticRefusal ?? null,
    expectedSyntheticRefusalObserved: expectedRefusalObserved,
    negativeMutation: mutation,
    pinnedAuthority: {
      capsuleDigest: originalDigest,
      baselineCommit,
      image: originalManifest.image,
    },
    runtimeCitation: image,
    generatedAssets: generatedFiles,
    generatorReadPolicy: {
      sourceReadPaths: generatorSourceReadPaths(definition),
      prohibitedReadRoots: [`capsules/${definition.label}/assets`],
      capsuleAssetsDirectoryPassedToGenerator: false,
      holdoutBytesPassedToGenerator: false,
    },
    assetGroup: {
      id: SYNTHETIC_GROUP_ID,
      visibility: "holdout",
      syntheticOverride: true,
      stagedAtDeclaredLayout: true,
      paths: stagedFiles.map((file) => file.stagedPath),
    },
    execution: {
      evaluatorInvoked,
      workerUid,
      isolationMode: isolation?.mode,
      allocationId: isolation?.allocationId,
      uidInReservedPool,
      outputParsed: output !== undefined,
      outputValid: output?.valid ?? false,
      constraintsPassed,
      evaluatorTimeoutSec,
      failure,
      costUsd: record?.costUsd ?? null,
      zeroSpendProvenance: record?.costUsd === 0
        ? "trusted EvaluationRecord"
        : expectedRefusalObserved && mountEvidence.networkMode === "none"
          ? "network-none evaluator refusal before EvaluationRecord"
          : null,
      evaluatorDurationMs,
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
  const campaign = MetaCampaignConfigV2.parse(readJson<unknown>(campaignPath));
  const config = readJson<ProbeConfig>(configPath);
  const evaluatorTimeoutSec = args.evaluatorTimeoutSec ?? campaign.evaluatorTimeoutSec;
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
  const expectedRefusals = config.capsules.filter((capsule) => capsule.expectedSyntheticRefusal !== undefined);
  if (
    expectedRefusals.length !== 1
    || expectedRefusals[0]?.label !== "floyd-custom-scoreboard-render"
    || expectedRefusals[0].expectedSyntheticRefusal !== "sealed reference renderer digest mismatch"
  ) {
    throw new Error("captain-authorized synthetic-refusal classification must be pinned exactly to Floyd's digest oracle refusal");
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
        results.push(await runOne(definition, negative, reportRoot, evaluatorTimeoutSec));
      } catch (error) {
        const failedCapsuleRoot = join(REPO_ROOT, "capsules", definition.label);
        const failedManifest = CapsuleManifest.parse(readJson<unknown>(join(failedCapsuleRoot, "manifest.json")));
        const failedBaselineCommit = failedManifest.baseline.kind === "git"
          ? failedManifest.baseline.commit
          : null;
        results.push({
          capsuleId: failedManifest.id,
          frozenCampaignCapsuleId: definition.frozenCapsuleId,
          label: definition.label,
          verdict: "FAIL",
          failureClass: "PRE_EVALUATOR_FAILURE",
          synthetic: true,
          derivedFromHoldout: false,
          generator: definition.generator,
          schema: definition.schema,
          expectedSyntheticRefusal: definition.expectedSyntheticRefusal ?? null,
          pinnedAuthority: {
            capsuleDigest: capsuleDigest(failedManifest),
            baselineCommit: failedBaselineCommit,
            image: failedManifest.image,
          },
          runtimeCitation: imageCitation(failedManifest.image),
          execution: {
            evaluatorInvoked: false,
            outputParsed: false,
            costUsd: null,
            failure: bounded(error),
          },
          probeScore: null,
        });
      }
    }
  } finally {
    rmSync(reportRoot, { recursive: true, force: true });
  }

  const count = (verdict: string): number => results.filter((row: any) => row.verdict === verdict).length;
  const countFailureClass = (failureClass: string): number =>
    results.filter((row: any) => row.failureClass === failureClass).length;
  const negativeResult = args.negativeProbe === undefined ? undefined : results.find((row: any) => row.label === args.negativeProbe);
  const report = {
    schemaVersion: 1,
    gate: "terminal-authority-preflight",
    generatedAt: new Date().toISOString(),
    gateInvocation: args.evaluatorTimeoutExplicit
      ? `bun capsules/tools/preflight-m2-terminal-authority.mts --evaluator-timeout-sec ${evaluatorTimeoutSec}`
      : "bun capsules/tools/preflight-m2-terminal-authority.mts",
    campaign: relative(REPO_ROOT, campaignPath).split(sep).join("/"),
    config: relative(REPO_ROOT, configPath).split(sep).join("/"),
    parameters: {
      evaluatorTimeoutSec,
      evaluatorTimeoutSource: args.evaluatorTimeoutExplicit ? "explicit-cli-override" : "campaign-faithful-default",
    },
    synthetic: true,
    derivedFromHoldout: false,
    zeroModelCalls: true,
    probeScoresAreMeasurements: false,
    operatorContaminationDisclosure: OPERATOR_CONTAMINATION_DISCLOSURE,
    verdictPolicy: {
      launchAccountedVerdicts: ["PASS", "EXECUTES-REFUSES-SYNTHETIC"],
      passRequires: [
        "valid evaluator output with all constraints true",
        "trusted costUsd=0 record",
        "reserved evaluator uid",
        "network-none and read-only synthetic/workspace/baseline mounts",
        "no capsule asset, validation, or holdout mount",
      ],
      executesRefusesSyntheticRequires: [
        "configured exact expected refusal",
        "real evaluator container invocation ending nonzero",
        "reserved evaluator uid",
        "network-none and read-only synthetic/workspace/baseline mounts",
        "no capsule asset, validation, or holdout mount",
      ],
      expectedSyntheticRefusalCapsules: expectedRefusals.map((definition) => definition.label),
    },
    negativeProbe: args.negativeProbe === undefined ? null : {
      label: args.negativeProbe,
      gateFailedClosed: (negativeResult as any)?.verdict === "FAIL"
        && (negativeResult as any)?.execution?.evaluatorInvoked === true,
    },
    results,
    summary: {
      provenExecutable: count("PASS"),
      executesRefusesSynthetic: count("EXECUTES-REFUSES-SYNTHETIC"),
      fail: count("FAIL"),
      failedAfterEvaluatorInvocation: results.filter((row: any) => row.verdict === "FAIL" && row.execution?.evaluatorInvoked === true).length,
      untestedBeforeEvaluatorInvocation: results.filter((row: any) => row.verdict === "FAIL" && row.execution?.evaluatorInvoked !== true).length,
      spendViolations: results.filter((row: any) =>
        typeof row.execution?.costUsd === "number" && row.execution.costUsd !== 0
      ).length,
      authorizedCount: terminalIds.length,
      selectedCount: selectedDefinitions.length,
      accountedAuthorities: count("PASS") + count("EXECUTES-REFUSES-SYNTHETIC"),
      genuineVerdicts: results.length,
      allCovered: results.length === terminalIds.length,
      holdoutCommandOrMountViolations: results.filter((row: any) => row.zeroHoldoutReadEvidence
        && (!row.zeroHoldoutReadEvidence.commandCheckPassed || !row.zeroHoldoutReadEvidence.mountCheckPassed)).length,
      failureClasses: {
        uidEnforcement: countFailureClass("UID_ENFORCEMENT"),
        evaluatorRefusal: countFailureClass("EVALUATOR_REFUSAL"),
        evaluatorExecutionFailure: countFailureClass("EVALUATOR_EXECUTION_FAILURE"),
        isolationEvidenceFailure: countFailureClass("ISOLATION_EVIDENCE_FAILURE"),
        preEvaluatorFailure: countFailureClass("PRE_EVALUATOR_FAILURE"),
        expectedSyntheticRefusal: countFailureClass("EXPECTED_SYNTHETIC_REFUSAL"),
      },
    },
  };
  writeJson(outputPath, report);
  console.log(`report: ${relative(REPO_ROOT, outputPath)}`);
  console.log(`${report.summary.accountedAuthorities}/${report.summary.selectedCount} selected accounted; ${report.summary.provenExecutable} PASS; ${report.summary.executesRefusesSynthetic} EXECUTES-REFUSES-SYNTHETIC; ${report.summary.fail} FAIL; ${report.summary.spendViolations} spend violations; ${report.summary.holdoutCommandOrMountViolations} holdout command/mount violations`);
  if (args.negativeProbe !== undefined) {
    process.exitCode = report.negativeProbe?.gateFailedClosed === true ? 0 : 1;
  } else {
    process.exitCode = report.summary.accountedAuthorities === report.summary.authorizedCount ? 0 : 1;
  }
}

await main();
