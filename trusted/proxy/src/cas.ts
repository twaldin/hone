import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Content-addressed store write. Layout (shared convention, contract-adjacent):
 * `<casDir>/sha256/<first2>/<fullhash>`. Write = hash + temp file + rename
 * into place, so concurrent writers of identical content are idempotent.
 * Returns the `sha256:<hex>` reference used by ProxyTraceRecord.
 */
export async function casWrite(casDir: string, content: string | Buffer): Promise<string> {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const hash = createHash("sha256").update(buf).digest("hex");
  const dir = join(casDir, "sha256", hash.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  await writeFile(tmp, buf);
  await rename(tmp, join(dir, hash));
  return `sha256:${hash}`;
}
