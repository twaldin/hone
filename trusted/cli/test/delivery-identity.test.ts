import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageError } from "../src/args.js";
import { deliver } from "../src/deliver.js";
import {
  DELIVERY_TARGET_FILE,
  TARGET_MARKER_PREFIX,
  assertTargetIdentity,
  isEmbeddedBaselineTarget,
  readSealedDeliveryTarget,
  resolveDeliveryTarget,
  sealDeliveryTarget,
} from "../src/delivery-target.js";
import { runCommand as cliRunCommand } from "../src/supervisor.js";
import {
  fixtureEvents,
  gitIn,
  initScratchRepo,
  makeGitBaselineCapsule,
  makeIo,
  makeRoot,
  sealBaselineCommitSnapshot,
  sealGitBaselineSnapshot,
  tarToCas,
  writeEvents,
} from "./helpers.js";

/**
 * Delivery-target immutable identity (release gate P1): the sealed sidecar
 * binds dev:ino of the repo root AND its git store plus a per-run random
 * marker fsynced inside the store; every revalidation and the pre-publication
 * hook require all of it, so a renamed/deleted+recreated/cloned-into-place
 * target fails closed — path equality alone never publishes.
 */

interface Fix {
  root: string;
  repo: string;
  runDir: string;
  runId: string;
}

function setup(runId = "run_ident"): Fix {
  const root = makeRoot();
  const repo = join(root, "repo");
  initScratchRepo(repo);
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
  const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash, bestHash, finished: false }));
  sealGitBaselineSnapshot(root, runId, repo);
  return { root, repo, runDir, runId };
}

describe("sealDeliveryTarget — identity + in-store marker", () => {
  it("seals dev:ino identities and creates the durable per-run marker inside the git store", () => {
    const { root, repo, runDir, runId } = setup();
    const target = sealDeliveryTarget(root, runDir, "repo");
    expect(target.repoIdentity.dev).toMatch(/^\d+$/);
    expect(target.repoIdentity.ino).toMatch(/^\d+$/);
    expect(target.storeIdentity.ino).toMatch(/^\d+$/);
    expect(target.marker?.file).toBe(`${TARGET_MARKER_PREFIX}${runId}`);
    expect(target.marker?.nonce).toMatch(/^[0-9a-f]{32}$/);
    // marker really sits INSIDE the store and carries the sealed nonce
    const markerPath = join(repo, ".git", target.marker?.file ?? "");
    expect(readFileSync(markerPath, "utf8").trim()).toBe(target.marker?.nonce);
    // sidecar persisted whole
    const sidecar = JSON.parse(readFileSync(join(runDir, DELIVERY_TARGET_FILE), "utf8")) as Record<string, unknown>;
    expect(sidecar["repoIdentity"]).toEqual(target.repoIdentity);
    expect(sidecar["marker"]).toEqual(target.marker);
    // and the sealed target revalidates clean
    expect(readSealedDeliveryTarget(root, runDir)).toEqual(target);
  });

  it("two runs targeting the same repo keep independent markers", () => {
    const { root, repo, runDir } = setup("run_m1");
    const bestHash = tarToCas(root, { "hello.txt": "improved2\n" });
    const runDir2 = writeEvents(root, "run_m2", fixtureEvents({ runId: "run_m2", baselineHash: bestHash, bestHash, finished: false }));
    sealGitBaselineSnapshot(root, "run_m2", repo);
    const t1 = sealDeliveryTarget(root, runDir, "repo");
    const t2 = sealDeliveryTarget(root, runDir2, "repo");
    expect(t1.marker?.file).not.toBe(t2.marker?.file);
    expect(readSealedDeliveryTarget(root, runDir)).toEqual(t1);
    expect(readSealedDeliveryTarget(root, runDir2)).toEqual(t2);
  });
});

  it("refuses an ordinary target whose object database escapes through a symlink", () => {
    const { root, repo, runDir } = setup();
    const objects = join(repo, ".git", "objects");
    const outside = join(root, "outside-objects");
    renameSync(objects, outside);
    symlinkSync(outside, objects, "dir");
    expect(() => sealDeliveryTarget(root, runDir, "repo")).toThrow(/git store contains symlink "objects"/);
  });

describe("sealed-target tamper/replacement regressions (fail closed)", () => {
  it("a repo REPLACED at the same path (byte-identical copy) refuses: dev:ino drift", () => {
    const { root, repo, runDir } = setup();
    sealDeliveryTarget(root, runDir, "repo");
    // Adversarial swap: identical bytes, same path, different filesystem object.
    renameSync(repo, `${repo}-original`);
    cpSync(`${repo}-original`, repo, { recursive: true });
    expect(() => readSealedDeliveryTarget(root, runDir)).toThrow(/not the validated filesystem object|dev:ino/);
  });

  it("a deleted marker refuses even when dev:ino would still pass", () => {
    const { root, repo, runDir, runId } = setup();
    sealDeliveryTarget(root, runDir, "repo");
    rmSync(join(repo, ".git", `${TARGET_MARKER_PREFIX}${runId}`));
    expect(() => readSealedDeliveryTarget(root, runDir)).toThrow(/marker .* is missing/);
  });

  it("a marker carrying a foreign nonce refuses", () => {
    const { root, repo, runDir, runId } = setup();
    sealDeliveryTarget(root, runDir, "repo");
    writeFileSync(join(repo, ".git", `${TARGET_MARKER_PREFIX}${runId}`), `${"0".repeat(32)}\n`);
    expect(() => readSealedDeliveryTarget(root, runDir)).toThrow(/does not carry the sealed nonce/);
  });

  it("a malformed sidecar (missing identities) refuses rather than degrading to path-only validation", () => {
    const { root, runDir } = setup();
    sealDeliveryTarget(root, runDir, "repo");
    const path = join(runDir, DELIVERY_TARGET_FILE);
    const sidecar = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete sidecar["repoIdentity"];
    writeFileSync(path, JSON.stringify(sidecar));
    expect(() => readSealedDeliveryTarget(root, runDir)).toThrow(/malformed/);
  });

  it("a sidecar marker smuggling a path is malformed", () => {
    const { root, runDir } = setup();
    sealDeliveryTarget(root, runDir, "repo");
    const path = join(runDir, DELIVERY_TARGET_FILE);
    const sidecar = JSON.parse(readFileSync(path, "utf8")) as { marker: { file: string } };
    sidecar.marker.file = "../../outside";
    writeFileSync(path, JSON.stringify(sidecar));
    expect(() => readSealedDeliveryTarget(root, runDir)).toThrow(/malformed/);
  });

  it("rejects a refs symlink planted below the sealed store", () => {
    const { root, repo, runDir } = setup();
    const target = sealDeliveryTarget(root, runDir, "repo");
    const refs = join(repo, ".git", "refs");
    const outside = join(root, "outside-refs");
    renameSync(refs, outside);
    symlinkSync(outside, refs, "dir");
    expect(() => assertTargetIdentity(target)).toThrow(/git store contains symlink "refs"/);
  });
});

describe("pre-publication identity verification (deliver verifyTarget hook)", () => {
  it("fires immediately before the ref update; a failing verification publishes NOTHING", () => {
    const { root, repo, runDir, runId } = setup();
    const target = sealDeliveryTarget(root, runDir, "repo");
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    let calls = 0;
    expect(() =>
      deliver({
        mode: "branch",
        repo: target.repo,
        baselineCommit: target.baselineCommit,
        runId,
        artifact: bestHash,
        casDir: join(root, ".hone-cas"),
        improverSeat: false,
        env: process.env,
        verifyTarget: () => {
          calls++;
          throw new Error("target was replaced between validation and publication");
        },
      }),
    ).toThrow(/replaced between validation and publication/);
    expect(calls).toBe(1);
    // Objects may exist, but NO ref made anything reachable.
    const refs = spawnSync("git", ["-C", repo, "for-each-ref", "refs/heads/hone"], { encoding: "utf8" });
    expect((refs.stdout ?? "").trim()).toBe("");
  });

  it("a passing verification publishes and was actually invoked (branch + assertTargetIdentity)", () => {
    const { root, repo, runDir, runId } = setup();
    const target = sealDeliveryTarget(root, runDir, "repo");
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    let calls = 0;
    const result = deliver({
      mode: "branch",
      repo: target.repo,
      baselineCommit: target.baselineCommit,
      runId,
      artifact: bestHash,
      casDir: join(root, ".hone-cas"),
      improverSeat: false,
      env: process.env,
      verifyTarget: () => {
        calls++;
        assertTargetIdentity(target);
      },
    });
    expect(calls).toBe(2);
    expect(gitIn(repo, "show", `${result.ref ?? ""}:hello.txt`)).toBe("improved");
  });

  it.each([
    ["branch", join(".git", "refs", "heads", "hone")],
    ["auto", join(".git", "refs", "heads", "main")],
  ] as const)("%s delivery re-verifies the sealed target after syncing its published ref", (mode, trigger) => {
    const { root, repo, runDir, runId } = setup();
    const target = sealDeliveryTarget(root, runDir, "repo", mode);
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    const aside = `${repo}-original`;
    let swapped = false;
    expect(() =>
      deliver({
        mode,
        repo: target.repo,
        baselineCommit: target.baselineCommit,
        runId,
        runDir,
        artifact: bestHash,
        casDir: join(root, ".hone-cas"),
        ...(target.autoRef !== undefined ? { autoRef: target.autoRef } : {}),
        improverSeat: false,
        env: process.env,
        fsyncPath: (path) => {
          if (swapped || !path.includes(trigger)) return;
          renameSync(repo, aside);
          cpSync(aside, repo, { recursive: true });
          swapped = true;
        },
        verifyTarget: () => assertTargetIdentity(target),
      }),
    ).toThrow(/not the validated filesystem object/);
    expect(swapped).toBe(true);
  });

  it("assertTargetIdentity itself rejects a swapped store and a vanished repo", () => {
    const { root, repo, runDir } = setup();
    const target = sealDeliveryTarget(root, runDir, "repo");
    expect(() => assertTargetIdentity(target)).not.toThrow();
    renameSync(join(repo, ".git"), join(repo, ".git-aside"));
    cpSync(join(repo, ".git-aside"), join(repo, ".git"), { recursive: true });
    expect(() => assertTargetIdentity(target)).toThrow(/git store .* is not the validated filesystem object/);
    rmSync(repo, { recursive: true, force: true });
    expect(() => assertTargetIdentity(target)).toThrow(/no longer exists/);
  });
});

describe("embedded .gitdir target × apply:auto (fresh preflight, before run minting)", () => {
  it("hone run --apply auto --repo <embedded> refuses BEFORE any run state exists", async () => {
    const root = makeRoot();
    makeGitBaselineCapsule(root);
    const embedded = join(root, "embedded");
    initScratchRepo(embedded);
    renameSync(join(embedded, ".git"), join(embedded, ".gitdir"));
    expect(isEmbeddedBaselineTarget(root, "embedded")).toBe(true);
    const { io } = makeIo(root, { HONE_STUB_EPISODES: "0" });
    await expect(
      cliRunCommand(["capsule", "--headless", "--backend", "stub", "--apply", "auto", "--repo", "embedded"], io),
    ).rejects.toThrow(/--apply auto .*cannot target an embedded capsule-baseline store/);
    // preflight: no runId was minted, no run dir touched disk
    expect(existsSync(join(root, ".hone-runs"))).toBe(false);
  });

  it("branch mode still seals an embedded store target at creation (marker lands inside .gitdir)", async () => {
    const root = makeRoot();
    const { baselineDir } = makeGitBaselineCapsule(root);
    // Turn the capsule baseline into an embedded-store target. Zero
    // episodes: the stub mints no incumbent, so the run completes without
    // delivering — the SEAL (identity + marker) is what this test pins.
    renameSync(join(baselineDir, ".git"), join(baselineDir, ".gitdir"));
    const { io, err } = makeIo(root, { HONE_STUB_EPISODES: "0" });
    const code = await cliRunCommand(["capsule", "--headless", "--backend", "stub", "--apply", "branch", "--repo", "capsule/baseline"], io);
    expect(code, err.join("\n")).toBe(0);
    const markers = readdirSync(join(baselineDir, ".gitdir")).filter((n) => n.startsWith(TARGET_MARKER_PREFIX));
    expect(markers.length).toBe(1);
  });

  it("resolveDeliveryTarget/readSealedDeliveryTarget refuse an embedded store under apply:auto (resume defense in depth)", () => {
    const root = makeRoot();
    const embedded = join(root, "embedded");
    initScratchRepo(embedded);
    const commit = gitIn(embedded, "rev-parse", "HEAD");
    renameSync(join(embedded, ".git"), join(embedded, ".gitdir"));
    const bestHash = tarToCas(root, { "hello.txt": "improved\n" });
    const runDir = writeEvents(root, "run_embauto", fixtureEvents({ runId: "run_embauto", baselineHash: bestHash, bestHash, finished: false }));
    sealBaselineCommitSnapshot(root, "run_embauto", commit);
    // branch/pr remain supported…
    const sealed = sealDeliveryTarget(root, runDir, "embedded", "branch");
    expect(sealed.gitDir?.endsWith(join("embedded", ".gitdir"))).toBe(true);
    expect(readSealedDeliveryTarget(root, runDir, "branch")?.gitDir).toBe(sealed.gitDir);
    // …auto refuses at resolve time AND at sealed-read time.
    expect(() => resolveDeliveryTarget(root, runDir, "embedded", "auto")).toThrow(/cannot target an embedded capsule-baseline store/);
    expect(() => readSealedDeliveryTarget(root, runDir, "auto")).toThrow(/cannot target an embedded capsule-baseline store/);
  });
});

describe("manual apply flag misuse", () => {
  it("resolveDeliveryTarget without --repo stays a UsageError", () => {
    const { root, runDir } = setup();
    expect(() => resolveDeliveryTarget(root, runDir, undefined)).toThrow(UsageError);
  });
});
