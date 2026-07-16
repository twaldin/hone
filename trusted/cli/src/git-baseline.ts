import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const SKIP_WORKTREE = new Set([".git", ".gitdir", "__pycache__", ".pytest_cache"]);

interface TreeFile {
  rel: string;
  mode: "100644" | "100755";
  bytes: Buffer;
}

function assertPlainRepositoryTree(dir: string, rel = ""): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`baseline git store is not a directory: ${dir}`);
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error(`baseline git store contains symlink ${JSON.stringify(childRel)}`);
    if (childStat.isDirectory()) assertPlainRepositoryTree(child, childRel);
    else if (!childStat.isFile()) throw new Error(`baseline git store contains non-file ${JSON.stringify(childRel)}`);
  }
}

export function baselineGitDir(baselineDir: string): string {
  const gitDir = existsSync(join(baselineDir, ".gitdir")) ? join(baselineDir, ".gitdir") : join(baselineDir, ".git");
  if (!existsSync(gitDir)) throw new Error(`git baseline has no .gitdir/ or .git/ store: ${baselineDir}`);
  assertPlainRepositoryTree(gitDir);
  for (const rel of ["objects/info/alternates", "objects/info/http-alternates", "commondir"]) {
    if (existsSync(join(gitDir, rel))) throw new Error(`baseline git store uses forbidden external object indirection: ${rel}`);
  }
  return gitDir;
}

function gitEnv(): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

function gitBuffer(gitDir: string, args: string[], maxBuffer = MAX_TREE_BYTES + 1024): Buffer {
  try {
    return execFileSync(
      "git",
      [
        "--no-pager",
        `--git-dir=${gitDir}`,
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "core.attributesFile=/dev/null",
        ...args,
      ],
      { env: gitEnv(), maxBuffer },
    );
  } catch (error) {
    throw new Error(`hardened git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeTreePath(pathBytes: Buffer, seen: Set<string>): string {
  const rel = pathBytes.toString("utf8");
  if (!Buffer.from(rel, "utf8").equals(pathBytes)) throw new Error("git tree contains a non-UTF-8 path");
  const parts = rel.split("/");
  if (
    rel === ""
    || rel.startsWith("/")
    || parts.some((part) => part === "" || part === "." || part === ".." || part === ".git" || part === ".gitdir")
  ) throw new Error(`git tree contains unsafe path ${JSON.stringify(rel)}`);
  const collisionKey = rel.normalize("NFC").toLowerCase();
  if (seen.has(collisionKey)) throw new Error(`git tree contains a case/Unicode-colliding path ${JSON.stringify(rel)}`);
  seen.add(collisionKey);
  return rel;
}

function readTree(gitDir: string, commit: string): TreeFile[] {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new Error(`invalid declared git commit: ${commit}`);
  const type = gitBuffer(gitDir, ["cat-file", "-t", commit], 1024).toString("utf8").trim();
  if (type !== "commit") throw new Error(`declared git object ${commit} is ${type || "missing"}, not a commit`);
  const listing = gitBuffer(gitDir, ["ls-tree", "-r", "-z", "--full-tree", commit], 128 * 1024 * 1024);
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < listing.length; i += 1) {
    if (listing[i] !== 0) continue;
    if (i > start) records.push(listing.subarray(start, i));
    start = i + 1;
  }
  if (start !== listing.length) throw new Error("git ls-tree returned a non-NUL-terminated record");
  if (records.length > MAX_TREE_ENTRIES) throw new Error(`git tree has too many entries (${records.length} > ${MAX_TREE_ENTRIES})`);

  const files: TreeFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const record of records) {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error("git ls-tree returned an invalid record");
    const meta = record.subarray(0, tab).toString("ascii").split(" ");
    const [mode, typeName, oid] = meta;
    if ((mode !== "100644" && mode !== "100755") || typeName !== "blob" || oid === undefined || !/^[0-9a-f]{40,64}$/.test(oid)) {
      throw new Error(`git tree contains unsupported entry ${record.subarray(0, tab).toString("utf8")}`);
    }
    const rel = safeTreePath(record.subarray(tab + 1), seen);
    const bytes = gitBuffer(gitDir, ["cat-file", "blob", oid]);
    total += bytes.length;
    if (total > MAX_TREE_BYTES) throw new Error(`git tree exceeds ${MAX_TREE_BYTES} bytes`);
    files.push({ rel, mode, bytes });
  }
  return files;
}

/** Materialize commit blobs only: no checkout, filters, attributes, or hooks. */
export function materializeGitCommit(baselineDir: string, commit: string, destination: string): void {
  const gitDir = baselineGitDir(baselineDir);
  mkdirSync(destination, { recursive: true });
  const root = resolve(destination);
  for (const file of readTree(gitDir, commit)) {
    const target = resolve(destination, ...file.rel.split("/"));
    if (!target.startsWith(`${root}${sep}`)) throw new Error(`git tree path escapes destination: ${file.rel}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
    chmodSync(target, file.mode === "100755" ? 0o755 : 0o644);
  }
}

function collectWorkspace(dir: string): Map<string, { mode: string; hash: string }> {
  const files = new Map<string, { mode: string; hash: string }>();
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (prefix === "" && SKIP_WORKTREE.has(name)) continue;
      const abs = join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) {
        files.set(rel, {
          mode: (st.mode & 0o111) !== 0 ? "100755" : "100644",
          hash: createHash("sha256").update(readFileSync(abs)).digest("hex"),
        });
      } else {
        throw new Error(`baseline worktree contains non-regular entry ${JSON.stringify(rel)}`);
      }
    }
  };
  walk(dir, "");
  return files;
}

/** Verify the visible baseline directory is exactly the declared commit tree. */
export function assertBaselineMatchesGitCommit(baselineDir: string, commit: string): void {
  const temp = mkdtempSync(join(tmpdir(), "hone-git-baseline-"));
  const expectedDir = join(temp, "tree");
  try {
    materializeGitCommit(baselineDir, commit, expectedDir);
    const actual = collectWorkspace(baselineDir);
    const expected = collectWorkspace(expectedDir);
    if (actual.size !== expected.size) {
      throw new Error(`baseline worktree path count ${actual.size} != declared commit path count ${expected.size}`);
    }
    for (const [rel, expectedFile] of expected) {
      const actualFile = actual.get(rel);
      if (actualFile === undefined || actualFile.mode !== expectedFile.mode || actualFile.hash !== expectedFile.hash) {
        throw new Error(`baseline worktree differs from declared commit at ${JSON.stringify(rel)}`);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
