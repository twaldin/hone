import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CasStore, durability } from "../src/cas.js";
import { globToRegExp, matchesAnyGlob } from "../src/glob.js";
import { diffProtectedPaths } from "../src/artifact.js";
import { mkdir } from "node:fs/promises";

describe("glob matcher", () => {
  it("matches ** across directory separators", () => {
    expect(matchesAnyGlob("protected/frozen.txt", ["protected/**"])).toBe(true);
    expect(matchesAnyGlob("protected/a/b/c.txt", ["protected/**"])).toBe(true);
    expect(matchesAnyGlob("src/main.ts", ["protected/**"])).toBe(false);
  });

  it("does not match the bare directory itself for dir/**", () => {
    expect(matchesAnyGlob("protected", ["protected/**"])).toBe(false);
  });

  it("* stays within one path segment", () => {
    expect(matchesAnyGlob("a/x.txt", ["a/*.txt"])).toBe(true);
    expect(matchesAnyGlob("a/b/x.txt", ["a/*.txt"])).toBe(false);
  });

  it("**/ matches zero or more leading segments", () => {
    expect(matchesAnyGlob("secret.key", ["**/secret.key"])).toBe(true);
    expect(matchesAnyGlob("deep/nested/secret.key", ["**/secret.key"])).toBe(true);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globToRegExp("a.b").test("a.b")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("exact literal paths match themselves only", () => {
    expect(matchesAnyGlob("knn/pricing.ts", ["knn/pricing.ts"])).toBe(true);
    expect(matchesAnyGlob("knn/pricing_extra.ts", ["knn/pricing.ts"])).toBe(false);
  });
});

describe("CAS store", () => {
  it("stores blobs at sha256/<first2>/<fullhash> and round-trips content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const content = Buffer.from("hello cas");
    const hash = await cas.putBuffer(content);
    const hex = createHash("sha256").update(content).digest("hex");
    expect(hash).toBe(`sha256:${hex}`);
    const blobPath = cas.blobPath(hash);
    expect(blobPath).toBe(path.join(root, "sha256", hex.slice(0, 2), hex));
    await expect(stat(blobPath)).resolves.toBeTruthy();
    expect(await cas.readBuffer(hash)).toEqual(content);
    expect(await cas.has(hash)).toBe(true);
    expect(await cas.has(`sha256:${"0".repeat(64)}`)).toBe(false);
  });

  it("putFile hashes file content and moves it into place", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const src = path.join(root, "src.bin");
    await writeFile(src, "file content");
    const hash = await cas.putFile(src);
    expect((await readFile(cas.blobPath(hash))).toString()).toBe("file content");
  });
});

describe("CAS durable publication — power-loss ordering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface OrderSpies {
    calls: string[];
    write: MockInstance;
    rename: MockInstance;
    syncFile: MockInstance;
    syncDir: MockInstance;
  }

  /** Record the primitive call sequence while keeping the real implementations. */
  function spyOrder(): OrderSpies {
    const calls: string[] = [];
    const real = {
      write: durability.writeFileSynced.bind(durability),
      rename: durability.rename.bind(durability),
      syncFile: durability.syncFile.bind(durability),
      syncDir: durability.syncDir.bind(durability),
    };
    const write = vi.spyOn(durability, "writeFileSynced").mockImplementation(async (tmp, content) => {
      calls.push(`write:${tmp}`);
      await real.write(tmp, content);
    });
    const rename = vi.spyOn(durability, "rename").mockImplementation(async (from, to) => {
      calls.push(`rename:${from}->${to}`);
      await real.rename(from, to);
    });
    const syncFile = vi.spyOn(durability, "syncFile").mockImplementation(async (p) => {
      calls.push(`syncFile:${p}`);
      await real.syncFile(p);
    });
    const syncDir = vi.spyOn(durability, "syncDir").mockImplementation(async (dir) => {
      calls.push(`syncDir:${dir}`);
      await real.syncDir(dir);
    });
    return { calls, write, rename, syncFile, syncDir };
  }

  /** Leaf-first fsync chain: leaf → sha256/ → store root → root parent. */
  function blobDirChain(cas: CasStore, hash: string): string[] {
    const leaf = path.dirname(cas.blobPath(hash));
    return [leaf, path.dirname(leaf), cas.rootDir, path.dirname(cas.rootDir)];
  }

  it("putBuffer publishes as fsync(temp) → rename → fsync through the store root parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const spies = spyOrder();
    const hash = await cas.putBuffer(Buffer.from("durable blob"));
    const dest = cas.blobPath(hash);
    const esc = dest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(spies.calls[0]).toMatch(new RegExp(`^write:${esc}\\.tmp-`));
    expect(spies.calls[1]).toMatch(new RegExp(`->${esc}$`));
    expect(spies.calls.slice(2)).toEqual(blobDirChain(cas, hash).map((d) => `syncDir:${d}`));
    expect(spies.syncFile).not.toHaveBeenCalled();
    expect((await readFile(dest)).toString()).toBe("durable blob");
  });

  it("the blob is already at its final path when the directory fsyncs run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const realSyncDir = durability.syncDir.bind(durability);
    const listings = new Map<string, string>();
    vi.spyOn(durability, "syncDir").mockImplementation(async (dir) => {
      listings.set(dir, (await readdir(dir)).join(","));
      await realSyncDir(dir);
    });
    const hash = await cas.putBuffer(Buffer.from("rename before dir fsync"));
    const hex = hash.slice("sha256:".length);
    // final name only in the leaf — no temp entry left behind at sync time
    expect(listings.get(path.dirname(cas.blobPath(hash)))).toBe(hex);
  });

  it("dedup hit re-establishes durability without rewriting the blob", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const content = Buffer.from("dedup me");
    const hash = await cas.putBuffer(content);
    const before = await stat(cas.blobPath(hash));
    const spies = spyOrder();
    expect(await cas.putBuffer(content)).toBe(hash);
    expect(spies.write).not.toHaveBeenCalled();
    expect(spies.rename).not.toHaveBeenCalled();
    expect(spies.calls).toEqual([
      `syncFile:${cas.blobPath(hash)}`,
      ...blobDirChain(cas, hash).map((d) => `syncDir:${d}`),
    ]);
    const after = await stat(cas.blobPath(hash));
    expect(after.ino).toBe(before.ino); // same inode: never rewritten
    expect((await readFile(cas.blobPath(hash))).toString()).toBe("dedup me");
  });

  it("putFile follows the same durable order, including its dedup path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const src = path.join(root, "src.bin");
    await writeFile(src, "file bytes");
    const spies = spyOrder();
    const hash = await cas.putFile(src);
    const dest = cas.blobPath(hash);
    expect(spies.calls[0]).toMatch(/^write:/);
    expect(spies.calls[1]).toMatch(/^rename:/);
    expect(spies.calls.slice(2)).toEqual(blobDirChain(cas, hash).map((d) => `syncDir:${d}`));
    spies.calls.length = 0;
    expect(await cas.putFile(src)).toBe(hash);
    expect(spies.calls).toEqual([`syncFile:${dest}`, ...blobDirChain(cas, hash).map((d) => `syncDir:${d}`)]);
  });

  it("putFile hashes and publishes ONE read of the source — no re-read can skew content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const src = path.join(root, "src.bin");
    await writeFile(src, "original bytes");
    const seen: Buffer[] = [];
    const realPut = cas.putBuffer.bind(cas);
    vi.spyOn(cas, "putBuffer").mockImplementation(async (content) => {
      seen.push(Buffer.from(content));
      // Mutate the source AFTER the single read: must have zero effect.
      await writeFile(src, "tampered bytes!");
      return realPut(content);
    });
    const hash = await cas.putFile(src);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toString()).toBe("original bytes");
    expect(hash).toBe(`sha256:${createHash("sha256").update("original bytes").digest("hex")}`);
    const stored = await cas.readBuffer(hash);
    expect(stored.toString()).toBe("original bytes");
    expect(createHash("sha256").update(stored).digest("hex")).toBe(hash.slice("sha256:".length));
  });

  it("indexPut publishes the pointer with the same fsync ordering", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const spies = spyOrder();
    await cas.indexPut("memo", "key-1", `sha256:${"a".repeat(64)}`);
    const indexDest = path.join(root, "index", "memo", createHash("sha256").update("key-1").digest("hex"));
    const esc = indexDest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(spies.calls).toHaveLength(6);
    expect(spies.calls[0]).toMatch(new RegExp(`^write:${esc}\\.tmp-`));
    expect(spies.calls[1]).toMatch(new RegExp(`->${esc}$`));
    expect(spies.calls.slice(2)).toEqual([
      `syncDir:${path.dirname(indexDest)}`,
      `syncDir:${path.join(root, "index")}`,
      `syncDir:${root}`,
      `syncDir:${path.dirname(root)}`,
    ]);
    expect(await cas.indexGet("memo", "key-1")).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("a failed directory fsync fails the put — no hash is handed out to journal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    vi.spyOn(durability, "syncDir").mockRejectedValue(new Error("EIO: fsync failed"));
    await expect(cas.putBuffer(Buffer.from("not durable"))).rejects.toThrow(/fsync failed/);
  });

  it("a failed temp write publishes nothing and leaves no temp debris", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    vi.spyOn(durability, "writeFileSynced").mockRejectedValue(new Error("ENOSPC"));
    const content = Buffer.from("never lands");
    await expect(cas.putBuffer(content)).rejects.toThrow(/ENOSPC/);
    const hex = createHash("sha256").update(content).digest("hex");
    const dir = path.join(root, "sha256", hex.slice(0, 2));
    expect(await readdir(dir)).toEqual([]);
  });

  it("concurrent writers of identical content converge on one durable blob", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-cas-"));
    const cas = new CasStore(root);
    const content = Buffer.from("raced content");
    const hashes = await Promise.all([cas.putBuffer(content), cas.putBuffer(content), cas.putBuffer(content)]);
    expect(new Set(hashes).size).toBe(1);
    const first = hashes[0];
    expect(first).toBeDefined();
    const dest = cas.blobPath(first ?? "");
    expect((await readFile(dest)).toString()).toBe("raced content");
    expect((await readdir(path.dirname(dest))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("protected path diff", () => {
  async function tree(spec: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "hone-tree-"));
    for (const [rel, content] of Object.entries(spec)) {
      const p = path.join(root, rel);
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content);
    }
    return root;
  }

  it("reports modified, deleted, and added files under protected globs", async () => {
    const base = await tree({ "protected/a.txt": "1", "protected/b.txt": "2", "src/x.ts": "x" });
    const modified = await tree({ "protected/a.txt": "HACKED", "src/x.ts": "y" });
    const violations = await diffProtectedPaths(base, modified, ["protected/**"]);
    expect(violations.sort()).toEqual(["protected/a.txt", "protected/b.txt"]);
  });

  it("passes when protected files are byte-identical", async () => {
    const base = await tree({ "protected/a.txt": "same", "src/x.ts": "1" });
    const cand = await tree({ "protected/a.txt": "same", "src/x.ts": "totally different" });
    expect(await diffProtectedPaths(base, cand, ["protected/**"])).toEqual([]);
  });

  it("flags files added inside the protected namespace", async () => {
    const base = await tree({ "protected/a.txt": "1" });
    const cand = await tree({ "protected/a.txt": "1", "protected/new.txt": "sneak" });
    expect(await diffProtectedPaths(base, cand, ["protected/**"])).toEqual(["protected/new.txt"]);
  });
});
