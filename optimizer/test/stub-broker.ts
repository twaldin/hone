import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrokerMethods, EvaluationRecord, type BudgetEnvelope, type BudgetState } from "@hone/schema";
import { deferred } from "../src/deferred.js";
import { SANDBOX_WORKER_PATH, WORKER_PART_DIR } from "../src/loop.js";

/**
 * In-process scripted broker: a real net.Server speaking the newline JSON-RPC
 * wire protocol from @hone/schema, so loop tests exercise the actual client
 * framing. Behavior is scripted per call order; every request's params are
 * validated against the contract schema (a loop that sends malformed params
 * fails the test through an RPC error).
 */

const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export interface ExecStep {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface StubScript {
  objective?: string;
  baselineHash: string;
  /** Objectives returned for the baseline artifact. */
  baselineObjectives: Record<string, number>;
  /** Objectives per saveArtifact call index (1-based). Missing index => evaluating it is a test failure. */
  objectivesBySaveIndex: Record<number, Record<string, number>>;
  /** Seed-specific override: objectives keyed `${saveIndex}:${seed}`, consulted before objectivesBySaveIndex. */
  objectivesBySaveIndexAndSeed?: Record<string, Record<string, number>>;
  /** saveArtifact indices whose evaluation comes back output.valid=false. */
  invalidSaveIndices?: number[];
  /** Consumed in exec-call order; running past the end fails the test. */
  execPlan: ExecStep[];
  envelope: BudgetEnvelope;
}

export function stubHash(n: number): string {
  return `sha256:${String(n).padStart(64, "0")}`;
}

export function okStdout(approach: string): string {
  return `session log line\n${JSON.stringify({ summary: `did ${approach}`, approach, filesChanged: ["src/x.ts"] })}\n`;
}

interface PutFileRecord {
  sandboxId: string;
  path: string;
  content: string;
}

export class StubBroker {
  readonly socketPath: string;
  /** Episode-context putFiles only; worker-bundle chunks land in workerParts. */
  readonly putFiles: PutFileRecord[] = [];
  readonly savedArtifacts: string[] = [];
  /** Artifact hashes evaluated fresh (memo misses), in order. */
  readonly evaluated: string[] = [];
  /** Every evaluate ask (memo hits included) as `hash@seed`, in call order. */
  readonly evaluateAsks: string[] = [];
  readonly reportedIncumbents: string[] = [];
  readonly finished: string[] = [];
  /** Mutation-session execs only; worker probe/assembly execs are emulated structurally. */
  readonly execArgvs: string[][] = [];
  /** Every call in arrival order — `createSandbox:<id>`, `putFile:<sbId>:<path>`, `exec:<sbId>:<argv0>`, `evaluate:<hash>@<seed>`, ... */
  readonly ops: string[] = [];
  /** Worker-bundle chunk putFiles in arrival order (raw bytes preserved). */
  readonly workerParts: { sandboxId: string; path: string; bytes: Buffer }[] = [];
  /** One entry per successful in-sandbox assembly: the exact assembled bytes. */
  readonly workerTransfers: { sandboxId: string; bytes: Buffer }[] = [];
  /** The run's shared /scratch state: path -> bytes. Persists across sandboxes like the real volume. */
  readonly scratch = new Map<string, Buffer>();

  private readonly server: net.Server;
  private evalInvocations = 0;
  private execIndex = 0;
  private sandboxSeq = 0;
  private readonly sandboxParent = new Map<string, string>();
  private readonly saveIndexByHash = new Map<string, number>();
  private readonly memo = new Map<string, EvaluationRecord>();

  constructor(private readonly script: StubScript) {
    this.socketPath = join(mkdtempSync(join(tmpdir(), "hone-stub-")), "broker.sock");
    this.server = net.createServer((sock) => this.onConnection(sock));
  }

  async listen(): Promise<void> {
    const ready = deferred<void>();
    this.server.once("error", ready.reject);
    this.server.listen(this.socketPath, () => ready.resolve());
    await ready.promise;
  }

  async close(): Promise<void> {
    const closed = deferred<void>();
    this.server.close(() => closed.resolve());
    await closed.promise;
  }

  private onConnection(sock: net.Socket): void {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => sock.destroy());
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const resp = this.handle(line);
        if (!sock.destroyed) sock.write(`${JSON.stringify(resp)}\n`);
      }
    });
  }

  private handle(line: string): unknown {
    const req = RpcRequest.parse(JSON.parse(line));
    try {
      return { jsonrpc: "2.0", id: req.id, result: this.dispatch(req.method, req.params) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: "2.0", id: req.id, error: { code: -32006, message, data: { code: "INTERNAL" } } };
    }
  }

  private budgetNow(): BudgetState {
    return {
      envelope: this.script.envelope,
      spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: this.evalInvocations },
    };
  }

  private dispatch(method: string, rawParams: unknown): unknown {
    switch (method) {
      case "getTask": {
        BrokerMethods.getTask.params.parse(rawParams ?? {});
        return BrokerMethods.getTask.result.parse({
          capsuleId: "cap_000000000000",
          objective: this.script.objective ?? "make it faster without breaking tests",
          baselineArtifact: { hash: this.script.baselineHash },
          visibleAssetGroups: ["train", "validation"],
          budget: this.budgetNow(),
        });
      }
      case "createSandbox": {
        const params = BrokerMethods.createSandbox.params.parse(rawParams);
        const sandboxId = `sb_${String(++this.sandboxSeq).padStart(12, "0")}`;
        this.sandboxParent.set(sandboxId, params.artifact.hash);
        this.ops.push(`createSandbox:${sandboxId}`);
        return { sandboxId };
      }
      case "putFile": {
        const params = BrokerMethods.putFile.params.parse(rawParams);
        this.ops.push(`putFile:${params.sandboxId}:${params.path}`);
        const bytes = Buffer.from(params.contentBase64, "base64");
        if (params.path.startsWith("/scratch/")) this.scratch.set(params.path, bytes);
        if (params.path.startsWith(`${WORKER_PART_DIR}/`)) {
          this.workerParts.push({ sandboxId: params.sandboxId, path: params.path, bytes });
          return {};
        }
        this.putFiles.push({ sandboxId: params.sandboxId, path: params.path, content: bytes.toString("utf8") });
        return {};
      }
      case "exec": {
        const params = BrokerMethods.exec.params.parse(rawParams);
        this.ops.push(`exec:${params.sandboxId}:${params.argv.join(" ")}`);
        const emulated = this.workerProtocolExec(params.sandboxId, params.argv);
        if (emulated !== null) return BrokerMethods.exec.result.parse(emulated);
        this.execArgvs.push(params.argv);
        const step = this.script.execPlan[this.execIndex++];
        if (step === undefined) throw new Error(`unscripted exec call #${this.execIndex}`);
        return BrokerMethods.exec.result.parse({
          exitCode: step.exitCode,
          stdout: step.stdout ?? "",
          stderr: step.stderr ?? "",
          truncated: false,
        });
      }
      case "saveArtifact": {
        const params = BrokerMethods.saveArtifact.params.parse(rawParams);
        if (!this.sandboxParent.has(params.sandboxId)) throw new Error(`unknown sandbox ${params.sandboxId}`);
        const hash = stubHash(this.savedArtifacts.length + 1);
        this.savedArtifacts.push(hash);
        this.saveIndexByHash.set(hash, this.savedArtifacts.length);
        return { hash };
      }
      case "evaluate": {
        const params = BrokerMethods.evaluate.params.parse(rawParams);
        const key = `${params.artifact.hash}|${params.assetGroupId}|${params.seed}`;
        this.evaluateAsks.push(`${params.artifact.hash}@${params.seed}`);
        this.ops.push(`evaluate:${params.artifact.hash}@${params.seed}`);
        const memoized = this.memo.get(key);
        if (memoized !== undefined) return { ...memoized, cached: true };
        this.evalInvocations++;
        this.evaluated.push(params.artifact.hash);
        const record = EvaluationRecord.parse({
          capsuleId: "cap_000000000000",
          artifactHash: params.artifact.hash,
          assetGroupId: params.assetGroupId,
          seed: params.seed,
          output: this.outputFor(params.artifact.hash, params.seed),
          costUsd: 0,
          durationMs: 5,
          cached: false,
          evaluatedAt: new Date().toISOString(),
        });
        this.memo.set(key, record);
        return record;
      }
      case "reportIncumbent": {
        const params = BrokerMethods.reportIncumbent.params.parse(rawParams);
        this.reportedIncumbents.push(params.artifact.hash);
        return {};
      }
      case "getBudget": {
        BrokerMethods.getBudget.params.parse(rawParams ?? {});
        return this.budgetNow();
      }
      case "finish": {
        const params = BrokerMethods.finish.params.parse(rawParams);
        this.finished.push(params.best.hash);
        return {};
      }
      default:
        throw new Error(`unexpected method: ${method}`);
    }
  }

  /**
   * Emulate the loop's worker-transfer protocol against the shared /scratch
   * state: the sha256sum probe and the explicit-part-list assembly. Returns
   * null for anything else (a real mutation-session exec, scripted by
   * execPlan). Keeps existing tests' exec/putFile ledgers session-only.
   */
  private workerProtocolExec(
    sandboxId: string,
    argv: string[],
  ): { exitCode: number; stdout: string; stderr: string; truncated: false } | null {
    const shaLine = (bytes: Buffer): string =>
      `${createHash("sha256").update(bytes).digest("hex")}  ${SANDBOX_WORKER_PATH}\n`;
    if (argv.length === 2 && argv[0] === "sha256sum" && argv[1] === SANDBOX_WORKER_PATH) {
      const bytes = this.scratch.get(SANDBOX_WORKER_PATH);
      if (bytes === undefined) {
        return { exitCode: 1, stdout: "", stderr: `sha256sum: ${SANDBOX_WORKER_PATH}: No such file or directory`, truncated: false };
      }
      return { exitCode: 0, stdout: shaLine(bytes), stderr: "", truncated: false };
    }
    if (argv[0] === "sh" && argv[1] === "-c" && argv[2] !== undefined && argv[2].includes(`> ${SANDBOX_WORKER_PATH}`)) {
      const catList = (argv[2].split(" > ")[0] ?? "").split(/\s+/).slice(1);
      const chunks: Buffer[] = [];
      for (const part of catList) {
        const bytes = this.scratch.get(part);
        if (bytes === undefined) {
          return { exitCode: 1, stdout: "", stderr: `cat: ${part}: No such file or directory`, truncated: false };
        }
        chunks.push(bytes);
      }
      const assembled = Buffer.concat(chunks);
      this.scratch.set(SANDBOX_WORKER_PATH, assembled);
      for (const path of [...this.scratch.keys()]) {
        if (path.startsWith(`${WORKER_PART_DIR}/`)) this.scratch.delete(path);
      }
      this.workerTransfers.push({ sandboxId, bytes: assembled });
      return { exitCode: 0, stdout: shaLine(assembled), stderr: "", truncated: false };
    }
    return null;
  }

  private outputFor(hash: string, seed: number): Record<string, unknown> {
    if (hash === this.script.baselineHash) {
      return { valid: true, objectives: this.script.baselineObjectives, constraints: {}, perExample: {} };
    }
    const index = this.saveIndexByHash.get(hash);
    if (index === undefined) throw new Error(`evaluate of unknown artifact ${hash}`);
    if (this.script.invalidSaveIndices?.includes(index) === true) {
      return {
        valid: false,
        objectives: {},
        constraints: {},
        perExample: {},
        diagnostics: { summary: `candidate ${index} failed the harness` },
      };
    }
    const objectives =
      this.script.objectivesBySaveIndexAndSeed?.[`${index}:${seed}`] ?? this.script.objectivesBySaveIndex[index];
    if (objectives === undefined) throw new Error(`unscripted evaluation of artifact #${index} (${hash})`);
    return { valid: true, objectives, constraints: {}, perExample: {} };
  }
}
