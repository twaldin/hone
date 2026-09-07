import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { BrokerServer, DEFAULT_MAX_FRAME_BYTES, FrameDecoder } from "../src/server.js";
import { deferred } from "../src/deferred.js";
import { buildTestCapsule, TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST } from "./helpers.js";

/** Per-broker public bearer (>=32 bytes) — both public transports require it on every request. */
const PUBLIC_TOKEN = "framing-test-public-token-".padEnd(64, "f");

// ---------------------------------------------------------------------------
// RPC framing hardening: a client that drips one byte per chunk must cost
// O(total bytes), not O(n^2) re-concatenation, while max-frame semantics and
// multi-frame handling stay byte-identical to the historical parser.
// ---------------------------------------------------------------------------

describe("FrameDecoder", () => {
  it("reassembles a max-size frame from a one-byte drip with every byte copied at most once", () => {
    const size = DEFAULT_MAX_FRAME_BYTES; // 1 MiB — the acceptance scenario
    const decoder = new FrameDecoder(size);
    const line = "x".repeat(size);
    const byte = Buffer.from("x");
    let earlyFrames = 0;
    let earlyError: string | undefined;
    for (let i = 0; i < size; i++) {
      const step = decoder.push(byte);
      earlyFrames += step.frames.length;
      earlyError ??= step.error;
    }
    expect(earlyError).toBeUndefined();
    expect(earlyFrames).toBe(0);
    const done = decoder.push(Buffer.from("\n"));
    expect(done.error).toBeUndefined();
    expect(done.frames).toHaveLength(1);
    expect(done.frames[0]?.line).toBe(line);
    expect(done.frames[0]?.bytes).toBe(size + 1);
    // Instrumented linearity proof: reassembly copied exactly the frame's
    // bytes once. The old per-chunk Buffer.concat repurchase would have
    // copied ~size^2/2 bytes (≈512 GiB for 1 MiB) and never finished.
    expect(decoder.copiedBytes).toBe(size);
  });

  it("accepts a line of exactly maxFrameBytes and rejects one byte more", () => {
    const ok = new FrameDecoder(16).push(Buffer.from(`${"x".repeat(16)}\n`));
    expect(ok.error).toBeUndefined();
    expect(ok.frames).toHaveLength(1);
    expect(ok.frames[0]?.bytes).toBe(17);

    const over = new FrameDecoder(16).push(Buffer.from(`${"x".repeat(17)}\n`));
    expect(over.error).toMatch(/frame exceeds 16 bytes/);
    expect(over.frames).toHaveLength(0);
  });

  it("rejects an unterminated fragment as soon as it outgrows the cap", () => {
    const decoder = new FrameDecoder(16);
    expect(decoder.push(Buffer.from("x".repeat(16))).error).toBeUndefined();
    expect(decoder.push(Buffer.from("x")).error).toMatch(/frame exceeds 16 bytes/);
  });

  it("splits multiple frames within one chunk and joins frames across chunk boundaries", () => {
    const decoder = new FrameDecoder(64);
    const first = decoder.push(Buffer.from("a\nbb\nccc"));
    expect(first.error).toBeUndefined();
    expect(first.frames.map((f) => f.line)).toEqual(["a", "bb"]);
    expect(first.frames.map((f) => f.bytes)).toEqual([2, 3]);
    const second = decoder.push(Buffer.from("c\ndddd\n"));
    expect(second.error).toBeUndefined();
    expect(second.frames.map((f) => f.line)).toEqual(["cccc", "dddd"]);
    // Wire-byte accounting includes the fragment bytes buffered earlier.
    expect(second.frames.map((f) => f.bytes)).toEqual([5, 5]);
  });

  it("still delivers frames completed before a cap violation in the same chunk", () => {
    const decoder = new FrameDecoder(8);
    const { frames, error } = decoder.push(Buffer.from(`ok\n${"y".repeat(20)}`));
    expect(frames.map((f) => f.line)).toEqual(["ok"]);
    expect(error).toMatch(/frame exceeds 8 bytes/);
  });
});

describe("wire integration + unix socket modes", () => {
  let base: string;
  let broker: Broker;
  const servers: BrokerServer[] = [];
  let sockN = 0;

  async function makeServer(): Promise<{ server: BrokerServer; socketPath: string; adminSocketPath: string }> {
    sockN++;
    const socketPath = path.join(base, "run", `f${sockN}.sock`);
    const adminSocketPath = path.join(base, "run", `f${sockN}a.sock`);
    const server = new BrokerServer(broker, { socketPath, adminSocketPath, publicToken: PUBLIC_TOKEN, maxFrameBytes: 4096 });
    await server.listen();
    servers.push(server);
    return { server, socketPath, adminSocketPath };
  }

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "hone-framing-"));
    const capsule = await buildTestCapsule(base, {
      maxTokens: 1_000_000,
      maxUsd: 100,
      maxWallClockSec: 3600,
      maxEvaluatorInvocations: 100,
    });
    broker = new Broker({
      runId: "run_framing_test",
      manifest: capsule.manifest,
      capsuleRootDir: capsule.capsuleRootDir,
      baselineArtifactHash: `sha256:${"0".repeat(64)}`,
      capsuleDigest: TEST_CAPSULE_DIGEST,
      optimizerDigest: TEST_OPTIMIZER_DIGEST,
      holdoutLedgerPath: path.join(base, "run", "holdout-ledger.ndjson"),
      image: TEST_IMAGE,
      runDir: path.join(base, "run"),
      casDir: path.join(base, "cas"),
      onEvent: () => {},
    });
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
    await rm(base, { recursive: true, force: true });
  });

  it("serves a request dripped one byte at a time and pipelined frames in one chunk", async () => {
    const { socketPath } = await makeServer();
    const sock = net.connect(socketPath);
    const connected = deferred<void>();
    sock.once("connect", connected.resolve);
    sock.once("error", connected.reject);
    await connected.promise;

    const lines: string[] = [];
    const gotLines = deferred<void>();
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (lines.length >= 3) gotLines.resolve();
    });

    // Frame 1 (dripped byte-by-byte, padded to ~2 KiB), then frames 2+3 in one chunk.
    const dripped = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "nope",
      params: { pad: "p".repeat(2000) },
      token: PUBLIC_TOKEN,
    })}\n`;
    for (const ch of dripped) sock.write(ch);
    sock.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "nope", params: {}, token: PUBLIC_TOKEN })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope", params: {}, token: PUBLIC_TOKEN })}\n`,
    );

    await gotLines.promise;
    const responses = lines.map((l) => JSON.parse(l) as { id: number; error?: { code: number } });
    expect(new Set(responses.map((r) => r.id))).toEqual(new Set([1, 2, 3]));
    for (const r of responses) expect(r.error?.code).toBe(-32601); // reassembled into valid requests
    sock.destroy();
  });

  it("public socket is 0666 (cross-uid optimizer can connect); admin socket stays owner-only 0600", async () => {
    const { socketPath, adminSocketPath } = await makeServer();
    expect(((await stat(socketPath)).mode & 0o777).toString(8)).toBe("666");
    expect(((await stat(adminSocketPath)).mode & 0o777).toString(8)).toBe("600");
  });
});
