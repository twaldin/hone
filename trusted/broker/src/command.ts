import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { deferred } from "./deferred.js";

export interface CmdOptions {
  /** Bytes/string written to stdin, then stdin is closed. */
  stdin?: Buffer | string | undefined;
  /** File streamed to stdin (for large payloads, e.g. artifact tars). */
  stdinFile?: string | undefined;
  /**
   * Timeout semantics — read carefully: on expiry the LOCAL process group
   * (the spawned CLI and its host-side children) is SIGKILLed and `timedOut`
   * is set. For `docker` this kills only the CLIENT; work already running
   * INSIDE a container is untouched. A caller that owns a container MUST
   * treat `timedOut` as "container state unknown" and reap it (`docker rm
   * -f`) itself — the broker does exactly that for sandboxes and evals.
   */
  timeoutMs?: number | undefined;
  /** Per-stream capture cap; excess is dropped and `truncated` set. */
  maxOutputBytes?: number | undefined;
}

export interface CmdResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Injectable command runner — the broker's single seam to the `docker` CLI.
 * Tests wrap it to observe container spawns; production uses the default.
 */
export type RunCommand = (argv: readonly string[], opts?: CmdOptions) => Promise<CmdResult>;

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

export const runCommand: RunCommand = (argv, opts = {}) => {
  const { promise, resolve, reject } = deferred<CmdResult>();
  const [cmd, ...args] = argv;
  if (!cmd) {
    reject(new Error("runCommand: empty argv"));
    return promise;
  }
  // detached: the child leads its own process group, so a timeout kill takes
  // out any host-side helpers it spawned — not just the top-level CLI.
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  let truncated = false;
  const collect = (stream: Readable): Buffer[] => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (size >= cap) {
        truncated = true;
        return; // keep draining so the child never blocks on a full pipe
      }
      const room = cap - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = cap;
        truncated = true;
      } else {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    return chunks;
  };
  const outChunks = collect(child.stdout);
  const errChunks = collect(child.stderr);

  let timedOut = false;
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          // Kill the local process GROUP (see CmdOptions.timeoutMs): this
          // never reaches in-container work — the caller owns that cleanup.
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, opts.timeoutMs)
      : undefined;

  child.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(outChunks),
      stderr: Buffer.concat(errChunks),
      truncated,
      timedOut,
    });
  });

  child.stdin.on("error", () => {
    // Child exited before consuming stdin (e.g. docker printed usage) — the
    // close handler still reports the real exit code.
  });
  if (opts.stdinFile !== undefined) {
    createReadStream(opts.stdinFile).pipe(child.stdin);
  } else {
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  }
  return promise;
};
