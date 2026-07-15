import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { Broker } from "../src/broker.js";
import { BrokerServer } from "../src/server.js";
import { CasStore } from "../src/cas.js";
import { canonicalizeWorkspaceTar, diffProtectedPaths, packDirAsArtifact, unpackArtifact } from "../src/artifact.js";
import { ArtifactValidationError, validateWorkspaceTar } from "../src/tarcheck.js";
import { deferred } from "../src/deferred.js";
import { runCommand, type RunCommand } from "../src/command.js";
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
  /** Override the header mtime field (defaults to 0). */
  mtime?: number;
  /** Override the header mode field (defaults to "0000755"). */
  mode?: string;
  /** Encoding used to write the name field (default "utf8"); "latin1" injects raw high bytes. */
  nameEncoding?: BufferEncoding;
}

function tarHeader(spec: TarEntrySpec): Buffer {
  const b = Buffer.alloc(BLOCK);
  b.write(spec.name, 0, 100, spec.nameEncoding ?? "utf8");
  b.write(`${spec.mode ?? "0000755"}\0`, 100, "latin1"); // mode
  b.write("0000000\0", 108, "latin1"); // uid
  b.write("0000000\0", 116, "latin1"); // gid
  const size = spec.size ?? (spec.content === undefined ? 0 : Buffer.byteLength(spec.content));
  b.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  b.write(`${(spec.mtime ?? 0).toString(8).padStart(11, "0")}\0`, 136, "latin1"); // mtime
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
      { path: "workspace", kind: "dir", size: 0, ownerExec: false },
      { path: "workspace/src", kind: "dir", size: 0, ownerExec: false },
      { path: "workspace/src/main.ts", kind: "file", size: 10, ownerExec: true },
      { path: "workspace/README", kind: "file", size: 1, ownerExec: true },
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

describe("canonical artifact packing", () => {
  async function makeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(root, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content);
    }
  }

  /** All rel paths under `root` (files and dirs), for detritus assertions. */
  async function listTree(root: string, rel = ""): Promise<string[]> {
    const out: string[] = [];
    for (const d of await readdir(rel === "" ? root : path.join(root, rel), { withFileTypes: true })) {
      const entryRel = rel === "" ? d.name : `${rel}/${d.name}`;
      out.push(entryRel);
      if (d.isDirectory()) out.push(...(await listTree(root, entryRel)));
    }
    return out.sort();
  }

  it("emits zero wall-clock metadata: every header has mtime 0, uid 0, gid 0", async () => {
    // Deterministic repro of the run_mrmbrlmv312b68 instability: the pre-fix
    // packer stamped real file mtimes into the tar, so the SAME tree packed
    // at two different times hashed differently. If no header carries wall
    // time or host identity, the bytes cannot depend on when we packed.
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-t-"));
    try {
      const src = path.join(base, "src");
      await makeTree(src, { "a.txt": "alpha", "sub/b.txt": "beta" });
      const cas = new CasStore(path.join(base, "cas"));
      const bytes = await cas.readBuffer(await packDirAsArtifact(src, cas));
      let entries = 0;
      for (let off = 0; off + BLOCK <= bytes.length; ) {
        const header = bytes.subarray(off, off + BLOCK);
        if (header.every((b) => b === 0)) break; // end-of-archive
        entries += 1;
        expect(header.subarray(136, 148).toString("latin1")).toBe("00000000000\0"); // mtime
        expect(header.subarray(108, 116).toString("latin1")).toBe("0000000\0"); // uid
        expect(header.subarray(116, 124).toString("latin1")).toBe("0000000\0"); // gid
        const size = parseInt(header.subarray(124, 136).toString("latin1").replace(/\0.*$/, ""), 8);
        off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
      }
      expect(entries).toBe(4); // workspace, a.txt, sub, sub/b.txt
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("independently staged copies of the same tree pack to the identical hash", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-r-"));
    try {
      const src = path.join(base, "src");
      await makeTree(src, { "a.txt": "alpha", "sub/b.txt": "beta" });
      // Backdate one copy and freshly stage another (cp discards mtimes):
      // the two trees have identical content but wildly different mtimes.
      await utimes(path.join(src, "a.txt"), new Date(0), new Date(0));
      const staged = path.join(base, "staged");
      await cp(src, staged, { recursive: true });
      const cas = new CasStore(path.join(base, "cas"));
      expect(await packDirAsArtifact(staged, cas)).toBe(await packDirAsArtifact(src, cas));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a source content change changes the hash", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-c-"));
    try {
      const src = path.join(base, "src");
      await makeTree(src, { "a.txt": "alpha" });
      const cas = new CasStore(path.join(base, "cas"));
      const before = await packDirAsArtifact(src, cas);
      await writeFile(path.join(src, "a.txt"), "ALPHA");
      expect(await packDirAsArtifact(src, cas)).not.toBe(before);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("strips runtime/VCS detritus at every depth, not just the top level", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-d-"));
    try {
      const src = path.join(base, "src");
      await makeTree(src, {
        "keep.txt": "k",
        "pkg/mod.py": "print(1)\n",
        "pkg/__pycache__/mod.cpython-311.pyc": "bytecode",
        "pkg/stray.pyo": "bytecode",
        ".pytest_cache/v/cache/lastfailed": "{}",
        "deep/a/.pytest_cache/x": "x",
        "deep/a/__pycache__/y.pyc": "y",
        ".gitdir/HEAD": "ref: refs/heads/main",
        ".git/config": "[core]",
        "stray.pyc": "bytecode",
      });
      const cas = new CasStore(path.join(base, "cas"));
      const hash = await packDirAsArtifact(src, cas);
      const entries = validateWorkspaceTar(await cas.readBuffer(hash));
      expect(entries.map((e) => e.path)).toEqual([
        "workspace",
        "workspace/deep",
        "workspace/deep/a",
        "workspace/keep.txt",
        "workspace/pkg",
        "workspace/pkg/mod.py",
      ]);
      const ws = await unpackArtifact(cas, hash, path.join(base, "unpack"));
      expect(await listTree(ws)).toEqual(["deep", "deep/a", "keep.txt", "pkg", "pkg/mod.py"]);
      expect(await readFile(path.join(ws, "pkg", "mod.py"), "utf8")).toBe("print(1)\n");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects symlinks in the source tree instead of following them", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-s-"));
    try {
      const src = path.join(base, "src");
      await makeTree(src, { "a.txt": "alpha" });
      await symlink("/etc/passwd", path.join(src, "leak"));
      const cas = new CasStore(path.join(base, "cas"));
      await expect(packDirAsArtifact(src, cas)).rejects.toThrowError(/unsupported symlink.*leak/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("canonicalizeWorkspaceTar collapses metadata-noisy tars onto the on-disk canonical hash", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-z-"));
    try {
      // Two byte-DIFFERENT tars of the same logical tree: mtimes differ and
      // both drag __pycache__ junk along — exactly what a sandbox emits.
      const noisy = (mtime: number): Buffer =>
        makeTar([
          { name: "workspace/", type: "5", mtime },
          { name: "workspace/pkg/", type: "5", mtime },
          { name: "workspace/pkg/mod.py", content: "print(1)\n", mode: "0000644", mtime },
          { name: "workspace/pkg/__pycache__/", type: "5", mtime },
          { name: "workspace/pkg/__pycache__/mod.cpython-311.pyc", content: "junk", mode: "0000644", mtime },
        ]);
      const a = noisy(12345);
      const b = noisy(999999);
      expect(a.equals(b)).toBe(false);
      const cas = new CasStore(path.join(base, "cas"));
      const hashA = await canonicalizeWorkspaceTar(a, cas);
      const hashB = await canonicalizeWorkspaceTar(b, cas);
      expect(hashA).toBe(hashB);
      // ...and both equal the canonical pack of the equivalent clean tree.
      const clean = path.join(base, "clean");
      await makeTree(clean, { "pkg/mod.py": "print(1)\n" });
      expect(await packDirAsArtifact(clean, cas)).toBe(hashA);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("canonicalizeWorkspaceTar never extracts or CAS-admits a malicious tar", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-m-"));
    try {
      const evil = makeTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/link", type: "2", linkname: "/etc" },
      ]);
      const casDir = path.join(base, "cas");
      const cas = new CasStore(casDir);
      const spawned: string[][] = [];
      const run: RunCommand = async (argv) => {
        spawned.push([...argv]);
        throw new Error("no process may run for a rejected artifact");
      };
      await expect(canonicalizeWorkspaceTar(evil, cas, run)).rejects.toThrowError(ArtifactValidationError);
      expect(spawned).toEqual([]); // validation failed CLOSED before extraction
      await expect(readdir(casDir)).rejects.toThrowError(); // nothing entered CAS
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("canonicalizes hostile mode bits (000 dirs/files, exec-only) and never leaks temp trees", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-p-"));
    try {
      // Validated-but-hostile modes: an unreadable/untraversable dir hiding a
      // mode-000 file, plus an exec-only (0111) script. Pre-fix, host tar
      // restored these, the canonical pack could not walk them, and the
      // finally-cleanup could not traverse them — leaking one hone-canon-*
      // temp tree per save.
      const hostile = makeTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/locked/", type: "5", mode: "0000000" },
        { name: "workspace/locked/secret.txt", content: "s", mode: "0000000" },
        { name: "workspace/runme", content: "#!/bin/sh\n", mode: "0000111" },
      ]);
      const cas = new CasStore(path.join(base, "cas"));
      // Capture the extraction dir so temp cleanup is asserted on the exact path.
      let extractDir: string | undefined;
      const spyRun: RunCommand = async (argv, opts) => {
        const c = argv.indexOf("-C");
        if (c >= 0) extractDir = argv[c + 1];
        return runCommand(argv, opts);
      };
      const hash = await canonicalizeWorkspaceTar(hostile, cas, spyRun);
      expect(extractDir).toBeDefined();
      await expect(stat(path.dirname(extractDir as string))).rejects.toThrowError(); // temp tree fully removed
      // Repeated canonicalization is stable and leak-free too.
      expect(await canonicalizeWorkspaceTar(hostile, cas)).toBe(hash);
      // Canonical mode keeps only the owner-exec signal: the same tree built
      // with sane modes (runme executable) hashes identically.
      const clean = path.join(base, "clean");
      await makeTree(clean, { "locked/secret.txt": "s", "runme": "#!/bin/sh\n" });
      await chmod(path.join(clean, "runme"), 0o755);
      expect(await packDirAsArtifact(clean, cas)).toBe(hash);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("the size cap covers the complete archive including the end-of-archive blocks", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-cap-"));
    try {
      // Canonical layout for one 512-byte file: 512 (workspace hdr) +
      // 512 (file hdr) + 512 (data) + 1024 (end-of-archive) = 2560 bytes.
      const src = path.join(base, "src");
      await makeTree(src, { "data.bin": "x".repeat(512) });
      const cas = new CasStore(path.join(base, "cas"));
      const hash = await packDirAsArtifact(src, cas, 2560); // exact boundary: accepted
      expect((await cas.readBuffer(hash)).length).toBe(2560);
      // One byte less of budget must fail — a blob may NEVER exceed the cap,
      // and pre-fix the two terminal blocks escaped the accounting.
      await expect(packDirAsArtifact(src, new CasStore(path.join(base, "cas2")), 2559)).rejects.toThrowError(/size cap/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails closed when host extraction cannot reproduce the accepted entries exactly", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-fid-"));
    try {
      // Probe THIS host's filesystem semantics rather than assuming platform.
      const probe = path.join(base, "probe");
      await mkdir(probe);
      await writeFile(path.join(probe, "CaseProbe"), "p");
      const caseInsensitive = await stat(path.join(probe, "caseprobe")).then(
        () => true,
        () => false,
      );

      const twoCase = makeTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/CaseFile", content: "upper", mode: "0000644" },
        { name: "workspace/casefile", content: "lower", mode: "0000644" },
      ]);
      const casDir = path.join(base, "cas");
      const cas = new CasStore(casDir);
      if (caseInsensitive) {
        // Darwin default (APFS case-insensitive): the two names collapse to
        // one on disk — the fidelity gate must reject, and nothing may enter
        // CAS (pre-fix a silently mangled tree was repacked and admitted).
        await expect(canonicalizeWorkspaceTar(twoCase, cas)).rejects.toThrowError(ArtifactValidationError);
        await expect(readdir(casDir)).rejects.toThrowError();
      } else {
        // Case-sensitive host (Linux): both files round-trip faithfully.
        const hash = await canonicalizeWorkspaceTar(twoCase, cas);
        const paths = validateWorkspaceTar(await cas.readBuffer(hash)).map((e) => e.path);
        expect(paths).toContain("workspace/CaseFile");
        expect(paths).toContain("workspace/casefile");
      }

      // Ordinary Unicode names are preserved exactly where the host stores
      // them byte-exact; a normalizing filesystem must reject, never mangle.
      const nfc = "caf\u00e9.txt"; // NFC: U+00E9
      await writeFile(path.join(probe, nfc), "u");
      const names = await readdir(probe);
      const preservesBytes = names.includes(nfc);
      const unicodeTar = makeTar([
        { name: "workspace/", type: "5" },
        { name: `workspace/${nfc}`, content: "u", mode: "0000644" },
      ]);
      const cas3 = new CasStore(path.join(base, "cas3"));
      if (preservesBytes) {
        const hash = await canonicalizeWorkspaceTar(unicodeTar, cas3);
        const paths = validateWorkspaceTar(await cas3.readBuffer(hash)).map((e) => e.path);
        expect(paths).toContain(`workspace/${nfc}`);
      } else {
        await expect(canonicalizeWorkspaceTar(unicodeTar, cas3)).rejects.toThrowError(ArtifactValidationError);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("owner-exec and traversal survive a restrictive process umask", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-um-"));
    try {
      // Canonical truth, computed under the normal umask: pkg/run.sh IS
      // executable, pkg/data.txt is not.
      const clean = path.join(base, "clean");
      await makeTree(clean, { "pkg/run.sh": "#!/bin/sh\n", "pkg/data.txt": "d" });
      await chmod(path.join(clean, "pkg", "run.sh"), 0o755);
      const cas = new CasStore(path.join(base, "cas"));
      const want = await packDirAsArtifact(clean, cas);

      // Sandbox-style tar of the same tree; workspace/pkg/ is IMPLIED (no
      // explicit dir entry), so extraction must also create it traversable.
      const noisy = makeTar([
        { name: "workspace/", type: "5" },
        { name: "workspace/pkg/run.sh", content: "#!/bin/sh\n", mode: "0000755", mtime: 5555 },
        { name: "workspace/pkg/data.txt", content: "d", mode: "0000644", mtime: 5555 },
      ]);

      // Controlled-umask window (child processes inherit it): 0177 makes
      // --no-same-permissions extraction strip owner-x from files and leave
      // implied dirs untraversable — pre-fix the canonical hash (or the save
      // itself) depended on the broker's umask.
      const prev = process.umask(0o177);
      let got: string;
      try {
        got = await canonicalizeWorkspaceTar(noisy, cas);
      } finally {
        process.umask(prev);
      }
      expect(got).toBe(want);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("rejects invalid UTF-8 in entry names before anything is extracted", async () => {
    // A lossy decode would let the validator chmod/compare a U+FFFD name
    // while tar writes the raw bytes — e.g. a raw-\xff mode-000 dir the
    // cleanup pass can never reach. Strict decode fails CLOSED instead.
    const rawByteName = makeTar([
      { name: "workspace/", type: "5" },
      { name: "workspace/\u00ffdir/", type: "5", mode: "0000000", nameEncoding: "latin1" },
    ]);

    const longnamePayload = Buffer.concat([Buffer.from("workspace/"), Buffer.from([0xff]), Buffer.from("d")]);
    const rawByteLongname = makeTar([
      { name: "workspace/", type: "5" },
      { name: "././@LongLink", type: "L", content: longnamePayload },
      { name: "workspace/placeholder", content: "x" },
    ]);

    const paxValue = Buffer.concat([Buffer.from("path=workspace/"), Buffer.from([0xff]), Buffer.from("f\n")]);
    let len = paxValue.length + 3;
    while (String(len).length + 1 + paxValue.length !== len) len = String(len).length + 1 + paxValue.length;
    const paxBody = Buffer.concat([Buffer.from(`${len} `), paxValue]);
    const rawBytePax = makeTar([
      { name: "workspace/", type: "5" },
      { name: "pax", type: "x", content: paxBody },
      { name: "workspace/f", content: "x" },
    ]);

    for (const evil of [rawByteName, rawByteLongname, rawBytePax]) {
      expect(() => validateWorkspaceTar(evil)).toThrowError(/invalid UTF-8/);
      const base = await mkdtemp(path.join(os.tmpdir(), "hone-canon-u8-"));
      try {
        const casDir = path.join(base, "cas");
        const spawned: string[][] = [];
        const run: RunCommand = async (argv) => {
          spawned.push([...argv]);
          throw new Error("no process may run for a rejected artifact");
        };
        await expect(canonicalizeWorkspaceTar(evil, new CasStore(casDir), run)).rejects.toThrowError(/invalid UTF-8/);
        expect(spawned).toEqual([]); // zero spawns: rejected before extraction
        await expect(readdir(casDir)).rejects.toThrowError(); // CAS empty
      } finally {
        await rm(base, { recursive: true, force: true });
      }
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
