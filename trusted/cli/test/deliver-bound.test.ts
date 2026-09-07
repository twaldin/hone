import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliver, type DeliverOptions } from "../src/deliver.js";
import { assertTargetIdentity, type DeliveryTarget } from "../src/delivery-target.js";
import { gitIn, initScratchRepo, makeRoot, tarToCas } from "./helpers.js";

/**
 * Release-gate P1 regressions for the delivery Git surface:
 *  - every synchronous Git call is hard-bounded (timeout + SIGKILL): a
 *    sleeping shim or FIFO-backed config returns within the bound, publishes
 *    no ref, and leaves no child;
 *  - existing-branch recovery accepts ONLY the exact prior-delivery shape
 *    (candidate == sealed baseline, or exactly one parent == baseline) — a
 *    forged multi-parent commit carrying the exact artifact tree rejects;
 *  - a zero-delta delivery over a MERGE baseline recovers (tip == baseline
 *    is the raw candidate, never misread as a Hone wrapper merge);
 *  - sealed identity/marker verification runs before recovery filesystem
 *    authority and again before every no-update/already-applied return, so
 *    a repo swapped A→B between validation and recovery rejects.
 */

const CAS = ".hone-cas";

function opts(root: string, repo: string, artifact: string, extra: Partial<DeliverOptions> = {}): DeliverOptions {
  return {
    mode: "branch",
    repo,
    baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
    runId: "run_bound",
    runDir: root,
    artifact,
    casDir: join(root, CAS),
    autoRef: "refs/heads/main",
    improverSeat: false,
    env: process.env,
    ...extra,
  };
}

describe("hard bound on every synchronous delivery git call", () => {
  beforeEach(() => {
    process.env["HONE_GIT_TIMEOUT_MS"] = "500";
  });
  afterEach(() => {
    delete process.env["HONE_GIT_TIMEOUT_MS"];
  });

  it("a sleeping git shim returns within the bound, publishes no ref, and leaves no child", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });

    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    const pidFile = join(root, "shim.pid");
    // exec replaces the shell, so the SIGKILL lands on the recorded PID.
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\necho $$ >> ${JSON.stringify(pidFile)}\nexec sleep 600\n`, { mode: 0o755 });

    const started = Date.now();
    expect(() =>
      deliver(opts(root, repo, hash, { env: { PATH: `${shimDir}:${process.env["PATH"] ?? ""}` } })),
    ).toThrow(/exceeded the 500ms bound and was SIGKILLed/);
    expect(Date.now() - started).toBeLessThan(10_000);

    // The SIGKILLed shim is reaped by spawnSync before it returns.
    for (const pid of readFileSync(pidFile, "utf8").trim().split("\n").map(Number)) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive, `shim pid ${pid} survived the bound`).toBe(false);
    }
    // Nothing was published (real git, not the shim).
    expect(gitIn(repo, "for-each-ref", "refs/heads/hone/")).toBe("");
  });

  it("a FIFO .git/config cannot wedge delivery — bounded fail-closed refusal, no ref", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    // Resolve everything that shells UNBOUNDED helper git BEFORE the config
    // becomes a FIFO — only the bounded delivery calls may touch it after.
    const delivery = opts(root, repo, hash);

    const config = join(repo, ".git", "config");
    rmSync(config);
    expect(spawnSync("mkfifo", [config]).status).toBe(0);
    try {
      const started = Date.now();
      // Any git call loading repo-local config blocks forever on the FIFO;
      // the bound SIGKILLs it and the delivery fails closed.
      expect(() => deliver(delivery)).toThrow(/exceeded the 500ms bound/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(config, { force: true });
      writeFileSync(config, "[user]\n\tname = hone-test\n\temail = hone-test@localhost\n");
    }
    expect(gitIn(repo, "for-each-ref", "refs/heads/hone/")).toBe("");
  });
});

/** Plumb a blob+tree carrying exactly {hello.txt: "improved\n"} into the repo. */
function forgedArtifactTree(repo: string): string {
  const blob = spawnSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: "improved\n", encoding: "utf8" });
  expect(blob.status).toBe(0);
  const tree = spawnSync("git", ["-C", repo, "mktree"], {
    input: `100644 blob ${blob.stdout.trim()}\thello.txt\n`,
    encoding: "utf8",
  });
  expect(tree.status).toBe(0);
  return tree.stdout.trim();
}

describe("existing-branch recovery accepts only the exact prior-delivery shape", () => {
  it("a forged 3-parent commit carrying the EXACT artifact tree rejects before any ref/event", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const baseline = gitIn(repo, "rev-parse", "HEAD");
    const hash = tarToCas(root, { "hello.txt": "improved\n" });

    // Two extra ancestry commits the forgery smuggles in as parents 2 and 3.
    const baselineTree = gitIn(repo, "rev-parse", `${baseline}^{tree}`);
    const extraA = gitIn(repo, "commit-tree", baselineTree, "-p", baseline, "-m", "smuggled A");
    const extraB = gitIn(repo, "commit-tree", baselineTree, "-p", baseline, "-m", "smuggled B");
    const forged = gitIn(repo, "commit-tree", forgedArtifactTree(repo), "-p", baseline, "-p", extraA, "-p", extraB, "-m", "forged");
    gitIn(repo, "update-ref", "refs/heads/hone/run_bound", forged);

    expect(() => deliver(opts(root, repo, hash))).toThrow(/not exactly the sealed baseline commit .* \(3 parents\)/);
    // The forged ref was not adopted: no delivery result, branch unchanged.
    expect(gitIn(repo, "rev-parse", "refs/heads/hone/run_bound")).toBe(forged);
  });

  it("zero-delta delivery over a MERGE baseline: tip == baseline recovers as the raw candidate", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    // Make the baseline itself a merge commit (2 parents).
    gitIn(repo, "checkout", "-b", "side");
    writeFileSync(join(repo, "side.txt"), "side\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "side");
    gitIn(repo, "checkout", "main");
    writeFileSync(join(repo, "main.txt"), "main\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-m", "mainline");
    gitIn(repo, "merge", "--no-ff", "-m", "merge baseline", "side");
    const baseline = gitIn(repo, "rev-parse", "HEAD");
    expect(gitIn(repo, "rev-list", "--no-walk", "--parents", baseline).split(/\s+/).length).toBe(3);

    // Byte-identical artifact: a prior crashed attempt pointed the branch
    // DIRECTLY at the merge baseline (zero-delta candidate) before the event
    // was fsynced.
    const hash = tarToCas(root, { "hello.txt": "baseline\n", "main.txt": "main\n", "side.txt": "side\n" });
    gitIn(repo, "update-ref", "refs/heads/hone/run_bound", baseline);

    // Recovery must treat tip == baseline as the raw candidate — NOT infer
    // the two-parent Hone wrapper shape and misread the baseline's second
    // parent as the candidate.
    const result = deliver(opts(root, repo, hash));
    expect(result.ref).toBe("hone/run_bound");
    expect(gitIn(repo, "rev-parse", "refs/heads/hone/run_bound")).toBe(baseline);
  });
});

/** Bigint-exact dev:ino identity of a path, matching the sealed-target shape. */
function fsIdentityOf(path: string): { dev: string; ino: string } {
  const st = statSync(path, { bigint: true });
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}

describe("sealed identity is re-verified on recovery and no-update/already-applied returns", () => {
  it("branch recovery: a repo swapped A→B after validation rejects with no sync/ref authority", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    // Legitimate first delivery creates the branch.
    const first = deliver(opts(root, repo, hash));
    expect(first.ref).toBe("hone/run_bound");

    // Seal the CURRENT filesystem identity, then swap the repo for a
    // byte-identical copy (fresh inodes — the classic A→B swap).
    const target: DeliveryTarget = {
      repo,
      baselineCommit: gitIn(repo, "rev-parse", "HEAD"),
      repoIdentity: fsIdentityOf(repo),
      storeIdentity: fsIdentityOf(join(repo, ".git")),
    };
    const aside = join(root, "repo-aside");
    renameSync(repo, aside);
    cpSync(aside, repo, { recursive: true });

    // Recovery would return "already delivered" — the identity gate must
    // reject BEFORE any recovery authority (and before the return).
    expect(() =>
      deliver(opts(root, repo, hash, { verifyTarget: () => assertTargetIdentity(target) })),
    ).toThrow(/not the validated filesystem object/);
  });

  it("auto already-applied return: verifyTarget runs before recovery authority and before the return", () => {
    const root = makeRoot();
    const repo = join(root, "repo");
    initScratchRepo(repo);
    // The SEALED baseline never changes across attempts — pin it before the
    // first delivery moves main (opts() would re-read the merged HEAD).
    const baseline = gitIn(repo, "rev-parse", "HEAD");
    const hash = tarToCas(root, { "hello.txt": "improved\n" });
    // Full auto delivery merges the branch into main.
    const auto = deliver(opts(root, repo, hash, { mode: "auto", baselineCommit: baseline }));
    expect(auto.ref).toBe("main");

    // Second auto delivery of the same artifact takes the already-applied
    // path; count the verification calls on the healthy repo…
    let calls = 0;
    let poisoned = false;
    const verify = (): void => {
      calls += 1;
      if (poisoned) throw new Error("delivery target repository root swapped (A→B) — refusing to publish");
    };
    const recovered = deliver(opts(root, repo, hash, { mode: "auto", baselineCommit: baseline, verifyTarget: verify }));
    expect(recovered.ref).toBe("main");
    // Branch recovery (entry + return) and the already-applied path (entry +
    // return) each re-verify: at least two checks on the auto recovery line.
    expect(calls).toBeGreaterThanOrEqual(2);

    // …and a failing verification rejects the already-applied return.
    poisoned = true;
    expect(() => deliver(opts(root, repo, hash, { mode: "auto", baselineCommit: baseline, verifyTarget: verify }))).toThrow(/swapped \(A→B\)/);
  });
});
