import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasStore } from "./cas.js";
import { runCommand, type RunCommand } from "./command.js";
import { globToRegExp } from "./glob.js";
import { validateWorkspaceTar } from "./tarcheck.js";

/**
 * Artifact layout contract (broker-local): an artifact is a tar whose entries
 * are rooted at `workspace/` — exactly what `docker cp <c>:/workspace -`
 * emits. Extracting it at `/` inside a container recreates /workspace, and
 * extracting it on the host yields `<dir>/workspace/…`.
 *
 * Canonical form: artifacts are BYTE-STABLE for an unchanged file tree.
 * Packing writes ustar bytes directly (no tar binary), with entries sorted by
 * path, mtime/uid/gid forced to 0, uname/gname empty, and mode collapsed to
 * 0644/0755 by the owner-exec bit — the tree's content alone determines the
 * hash, on Darwin and Linux alike. Runtime/VCS detritus (.git, .gitdir,
 * .pytest_cache, __pycache__, *.pyc, *.pyo) is excluded at every depth.
 */

/** Hard cap on artifact tar size — applies to sandbox output AND canonical repacks. */
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

const BLOCK = 512;

/** Runtime/VCS detritus never admitted into a canonical artifact, at any depth. */
const DETRITUS_NAMES: Record<string, true> = { ".git": true, ".gitdir": true, ".pytest_cache": true, "__pycache__": true };
const DETRITUS_SUFFIXES = [".pyc", ".pyo"];

/**
 * Splits a path into ustar (name, prefix) fields: leftmost `/` split whose
 * suffix fits the 100-byte name field and prefix the 155-byte prefix field.
 * Deterministic; paths that cannot split are rejected (fail-closed).
 */
function splitUstarName(p: string): { name: string; prefix: string } {
  if (Buffer.byteLength(p) <= 100) return { name: p, prefix: "" };
  for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) {
    const prefix = p.slice(0, i);
    const name = p.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`artifact path does not fit ustar name+prefix fields: ${p}`);
}

/** One canonical ustar header block. Every non-content field is fixed. */
function ustarHeader(entryPath: string, kind: "file" | "dir", size: number, mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitUstarName(kind === "dir" ? `${entryPath}/` : entryPath);
  h.write(name, 0, 100, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "latin1");
  h.write("0000000\0", 108, "latin1"); // uid 0
  h.write("0000000\0", 116, "latin1"); // gid 0
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  h.write("00000000000\0", 136, "latin1"); // mtime 0: wall time never reaches the bytes
  h.write(kind === "dir" ? "5" : "0", 156, "latin1");
  h.write("ustar\0", 257, "latin1");
  h.write("00", 263, "latin1");
  // uname/gname/devmajor/devminor stay NUL — no host identity leaks in.
  if (prefix !== "") h.write(prefix, 345, 155, "utf8");
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}

interface SourceEntry {
  rel: string;
  kind: "file" | "dir";
  abs: string;
}

/**
 * Collects the packable tree under `root`. Detritus is pruned recursively;
 * anything that is not a regular file or directory (symlink, FIFO, device,
 * socket) is rejected outright — links are never followed.
 */
async function collectTree(root: string, rel: string, out: SourceEntry[]): Promise<void> {
  const dirents = await readdir(rel === "" ? root : path.join(root, rel), { withFileTypes: true });
  for (const d of dirents) {
    if (DETRITUS_NAMES[d.name] === true || DETRITUS_SUFFIXES.some((s) => d.name.endsWith(s))) continue;
    const entryRel = rel === "" ? d.name : `${rel}/${d.name}`;
    const abs = path.join(root, entryRel);
    if (d.isDirectory()) {
      out.push({ rel: entryRel, kind: "dir", abs });
      await collectTree(root, entryRel, out);
    } else if (d.isFile()) {
      out.push({ rel: entryRel, kind: "file", abs });
    } else {
      const what = d.isSymbolicLink() ? "symlink" : "special file";
      throw new Error(`unsupported ${what} in artifact tree: ${entryRel}`);
    }
  }
}

/**
 * Packs a directory tree into a canonical `workspace/`-rooted tar and stores
 * it in CAS. Same tree in, same bytes (and hash) out — independent of wall
 * time, umask beyond the owner-exec bit, platform tar binary, or traversal
 * order. Output is self-validated before it enters CAS.
 */
export async function packDirAsArtifact(dir: string, cas: CasStore): Promise<string> {
  const entries: SourceEntry[] = [];
  await collectTree(dir, "", entries);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const parts: Buffer[] = [ustarHeader("workspace", "dir", 0, 0o755)];
  let total = BLOCK;
  const charge = (n: number): void => {
    total += n;
    if (total > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds size cap");
  };
  for (const e of entries) {
    const entryPath = `workspace/${e.rel}`;
    if (e.kind === "dir") {
      parts.push(ustarHeader(entryPath, "dir", 0, 0o755));
      charge(BLOCK);
      continue;
    }
    const st = await lstat(e.abs);
    charge(BLOCK + Math.ceil(st.size / BLOCK) * BLOCK); // fail-closed BEFORE reading a huge file
    const content = await readFile(e.abs);
    if (content.length !== st.size) throw new Error(`artifact tree changed while packing: ${e.rel}`);
    const mode = (st.mode & 0o100) !== 0 ? 0o755 : 0o644;
    parts.push(ustarHeader(entryPath, "file", content.length, mode));
    parts.push(content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad !== 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  const bytes = Buffer.concat(parts);
  // Self-check: only validator-clean bytes ever enter CAS, so the unpack
  // gate can never reject an artifact this function produced.
  validateWorkspaceTar(bytes);
  return await cas.putBuffer(bytes);
}

/**
 * Extraction flags shared by every host-side `tar -x` of a validated
 * artifact: never adopt archive ownership, and never restore "full"
 * permissions (SUID/SGID, BSD file flags, ACLs, xattrs) — GNU tar and bsdtar
 * both honor these spellings, so no shell-specific cleanup is needed.
 */
const EXTRACT_FLAGS = ["--no-same-owner", "--no-same-permissions"];

/**
 * Owner-recursive access normalization for an extracted (possibly partial)
 * hostile tree: a validated tar may still carry mode-000/0111 entries, which
 * host tar restores — unwalkable by the canonical pack and untraversable by
 * cleanup. Directories gain u+rwx BEFORE their children are visited; regular
 * files gain u+rw while keeping the owner-exec bit (the canonical-mode
 * signal). Missing paths and chmod failures are tolerated — the caller's
 * readdir/read fails with a precise error if access is still impossible.
 */
async function makeTreeOwnerAccessible(root: string): Promise<void> {
  let st;
  try {
    st = await lstat(root); // never follows: a symlink target is never chmod'd
  } catch {
    return; // partial extraction — path never materialized
  }
  if (st.isDirectory()) {
    try {
      await chmod(root, (st.mode & 0o777) | 0o700);
    } catch {
      // fall through: readdir below reports the real failure if any
    }
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    for (const name of names) await makeTreeOwnerAccessible(path.join(root, name));
  } else if (st.isFile()) {
    try {
      await chmod(root, (st.mode & 0o777) | 0o600);
    } catch {
      // tolerated — pack's readFile surfaces the failure
    }
  }
}

/**
 * Canonicalizes an UNTRUSTED workspace tar (e.g. `docker cp` output from an
 * adversarial sandbox) into CAS: structural validation FIRST — nothing
 * malformed is ever written to disk or handed to a tar binary — then
 * extraction into a trusted temp dir (access-normalized so hostile mode bits
 * cannot block packing or cleanup), then a canonical repack of the extracted
 * `workspace/` tree. Returns the canonical hash; the temp dir is always
 * cleaned up.
 */
export async function canonicalizeWorkspaceTar(tarBytes: Buffer, cas: CasStore, run: RunCommand = runCommand): Promise<string> {
  validateWorkspaceTar(tarBytes);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hone-canon-"));
  try {
    const tarPath = path.join(tmp, "incoming.tar");
    await writeFile(tarPath, tarBytes);
    const treeDir = path.join(tmp, "tree");
    await mkdir(treeDir);
    const res = await run(["tar", ...EXTRACT_FLAGS, "-xf", tarPath, "-C", treeDir]);
    await makeTreeOwnerAccessible(treeDir); // even a failed extract left a partial tree to walk/remove
    if (res.exitCode !== 0) throw new Error(`tar extract failed: ${res.stderr.toString()}`);
    return await packDirAsArtifact(path.join(treeDir, "workspace"), cas);
  } finally {
    // Cleanup must survive whatever mode bits extraction restored.
    await makeTreeOwnerAccessible(tmp);
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Unpacks artifact `hash` under `destRoot` and returns the workspace dir.
 * Idempotent: an already-unpacked artifact is returned as-is; extraction goes
 * through a temp dir + rename so a crashed unpack never looks complete.
 */
export async function unpackArtifact(
  cas: CasStore,
  hash: string,
  destRoot: string,
  run: RunCommand = runCommand,
): Promise<string> {
  const finalDir = path.join(destRoot, hash.replace(":", "-"));
  const workspaceDir = path.join(finalDir, "workspace");
  try {
    const entries = await readdir(finalDir);
    if (entries.includes("workspace")) return workspaceDir;
  } catch {
    // not unpacked yet
  }
  // Adversarial-artifact gate: structurally validate the archive (single
  // workspace/ root, no links/devices/traversal/.git) BEFORE any tar binary
  // touches it. Extant CAS blobs get the same treatment as fresh ones.
  validateWorkspaceTar(await cas.readBuffer(hash));
  const tmp = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(tmp, { recursive: true });
  const res = await run(["tar", ...EXTRACT_FLAGS, "-xf", cas.blobPath(hash), "-C", tmp]);
  if (res.exitCode !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(`tar unpack failed for ${hash}: ${res.stderr.toString()}`);
  }
  try {
    await rename(tmp, finalDir);
  } catch {
    // A concurrent unpack won the rename; ours is redundant.
    await rm(tmp, { recursive: true, force: true });
  }
  return workspaceDir;
}

/**
 * Walks a tree into rel-path → fingerprint. Directories are first-class
 * (`dir`) so an added/deleted/type-changed directory diffs like any leaf;
 * symlinks fingerprint their target so a retarget diffs too.
 */
async function walkTree(root: string, rel = ""): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const entryRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.set(entryRel, "dir");
      for (const [k, v] of await walkTree(root, entryRel)) out.set(k, v);
    } else if (entry.isFile()) {
      const digest = createHash("sha256")
        .update(await readFile(path.join(root, rel, entry.name)))
        .digest("hex");
      out.set(entryRel, `file:${digest}`);
    } else if (entry.isSymbolicLink()) {
      out.set(entryRel, `link:${await readlink(path.join(root, rel, entry.name))}`);
    } else {
      // devices/FIFOs inside an unpacked tree: record kind so a type change diffs
      out.set(entryRel, "special");
    }
  }
  return out;
}

/**
 * Protected-spec matching: a spec containing glob metacharacters keeps glob
 * semantics (see glob.ts); a PLAIN path is a namespace — it protects itself
 * and every descendant, so `protected` freezes `protected`, `protected/a`,
 * `protected/a/b`, … without needing `/**`.
 */
function matchesProtected(rel: string, specs: readonly string[]): boolean {
  for (const spec of specs) {
    if (/[*?]/.test(spec)) {
      if (globToRegExp(spec).test(rel)) return true;
    } else {
      const p = spec.replace(/\/+$/, "");
      if (rel === p || rel.startsWith(`${p}/`)) return true;
    }
  }
  return false;
}

/**
 * Diffs two unpacked trees over the protected specs. Returns every relative
 * path in a protected namespace that was modified, deleted, added, or changed
 * type (file/dir/link) — any of which is a violation (the protected namespace
 * is frozen wholesale, directories included).
 */
export async function diffProtectedPaths(
  baselineDir: string,
  candidateDir: string,
  protectedGlobs: readonly string[],
): Promise<string[]> {
  if (protectedGlobs.length === 0) return [];
  const [base, cand] = await Promise.all([walkTree(baselineDir), walkTree(candidateDir)]);
  const violations = new Set<string>();
  for (const [rel, digest] of base) {
    if (!matchesProtected(rel, protectedGlobs)) continue;
    if (cand.get(rel) !== digest) violations.add(rel);
  }
  for (const rel of cand.keys()) {
    if (!base.has(rel) && matchesProtected(rel, protectedGlobs)) violations.add(rel);
  }
  return [...violations].sort();
}

/** Recursive on-disk size in bytes — scratch quota accounting. */
export async function dirSizeBytes(root: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(p);
    } else if (entry.isFile()) {
      total += (await stat(p)).size;
    }
  }
  return total;
}
