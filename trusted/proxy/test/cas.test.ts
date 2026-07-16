import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { casWrite, DEFAULT_DURABLE_IO } from "../src/index.js";

function sha256hex(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function leafDirOf(casDir: string, content: string): string {
  return join(casDir, "sha256", sha256hex(content).slice(0, 2));
}

function finalPathOf(casDir: string, content: string): string {
  const hex = sha256hex(content);
  return join(casDir, "sha256", hex.slice(0, 2), hex);
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function tempCasDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "hone-cas-"));
  return join(base, "cas"); // does not exist yet — casWrite must create AND sync the chain
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

/** `Promise.withResolvers` ponyfill — the workspace engine floor is Node 18,
 * so this is the single sanctioned use of the executor form in this file. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** "done" if `p` settles within `ms`, else "pending" — never throws. */
async function raced(p: Promise<unknown>, ms = 80): Promise<"done" | "pending"> {
  return Promise.race([
    p.then(
      () => "done" as const,
      () => "done" as const,
    ),
    sleep(ms).then(() => "pending" as const),
  ]);
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

/** Different content whose hash shares `base`'s 2-hex fanout prefix. */
function sameFanoutContent(base: string): string {
  const prefix = sha256hex(base).slice(0, 2);
  for (let i = 0; ; i += 1) {
    const candidate = `{"body":"fanout-sibling-${i}"}`;
    if (candidate !== base && sha256hex(candidate).slice(0, 2) === prefix) return candidate;
  }
}

describe("casWrite durability", () => {
  it("publishes in exact order: content written+fsynced under a temp name, then renamed, then dirs fsynced", async () => {
    const casDir = await tempCasDir();
    const content = '{"body":"ordering"}';
    const final = finalPathOf(casDir, content);
    const leaf = leafDirOf(casDir, content);
    const events: string[] = [];
    const ref = await casWrite(casDir, content, {
      async write(handle, buf, offset, length) {
        events.push("write");
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, length);
      },
      async syncFile(handle) {
        // At content-fsync time the final name must NOT exist yet — only the
        // private temp does. A crash here loses nothing observable.
        expect(await exists(final)).toBe(false);
        const names = await listNames(leaf);
        expect(names.some((n) => n.startsWith(".tmp-"))).toBe(true);
        events.push("syncFile");
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
      async syncDir(p) {
        // By the first directory fsync the rename has already happened.
        expect(await exists(final)).toBe(true);
        events.push(`syncDir:${p}`);
        return DEFAULT_DURABLE_IO.syncDir(p);
      },
    });
    expect(ref).toBe(`sha256:${sha256hex(content)}`);
    expect(await readFile(final, "utf8")).toBe(content);
    // Every write precedes the content fsync; the content fsync precedes every dir fsync.
    expect(events[0]).toBe("write");
    expect(events.indexOf("syncFile")).toBe(events.lastIndexOf("write") + 1);
    expect(events.filter((e) => e.startsWith("syncDir:")).length).toBeGreaterThan(0);
    expect(events.indexOf("syncFile")).toBeLessThan(events.findIndex((e) => e.startsWith("syncDir:")));
  });

  it("EVERY put fsyncs the full chain child-first, independent of what mkdir created", async () => {
    const casDir = await tempCasDir(); // casDir itself does not exist
    const content = '{"body":"chain"}';
    const leaf = leafDirOf(casDir, content);
    const chain = [leaf, join(casDir, "sha256"), casDir, dirname(casDir)];
    const synced: string[] = [];
    const io = {
      async syncDir(p: string) {
        synced.push(p);
        return DEFAULT_DURABLE_IO.syncDir(p);
      },
    };
    await casWrite(casDir, content, io);
    expect(synced).toEqual(chain); // leaf -> sha256 -> CAS root -> root parent

    // A repeat put re-syncs the SAME full chain: preexisting directories are
    // never trusted to be durable (they may be crash-created leftovers).
    synced.length = 0;
    await casWrite(casDir, content, io);
    expect(synced).toEqual(chain);
  });

  it("loops short writes until the full content is durable", async () => {
    const casDir = await tempCasDir();
    const content = '{"body":"short-writes"}';
    let writeCalls = 0;
    const ref = await casWrite(casDir, content, {
      async write(handle, buf, offset, length) {
        writeCalls += 1;
        return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
      },
    });
    expect(writeCalls).toBe(Buffer.byteLength(content, "utf8"));
    expect(await readFile(finalPathOf(casDir, content), "utf8")).toBe(content);
    expect(ref).toBe(`sha256:${sha256hex(content)}`);
  });

  it("treats a zero-progress write as a failure instead of looping forever", async () => {
    const casDir = await tempCasDir();
    await expect(
      casWrite(casDir, '{"body":"stuck"}', {
        async write() {
          return 0;
        },
      }),
    ).rejects.toThrow(/no progress/);
  });

  it("a write or fsync failure rejects, publishes nothing, leaves no temp, and a retry succeeds", async () => {
    const casDir = await tempCasDir();
    const content = '{"body":"faulty"}';
    const leaf = leafDirOf(casDir, content);

    // Mid-content write failure.
    let attempts = 0;
    await expect(
      casWrite(casDir, content, {
        async write(handle, buf, offset, length) {
          attempts += 1;
          if (attempts > 2) throw new Error("ENOSPC: simulated");
          return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
        },
      }),
    ).rejects.toThrow(/ENOSPC/);
    expect(await exists(finalPathOf(casDir, content))).toBe(false); // never published
    expect(await listNames(leaf)).toEqual([]); // no temp litter

    // Content-fsync failure.
    await expect(
      casWrite(casDir, content, {
        async syncFile() {
          throw new Error("EIO: simulated fsync failure");
        },
      }),
    ).rejects.toThrow(/EIO/);
    expect(await exists(finalPathOf(casDir, content))).toBe(false);
    expect(await listNames(leaf)).toEqual([]);

    // CAS is retryable (content-addressed, idempotent): a healthy retry publishes.
    const ref = await casWrite(casDir, content);
    expect(ref).toBe(`sha256:${sha256hex(content)}`);
    expect(await readFile(finalPathOf(casDir, content), "utf8")).toBe(content);
    expect(await listNames(leaf)).toEqual([sha256hex(content)]);
  });

  it("concurrent writers of identical content dedup to one durable entry with no temp litter", async () => {
    const casDir = await tempCasDir();
    const content = '{"body":"concurrent-dedup"}';
    const refs = await Promise.all(
      Array.from({ length: 8 }, () =>
        casWrite(casDir, content, {
          // 1-byte writes widen the overlap window between racers.
          async write(handle, buf, offset, length) {
            return DEFAULT_DURABLE_IO.write(handle, buf, offset, Math.min(1, length));
          },
        }),
      ),
    );
    const expected = `sha256:${sha256hex(content)}`;
    for (const ref of refs) expect(ref).toBe(expected);
    const leaf = leafDirOf(casDir, content);
    expect(await listNames(leaf)).toEqual([sha256hex(content)]); // one entry, zero .tmp-*
    expect(await readFile(finalPathOf(casDir, content), "utf8")).toBe(content);
  });

  it("re-writing content that already exists re-establishes durability instead of skipping", async () => {
    const casDir = await tempCasDir();
    const content = '{"body":"redurable"}';
    const leaf = leafDirOf(casDir, content);
    // Simulate a PRIOR NON-DURABLE publication (plain write, no fsyncs).
    await mkdir(leaf, { recursive: true });
    await writeFile(finalPathOf(casDir, content), content);

    let contentSyncs = 0;
    const dirSyncs: string[] = [];
    const ref = await casWrite(casDir, content, {
      async syncFile(handle) {
        contentSyncs += 1;
        return DEFAULT_DURABLE_IO.syncFile(handle);
      },
      async syncDir(p) {
        dirSyncs.push(p);
        return DEFAULT_DURABLE_IO.syncDir(p);
      },
    });
    expect(ref).toBe(`sha256:${sha256hex(content)}`);
    expect(contentSyncs).toBe(1); // content re-written + re-fsynced, not skipped
    // rename re-published the entry durably, and the full chain was re-proven
    expect(dirSyncs).toEqual([leaf, join(casDir, "sha256"), casDir, dirname(casDir)]);
    expect(await readFile(finalPathOf(casDir, content), "utf8")).toBe(content);
    expect(await listNames(leaf)).toEqual([sha256hex(content)]);
  });

  it("a writer inheriting crash-created visible-but-unsynced fanout cannot resolve until the full chain is fsynced", async () => {
    const casDir = await tempCasDir();
    const contentA = '{"body":"crash-A"}';
    const leafA = leafDirOf(casDir, contentA);

    // Writer A dies after rename, before its ancestor syncs: the fanout and
    // the final name are VISIBLE but nothing about the chain is durable.
    await expect(
      casWrite(casDir, contentA, {
        async syncDir(p) {
          if (p !== leafA) throw new Error("EIO: crashed before ancestor sync");
          return DEFAULT_DURABLE_IO.syncDir(p);
        },
      }),
    ).rejects.toThrow(/crashed before ancestor sync/);
    expect(await exists(finalPathOf(casDir, contentA))).toBe(true); // visible, not chain-durable

    // Writer B lands in the SAME fanout (identical 2-hex prefix), so mkdir
    // reports nothing created. B must still fsync the whole chain — and must
    // not resolve before the LAST (root-parent) sync completes.
    const contentB = sameFanoutContent(contentA);
    const chain = [leafA, join(casDir, "sha256"), casDir, dirname(casDir)];
    const gate = deferred<void>();
    const synced: string[] = [];
    const putB = casWrite(casDir, contentB, {
      async syncDir(p) {
        synced.push(p);
        if (p === dirname(casDir)) await gate.promise;
        return DEFAULT_DURABLE_IO.syncDir(p);
      },
    });
    await until(() => synced.length === chain.length);
    expect(await raced(putB)).toBe("pending"); // resolution waits on the root-parent sync
    gate.resolve();
    await expect(putB).resolves.toBe(`sha256:${sha256hex(contentB)}`);
    expect(synced).toEqual(chain); // full chain, child-first, despite preexisting dirs
    expect(await readFile(finalPathOf(casDir, contentB), "utf8")).toBe(contentB);
  });
});
