import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { CapsuleManifest } from "@hone/schema";
import { deferred } from "../src/deferred.js";
import { runCommand } from "../src/command.js";

export const TEST_IMAGE = "busybox:1.36";

const RpcError = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({ code: z.string().optional(), detail: z.unknown().optional() }).optional(),
});
const RpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: RpcError.optional(),
});
export type RpcResponse = z.infer<typeof RpcResponse>;

/** Minimal newline-delimited JSON-RPC 2.0 client for wire-level tests. */
export class RpcClient {
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, (r: RpcResponse) => void>();

  private constructor(private sock: net.Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = RpcResponse.parse(JSON.parse(line));
        if (msg.id === null) continue;
        const cb = this.pending.get(msg.id);
        if (cb) {
          this.pending.delete(msg.id);
          cb(msg);
        }
      }
    });
  }

  static connect(socketPath: string): Promise<RpcClient> {
    const { promise, resolve, reject } = deferred<RpcClient>();
    const sock = net.connect(socketPath);
    sock.once("connect", () => resolve(new RpcClient(sock)));
    sock.once("error", reject);
    return promise;
  }

  /** Raw round-trip: returns the full JSON-RPC response (result or error). */
  callRaw(method: string, params: unknown = {}): Promise<RpcResponse> {
    const id = this.nextId++;
    const { promise, resolve } = deferred<RpcResponse>();
    this.pending.set(id, resolve);
    this.sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const resp = await this.callRaw(method, params);
    if (resp.error) {
      throw new Error(`${method} failed: ${resp.error.message} (${resp.error.data?.code ?? resp.error.code})`);
    }
    // Wire results are re-validated by callers with the appropriate schema.
    return resp.result as T;
  }

  /** Write a raw line onto the socket and await one response (framing tests). */
  sendRawLine(line: string): Promise<RpcResponse> {
    const { promise, resolve } = deferred<RpcResponse>();
    const onData = (chunk: string) => {
      // The constructor's data handler consumes id-matched messages; parse-error
      // responses have id null and are skipped there, so watch separately.
      const idx = chunk.indexOf("\n");
      if (idx >= 0) {
        this.sock.off("data", onData);
        resolve(RpcResponse.parse(JSON.parse(chunk.slice(0, idx))));
      }
    };
    this.sock.on("data", onData);
    this.sock.write(`${line}\n`);
    return promise;
  }

  close(): void {
    this.sock.destroy();
  }
}

/** Wait for the Docker daemon to accept commands (it may still be starting). */
export async function waitForDocker(timeoutMs = 180_000): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const res = await runCommand(["docker", "version", "--format", "{{.Server.Version}}"]);
    if (res.exitCode === 0) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`docker daemon not ready after ${timeoutMs}ms: ${res.stderr.toString()}`);
    }
    // Real wait is intentional: polling an external daemon that is still booting.
    const tick = deferred<void>();
    setTimeout(tick.resolve, 2_000);
    await tick.promise;
  }
}

export async function ensureImage(image: string): Promise<void> {
  const inspect = await runCommand(["docker", "image", "inspect", image]);
  if (inspect.exitCode === 0) return;
  const pull = await runCommand(["docker", "pull", image], { timeoutMs: 240_000 });
  if (pull.exitCode !== 0) throw new Error(`docker pull ${image} failed: ${pull.stderr.toString()}`);
}

const sha256 = (buf: Buffer | string): string => `sha256:${createHash("sha256").update(buf).digest("hex")}`;

/**
 * Eval entrypoint used by the test capsule: score = numeric content of
 * /workspace/answer.txt; feedback proves which asset group was mounted.
 */
const EVAL_SCRIPT = [
  'S="$(cat /workspace/answer.txt 2>/dev/null || echo 0)"',
  'A="$(cat /capsule/assets/train/data.txt 2>/dev/null || echo no-train-asset)"',
  'printf \'{"valid":true,"objectives":{"score":%s},"perExample":{"ex1":{"score":%s,"feedback":"asset=%s"}}}\' "$S" "$S" "$A"',
].join("\n");

export interface TestCapsule {
  manifest: CapsuleManifest;
  capsuleRootDir: string;
  baselineDir: string;
}

/**
 * Builds a capsule root on disk:
 *   train/data.txt        (public asset)
 *   protected/secret.txt  (protected asset — mutation sandboxes must never see it)
 *   holdout/holdout.txt   (holdout asset — admin-socket only)
 * plus a baseline workspace tree with answer.txt and a protected artifact file.
 */
export async function buildTestCapsule(
  baseDir: string,
  budget: { maxTokens: number; maxUsd: number; maxWallClockSec: number; maxEvaluatorInvocations: number },
): Promise<TestCapsule> {
  const capsuleRootDir = path.join(baseDir, "capsule");
  const files: Record<string, string> = {
    "train/data.txt": "train-data",
    "protected/secret.txt": "TOP-SECRET-FIXTURE",
    "holdout/holdout.txt": "holdout-data",
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(capsuleRootDir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  const contentHashes: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) contentHashes[rel] = sha256(content);

  const baselineDir = path.join(baseDir, "baseline");
  await mkdir(path.join(baselineDir, "protected"), { recursive: true });
  await writeFile(path.join(baselineDir, "answer.txt"), "1");
  await writeFile(path.join(baselineDir, "protected", "frozen.txt"), "do not touch");

  const manifest: CapsuleManifest = {
    schemaVersion: 1,
    id: "cap_0123456789ab",
    objective: "make the answer bigger without touching protected files",
    // Placeholder; tests overwrite with the packed baseline hash before use.
    baseline: { kind: "cas", hash: `sha256:${"0".repeat(64)}` },
    image: TEST_IMAGE,
    evalEntrypoint: ["sh", "-c", EVAL_SCRIPT],
    protectedPaths: ["protected/**"],
    assetGroups: [
      { id: "train", visibility: "public", paths: ["train"] },
      { id: "secret", visibility: "protected", paths: ["protected"] },
      { id: "holdout", visibility: "holdout", paths: ["holdout"] },
    ],
    budget,
    contentHashes,
  };
  return { manifest, capsuleRootDir, baselineDir };
}
