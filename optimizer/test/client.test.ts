import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerClient, parseBrokerEndpoint } from "../src/client.js";
import { deferred } from "../src/deferred.js";

/**
 * Broker endpoint plumbing for the containerized optimizer: unix socket paths
 * stay unix, tcp://host:port dials TCP, and the runner-injected capability is
 * attached to EVERY request as the top-level "token" field — resolved from
 * HONE_BROKER_TOKEN when not passed explicitly, and never emitted anywhere
 * else.
 */

describe("parseBrokerEndpoint", () => {
  it("treats a bare path as a unix socket", () => {
    expect(parseBrokerEndpoint("/run/hone/broker.sock")).toEqual({ kind: "unix", path: "/run/hone/broker.sock" });
    expect(parseBrokerEndpoint("relative/broker.sock")).toEqual({ kind: "unix", path: "relative/broker.sock" });
  });

  it("parses tcp://host:port", () => {
    expect(parseBrokerEndpoint("tcp://host.docker.internal:49123")).toEqual({ kind: "tcp", host: "host.docker.internal", port: 49123 });
    expect(parseBrokerEndpoint("tcp://127.0.0.1:1")).toEqual({ kind: "tcp", host: "127.0.0.1", port: 1 });
  });

  it("rejects malformed tcp endpoints", () => {
    for (const bad of ["tcp://", "tcp://host", "tcp://host:", "tcp://host:0", "tcp://host:65536", "tcp://:8080", "tcp://host:abc"]) {
      expect(() => parseBrokerEndpoint(bad), bad).toThrow(/invalid tcp broker endpoint/);
    }
  });
});

interface CapturedRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown;
  token?: string;
}

/** One-shot line server: captures the first request, answers it with a valid getBudget result. */
function captureServer(): { server: net.Server; first: Promise<CapturedRequest> } {
  const first = deferred<CapturedRequest>();
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as CapturedRequest;
      first.resolve(req);
      const budget = {
        envelope: { maxTokens: 1, maxUsd: 1, maxWallClockSec: 1, maxEvaluatorInvocations: 1 },
        spent: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
      };
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: budget })}\n`);
    });
  });
  return { server, first: first.promise };
}

async function listenTcp(server: net.Server): Promise<number> {
  const ready = deferred<void>();
  server.once("error", ready.reject);
  server.listen(0, "127.0.0.1", () => ready.resolve());
  await ready.promise;
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no tcp address");
  return addr.port;
}

describe("BrokerClient transport + auth", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
    delete process.env["HONE_BROKER_TOKEN"];
  });

  it("dials tcp:// and attaches the explicit token to every request", async () => {
    const { server, first } = captureServer();
    const port = await listenTcp(server);
    cleanups.push(() => server.close());
    const client = await BrokerClient.connect(`tcp://127.0.0.1:${port}`, { token: "cap-".padEnd(64, "x") });
    cleanups.push(() => client.close());
    await client.getBudget();
    const req = await first;
    expect(req.token).toBe("cap-".padEnd(64, "x"));
    expect(req.jsonrpc).toBe("2.0");
    expect(req.method).toBe("getBudget");
  });

  it("defaults the token from HONE_BROKER_TOKEN (the runner-injected container env)", async () => {
    const { server, first } = captureServer();
    const port = await listenTcp(server);
    cleanups.push(() => server.close());
    process.env["HONE_BROKER_TOKEN"] = "env-token-".padEnd(64, "y");
    const client = await BrokerClient.connect(`tcp://127.0.0.1:${port}`);
    cleanups.push(() => client.close());
    await client.getBudget();
    expect((await first).token).toBe("env-token-".padEnd(64, "y"));
  });

  it("unix endpoint: connects to the socket path and sends NO token field by default", async () => {
    const sockPath = join(mkdtempSync(join(tmpdir(), "hone-clt-")), "b.sock");
    const { server, first } = captureServer();
    const ready = deferred<void>();
    server.once("error", ready.reject);
    server.listen(sockPath, () => ready.resolve());
    await ready.promise;
    cleanups.push(() => server.close());
    const client = await BrokerClient.connect(sockPath);
    cleanups.push(() => client.close());
    await client.getBudget();
    const req = await first;
    expect("token" in req).toBe(false);
    expect(req.method).toBe("getBudget");
  });
});
