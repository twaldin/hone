import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { BrokerServer } from "../src/server.js";
import { CasStore } from "../src/cas.js";
import { diffProtectedPaths, packDirAsArtifact, unpackArtifact } from "../src/artifact.js";
import { ArtifactValidationError, validateWorkspaceTar } from "../src/tarcheck.js";
import { deferred } from "../src/deferred.js";
import { buildTestCapsule, TEST_IMAGE } from "./helpers.js";

// ---------------------------------------------------------------------------
// In-test tar writer: crafts adversarial archives byte-by-byte so the
// validator is exercised against the real wire format, not a mock.
// ---------------------------------------------------------------------------

const BLOCK = 512;

interface TarEntrySpec {
  name: string;
  /** tar typeflag; default "0" (regular file). */
  type?: string;
  content?: Buffer | string;
  linkname?: string;
  prefix?: string;
  /** Override the header size field (defaults to content length). */
  size?: number;
}

function tarHeader(spec: TarEntrySpec): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(spec.name, 0, 100, "utf8");
  b.write("0000755\0", 100, "latin1"); // mode
  b.write("0000000\0", 108, "latin1"); // uid
  b.write("0000000\0", 116, "latin1"); // gid
  const size = spec.size ?? (spec.content === undefined ? 0 : Buffer.byteLength(spec.content));
  b.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  b.write("00000000000\0", 136, "latin1"); // mtime
  b.write(spec.type ?? "0", 156, "latin1");
  if (spec.linkname !== undefined) b.write(spec.linkname, 157, 100, "utf8");
  b.write("ustar\0", 257, "latin1");
  b.write("00", 263, "latin1");
  if (spec.prefix !== undefined) b.write(spec.prefix, 345, 155, "utf8");
  b.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return b;
}

function makeTar(specs: TarEntrySpec[], opts: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    parts.push(tarHeader(spec));
    if (spec.content !== undefined) {
      const content = Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content);
      const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
      content.copy(padded);
      parts.push(padded);
    }
  }
  if (opts.end !== false) parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** One PAX record: `<len> <key>=<value>\n` where len counts the whole record. */
function paxRecord(key: string, value: string): string {
  const bodyLen = 1 + Buffer.byteLength(key) + 1 + Buffer.byteLength(value) + 1;
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return `${len} ${key}=${value}\n`;
}

/** A minimal valid workspace archive: root dir + one file. */
function validSpecs(): TarEntrySpec[] {
  return [
    { name: "workspace/", type: "5" },
    { name: "workspace/hello.txt", content: "hi" },
  ];
}

describe("validateWorkspaceTar", () => {
  const rejects = (specs: TarEntrySpec[], reason: RegExp, opts: { end?: boolean } = {}) => {
    expect(() => validateWorkspaceTar(makeTar(specs, opts))).toThrowError(reason);
    try {
      validateWorkspaceTar(makeTar(specs, opts));
    } catch (err) {
      expect(err).toBeInstanceOf(ArtifactValidationError);
    }
  };

  it("accepts a valid workspace archive and returns normalized entries", () => {
    const entries = validateWorkspaceTar(
      makeTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/src/", type: "5" },
        { name: "workspace/src/main.ts", content: "export {};" },
        { name: "workspace/README", content: "r" },
      ]),
    );
    expect(entries).toEqual([
      { path: "workspace", kind: "dir", size: 0 },
      { path: "workspace/src", kind: "dir", size: 0 },
      { path: "workspace/src/main.ts", kind: "file", size: 10 },
      { path: "workspace/README", kind: "file", size: 1 },
    ]);
  });

  it("normalizes a benign leading ./ prefix", () => {
    const entries = validateWorkspaceTar(
      makeTar([
        { name: "./workspace/", type: "5" },
        { name: "./workspace/a.txt", content: "a" },
      ]),
    );
    expect(entries.map((e) => e.path)).toEqual(["workspace", "workspace/a.txt"]);
  });

  it("rejects .. traversal", () => {
    rejects([...validSpecs(), { name: "workspace/../evil", content: "x" }], /'\.\.' path segment/);
  });

  it("rejects absolute paths", () => {
    rejects([...validSpecs(), { name: "/etc/passwd", content: "x" }], /absolute entry path/);
  });

  it("rejects entries outside the workspace/ root and rootless archives", () => {
    rejects([...validSpecs(), { name: "other/", type: "5" }], /outside the workspace\/ root/);
    rejects([{ name: "loose.txt", content: "x" }], /outside the workspace\/ root/);
  });

  it("requires a real workspace/ directory entry", () => {
    rejects([{ name: "workspace/a.txt", content: "x" }], /exactly one real workspace\/ directory root/);
    // workspace present but as a FILE: the dir root is missing and the
    // file/dir conflict is caught first.
    rejects(
      [
        { name: "workspace", content: "not a dir" },
        { name: "workspace/a.txt", content: "x" },
      ],
      /file entry used as a directory|exactly one real workspace/,
    );
  });

  it("rejects symlinks, hardlinks, devices, and FIFOs", () => {
    rejects([...validSpecs(), { name: "workspace/link", type: "2", linkname: "/etc/passwd" }], /symlink/);
    rejects([...validSpecs(), { name: "workspace/hard", type: "1", linkname: "workspace/hello.txt" }], /hardlink/);
    rejects([...validSpecs(), { name: "workspace/dev", type: "3" }], /character-device/);
    rejects([...validSpecs(), { name: "workspace/dev", type: "4" }], /block-device/);
    rejects([...validSpecs(), { name: "workspace/fifo", type: "6" }], /FIFO/);
  });

  it("rejects .git anywhere, case-insensitively", () => {
    rejects([...validSpecs(), { name: "workspace/.git/", type: "5" }], /\.git is not allowed/);
    rejects([...validSpecs(), { name: "workspace/sub/.git", content: "gitdir: /x" }], /\.git is not allowed/);
    rejects([...validSpecs(), { name: "workspace/.GIT/", type: "5" }], /\.git is not allowed/);
  });

  it("rejects duplicate entries", () => {
    rejects([...validSpecs(), { name: "workspace/hello.txt", content: "again" }], /duplicate entry/);
  });

  it("rejects file/directory type conflicts", () => {
    rejects(
      [...validSpecs(), { name: "workspace/hello.txt/nested", content: "x" }],
      /file entry used as a directory/,
    );
    rejects(
      [
        { name: "workspace/", type: "5" },
        { name: "workspace/a/b", content: "x" },
        { name: "workspace/a", content: "collide" },
      ],
      /both a file and a directory/,
    );
  });

  it("rejects ambiguous names: NUL, backslash, empty and dot segments", () => {
    const pax = paxRecord("path", "workspace/a\0b");
    rejects([...validSpecs(), { name: "PaxHeader", type: "x", content: pax }, { name: "d", content: "x" }], /NUL/);
    rejects([...validSpecs(), { name: "workspace/a\\b", content: "x" }], /backslash/);
    rejects([...validSpecs(), { name: "workspace//x", content: "x" }], /empty path segment/);
    rejects([...validSpecs(), { name: "workspace/./x", content: "x" }], /'\.' path segment/);
    rejects([...validSpecs(), { name: "workspace/x/", content: "x" }], /file entry named like a directory/);
  });

  it("applies pax path overrides and validates the overridden name", () => {
    const good = paxRecord("path", "workspace/from-pax.txt");
    const entries = validateWorkspaceTar(
      makeTar([...validSpecs(), { name: "PaxHeader", type: "x", content: good }, { name: "ignored", content: "x" }]),
    );
    expect(entries.map((e) => e.path)).toContain("workspace/from-pax.txt");

    const evil = paxRecord("path", "../../escape");
    rejects(
      [...validSpecs(), { name: "PaxHeader", type: "x", content: evil }, { name: "ignored", content: "x" }],
      /'\.\.' path segment/,
    );
  });

  it("rejects pax size overrides that desynchronize validator and extractor block-walks", () => {
    // Differential: the raw ustar header says 1024 bytes of data, the pax
    // override says 0. A validator walking by the raw size treats the next
    // 1024 bytes as opaque payload; an extractor honoring the pax override
    // parses them as HEADERS — so forbidden entries hide in the disputed
    // region. The payload here embeds a real symlink header and a .git dir
    // header, byte-exact.
    const hidden = Buffer.concat([
      tarHeader({ name: "workspace/evil-link", type: "2", linkname: "/etc/passwd" }),
      tarHeader({ name: "workspace/.git/", type: "5" }),
    ]);
    expect(hidden.length).toBe(1024);
    rejects(
      [
        ...validSpecs(),
        { name: "x", type: "x", content: paxRecord("size", "0") },
        { name: "workspace/decoy.bin", content: hidden, size: 1024 },
      ],
      /pax size override is not allowed/,
    );
    // Nonzero override with the same raw/logical mismatch is equally rejected.
    rejects(
      [
        ...validSpecs(),
        { name: "x", type: "x", content: paxRecord("size", "512") },
        { name: "workspace/decoy.bin", content: hidden, size: 1024 },
      ],
      /pax size override is not allowed/,
    );
  });

  it("still accepts benign libarchive/pax metadata records", () => {
    const meta = paxRecord("mtime", "1752537600.123456789") + paxRecord("LIBARCHIVE.creationtime", "1752537600") + paxRecord("SCHILY.dev", "16777232");
    const entries = validateWorkspaceTar(
      makeTar([...validSpecs(), { name: "x", type: "x", content: meta }, { name: "workspace/meta.txt", content: "m" }]),
    );
    expect(entries.map((e) => e.path)).toContain("workspace/meta.txt");
  });

  it("handles GNU longnames and rejects traversal through them", () => {
    const long = `workspace/${"a".repeat(150)}.txt`;
    const entries = validateWorkspaceTar(
      makeTar([...validSpecs(), { name: "././@LongLink", type: "L", content: `${long}\0` }, { name: "trunc", content: "x" }]),
    );
    expect(entries.map((e) => e.path)).toContain(long);

    rejects(
      [...validSpecs(), { name: "././@LongLink", type: "L", content: "workspace/../../up\0" }, { name: "t", content: "x" }],
      /'\.\.' path segment/,
    );
  });

  it("rejects pax globals, pax linkpath, and GNU longlinks", () => {
    rejects(
      [...validSpecs(), { name: "g", type: "g", content: paxRecord("path", "workspace/x") }],
      /pax global/,
    );
    rejects(
      [...validSpecs(), { name: "x", type: "x", content: paxRecord("linkpath", "/etc") }, { name: "f", content: "x" }],
      /linkpath/,
    );
    rejects([...validSpecs(), { name: "k", type: "K", content: "/etc\0" }], /longlink/);
  });

  it("rejects truncated archives and directories with payload", () => {
    rejects(validSpecs(), /missing end-of-archive marker/, { end: false });
    const cut = makeTar(validSpecs()).subarray(0, BLOCK); // header without its data
    expect(() => validateWorkspaceTar(cut)).toThrowError(/truncated|missing end-of-archive/);
    rejects([{ name: "workspace/", type: "5", content: "sneaky", size: 6 }], /directory entry with nonzero size/);
  });

  it("rejects dangling metadata at end of archive", () => {
    rejects([...validSpecs(), { name: "x", type: "x", content: paxRecord("path", "workspace/x") }], /dangling metadata/);
  });
});

describe("artifact pack/unpack through the validator", () => {
  it("accepts what packDirAsArtifact produces and round-trips it", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-secart-"));
    try {
      const src = path.join(base, "ws");
      await mkdir(path.join(src, "sub"), { recursive: true });
      await writeFile(path.join(src, "a.txt"), "alpha");
      await writeFile(path.join(src, "sub", "b.txt"), "beta");
      const cas = new CasStore(path.join(base, "cas"));
      const hash = await packDirAsArtifact(src, cas);
      const entries = validateWorkspaceTar(await cas.readBuffer(hash));
      expect(entries.some((e) => e.path === "workspace" && e.kind === "dir")).toBe(true);
      expect(entries.some((e) => e.path === "workspace/sub/b.txt" && e.kind === "file")).toBe(true);
      const ws = await unpackArtifact(cas, hash, path.join(base, "unpack"));
      expect(ws.endsWith("/workspace")).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("refuses to extract a malicious CAS blob", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-secart-"));
    try {
      const cas = new CasStore(path.join(base, "cas"));
      const evil = makeTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/link", type: "2", linkname: "/etc" },
      ]);
      const hash = await cas.putBuffer(evil);
      await expect(unpackArtifact(cas, hash, path.join(base, "unpack"))).rejects.toThrowError(/symlink/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("protected namespaces", () => {
  async function tree(spec: Record<string, string>, dirs: string[] = []): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-ns-"));
    for (const d of dirs) await mkdir(path.join(root, d), { recursive: true });
    for (const [rel, content] of Object.entries(spec)) {
      const p = path.join(root, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content);
    }
    return root;
  }

  it("a plain directory spec (no /**) freezes itself and all descendants", async () => {
    const base = await tree({ "protected/a.txt": "1", "protected/deep/b.txt": "2", "src/x.ts": "x" });
    const cand = await tree({ "protected/a.txt": "CHANGED", "src/x.ts": "y" });
    const violations = await diffProtectedPaths(base, cand, ["protected"]);
    // modified a.txt, deleted deep/ (dir) and deep/b.txt
    expect(violations).toEqual(["protected/a.txt", "protected/deep", "protected/deep/b.txt"]);
  });

  it("flags files AND directories added inside the namespace", async () => {
    const base = await tree({ "protected/a.txt": "1" });
    const cand = await tree({ "protected/a.txt": "1", "protected/new/sneak.txt": "s" });
    expect(await diffProtectedPaths(base, cand, ["protected"])).toEqual([
      "protected/new",
      "protected/new/sneak.txt",
    ]);
  });

  it("flags type changes: file→dir and file→symlink", async () => {
    const base = await tree({ "protected/thing": "file-content", "protected/other": "o" });
    const cand = await tree({ "protected/thing/inner": "x", "protected/other": "o" });
    expect(await diffProtectedPaths(base, cand, ["protected"])).toEqual([
      "protected/thing",
      "protected/thing/inner",
    ]);

    const linkCand = await tree({ "protected/other": "o" });
    await symlink("/etc/passwd", path.join(linkCand, "protected", "thing"));
    expect(await diffProtectedPaths(base, linkCand, ["protected"])).toEqual(["protected/thing"]);
  });

  it("flags an empty protected directory being deleted", async () => {
    const base = await tree({ "protected/keep.txt": "k" }, ["protected/empty"]);
    const cand = await tree({ "protected/keep.txt": "k" });
    expect(await diffProtectedPaths(base, cand, ["protected"])).toEqual(["protected/empty"]);
  });

  it("an exact-file spec protects the file, not lookalike siblings", async () => {
    const base = await tree({ "knn/pricing.ts": "p", "knn/pricing_extra.ts": "e" });
    const cand = await tree({ "knn/pricing.ts": "TAMPERED", "knn/pricing_extra.ts": "changed-ok" });
    expect(await diffProtectedPaths(base, cand, ["knn/pricing.ts"])).toEqual(["knn/pricing.ts"]);
  });

  it("explicit glob specs keep glob semantics", async () => {
    const base = await tree({ "protected/a.txt": "1", "src/x.ts": "x" });
    const cand = await tree({ "protected/a.txt": "1", "protected/added.txt": "s", "src/x.ts": "changed" });
    expect(await diffProtectedPaths(base, cand, ["protected/**"])).toEqual(["protected/added.txt"]);
  });
});

// ---------------------------------------------------------------------------
// Wire framing: hard frame cap, malformed-frame resilience, admin invisibility.
// No Docker required — the broker is constructed but never touches containers.
// ---------------------------------------------------------------------------

const MAX_FRAME = 4096;

interface LineSock {
  write(data: string | Buffer): void;
  nextLine(): Promise<string>;
  closed: Promise<void>;
  destroy(): void;
}

function connectLines(socketPath: string): Promise<LineSock> {
  const conn = deferred<LineSock>();
  const sock = net.connect(socketPath);
  const closed = deferred<void>();
  let buf = "";
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const w = waiters.shift();
      if (w) w(line);
      else lines.push(line);
    }
  });
  sock.on("close", () => closed.resolve());
  sock.on("error", () => {}); // EPIPE after server-side teardown is expected
  sock.once("connect", () =>
    conn.resolve({
      write: (data) => sock.write(data),
      nextLine: () => {
        const head = lines.shift();
        if (head !== undefined) return Promise.resolve(head);
        const { promise, resolve } = deferred<string>();
        waiters.push(resolve);
        return promise;
      },
      closed: closed.promise,
      destroy: () => sock.destroy(),
    }),
  );
  sock.once("error", conn.reject);
  return conn.promise;
}

describe("broker wire hardening", () => {
  let base: string;
  let server: BrokerServer;
  let broker: Broker;
  let socketPath: string;
  let adminSocketPath: string;

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "hone-wire-"));
    const capsule = await buildTestCapsule(base, {
      maxTokens: 1_000_000,
      maxUsd: 100,
      maxWallClockSec: 3600,
      maxEvaluatorInvocations: 100,
    });
    broker = new Broker({
      runId: "run_wire_test",
      manifest: capsule.manifest,
      capsuleRootDir: capsule.capsuleRootDir,
      baselineArtifactHash: `sha256:${"0".repeat(64)}`,
      image: TEST_IMAGE,
      runDir: path.join(base, "run"),
      casDir: path.join(base, "cas"),
      onEvent: () => {},
    });
    socketPath = path.join(base, "run", "broker.sock");
    adminSocketPath = path.join(base, "run", "broker-admin.sock");
    server = new BrokerServer(broker, { socketPath, adminSocketPath, maxFrameBytes: MAX_FRAME });
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
    await rm(base, { recursive: true, force: true });
  });

  it("rejects an oversized complete frame with one error, then closes", async () => {
    const c = await connectLines(socketPath);
    const fat = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTask", params: { pad: "a".repeat(MAX_FRAME) } });
    c.write(`${fat}\n`);
    const resp = JSON.parse(await c.nextLine());
    expect(resp.error.code).toBe(-32700);
    expect(resp.error.message).toMatch(/frame exceeds 4096 bytes/);
    expect(resp.id).toBeNull();
    await c.closed;
  });

  it("rejects a fragmented oversized frame without buffering it whole", async () => {
    const c = await connectLines(socketPath);
    // Never send a newline: the server must give up as soon as the pending
    // fragment passes the cap, not wait for the frame to complete.
    const chunk = "x".repeat(1024);
    for (let i = 0; i < 8; i++) c.write(chunk);
    const resp = JSON.parse(await c.nextLine());
    expect(resp.error.code).toBe(-32700);
    expect(resp.error.message).toMatch(/frame exceeds/);
    await c.closed;
  });

  it("answers malformed JSON with -32700 and keeps serving the connection", async () => {
    const c = await connectLines(socketPath);
    c.write("{this is not json\n");
    const bad = JSON.parse(await c.nextLine());
    expect(bad.error.code).toBe(-32700);
    // Same connection still works afterwards.
    c.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "noSuchMethod" })}\n`);
    const next = JSON.parse(await c.nextLine());
    expect(next.id).toBe(2);
    expect(next.error.code).toBe(-32601);
    c.destroy();
  });

  it("answers structurally invalid JSON-RPC with -32600", async () => {
    const c = await connectLines(socketPath);
    c.write(`${JSON.stringify({ jsonrpc: "1.0", id: 3, method: "getBudget" })}\n`);
    const resp = JSON.parse(await c.nextLine());
    expect(resp.error.code).toBe(-32600);
    c.destroy();
  });

  it("keeps admin-only methods invisible (-32601) on the client socket", async () => {
    const c = await connectLines(socketPath);
    c.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "recordSpend", params: { tokens: 1, usd: 0 } })}\n`);
    const resp = JSON.parse(await c.nextLine());
    expect(resp.error.code).toBe(-32601);
    expect(resp.error.message).toBe("method not found: recordSpend");
    c.destroy();
  });

  it("serves admin methods on the admin socket", async () => {
    const c = await connectLines(adminSocketPath);
    c.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "recordSpend", params: { tokens: 1, usd: 0.01 } })}\n`);
    const resp = JSON.parse(await c.nextLine());
    expect(resp.error).toBeUndefined();
    expect(resp.id).toBe(5);
    c.destroy();
  });

  it("accepts frames right up to the cap", async () => {
    const c = await connectLines(socketPath);
    const req = { jsonrpc: "2.0", id: 6, method: "noSuchMethod", params: { pad: "" } };
    const overhead = JSON.stringify(req).length;
    req.params.pad = "p".repeat(MAX_FRAME - overhead);
    const frame = JSON.stringify(req);
    expect(frame.length).toBe(MAX_FRAME);
    c.write(`${frame}\n`);
    const resp = JSON.parse(await c.nextLine());
    expect(resp.id).toBe(6);
    expect(resp.error.code).toBe(-32601); // parsed and dispatched, not size-rejected
    c.destroy();
  });
});
