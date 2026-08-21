import { afterAll, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CapsuleManifest, type RunEvent } from "@hone/schema";
import { Broker, CasStore, packDirAsArtifact, runCommand } from "../src/index.js";

const enabled = process.env.HONE_REAL_EVAL_UID_PROOF === "1";
const realDocker = describe.skipIf(!enabled);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CAPSULE_ROOT = join(REPO_ROOT, "capsules/flt-text-input");
const BASELINE_ROOT = join(CAPSULE_ROOT, "baseline");
const HOLDER_UID = Number(process.env.HONE_EVAL_UID_HOLDER_UID ?? "20001");
const CLIENT = { privileged: true, role: "admin" as const };
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
let proofRoot: string | undefined;

interface Harness {
  broker: Broker;
  cas: CasStore;
  baselineHash: string;
  events: RunEvent[];
}

async function countUidTasks(uid: number): Promise<number> {
  let count = 0;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      const match = /^Uid:\s+(\d+)/m.exec(status);
      if (Number(match?.[1]) !== uid) continue;
      count += (await readdir(`/proc/${name}/task`)).filter((entry) => /^\d+$/.test(entry)).length;
    } catch {
      // A process that exits during the scan contributes no standing task.
    }
  }
  return count;
}

async function reservedUidTaskCounts(): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(`/proc/${name}/status`, "utf8");
      const match = /^Uid:\s+(\d+)/m.exec(status);
      const uid = Number(match?.[1]);
      if (uid < 20_000 || uid > 20_031) continue;
      const tasks = (await readdir(`/proc/${name}/task`)).filter((entry) => /^\d+$/.test(entry)).length;
      counts.set(uid, (counts.get(uid) ?? 0) + tasks);
    } catch {
      // A process that exits during the scan contributes no standing task.
    }
  }
  return counts;
}
async function makeHarness(): Promise<Harness> {
  proofRoot ??= await mkdtemp(join(tmpdir(), "hone-eval-uid-proof-"));
  const id = randomUUID().replaceAll("-", "");
  const runDir = join(proofRoot, `run-${id}`);
  const casDir = join(proofRoot, `cas-${id}`);

  await mkdir(runDir, { recursive: true });
  const cas = new CasStore(casDir);
  const baselineHash = await packDirAsArtifact(BASELINE_ROOT, cas);
  const manifest = CapsuleManifest.parse(JSON.parse(await readFile(join(CAPSULE_ROOT, "manifest.json"), "utf8")));
  const events: RunEvent[] = [];
  const broker = new Broker({
    runId: `run-eval-uid-proof-${id}`,
    manifest,
    capsuleRootDir: CAPSULE_ROOT,
    baselineArtifactHash: baselineHash,
    capsuleDigest: DIGEST_A,
    optimizerDigest: DIGEST_B,
    image: manifest.image,
    runDir,
    casDir,
    holdoutLedgerPath: join(runDir, "holdout-ledger.ndjson"),
    runCommand,
    onEvent: (event) => events.push(event),
    maxConcurrentEvaluations: 4,
    maxMutationEpisodes: 1,
    evalTimeoutSec: 600,
  });
  await broker.init();
  return { broker, cas, baselineHash, events };
}

function isolationEvents(events: RunEvent[]): Extract<RunEvent, { type: "evaluator.isolation" }>[] {
  return events.filter((event): event is Extract<RunEvent, { type: "evaluator.isolation" }> =>
    event.type === "evaluator.isolation");
}

afterAll(async () => {
  if (proofRoot !== undefined) await rm(proofRoot, { recursive: true, force: true });
});

realDocker("real evaluator uid isolation", () => {
  it("keeps four M2-shaped FLT evaluations healthy beside at least 24 tasks in another reserved uid pool", { timeout: 600_000 }, async () => {
    expect(await countUidTasks(HOLDER_UID)).toBeGreaterThanOrEqual(24);
    const harness = await makeHarness();
    try {
      const records = await Promise.all(Array.from({ length: 4 }, (_, seed) =>
        harness.broker.evaluate({ artifact: { hash: harness.baselineHash }, assetGroupId: "train", seed }, CLIENT)));
      expect(records.map((record) => record.output.valid)).toEqual([true, true, true, true]);
      expect(records.map((record) => record.output.diagnostics?.summary)).toEqual([
        "14/41 sealed cases passed",
        "14/41 sealed cases passed",
        "14/41 sealed cases passed",
        "14/41 sealed cases passed",
      ]);
      const isolation = isolationEvents(harness.events);
      expect(isolation).toHaveLength(4);
      expect(isolation.every((event) => event.isolation.mode === "reserved-uid")).toBe(true);
      expect(new Set(isolation.map((event) => event.isolation.workerUid)).size).toBe(4);
      expect(isolation.every((event) => event.isolation.workerUid !== HOLDER_UID)).toBe(true);
      expect(records.map((record) => record.isolation?.workerUid).sort()).toEqual(
        isolation.map((event) => event.isolation.workerUid).sort(),
      );
      expect(records.every((record) => record.isolation?.mode === "reserved-uid")).toBe(true);
    } finally {
      await harness.broker.close();
    }
  });

  it("contains a fork-bomb-shaped FLT candidate at RLIMIT_NPROC=32 and reaps every task", { timeout: 600_000 }, async () => {
    expect(await countUidTasks(HOLDER_UID)).toBeGreaterThanOrEqual(24);
    const harness = await makeHarness();
    try {
      const candidateDir = join(proofRoot!, `fork-bomb-${randomUUID()}`);
      await cp(BASELINE_ROOT, candidateDir, { recursive: true });
      const source = await readFile(join(BASELINE_ROOT, "text_input.mjs"), "utf8");
      const trigger = "export function parseRawKey(key, raw) {";
      expect(source).toContain(trigger);
      const bomb = [
        "import { spawn as __spawn } from 'node:child_process'",
        "function __boundedForkBomb() {",
        "  for (let i = 0; i < 96; i += 1) {",
        "    const child = __spawn('/bin/sleep', ['60'])",
        "    child.on('error', () => {})",
        "    child.unref()",
        "  }",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)",
        "}",
        "",
      ].join("\n");
      await writeFile(join(candidateDir, "text_input.mjs"), `${bomb}${source.replace(trigger, `${trigger}\n    __boundedForkBomb();`)}`);
      const candidateHash = await packDirAsArtifact(candidateDir, harness.cas);

      let settled = false;
      const evaluation = harness.broker
        .evaluate({ artifact: { hash: candidateHash }, assetGroupId: "train", seed: 97 }, CLIENT)
        .then((record) => ({ record }), (error: unknown) => ({ error }))
        .finally(() => { settled = true; });
      const peakTasks = new Map<number, number>();
      while (!settled) {
        for (const [uid, count] of await reservedUidTaskCounts()) {
          peakTasks.set(uid, Math.max(peakTasks.get(uid) ?? 0, count));
        }
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
      const outcome = await evaluation;
      if ("error" in outcome) throw outcome.error;
      const isolation = isolationEvents(harness.events);
      expect(isolation).toHaveLength(1);
      const uid = isolation[0]!.isolation.workerUid;
      expect(peakTasks.get(uid) ?? 0).toBeGreaterThanOrEqual(20);
      expect(peakTasks.get(uid) ?? 0).toBeLessThanOrEqual(32);
      expect(outcome.record.isolation).toEqual(isolation[0]!.isolation);
      expect(await countUidTasks(uid)).toBe(0);
      expect(outcome.record.output.diagnostics?.summary).toMatch(/^\d+\/41 sealed cases passed$/);
    } finally {
      await harness.broker.close();
    }
  });
});
