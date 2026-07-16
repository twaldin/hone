import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_DURABLE_IO, writeAll, type DurableIo } from "./durable-io.js";

/**
 * Power-loss-durable content-addressed store write. Layout (shared
 * convention, contract-adjacent): `<casDir>/sha256/<first2>/<fullhash>`.
 *
 * Publication ordering — a reader that sees the final name after a crash is
 * GUARANTEED to read the full content:
 *   1. temp file written (short writes looped) and fsynced — content durable
 *      under a private name;
 *   2. atomic rename onto the final name;
 *   3. the FULL directory chain fsynced child-first on EVERY put — leaf,
 *      `sha256`, the CAS root, and the CAS root's parent — regardless of
 *      whether mkdir created anything. A merely-visible fanout inherited
 *      from a crashed writer (created but never chain-fsynced) is therefore
 *      re-established as durable by ANY later writer; resolution never
 *      trusts another writer's unproven syncs.
 *
 * Concurrent/duplicate writers of identical content are idempotent: each
 * writes its own temp and renames onto the same final name (same bytes), and
 * every call re-establishes durability even if an earlier unsynced copy
 * existed. The temp file is removed on any failure — no `.tmp-*` litter.
 * Returns the `sha256:<hex>` reference used by ProxyTraceRecord.
 */
export async function casWrite(
  casDir: string,
  content: string | Buffer,
  io?: Partial<DurableIo>,
): Promise<string> {
  const ops: DurableIo = { ...DEFAULT_DURABLE_IO, ...io };
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const hash = createHash("sha256").update(buf).digest("hex");
  const dir = resolve(join(casDir, "sha256", hash.slice(0, 2)));
  await mkdir(dir, { recursive: true });

  // 1. Content durable under a private name BEFORE it can be observed.
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    // `wx`: the temp name is private by construction (random suffix), and
    // exclusive-create guarantees even a pathological collision can never
    // truncate another publisher's in-flight temp.
    const handle = await open(tmp, "wx");
    try {
      await writeAll(ops, handle, buf);
      await ops.syncFile(handle);
    } finally {
      await handle.close();
    }
    // 2. Atomic publication onto the final name.
    await rename(tmp, join(dir, hash));
  } catch (err) {
    // Never leave temp litter behind a failed publication.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  // 3. Name + chain durable, independent of mkdir's report: dirs that EXIST
  // may still be non-durable leftovers of a crashed writer, so every put
  // fsyncs the whole chain child-first before resolving.
  const casRoot = resolve(casDir);
  for (const p of new Set<string>([dir, dirname(dir), casRoot, dirname(casRoot)])) {
    await ops.syncDir(p);
  }
  return `sha256:${hash}`;
}
