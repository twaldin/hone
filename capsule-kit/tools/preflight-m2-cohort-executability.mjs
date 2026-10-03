#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The engine's own launcher, independent of the working directory. */
const HONE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../trusted/cli/bin/hone.js");
/**
 * Hone state root (the working directory, like the hone CLI's io.root):
 * campaign data, the preflight config, .hone-runs and the report live here.
 */
const STATE_ROOT = process.cwd();
const DEFAULT_OUTPUT = "tmp/m2-cohort-executability-results.json";
const UPSTREAM_URL = "http://127.0.0.1:1";
const MAX_DIAGNOSTIC_CHARS = 16_384;
const WORKER_UID = 2000;
const UID_TASK_SAMPLE_MS = 250;

/**
 * Plain-node mirror of resolveCapsulesRoot (trusted/cli/src/capsules-root.ts):
 * HONE_CAPSULES_ROOT, else ./capsules under the state root; must be a directory.
 */
function resolveCapsulesRoot(root, env) {
  const raw = env.HONE_CAPSULES_ROOT;
  if (raw === "") throw new Error("HONE_CAPSULES_ROOT is set but empty");
  const dir = resolve(root, raw ?? "capsules");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`capsules root ${dir} is not an existing directory; set HONE_CAPSULES_ROOT`);
  }
  return dir;
}

function usage() {
  return [
    "usage: node capsule-kit/tools/preflight-m2-cohort-executability.mjs",
    "       --campaign PATH --config PATH [--output PATH]",
    "",
    "Runs every development and terminal capsule from the frozen M2 campaign",
    "through the real trusted CLI, Docker staging, and evaluator path. The",
    "upstream is pinned to unreachable 127.0.0.1:1 and any non-zero model",
    "token or USD spend stops the gate immediately. Paths resolve against the",
    "working directory; capsules come from HONE_CAPSULES_ROOT, else ./capsules.",
    "Host uid-2000 task counts are sampled around each run so concurrent",
    "evaluator interference remains visible in the report.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {
    campaign: "",
    config: "",
    output: DEFAULT_OUTPUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg !== "--campaign" && arg !== "--config" && arg !== "--output") {
      throw new Error(`unknown argument ${JSON.stringify(arg)}\n${usage()}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a path\n${usage()}`);
    }
    values[arg.slice(2)] = value;
    i += 1;
  }
  if (values.campaign === "" || values.config === "") throw new Error(`--campaign and --config are required\n${usage()}`);
  return values;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function diagnosticTail(value) {
  return value.length <= MAX_DIAGNOSTIC_CHARS
    ? value
    : `[earlier output omitted]\n${value.slice(-MAX_DIAGNOSTIC_CHARS)}`;
}

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length <= MAX_DIAGNOSTIC_CHARS * 2
    ? next
    : next.slice(-MAX_DIAGNOSTIC_CHARS * 2);
}

function assertRelativeToRepo(path, label) {
  const rel = relative(STATE_ROOT, path);
  if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${label} must be a file under ${STATE_ROOT}`);
  }
  return rel;
}

function probeUnreachableUpstream() {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port: 1 });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectProbe(new Error("upstream probe timed out instead of refusing the connection"));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      rejectProbe(new Error(`${UPSTREAM_URL} is reachable; refusing to risk model spend`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (error && error.code === "ECONNREFUSED") {
        resolveProbe({ endpoint: UPSTREAM_URL, result: "ECONNREFUSED" });
      } else {
        rejectProbe(new Error(`upstream probe failed unexpectedly: ${error?.code ?? String(error)}`));
      }
    });
  });
}

function findCapsules(capsuleIds) {
  const wanted = new Set(capsuleIds);
  const found = new Map();
  for (const entry of readdirSync(CAPSULES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(CAPSULES_ROOT, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!wanted.has(manifest.id)) continue;
    if (found.has(manifest.id)) throw new Error(`duplicate capsule id ${manifest.id}`);
    found.set(manifest.id, {
      capsuleId: manifest.id,
      // Repository-relative descriptors (`capsules/<label>`) keep reports checkout-independent.
      capsuleDir: `capsules/${entry.name}`,
      manifestPath: `capsules/${entry.name}/manifest.json`,
      absoluteDir: join(CAPSULES_ROOT, entry.name),
      image: manifest.image,
      assetGroups: manifest.assetGroups,
    });
  }
  const missing = capsuleIds.filter((id) => !found.has(id));
  if (missing.length !== 0) {
    throw new Error(`frozen cohort capsule manifests are missing: ${missing.join(", ")}`);
  }
  return found;
}

function baselineStoreRecord(capsule) {
  const base = join(capsule.absoluteDir, "baseline");
  const store = [".gitdir", ".git"].find((name) => existsSync(join(base, name)));
  if (store === undefined) {
    return { present: false, tracked: false, path: null, coreWorktree: null };
  }
  const storeRel = `${capsule.capsuleDir}/baseline/${store}`;
  const trackedCheck = spawnSync("git", ["ls-files", join(base, store)], {
    cwd: CAPSULES_ROOT,
    encoding: "utf8",
  });
  if (trackedCheck.status !== 0) {
    throw new Error(`git ls-files failed for ${storeRel}: ${trackedCheck.stderr}`);
  }
  const configPath = join(base, store, "config");
  let coreWorktree = null;
  if (existsSync(configPath)) {
    const match = readFileSync(configPath, "utf8").match(/^\s*worktree\s*=\s*(.+)$/mi);
    coreWorktree = match?.[1]?.trim() ?? null;
  }
  return {
    present: true,
    tracked: trackedCheck.stdout.trim() !== "",
    path: storeRel,
    coreWorktree,
  };
}

function parseJsonLines(value) {
  const records = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Human diagnostics can contain braces; authoritative records remain in events.ndjson.
    }
  }
  return records;
}

function readRunText(runId, filename) {
  if (runId === null) return "";
  const path = join(STATE_ROOT, ".hone-runs", runId, filename);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readRunRecords(runId, filename) {
  return parseJsonLines(readRunText(runId, filename));
}

function readEvents(runId) {
  return readRunRecords(runId, "events.ndjson");
}

function uidTaskCount(uid) {
  let total = 0;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const status = readFileSync(`/proc/${entry}/status`, "utf8");
        const realUid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
        if (realUid !== uid) continue;
        const threads = Number(status.match(/^Threads:\s+(\d+)/m)?.[1]);
        if (Number.isSafeInteger(threads) && threads > 0) total += threads;
      } catch {
        // Processes can exit between /proc enumeration and status read.
      }
    }
  } catch {
    return null;
  }
  return total;
}

function execute(command, monitorUid = null) {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn("sg", ["docker", "-c", command.inner], {
      cwd: STATE_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const uidTaskMonitor = monitorUid === null
      ? null
      : { uid: monitorUid, sampleIntervalMs: UID_TASK_SAMPLE_MS, before: null, min: null, max: null, after: null, samples: 0 };
    const sampleUidTasks = () => {
      if (uidTaskMonitor === null) return;
      const count = uidTaskCount(uidTaskMonitor.uid);
      if (count === null) return;
      uidTaskMonitor.samples += 1;
      uidTaskMonitor.min = uidTaskMonitor.min === null ? count : Math.min(uidTaskMonitor.min, count);
      uidTaskMonitor.max = uidTaskMonitor.max === null ? count : Math.max(uidTaskMonitor.max, count);
      uidTaskMonitor.after = count;
    };
    sampleUidTasks();
    if (uidTaskMonitor !== null) uidTaskMonitor.before = uidTaskMonitor.after;
    const sampler = uidTaskMonitor === null ? null : setInterval(sampleUidTasks, UID_TASK_SAMPLE_MS);
    sampler?.unref();
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      stdout = appendBounded(stdout, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      stderr = appendBounded(stderr, text);
    });
    child.once("error", (error) => {
      clearInterval(sampler);
      rejectExecution(error);
    });
    child.once("close", (code, signal) => {
      clearInterval(sampler);
      sampleUidTasks();
      resolveExecution({ exitCode: code, signal, stdout, stderr, uidTaskMonitor });
    });
  });
}

async function probeImageAvailability(image) {
  const inner = [
    "docker", "image", "inspect", "--format", "{{.Id}}", image,
  ].map(shellQuote).join(" ");
  const command = `sg docker -c ${shellQuote(inner)}`;
  const execution = await execute({ inner });
  const status = execution.exitCode === 0 && execution.stdout.trim() !== ""
    ? "PRESENT"
    : execution.stderr.match(/no such image|no such object/i)
      ? "IMAGE_ABSENT"
      : "PROBE_FAILED";
  return {
    image,
    status,
    command,
    exitCode: execution.exitCode,
    stdout: execution.stdout.trim(),
    stderr: diagnosticTail(execution.stderr.trim()),
  };
}

async function probeImageNodeRuntime(image) {
  const script = "if command -v node >/dev/null 2>&1; then node --version; else echo NODE_MISSING; exit 42; fi";
  const inner = [
    "docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only",
    "--pids-limit", "16", "--memory", "33554432", "--memory-swap", "33554432",
    "--cpus", "0.1", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--entrypoint", "/bin/sh", image, "-c", script,
  ].map(shellQuote).join(" ");
  const execution = await execute({ inner });
  const status = execution.exitCode === 0
    ? "PRESENT"
    : execution.exitCode === 42 && execution.stdout.includes("NODE_MISSING")
      ? "MISSING"
      : "PROBE_FAILED";
  return {
    status,
    command: `sg docker -c ${shellQuote(inner)}`,
    exitCode: execution.exitCode,
    stdout: execution.stdout.trim(),
    stderr: diagnosticTail(execution.stderr.trim()),
  };
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const CAPSULES_ROOT = resolveCapsulesRoot(STATE_ROOT, process.env);
const campaignPath = resolve(STATE_ROOT, args.campaign);
const configPath = resolve(STATE_ROOT, args.config);
const outputPath = resolve(STATE_ROOT, args.output);
const campaignRel = assertRelativeToRepo(campaignPath, "campaign");
const configRel = assertRelativeToRepo(configPath, "config");
assertRelativeToRepo(outputPath, "output");

const campaign = readJson(campaignPath);
const developmentIds = campaign.corpusCohort?.developmentCapsuleIds;
const terminalIds = campaign.corpusCohort?.terminalCapsuleIds;
const excludedIds = campaign.calibration?.excludedCapsuleIds;
if (!Array.isArray(developmentIds) || !Array.isArray(terminalIds) || !Array.isArray(excludedIds)) {
  throw new Error("campaign lacks the frozen corpus cohort or calibration exclusions");
}
const capsuleIds = [...developmentIds, ...terminalIds];
if (new Set(capsuleIds).size !== capsuleIds.length) throw new Error("frozen cohort contains duplicate capsule ids");
const excludedOverlap = capsuleIds.filter((id) => excludedIds.includes(id));
if (excludedOverlap.length !== 0) {
  throw new Error(`excluded capsules also appear in the authorized cohort: ${excludedOverlap.join(", ")}`);
}
const capsules = findCapsules(capsuleIds);
const upstreamProbe = await probeUnreachableUpstream();
console.log(`preflight upstream guard: ${upstreamProbe.endpoint} -> ${upstreamProbe.result}`);
const imageProbes = new Map();
for (const image of [...new Set(capsuleIds.map((id) => capsules.get(id).image))].sort()) {
  console.log(`\n=== image probe: ${image} ===`);
  const availability = await probeImageAvailability(image);
  const nodeRuntime = availability.status === "PRESENT" ? await probeImageNodeRuntime(image) : null;
  imageProbes.set(image, { ...availability, nodeRuntime });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gateInvocation: "node capsule-kit/tools/preflight-m2-cohort-executability.mjs",
  campaign: campaignRel,
  config: configRel,
  upstreamProbe,
  cohort: {
    authorizedCount: capsuleIds.length,
    developmentCapsuleIds: developmentIds,
    terminalCapsuleIds: terminalIds,
    deliberatelyExcludedCapsuleIds: excludedIds,
  },
  imageProbes: [...imageProbes.values()],
  results: [],
  summary: null,
};

for (const capsuleId of capsuleIds) {
  const capsule = capsules.get(capsuleId);
  const baselineStore = baselineStoreRecord(capsule);
  const inner = `HONE_UPSTREAM_BASE_URL=${UPSTREAM_URL} ${[
    "node",
    HONE_BIN,
    "run",
    capsule.absoluteDir,
    "--headless",
    "--apply",
    "none",
    "--config",
    configRel,
  ].map(shellQuote).join(" ")}`;
  const exactCommand = `sg docker -c ${shellQuote(inner)}`;
  const imageProbe = imageProbes.get(capsule.image);
  const visibleAssetGroups = capsule.assetGroups.filter((group) => group.visibility !== "holdout");
  if (imageProbe.status !== "PRESENT" || visibleAssetGroups.length === 0) {
    const reason = imageProbe.status === "IMAGE_ABSENT"
      ? "pinned manifest image is not installed; policy forbids pulling or building it"
      : imageProbe.status !== "PRESENT"
        ? `pinned manifest image availability probe failed (${imageProbe.status})`
        : "bare CLI optimizer has no visible public/protected asset group; terminal holdout authority is unavailable";
    report.results.push({
      capsuleId,
      role: developmentIds.includes(capsuleId) ? "development" : "terminal",
      capsuleDir: capsule.capsuleDir,
      manifestPath: capsule.manifestPath,
      image: capsule.image,
      assetGroups: capsule.assetGroups,
      baselineStore,
      imageProbe,
      verdict: "UNTESTED",
      reason,
      command: exactCommand,
      runId: null,
      runRecords: null,
      exitCode: null,
      uid2000TaskMonitor: null,
      signal: null,
      runStatus: null,
      spend: null,
      completedEvaluations: [],
      rejectedCompletionEvents: [],
      diagnosticStdout: imageProbe.status === "PRESENT" ? "" : imageProbe.stdout,
      optimizerDiagnostic: "",
      diagnosticStderr: imageProbe.status === "PRESENT" ? "" : imageProbe.stderr,
    });
    writeReport(outputPath, report);
    continue;
  }
  console.log(`\n=== ${capsuleId} (${capsule.capsuleDir}) ===`);
  console.log(`$ ${exactCommand}`);
  const execution = await execute({ inner }, WORKER_UID);
  const stdoutRecords = parseJsonLines(execution.stdout);
  const started = stdoutRecords.find((record) => record.type === "run.started");
  const runId = typeof started?.runId === "string" ? started.runId : null;
  const events = readEvents(runId);
  const optimizerLog = readRunText(runId, "optimizer.log");
  const optimizerEvents = parseJsonLines(optimizerLog);
  const emittedCompletionEvents = [...events, ...optimizerEvents].filter((event) => event.type === "eval.completed");
  const completionEvents = emittedCompletionEvents.filter((event) => Number.isFinite(event.aggregate));
  const rejectedCompletionEvents = emittedCompletionEvents.filter((event) => !Number.isFinite(event.aggregate));
  const completedEvaluations = [];
  const completionKeys = new Set();
  for (const event of completionEvents) {
    const key = JSON.stringify([
      event.artifact?.hash ?? null,
      event.assetGroupId ?? null,
      event.seed ?? null,
      event.cached ?? null,
    ]);
    if (completionKeys.has(key)) continue;
    completionKeys.add(key);
    completedEvaluations.push(event);
  }
  const summaryRecord = [...stdoutRecords].reverse().find((record) => record.runId === runId && record.spend);
  const lastBudget = [...events].reverse().find((event) => event.type === "budget.snapshot")?.budget?.spent;
  const spend = summaryRecord?.spend ?? lastBudget ?? null;
  const tokens = spend?.tokens ?? null;
  const usd = spend?.usd ?? null;
  const evaluatorInvocations = spend?.evaluatorInvocations ?? completedEvaluations.length;
  const freshCompletedEvaluations = completedEvaluations.filter((event) => event.cached === false);
  const cachedCompletedEvaluations = completedEvaluations.filter((event) => event.cached !== false);
  const finished = [...events].reverse().find((event) => event.type === "run.finished");
  let verdict;
  let reason;
  if (runId === null) {
    verdict = "UNTESTED";
    reason = "trusted CLI did not mint a run id; see diagnostics";
  } else if (tokens === null || usd === null) {
    verdict = "UNTESTED";
    reason = "run records contain no authoritative spend record";
  } else if (tokens !== 0 || usd !== 0) {
    verdict = "SPEND_VIOLATION";
    reason = `run recorded non-zero model spend (${tokens} tokens, $${usd})`;
  } else if (freshCompletedEvaluations.length > 0) {
    verdict = "PASS";
    reason = `${freshCompletedEvaluations.length} fresh trusted eval.completed event(s) in run records`;
  } else if (cachedCompletedEvaluations.length > 0) {
    verdict = "CACHED_RESULT";
    reason = `${cachedCompletedEvaluations.length} cached eval.completed event(s); no evaluator execution was proven`;
  } else if (evaluatorInvocations > 0) {
    verdict = "FAIL";
    reason = rejectedCompletionEvents.length > 0
      ? `${rejectedCompletionEvents.length} eval.completed diagnostic event(s) had a non-finite aggregate; no trusted completion was recorded`
      : "engine burned an evaluator invocation without a trusted eval.completed run record";
  } else {
    verdict = "UNTESTED";
    reason = /exec: "node": executable file not found in \$PATH/.test(optimizerLog)
      ? "pinned manifest image lacks node required by the default optimizer run contract"
      : "run stopped before evaluator invocation";
  }
  report.results.push({
    capsuleId,
    role: developmentIds.includes(capsuleId) ? "development" : "terminal",
    capsuleDir: capsule.capsuleDir,
    manifestPath: capsule.manifestPath,
    image: capsule.image,
    assetGroups: capsule.assetGroups,
    baselineStore,
    imageProbe,
    verdict,
    reason,
    command: exactCommand,
    runId,
    runRecords: runId === null ? null : `.hone-runs/${runId}`,
    exitCode: execution.exitCode,
    signal: execution.signal,
    uid2000TaskMonitor: execution.uidTaskMonitor,
    runStatus: finished?.status ?? null,
    spend: spend === null ? null : {
      tokens,
      usd,
      wallClockSec: spend.wallClockSec ?? null,
      evaluatorInvocations,
    },
    completedEvaluations: completedEvaluations.map((event) => ({
      assetGroupId: event.assetGroupId,
      aggregate: event.aggregate,
      cached: event.cached,
      artifactHash: event.artifact?.hash ?? null,
    })),
    rejectedCompletionEvents: rejectedCompletionEvents.map((event) => ({
      assetGroupId: event.assetGroupId ?? null,
      aggregate: event.aggregate ?? null,
      cached: event.cached ?? null,
      artifactHash: event.artifact?.hash ?? null,
    })),
    diagnosticStdout: diagnosticTail(execution.stdout),
    diagnosticStderr: diagnosticTail(execution.stderr),
    optimizerDiagnostic: diagnosticTail(optimizerLog),
  });
  writeReport(outputPath, report);
  if (verdict === "SPEND_VIOLATION") {
    throw new Error(`${capsuleId} violated the zero-spend guard; stopped after writing ${relative(STATE_ROOT, outputPath)}`);
  }
}

const count = (verdict) => report.results.filter((result) => result.verdict === verdict).length;
report.summary = {
  provenExecutable: count("PASS"),
  failedAfterEvaluatorInvocation: count("FAIL"),
  cachedWithoutExecution: count("CACHED_RESULT"),
  untestedBeforeEvaluatorInvocation: count("UNTESTED"),
  spendViolations: count("SPEND_VIOLATION"),
  zeroTokenRuns: report.results.filter((result) => result.spend?.tokens === 0 && result.spend?.usd === 0).length,
  authorizedCount: capsuleIds.length,
  cleanCheckoutBaselineStores: report.results.filter((result) => result.baselineStore.tracked).length,
  untrackedBaselineStores: report.results.filter((result) => result.baselineStore.present && !result.baselineStore.tracked).length,
  runsWithPreexistingUid2000Tasks: report.results.filter((result) => (result.uid2000TaskMonitor?.before ?? 0) > 0).length,
  maxObservedUid2000Tasks: Math.max(
    0,
    ...report.results.map((result) => result.uid2000TaskMonitor?.max ?? 0),
  ),
};
writeReport(outputPath, report);
console.log(`\npreflight report: ${relative(STATE_ROOT, outputPath)}`);
console.log(`${report.summary.provenExecutable}/${report.summary.authorizedCount} proven executable; ${report.summary.failedAfterEvaluatorInvocation} FAIL; ${report.summary.cachedWithoutExecution} CACHED_RESULT; ${report.summary.untestedBeforeEvaluatorInvocation} UNTESTED; ${report.summary.spendViolations} spend violations`);
process.exitCode = report.summary.provenExecutable === report.summary.authorizedCount ? 0 : 1;
