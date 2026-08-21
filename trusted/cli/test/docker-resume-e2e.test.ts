import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import { CasStore, packDirAsArtifact } from "@hone/broker";
import { hone, honeSpawn, killTree, makeCapsule, makeRoot, sleep } from "./helpers.js";

const ENABLED = process.env["HONE_DURABLE_DOCKER_E2E"] === "1";
const MUTATION_IMAGE = "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10";

const OPTIMIZER_SOURCE = String.raw`
const net = require("node:net");
const onceEvent = require("node:events").once;
const promisify = require("node:util").promisify;
const socket = net.connect(process.env.HONE_BROKER_SOCK);
socket.setEncoding("utf8");
let nextId = 0;
let buffer = "";
const pending = new Map();
socket.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter === undefined) continue;
    pending.delete(response.id);
    if (response.error !== undefined) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response.result);
  }
});
const call = promisify((method, params, done) => {
  const id = ++nextId;
  pending.set(id, {
    resolve: (value) => done(null, value),
    reject: (error) => done(error),
  });
  socket.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
    token: process.env.HONE_BROKER_TOKEN,
  }) + "\n");
});
async function main() {
  await onceEvent(socket, "connect");
  const task = await call("getTask", {});
  const resume = JSON.parse(process.env.HONE_RESUME || "{}");
  const active = resume.activeEpisode;
  if (active === undefined) {
    const sandbox = await call("createSandbox", { artifact: task.baselineArtifact, role: "mutation" });
    await call("evaluate", { artifact: task.baselineArtifact, assetGroupId: "train", seed: 0 });
    const mutation = [
      "const fs=require('node:fs')",
      "fs.writeFileSync('/workspace/candidate.txt','candidate\\n')",
      "process.stdout.write(JSON.stringify({summary:'docker candidate',approach:'provider-boundary fake',filesChanged:['candidate.txt']})+'\\n')",
    ].join(";");
    await call("exec", { sandboxId: sandbox.sandboxId, argv: ["node", "-e", mutation] });
    const candidate = await call("saveArtifact", { sandboxId: sandbox.sandboxId });
    await call("evaluate", { artifact: candidate, assetGroupId: "train", seed: 0 });
    return;
  }
  if (active.candidate === null) throw new Error("resume checkpoint has no candidate");
  const claimed = await call("createSandbox", { artifact: active.parent, role: "mutation" });
  await call("evaluate", { artifact: active.parent, assetGroupId: "train", seed: 0, resume: true });
  await call("evaluate", { artifact: active.candidate.artifact, assetGroupId: "train", seed: 0, resume: true });
  await call("reportIncumbent", { artifact: active.candidate.artifact, claimed: { aggregate: 0.6 } });
  await call("completeEpisode", {
    episode: active.episode,
    releaseSandboxId: claimed.sandboxId,
  });
  await call("finish", { best: active.candidate.artifact });
  socket.end();
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
`;

function runIds(root: string): string[] {
  const dir = join(root, ".hone-runs");
  return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.startsWith("run_")) : [];
}

function eventLines(root: string, runId: string): string[] {
  const path = join(root, ".hone-runs", runId, "events.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
}

function events(root: string, runId: string): RunEvent[] {
  return eventLines(root, runId).map((line) => RunEvent.parse(JSON.parse(line)));
}

function stateFacts(root: string, runId: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, ".hone-runs", runId, "broker-state.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(!ENABLED)("real Docker backend interrupted-run durability", () => {
  it("kills after a journaled candidate evaluation, then claims, replays, retires, completes, and finishes", { timeout: 300_000 }, async () => {
    const configuredRoot = process.env["HONE_DURABLE_DOCKER_EVIDENCE_ROOT"];
    const root = configuredRoot ?? makeRoot();
    if (configuredRoot !== undefined) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
    }
    const evaluator = [
      "const fs=require('node:fs')",
      "const score=fs.existsSync('/workspace/candidate.txt')?0.6:0.5",
      "process.stdout.write(JSON.stringify({valid:true,objectives:{score},constraints:{tests_pass:true},perExample:{}}))",
    ].join(";");
    makeCapsule(root, { image: MUTATION_IMAGE, evalEntrypoint: ["node", "-e", evaluator] });
    const baselineDir = join(root, "capsule", "baseline");
    mkdirSync(baselineDir, { recursive: true });
    writeFileSync(join(baselineDir, "seed.txt"), "seed\n");
    const baselineHash = await packDirAsArtifact(baselineDir, new CasStore(join(root, ".hone-cas")));
    makeCapsule(root, {
      baseline: { kind: "cas", hash: baselineHash },
      image: MUTATION_IMAGE,
      evalEntrypoint: ["node", "-e", evaluator],
    });
    const optimizerCommand = `node -e eval(Buffer.from(\"${Buffer.from(OPTIMIZER_SOURCE).toString("base64")}\",\"base64\").toString())`;
    const env = {
      HONE_OPTIMIZER_CMD: optimizerCommand,
      HONE_OPTIMIZER_DIGEST: `sha256:${"f".repeat(64)}`,
      HONE_MUTATION_TIMEOUT_SEC: "180",
    };

    const child = honeSpawn(["run", "capsule", "--headless", "--backend", "local"], { cwd: root, env });
    let launchStderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      launchStderr += chunk.toString("utf8");
    });
    const childClosed = once(child, "close");
    let runId: string | undefined;
    try {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`initial Docker run exited ${child.exitCode}: ${launchStderr}`);
        }
        runId = runIds(root)[0];
        if (runId !== undefined) {
          const current = events(root, runId);
          if (
            current.some((event) => event.type === "episode.candidate")
            && current.filter((event) => event.type === "eval.completed").length === 2
          ) {
            killTree(child);
            break;
          }
        }
        // External Docker/CLI integration: poll the durable journal signal,
        // not an estimated process duration.
        await sleep(100);
      }
      expect(runId).toBeDefined();
      if (runId === undefined) throw new Error("run did not start");
      expect(events(root, runId).filter((event) => event.type === "eval.completed")).toHaveLength(2);
    } finally {
      killTree(child);
    }
    const [initialExitCode, initialSignal] = await childClosed;
    if (runId === undefined) throw new Error("run did not start");
    expect(events(root, runId).some((event) => event.type === "episode.completed")).toBe(false);
    expect(events(root, runId).some((event) => event.type === "run.finished")).toBe(false);

    const resumed = await hone(["run", "capsule", "--headless", "--resume"], { cwd: root, env });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(runIds(root)).toEqual([runId]);

    const finished = events(root, runId);
    expect(finished.filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(finished.filter((event) => event.type === "run.resumed")).toHaveLength(1);
    expect(finished.filter((event) => event.type === "episode.started")).toHaveLength(1);
    expect(finished.filter((event) => event.type === "episode.candidate")).toHaveLength(1);
    expect(finished.filter((event) => event.type === "eval.completed")).toHaveLength(2);
    expect(finished.filter((event) => event.type === "episode.completed")).toHaveLength(1);
    expect(finished.filter((event) => event.type === "run.finished")).toHaveLength(1);
    expect(finished.at(-1)).toMatchObject({ type: "run.finished", status: "completed" });
    expect(finished.some((event) => event.type === "run.finished" && event.status === "failed")).toBe(false);
    const finalBudget = finished.filter((event) => event.type === "budget.snapshot").at(-1);
    expect(finalBudget?.type).toBe("budget.snapshot");
    if (finalBudget?.type === "budget.snapshot") {
      expect(finalBudget.budget.spent.evaluatorInvocations).toBe(2);
    }
    const facts = stateFacts(root, runId);
    expect(facts.filter((fact) => fact["t"] === "episode")).toHaveLength(1);
    expect(facts.filter((fact) => fact["t"] === "eval")).toHaveLength(2);
    expect(facts.filter((fact) => fact["t"] === "episodeComplete")).toHaveLength(1);
    if (configuredRoot !== undefined) {
      const candidate = finished.find((event) => event.type === "episode.candidate");
      const last = finished.at(-1);
      writeFileSync(
        join(root, "evidence.v1.json"),
        `${JSON.stringify({
          version: 1,
          recordedAt: new Date().toISOString(),
          runId,
          zeroModelCalls: true,
          dockerImage: MUTATION_IMAGE,
          testCommand:
            `sg docker -c 'HONE_DURABLE_DOCKER_E2E=1 HONE_DURABLE_DOCKER_EVIDENCE_ROOT=${root} ./node_modules/.bin/vitest run --root trusted/cli test/docker-resume-e2e.test.ts'`,
          launch: {
            cwd: root,
            argv: ["hone", "run", "capsule", "--headless", "--backend", "local"],
            killAfter: "episode.candidate plus two eval.completed records, before episode.completed",
            exitCode: initialExitCode,
            signal: initialSignal,
          },
          resume: {
            cwd: root,
            argv: ["hone", "run", "capsule", "--headless", "--resume"],
            exitCode: resumed.code,
          },
          records: {
            events: `.hone-runs/${runId}/events.ndjson`,
            brokerState: `.hone-runs/${runId}/broker-state.ndjson`,
          },
          assertions: {
            runStarted: 1,
            runResumed: 1,
            episodeStarted: 1,
            episodeCandidate: 1,
            evaluatorInvocations: 2,
            episodeCompleted: 1,
            episodeCheckpointFacts: 1,
            evaluatorFacts: 2,
            episodeCompleteFacts: 1,
            finishedStatus: last?.type === "run.finished" ? last.status : null,
            candidate: candidate?.type === "episode.candidate" ? candidate.candidate.hash : null,
          },
        }, null, 2)}\n`,
      );
    }
  });
});
