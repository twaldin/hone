import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BrokerMethods, EvaluationRecord, type BudgetEnvelope, type BudgetState } from "@hone/schema";
import { deferred } from "../src/deferred.js";

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
  readonly putFiles: PutFileRecord[] = [];
  readonly savedArtifacts: string[] = [];
  /** Artifact hashes evaluated fresh (memo misses), in order. */
  readonly evaluated: string[] = [];
  readonly reportedIncumbents: string[] = [];
  readonly finished: string[] = [];
  readonly execArgvs: string[][] = [];

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
        return { sandboxId };
      }
      case "putFile": {
        const params = BrokerMethods.putFile.params.parse(rawParams);
        this.putFiles.push({
          sandboxId: params.sandboxId,
          path: params.path,
          content: Buffer.from(params.contentBase64, "base64").toString("utf8"),
        });
        return {};
      }
      case "exec": {
        const params = BrokerMethods.exec.params.parse(rawParams);
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
        const memoized = this.memo.get(key);
        if (memoized !== undefined) return { ...memoized, cached: true };
        this.evalInvocations++;
        this.evaluated.push(params.artifact.hash);
        const record = EvaluationRecord.parse({
          capsuleId: "cap_000000000000",
          artifactHash: params.artifact.hash,
          assetGroupId: params.assetGroupId,
          seed: params.seed,
          output: this.outputFor(params.artifact.hash),
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

  private outputFor(hash: string): Record<string, unknown> {
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
    const objectives = this.script.objectivesBySaveIndex[index];
    if (objectives === undefined) throw new Error(`unscripted evaluation of artifact #${index} (${hash})`);
    return { valid: true, objectives, constraints: {}, perExample: {} };
  }
}
