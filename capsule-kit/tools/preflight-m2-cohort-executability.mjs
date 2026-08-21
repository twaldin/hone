#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CAMPAIGN = "data/m2-refreeze/campaign-frozen.json";
const DEFAULT_CONFIG = "data/m2-refreeze/cohort-executability-preflight.config.json";
const DEFAULT_OUTPUT = "tmp/m2-cohort-executability-results.json";
const UPSTREAM_URL = "http://127.0.0.1:1";
const MAX_DIAGNOSTIC_CHARS = 16_384;

function usage() {
  return [
    "usage: node capsules/tools/preflight-m2-cohort-executability.mjs",
    "       [--campaign PATH] [--config PATH] [--output PATH]",
    "",
    "Runs every development and terminal capsule from the frozen M2 campaign",
    "through the real trusted CLI, Docker staging, and evaluator path. The",
    "upstream is pinned to unreachable 127.0.0.1:1 and any non-zero model",
    "token or USD spend stops the gate immediately.",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {
    campaign: DEFAULT_CAMPAIGN,
    config: DEFAULT_CONFIG,
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
  const rel = relative(REPO_ROOT, path);
  if (rel === "" || rel === ".." || rel.startsWith("../")) {
    throw new Error(`${label} must be a file under ${REPO_ROOT}`);
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
  for (const entry of readdirSync(join(REPO_ROOT, "capsules"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(REPO_ROOT, "capsules", entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (!wanted.has(manifest.id)) continue;
    if (found.has(manifest.id)) throw new Error(`duplicate capsule id ${manifest.id}`);
    found.set(manifest.id, {
      capsuleId: manifest.id,
      capsuleDir: `capsules/${entry.name}`,
      manifestPath: `capsules/${entry.name}/manifest.json`,
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

function baselineStoreRecord(capsuleDir) {
  const base = join(REPO_ROOT, capsuleDir, "baseline");
  const store = [".gitdir", ".git"].find((name) => existsSync(join(base, name)));
  if (store === undefined) {
    return { present: false, tracked: false, path: null, coreWorktree: null };
  }
  const storeRel = `${capsuleDir}/baseline/${store}`;
  const trackedCheck = spawnSync("git", ["ls-files", storeRel], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (trackedCheck.status !== 0) {
    throw new Error(`git ls-files failed for ${storeRel}: ${trackedCheck.stderr}`);
  }
  const configPath = join(REPO_ROOT, storeRel, "config");
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

function readEvents(runId) {
  if (runId === null) return [];
  const path = join(REPO_ROOT, ".hone-runs", runId, "events.ndjson");
  if (!existsSync(path)) return [];
  return parseJsonLines(readFileSync(path, "utf8"));
}

function execute(command) {
  return new Promise((resolveExecution, rejectExecution) => {
    const child = spawn("sg", ["docker", "-c", command.inner], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
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
    child.once("error", rejectExecution);
    child.once("close", (code, signal) => {
      resolveExecution({ exitCode: code, signal, stdout, stderr });
    });
  });
}

async function probeImageBun(image) {
  const script = "p=$(command -v bun 2>/dev/null) || { echo BUN_MISSING; exit 42; }; "
    + "v=$(bun --version 2>/dev/null) || { echo BUN_BROKEN; exit 43; }; "
    + "printf 'BUN_PRESENT\\t%s\\t%s\\n' \"$p\" \"$v\"";
  const inner = [
    "docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only",
    "--entrypoint", "/bin/sh", image, "-c", script,
  ].map(shellQuote).join(" ");
  const command = `sg docker -c ${shellQuote(inner)}`;
  const execution = await execute({ inner });
  const status = execution.exitCode === 0 && execution.stdout.startsWith("BUN_PRESENT")
    ? "PRESENT"
    : execution.exitCode === 42
      ? "MISSING"
      : execution.stderr.includes("No such image")
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

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
const campaignPath = resolve(REPO_ROOT, args.campaign);
const configPath = resolve(REPO_ROOT, args.config);
const outputPath = resolve(REPO_ROOT, args.output);
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
  imageProbes.set(image, await probeImageBun(image));
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gateInvocation: "node capsules/tools/preflight-m2-cohort-executability.mjs",
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
  const baselineStore = baselineStoreRecord(capsule.capsuleDir);
  const inner = `HONE_UPSTREAM_BASE_URL=${UPSTREAM_URL} ${[
    "node",
    "trusted/cli/bin/hone.js",
    "run",
    capsule.capsuleDir,
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
      : imageProbe.status === "MISSING"
        ? "pinned manifest image lacks bun required by the current optimizer bundle build path"
        : imageProbe.status !== "PRESENT"
          ? `pinned manifest image probe failed (${imageProbe.status})`
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
      command: imageProbe.status === "PRESENT" ? exactCommand : imageProbe.command,
      runId: null,
      runRecords: null,
      exitCode: imageProbe.status === "PRESENT" ? null : imageProbe.exitCode,
      signal: null,
      runStatus: null,
      spend: null,
      completedEvaluations: [],
      diagnosticStdout: imageProbe.status === "PRESENT" ? "" : imageProbe.stdout,
      diagnosticStderr: imageProbe.status === "PRESENT" ? "" : imageProbe.stderr,
    });
    writeReport(outputPath, report);
    continue;
  }
  console.log(`\n=== ${capsuleId} (${capsule.capsuleDir}) ===`);
  console.log(`$ ${exactCommand}`);
  const execution = await execute({ inner });
  const stdoutRecords = parseJsonLines(execution.stdout);
  const started = stdoutRecords.find((record) => record.type === "run.started");
  const runId = typeof started?.runId === "string" ? started.runId : null;
  const events = readEvents(runId);
  const summaryRecord = [...stdoutRecords].reverse().find((record) => record.runId === runId && record.spend);
  const lastBudget = [...events].reverse().find((event) => event.type === "budget.snapshot")?.budget?.spent;
  const spend = summaryRecord?.spend ?? lastBudget ?? null;
  const tokens = spend?.tokens ?? null;
  const usd = spend?.usd ?? null;
  const evaluatorInvocations = spend?.evaluatorInvocations
    ?? events.filter((event) => event.type === "eval.completed").length;
  const completedEvaluations = events.filter((event) => event.type === "eval.completed");
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
    reason = `${freshCompletedEvaluations.length} fresh trusted eval.completed event(s)`;
  } else if (cachedCompletedEvaluations.length > 0) {
    verdict = "CACHED_RESULT";
    reason = `${cachedCompletedEvaluations.length} cached eval.completed event(s); no evaluator execution was proven`;
  } else if (evaluatorInvocations > 0) {
    verdict = "FAIL";
    reason = "engine burned an evaluator invocation without eval.completed";
  } else {
    verdict = "UNTESTED";
    reason = "run stopped before evaluator invocation";
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
    diagnosticStdout: diagnosticTail(execution.stdout),
    diagnosticStderr: diagnosticTail(execution.stderr),
  });
  writeReport(outputPath, report);
  if (verdict === "SPEND_VIOLATION") {
    throw new Error(`${capsuleId} violated the zero-spend guard; stopped after writing ${relative(REPO_ROOT, outputPath)}`);
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
};
writeReport(outputPath, report);
console.log(`\npreflight report: ${relative(REPO_ROOT, outputPath)}`);
console.log(`${report.summary.provenExecutable}/${report.summary.authorizedCount} proven executable; ${report.summary.failedAfterEvaluatorInvocation} FAIL; ${report.summary.cachedWithoutExecution} CACHED_RESULT; ${report.summary.untestedBeforeEvaluatorInvocation} UNTESTED; ${report.summary.spendViolations} spend violations`);
process.exitCode = report.summary.provenExecutable === report.summary.authorizedCount ? 0 : 1;
