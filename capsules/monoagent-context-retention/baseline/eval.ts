import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  REQUIRED_GROUPS,
  WEIGHT_VERSION,
  buildRetentionInput,
  canonicalJson,
  expectedBankSeal,
  groupCounts,
  isFixtureBank,
  isGroupBalanced,
} from "./fixture.ts";
import type { FixtureBank, FixtureCase } from "./fixture.ts";
import type {
  EncodingName,
  ProjectedRecord,
  RetentionInput,
  SourceRecord,
} from "./contract.ts";

const TRUSTED_DIR = import.meta.dir;
const WORKER_PATH = join(TRUSTED_DIR, "worker.ts");
const WORKSPACE = resolve(process.env.CAPSULE_WORKSPACE ?? "/workspace");
const ASSETS = resolve(process.env.CAPSULE_ASSETS ?? "/capsule/assets");
const WORKER_UID = 2000;
const CALL_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 256_000;
const MAX_REQUEST_BYTES = 2_000_000;
const RETENTION: Record<EncodingName, number> = { full: 1, compact: 0.78, preview: 0.48 };

interface PerExample {
  readonly score: number;
  readonly feedback: unknown;
}

interface CandidateResponse {
  readonly projection?: string;
  readonly error?: string;
}

export interface ProjectionAssessment {
  readonly valid: boolean;
  readonly currentPreserved: boolean;
  readonly withinCap: boolean;
  readonly authentic: boolean;
  readonly score: number;
  readonly rawRecall: number;
  readonly chars: number;
  readonly selectedCount: number;
  readonly penalty: number;
  readonly issues: readonly string[];
}

interface EvaluationCaseResult {
  readonly assessment: ProjectionAssessment;
  readonly perExample: PerExample;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function assetJsonFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...assetJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files.sort();
}

function loadBanks(): FixtureBank[] {
  const files = assetJsonFiles(ASSETS);
  if (files.length === 0) throw new Error("fixture asset group contains no JSON bank");
  return files.map((path) => {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isFixtureBank(parsed)) throw new Error(`invalid fixture bank ${basename(path)}`);
    if (parsed.seal !== expectedBankSeal(parsed)) throw new Error(`fixture bank seal mismatch ${basename(path)}`);
    if (!isGroupBalanced(parsed.cases)) throw new Error(`fixture bank is not group-balanced ${basename(path)}`);
    return parsed;
  });
}

function candidatePids(): number[] {
  if (!runningAsRoot()) return [];
  const found: number[] = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const status = readFileSync(join("/proc", entry.name, "status"), "utf8");
      const uidLine = status.split("\n").find((line) => line.startsWith("Uid:"));
      const realUid = uidLine?.trim().split(/\s+/)[1];
      if (realUid === String(WORKER_UID)) found.push(Number(entry.name));
    } catch {
      // A process may exit between /proc enumeration and status read.
    }
  }
  return found;
}

async function resetCandidateState(): Promise<void> {
  if (!runningAsRoot()) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pids = candidatePids();
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await Bun.sleep(5);
    if (attempt === 4 && candidatePids().length > 0) {
      throw new Error("candidate uid processes survived reset");
    }
  }
  for (const root of ["/tmp", "/dev/shm", "/dev/mqueue"]) {
    try {
      for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
    } catch {
      // Some minimal images omit optional IPC filesystems.
    }
  }
}

async function readLimited(stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > maximum) {
      await reader.cancel("response too large");
      throw new Error(`worker stream exceeded ${maximum} bytes`);
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function callCandidate(input: RetentionInput): Promise<CandidateResponse> {
  await resetCandidateState();
  const nonce = randomBytes(16).toString("hex");
  const request = `${JSON.stringify({ nonce, input })}\n`;
  if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) return { error: "trusted request exceeds worker boundary" };

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/candidate-home",
    CAPSULE_WORKSPACE: WORKSPACE,
    NO_PROXY: "*",
    no_proxy: "*",
  };
  const child = Bun.spawn(["bun", "--smol", WORKER_PATH], {
    cwd: WORKSPACE,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(runningAsRoot() ? { uid: WORKER_UID, gid: WORKER_UID } : {}),
  });
  child.stdin.write(request);
  child.stdin.end();
  let settled = false;
  const timedExit = Bun.sleep(CALL_TIMEOUT_MS).then(() => {
    if (!settled) child.kill("SIGKILL");
    return { timedOut: !settled, exitCode: -1 };
  });
  const normalExit = child.exited.then((exitCode) => {
    settled = true;
    return { timedOut: false, exitCode };
  });
  try {
    const stdoutPromise = readLimited(child.stdout, MAX_RESPONSE_BYTES);
    const stderrPromise = readLimited(child.stderr, 16_384);
    const exit = await Promise.race([normalExit, timedExit]);
    settled = true;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (exit.timedOut) return { error: `worker timeout after ${CALL_TIMEOUT_MS} ms` };
    if (exit.exitCode !== 0) return { error: `worker exited ${exit.exitCode}: ${stderr.slice(0, 300)}` };
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isRecord(parsed) || parsed.nonce !== nonce || typeof parsed.projection !== "string") {
      return { error: "invalid worker response envelope" };
    }
    return { projection: parsed.projection };
  } catch (error) {
    settled = true;
    child.kill("SIGKILL");
    await child.exited;
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await resetCandidateState();
  }
}

function projectedRecord(value: unknown): ProjectedRecord | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 3) return undefined;
  if (typeof value.id !== "string" || typeof value.encoding !== "string" || typeof value.body !== "string") {
    return undefined;
  }
  if (value.encoding !== "full" && value.encoding !== "compact" && value.encoding !== "preview") {
    return undefined;
  }
  return { id: value.id, encoding: value.encoding, body: value.body };
}

export function assessProjection(
  input: RetentionInput,
  fixture: FixtureCase,
  projection: string | undefined,
  workerError: string | undefined,
): ProjectionAssessment {
  const issues: string[] = [];
  const chars = projection?.length ?? 0;
  const overflow = Math.max(0, chars - input.maxWindowChars);
  if (workerError !== undefined) issues.push(`worker:${workerError}`);
  if (projection === undefined) issues.push("missing-projection");

  let versionOk = false;
  let currentPreserved = false;
  let recordsArray = false;
  const selected: ProjectedRecord[] = [];
  if (projection !== undefined) {
    try {
      const parsed: unknown = JSON.parse(projection);
      if (!isRecord(parsed)) issues.push("projection-not-object");
      else {
        versionOk = parsed.version === 1;
        if (!versionOk) issues.push("version");
        currentPreserved = canonicalJson(parsed.current) === canonicalJson(input.current);
        if (!currentPreserved) issues.push("current");
        recordsArray = Array.isArray(parsed.records);
        if (!recordsArray) issues.push("records-not-array");
        else {
          for (const value of parsed.records) {
            const record = projectedRecord(value);
            if (record === undefined) issues.push("invalid-record-shape");
            else selected.push(record);
          }
        }
      }
    } catch {
      issues.push("projection-json");
    }
  }

  const sourceById = new Map(input.records.map((record) => [record.id, record]));
  const seen = new Set<string>();
  let duplicates = 0;
  let fabricated = 0;
  let retainedUtility = 0;
  for (const item of selected) {
    if (seen.has(item.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(item.id);
    const source = sourceById.get(item.id);
    if (source === undefined) {
      fabricated += 1;
      continue;
    }
    const registered = source.encodings.find((encoding) =>
      encoding.name === item.encoding && encoding.body === item.body
    );
    if (registered === undefined) {
      fabricated += 1;
      continue;
    }
    const weight = fixture.oracle[item.id];
    if (weight === undefined) {
      fabricated += 1;
      continue;
    }
    retainedUtility += weight * RETENTION[item.encoding];
  }
  if (duplicates > 0) issues.push(`duplicate:${duplicates}`);
  if (fabricated > 0) issues.push(`fabricated:${fabricated}`);
  if (overflow > 0) issues.push(`overflow:${overflow}`);

  const optimum = feasibleOptimum(input, fixture.oracle);
  const total = Object.values(fixture.oracle).reduce((sum, weight) => sum + weight, 0);
  const normalized = optimum > 0 ? retainedUtility / optimum : 0;
  const rawRecall = total > 0 ? retainedUtility / total : 0;
  const penalty = duplicates * 0.25 + fabricated * 0.5 + overflow / input.maxWindowChars +
    (currentPreserved ? 0 : 1) + (versionOk && recordsArray ? 0 : 1);
  const withinCap = overflow === 0;
  const authentic = duplicates === 0 && fabricated === 0 && recordsArray;
  const valid = workerError === undefined && versionOk && currentPreserved && withinCap && authentic;
  return {
    valid,
    currentPreserved,
    withinCap,
    authentic,
    score: valid ? Math.max(0, normalized - penalty) : 0,
    rawRecall,
    chars,
    selectedCount: selected.length,
    penalty,
    issues,
  };
}

function feasibleOptimum(input: RetentionInput, weights: Readonly<Record<string, number>>): number {
  const emptyLength = JSON.stringify({ version: 1, current: input.current, records: [] }).length;
  const budget = input.maxWindowChars - emptyLength + 1;
  if (budget <= 0) return 0;
  let states = new Map<number, number>([[0, 0]]);
  for (const record of input.records) {
    const next = new Map(states);
    const weight = weights[record.id];
    if (weight === undefined) throw new Error(`oracle missing ${record.id}`);
    for (const [spent, utility] of states) {
      for (const candidate of record.encodings) {
        const projected = { id: record.id, encoding: candidate.name, body: candidate.body };
        const nextSpent = spent + JSON.stringify(projected).length + 1;
        if (nextSpent > budget) continue;
        const nextUtility = utility + weight * RETENTION[candidate.name];
        if (nextUtility > (next.get(nextSpent) ?? Number.NEGATIVE_INFINITY)) {
          next.set(nextSpent, nextUtility);
        }
      }
    }
    const pruned = new Map<number, number>();
    let best = Number.NEGATIVE_INFINITY;
    for (const [spent, utility] of [...next].sort((a, b) => a[0] - b[0])) {
      if (utility <= best) continue;
      pruned.set(spent, utility);
      best = utility;
    }
    states = pruned;
  }
  return Math.max(...states.values());
}

async function evaluateCase(fixture: FixtureCase): Promise<EvaluationCaseResult> {
  const input = buildRetentionInput(fixture);
  const response = await callCandidate(input);
  const assessment = assessProjection(input, fixture, response.projection, response.error);
  return {
    assessment,
    perExample: {
      score: assessment.score,
      feedback: {
        valid: assessment.valid,
        q: assessment.score,
        rawWeightedRecall: assessment.rawRecall,
        chars: `${assessment.chars}/${input.maxWindowChars}`,
        selectedRecords: assessment.selectedCount,
        issues: assessment.issues,
      },
    },
  };
}

async function main(): Promise<void> {
  const banks = loadBanks();
  const cases = banks.flatMap((bank) => bank.cases);
  const allCaseIds = new Set(cases.map((fixture) => fixture.id));
  if (allCaseIds.size !== cases.length) throw new Error("duplicate case id across fixture banks");
  const combinedGroups = groupCounts(cases);
  const banksSealed = banks.every((bank) => bank.seal === expectedBankSeal(bank));
  const balanced = banks.every((bank) => isGroupBalanced(bank.cases));
  const results: EvaluationCaseResult[] = [];
  const perExample: Record<string, PerExample> = {};
  for (const fixture of cases) {
    const result = await evaluateCase(fixture);
    results.push(result);
    perExample[fixture.id] = result.perExample;
  }
  const assessments = results.map((result) => result.assessment);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const currentPreserved = assessments.every((assessment) => assessment.currentPreserved);
  const hardCap = assessments.every((assessment) => assessment.withinCap);
  const sourceAuthentic = assessments.every((assessment) => assessment.authentic);
  const testsPass = cases.length >= 12 && REQUIRED_GROUPS.length >= 4 && banksSealed && balanced &&
    currentPreserved && hardCap && sourceAuthentic && assessments.every((assessment) => assessment.valid);
  const q = mean(assessments.map((assessment) => assessment.score));
  const output = {
    valid: testsPass,
    objectives: { q },
    constraints: {
      tests_pass: testsPass,
      current_preserved: currentPreserved,
      hard_cap: hardCap,
      source_authentic: sourceAuthentic,
      cases_sealed: banksSealed,
      group_balanced: balanced,
      no_model_or_service: true,
    },
    perExample,
    diagnostics: {
      summary: `${cases.length} deterministic in-memory SQLite states; groups ${canonicalJson(combinedGroups)}; no model, network, service, or score-time wall clock`,
      quality: assessments.length === 0 ? 0 : assessments.filter((assessment) => assessment.valid).length / assessments.length,
      q,
      qFail: 0,
      rawWeightedRecall: mean(assessments.map((assessment) => assessment.rawRecall)),
      weightVersion: WEIGHT_VERSION,
      caseCount: cases.length,
      groupCount: Object.keys(combinedGroups).length,
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (import.meta.main) await main();
