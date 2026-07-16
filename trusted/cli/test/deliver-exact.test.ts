import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTreeMatchesStage, deliver, type DeliverOptions } from "../src/deliver.js";
import { writeCas } from "../src/cas.js";
import { gitIn, initScratchRepo, makeRoot, tarToCas } from "./helpers.js";

/**
 * Artifact-exact delivery: the plumbing path (hash-object --no-filters →
 * temp index → write-tree → commit-tree → verify → update-ref) must be
 * structurally immune to everything the target repo or host git config can
 * throw at it — hooks, clean/smudge filters, ignore rules, hostile global
 * config, path edge cases — and must fail closed on any tree divergence.
 */

const CAS = ".hone-cas";

function opts(root: string, repo: string, artifact: string, extra: Partial<DeliverOptions> = {}): DeliverOptions {
  return {
    mode: "branch",
    repo,
    runId: "run_exact",
    artifact,
    casDir: join(root, CAS),
    improverSeat: false,
    env: process.env,
    ...extra,
  };
}

/** Build a workspace/-rooted artifact with full control over file modes. */
function tarFilesToCas(root: string, files: Record<string, { content: string; mode?: number }>): string {
  const stage = mkdtempSync(join(tmpdir(), "hone-exact-stage-"));
  for (const [rel, spec] of Object.entries(files)) {
    const p = join(stage, "workspace", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, spec.content);
    if (spec.mode !== undefined) chmodSync(p, spec.mode);
  }
  const tarPath = join(mkdtempSync(join(tmpdir(), "hone-exact-tar-")), "artifact.tar");
  const metaFlags =
    process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata", "--no-acls", "--no-fflags"] : ["--no-xattrs"];
  const r = spawnSync("tar", ["-C", stage, ...metaFlags, "-cf", tarPath, "workspace"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  return writeCas(join(root, CAS), readFileSync(tarPath));
}

/** Every hook a delivery could conceivably fire; each one is a tripwire. */
const HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-merge-commit",
  "post-checkout",
  "post-merge",
  "post-index-change",
  "reference-transaction",
  "fsmonitor-watchman",
  "pre-auto-gc",
];

function armHooks(dir: string, marker: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of HOOK_NAMES) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "$0" >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
  }
}

/**
 * Snapshot of everything delivery must not disturb in the target working
 * tree. The status probe itself runs hook-disabled — `git status` on a dirty
 * tree opportunistically refreshes the index and would fire the armed
 * post-index-change tripwire from the TEST harness, not from delivery.
 */
function wtSnapshot(repo: string): { status: string; hello: string } {
  return {
    status: gitIn(repo, "-c", `core.hooksPath=${mkdtempSync(join(tmpdir(), "hone-nohooks-"))}`, "-c", "core.fsmonitor=", "status", "--porcelain"),
    hello: readFileSync(join(repo, "hello.txt"), "utf8"),
  };
}

describe("delivery is hook-proof — zero hook processes run, including ref-transaction plumbing hooks", () => {
  it("armed .git/hooks + repo-local core.hooksPath/fsmonitor never execute; commit still lands exactly", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const marker = join(root, "hook-ran");
    armHooks(join(repo, ".git", "hooks"), marker);
    // repo-local config pointing hooks/fsmonitor at ANOTHER armed dir — the
    // delivery env's command-scope config must out-rank it
    const altHooks = join(root, "alt-hooks");
    armHooks(altHooks, marker);
    gitIn(repo, "config", "core.hooksPath", altHooks);
    gitIn(repo, "config", "core.fsmonitor", join(altHooks, "fsmonitor-watchman"));

    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    const before = wtSnapshot(repo);
    const result = deliver(opts(root, repo, hash));
    expect(result.ref).toBe("hone/run_exact");
    expect(gitIn(repo, "show", "hone/run_exact:hello.txt")).toBe("improved");
    expect(existsSync(marker), existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe(false);
    expect(wtSnapshot(repo)).toEqual(before);
  });

  it("pr mode: same plumbing, hooks silent, working tree untouched even when dirty", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const marker = join(root, "hook-ran");
    armHooks(join(repo, ".git", "hooks"), marker);
    // dirty working tree: delivery must not stash, checkout, or reset anything
    writeFileSync(join(repo, "hello.txt"), "locally edited\n");
    writeFileSync(join(repo, "untracked.txt"), "scratch\n");

    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    const before = wtSnapshot(repo);
    const result = deliver(opts(root, repo, hash, { mode: "pr" }));
    expect(result.ref).toBe("hone/run_exact");
    expect(result.notes.join("\n")).toMatch(/local-only/);
    expect(gitIn(repo, "show", "hone/run_exact:hello.txt")).toBe("improved");
    expect(existsSync(marker)).toBe(false);
    expect(wtSnapshot(repo)).toEqual(before);
    expect(readFileSync(join(repo, "untracked.txt"), "utf8")).toBe("scratch\n");
  });

  it("auto mode: ref-only merge advances HEAD branch, hooks silent, working tree bytes untouched", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const marker = join(root, "hook-ran");
    armHooks(join(repo, ".git", "hooks"), marker);

    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    const result = deliver(opts(root, repo, hash, { mode: "auto" }));
    expect(result.ref).toBe("main");
    expect(gitIn(repo, "show", "main:hello.txt")).toBe("improved");
    // the merge landed by ref update only — checkout never happened
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("baseline\n");
    expect(existsSync(marker)).toBe(false);
  });

  it("auto mode resumes after refs moved but delivery event was not recorded", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    const options = opts(root, repo, hash, { mode: "auto" });
    expect(deliver(options).ref).toBe("main");
    const applied = gitIn(repo, "rev-parse", "main");
    const recovered = deliver(options);
    expect(recovered.ref).toBe("main");
    expect(recovered.notes.join("\n")).toMatch(/already present/);
    expect(gitIn(repo, "rev-parse", "main")).toBe(applied);
  });
});

describe("delivery is filter-proof — clean/smudge/eol machinery never touches artifact bytes", () => {
  it("committed .gitattributes + repo-local required filter neither run nor rewrite content", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const marker = join(root, "filter-ran");
    const filterScript = join(root, "evil-filter.sh");
    writeFileSync(filterScript, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nsed 's/improved/FILTERED/'\n`, { mode: 0o755 });
    // attributes both committed at HEAD and present in the working tree
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil text eol=crlf\n");
    gitIn(repo, "add", ".gitattributes");
    gitIn(repo, "commit", "-m", "attrs");
    gitIn(repo, "config", "filter.evil.clean", filterScript);
    gitIn(repo, "config", "filter.evil.smudge", filterScript);
    gitIn(repo, "config", "filter.evil.required", "true");

    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    deliver(opts(root, repo, hash));
    expect(existsSync(marker)).toBe(false);
    // byte-exact: no clean rewrite, no eol=crlf conversion
    const blob = spawnSync("git", ["-C", repo, "cat-file", "blob", "hone/run_exact:hello.txt"], {});
    expect(blob.stdout.equals(Buffer.from("improved\n"))).toBe(true);
  });
});

describe("delivery is ignore-proof — .gitignore / info/exclude cannot drop artifact files", () => {
  it("files matching committed .gitignore and .git/info/exclude still land in the commit", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    writeFileSync(join(repo, ".gitignore"), "dist/\n*.gen\nsecret.txt\n");
    gitIn(repo, "add", ".gitignore");
    gitIn(repo, "commit", "-m", "ignore");
    writeFileSync(join(repo, ".git", "info", "exclude"), "*\n"); // exclude EVERYTHING

    const hash = tarToCas(root, {
      "dist/bundle.js": "built\n",
      "notes.gen": "generated\n",
      "secret.txt": "not actually secret\n",
      "kept.txt": "plain\n",
    });
    deliver(opts(root, repo, hash));
    expect(gitIn(repo, "show", "hone/run_exact:dist/bundle.js")).toBe("built");
    expect(gitIn(repo, "show", "hone/run_exact:notes.gen")).toBe("generated");
    expect(gitIn(repo, "show", "hone/run_exact:secret.txt")).toBe("not actually secret");
    expect(gitIn(repo, "show", "hone/run_exact:kept.txt")).toBe("plain");
  });
});

describe("delivery ignores hostile system/global git config entirely", () => {
  it("global hooksPath/filters/excludes/identity/gpgsign are all inert; identity stays repo-local", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const marker = join(root, "global-ran");
    const hostileHooks = join(root, "global-hooks");
    armHooks(hostileHooks, marker);
    const hostileFilter = join(root, "global-filter.sh");
    writeFileSync(hostileFilter, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\ncat\n`, { mode: 0o755 });
    const excludeAll = join(root, "global-excludes");
    writeFileSync(excludeAll, "*\n");
    const hostileHome = join(root, "hostile-home");
    mkdirSync(hostileHome);
    writeFileSync(
      join(hostileHome, ".gitconfig"),
      [
        "[core]",
        `\thooksPath = ${hostileHooks}`,
        `\tfsmonitor = ${join(hostileHooks, "fsmonitor-watchman")}`,
        `\texcludesFile = ${excludeAll}`,
        "[user]",
        "\tname = EVIL",
        "\temail = evil@example.com",
        '[filter "evil"]',
        `\tclean = ${hostileFilter}`,
        `\tsmudge = ${hostileFilter}`,
        "\trequired = true",
        "[commit]",
        "\tgpgsign = true", // would abort commit-tree if this scope ever loaded
        "[gpg]",
        `\tprogram = ${join(hostileHooks, "pre-commit")}`,
      ].join("\n"),
    );

    const hash = tarToCas(root, { "hello.txt": "improved\n", "ignored-by-global.txt": "still here\n" });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: hostileHome,
      XDG_CONFIG_HOME: join(hostileHome, ".config"),
      GIT_CONFIG_GLOBAL: join(hostileHome, ".gitconfig"),
      GIT_CONFIG_SYSTEM: join(hostileHome, ".gitconfig"),
    };
    const result = deliver(opts(root, repo, hash, { env }));
    expect(result.ref).toBe("hone/run_exact");
    expect(existsSync(marker)).toBe(false);
    expect(gitIn(repo, "show", "hone/run_exact:hello.txt")).toBe("improved");
    expect(gitIn(repo, "show", "hone/run_exact:ignored-by-global.txt")).toBe("still here");
    // explicit local identity — never the hostile global one
    expect(gitIn(repo, "log", "-1", "--format=%an <%ae>", "hone/run_exact")).toBe("hone-test <hone-test@localhost>");
  });
});

describe("executable modes and path edge cases survive exactly", () => {
  it("exec bit → 100755, plain → 100644", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const hash = tarFilesToCas(root, {
      "run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
      "plain.txt": { content: "text\n", mode: 0o644 },
    });
    deliver(opts(root, repo, hash));
    const tree = gitIn(repo, "ls-tree", "-r", "hone/run_exact");
    expect(tree).toMatch(/^100755 blob [0-9a-f]+\trun\.sh$/m);
    expect(tree).toMatch(/^100644 blob [0-9a-f]+\tplain\.txt$/m);
  });

  it("spaces, quotes, unicode, leading dashes, deep nesting — delivered byte-exact, nothing extra", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const files: Record<string, string> = {
      "a b/c d.txt": "spaced\n",
      'quote"s.txt': "quoted\n",
      "déjà vu.txt": "unicode\n",
      "-dash.txt": "dashed\n",
      "deep/nested/dir/file.txt": "deep\n",
    };
    const hash = tarToCas(root, files);
    deliver(opts(root, repo, hash));
    // macOS writes NFD filenames (and core.precomposeUnicode NFC-ifies CLI
    // path args), so compare the path SET under NFC and verify bytes by blob
    // oid — never by path lookup. -z: NUL-separated, never C-quoted.
    const records = gitIn(repo, "ls-tree", "-r", "-z", "hone/run_exact")
      .split("\0")
      .filter((r) => r !== "");
    const oidByNfc = new Map<string, string>();
    for (const record of records) {
      const tab = record.indexOf("\t");
      const oid = record.slice(0, tab).split(" ")[2] ?? "";
      oidByNfc.set(record.slice(tab + 1).normalize("NFC"), oid);
    }
    expect([...oidByNfc.keys()].sort()).toEqual(Object.keys(files).map((n) => n.normalize("NFC")).sort());
    for (const [rel, content] of Object.entries(files)) {
      const oid = oidByNfc.get(rel.normalize("NFC"));
      expect(oid, rel).toBeDefined();
      expect(gitIn(repo, "cat-file", "blob", oid ?? "")).toBe(content.trim());
    }
  });
});

describe("tree verification fails closed on any divergence", () => {
  /** Forge a tree via plumbing, bypassing delivery, to feed the verifier. */
  function forgeTree(repo: string, entries: { mode: string; content: string; path: string }[]): string {
    const indexFile = join(mkdtempSync(join(tmpdir(), "hone-forge-")), "index");
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    let info = "";
    for (const e of entries) {
      const h = spawnSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { encoding: "utf8", input: e.content });
      info += `${e.mode} ${h.stdout.trim()}\t${e.path}\0`;
    }
    const u = spawnSync("git", ["-C", repo, "update-index", "-z", "--index-info"], { encoding: "utf8", input: info, env });
    if (u.status !== 0) throw new Error(u.stderr);
    return spawnSync("git", ["-C", repo, "write-tree"], { encoding: "utf8", env }).stdout.trim();
  }

  function makeStage(files: Record<string, { content: string; mode?: number }>): string {
    const stage = mkdtempSync(join(tmpdir(), "hone-verify-stage-"));
    for (const [rel, spec] of Object.entries(files)) {
      const p = join(stage, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, spec.content);
      if (spec.mode !== undefined) chmodSync(p, spec.mode);
    }
    return stage;
  }

  it("accepts an exact match", () => {
    const repo = join(makeRoot(), "repo");
    initScratchRepo(repo);
    const tree = forgeTree(repo, [{ mode: "100644", content: "x\n", path: "f.txt" }]);
    expect(() => assertTreeMatchesStage(repo, tree, makeStage({ "f.txt": { content: "x\n" } }))).not.toThrow();
  });

  it("rejects content mismatch", () => {
    const repo = join(makeRoot(), "repo");
    initScratchRepo(repo);
    const tree = forgeTree(repo, [{ mode: "100644", content: "tampered\n", path: "f.txt" }]);
    expect(() => assertTreeMatchesStage(repo, tree, makeStage({ "f.txt": { content: "x\n" } }))).toThrow(/verification failed.*content mismatch/);
  });

  it("rejects a file missing from the tree", () => {
    const repo = join(makeRoot(), "repo");
    initScratchRepo(repo);
    const tree = forgeTree(repo, []);
    expect(() => assertTreeMatchesStage(repo, tree, makeStage({ "f.txt": { content: "x\n" } }))).toThrow(/verification failed.*missing/);
  });

  it("rejects an extra file smuggled into the tree", () => {
    const repo = join(makeRoot(), "repo");
    initScratchRepo(repo);
    const tree = forgeTree(repo, [{ mode: "100644", content: "x\n", path: "extra.txt" }]);
    expect(() => assertTreeMatchesStage(repo, tree, makeStage({}))).toThrow(/verification failed.*not in the artifact/);
  });

  it("rejects mode divergence", () => {
    const repo = join(makeRoot(), "repo");
    initScratchRepo(repo);
    const tree = forgeTree(repo, [{ mode: "100755", content: "x\n", path: "f.txt" }]);
    expect(() => assertTreeMatchesStage(repo, tree, makeStage({ "f.txt": { content: "x\n", mode: 0o644 } }))).toThrow(/verification failed.*mode mismatch/);
  });

  it("rejects symlink modes outright", () => {
    const repo = join(makeRoot(), "repo");
    initScratchRepo(repo);
    const tree = forgeTree(repo, [{ mode: "120000", content: "target", path: "link" }]);
    expect(() => assertTreeMatchesStage(repo, tree, makeStage({}))).toThrow(/120000/);
  });
});
