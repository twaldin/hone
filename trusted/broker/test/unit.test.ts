import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CasStore } from "../src/cas.js";
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
