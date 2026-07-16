import { spawn, spawnSync } from "node:child_process";
import { constants, appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  computeTrustedRuntimeDigest,
  sealBootRuntimeDigest,
  sealRuntimeSnapshot,
  verifiedBootRuntimeDigest,
} from "../src/runtime-digest.js";
import { deferred } from "../src/promise.js";
import { makeCapsule, makeRoot, pkgRoot, sleep } from "./helpers.js";

/**
 * Boot-bound trusted-runtime seal (release gate P1):
 *  1. bin/hone.js computes the complete closure digest BEFORE tsx registers
 *     or any trusted TypeScript loads, and every durable pin/run event is
 *     preceded by a recompute-and-compare against that immutable boot value —
 *     an edit racing the process start can never be pinned as if it were the
 *     code that ran.
 *  2. The digest seals the ACTUAL INSTALLED BYTES of the non-workspace
 *     production dependency closure (tsx → esbuild → platform binary; zod):
 *     mutating installed package bytes with the lockfile and workspace
 *     manifests untouched refuses, and restoring the bytes restores the seal.
 */

const HONE_BIN = join(pkgRoot, "bin", "hone.js");

/** Installed real directory of a package, resolved exactly like the digest resolves it (nearest node_modules walking up, then realpath). */
function installedDir(name: string, fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = join(dir, "..");
    if (realpathSync(parent) === realpathSync(dir)) throw new Error(`cannot resolve installed ${name} from ${fromDir}`);
    dir = parent;
  }
}

/** Mutate a file, run `body`, and ALWAYS restore the original bytes. */
function withMutatedFile(path: string, body: () => void): void {
  const original = readFileSync(path);
  // A trailing newline keeps the file valid for any concurrent reader
  // (package.json stays parseable JSON) while changing its bytes.
  appendFileSync(path, "\n");
  try {
    body();
  } finally {
    writeFileSync(path, original);
  }
}

describe("installed production dependency bytes are sealed (lock/manifests stable)", () => {
  it("mutating installed zod bytes drifts the digest and fails the boot-bound gate; restoring restores it", () => {
    const boot = sealBootRuntimeDigest();
    expect(verifiedBootRuntimeDigest()).toBe(boot);
    const zodManifest = join(installedDir("zod", pkgRoot), "package.json");
    withMutatedFile(zodManifest, () => {
      expect(computeTrustedRuntimeDigest()).not.toBe(boot);
      expect(() => verifiedBootRuntimeDigest()).toThrow(/trusted-runtime drift since process boot/);
    });
    expect(computeTrustedRuntimeDigest()).toBe(boot);
    expect(verifiedBootRuntimeDigest()).toBe(boot);
  });

  it("mutating installed tsx bytes and the transitively resolved esbuild platform package refuses then restores", () => {
    const boot = sealBootRuntimeDigest();
    const tsxDir = installedDir("tsx", pkgRoot);
    withMutatedFile(join(tsxDir, "package.json"), () => {
      expect(() => verifiedBootRuntimeDigest()).toThrow(/drift since process boot/);
    });
    expect(verifiedBootRuntimeDigest()).toBe(boot);

    // tsx → esbuild → @esbuild/<platform>: the platform binary package is
    // reached ONLY through the recursive optional-dependency closure — a
    // hand list of direct dependencies would miss it.
    const esbuildDir = installedDir("esbuild", tsxDir);
    const platformDir = installedDir(`@esbuild/${process.platform}-${process.arch}`, esbuildDir);
    withMutatedFile(join(platformDir, "package.json"), () => {
      expect(() => verifiedBootRuntimeDigest()).toThrow(/drift since process boot/);
    });
    expect(verifiedBootRuntimeDigest()).toBe(boot);
  });
});

describe("sealed snapshot root lifecycle", () => {
  it("creates the seal directly under the OS temp root, never beneath a predictable pre-created parent", () => {
    const trap = join(realpathSync(tmpdir()), `hone-runtime-seal-${process.pid}`);
    rmSync(trap, { recursive: true, force: true });
    mkdirSync(trap, { mode: 0o700 });
    writeFileSync(join(trap, "attacker-marker"), "do-not-enter\n");
    const snapshot = sealRuntimeSnapshot();
    try {
      expect(snapshot.root.startsWith(`${trap}${sep}`)).toBe(false);
      expect(readFileSync(join(trap, "attacker-marker"), "utf8")).toBe("do-not-enter\n");
    } finally {
      rmSync(snapshot.root, { recursive: true, force: true });
      rmSync(trap, { recursive: true, force: true });
    }
  });

  it("reclaims a SIGKILL-stranded, ownership-marked seal on the next boot without touching live seals", () => {
    const helperUrl = new URL("../src/runtime-digest.js", import.meta.url).href;
    const killed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeSync } from "node:fs";
         import { sealRuntimeSnapshot } from ${JSON.stringify(helperUrl)};
         const seal = sealRuntimeSnapshot();
         writeSync(1, seal.root + "\\n");
         process.kill(process.pid, "SIGKILL");`,
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(killed.signal).toBe("SIGKILL");
    const stranded = killed.stdout.trim();
    expect(stranded).not.toBe("");
    expect(existsSync(stranded)).toBe(true);

    const live = sealRuntimeSnapshot();
    try {
      expect(existsSync(stranded)).toBe(false);
      expect(existsSync(live.root)).toBe(true);
    } finally {
      rmSync(live.root, { recursive: true, force: true });
      rmSync(stranded, { recursive: true, force: true });
    }
  });
});

function runIds(root: string): string[] {
  const runs = join(root, ".hone-runs");
  return existsSync(runs) ? readdirSync(runs) : [];
}

describe("boot race: the real bin pins the digest of the source that LOADED, never a late disk state", () => {
  it(
    "an edit landing after boot (paused before run creation) cannot create or pin a run; removing it restores cleanly",
    { timeout: 120_000 },
    async () => {
      const root = makeRoot();
      makeCapsule(root);
      // --config names a FIFO: the real bin boots (seals the digest), starts
      // runCommand, and BLOCKS inside readFileSync(config) — a deterministic
      // pause strictly AFTER the boot seal and strictly BEFORE any run state
      // exists. The test then edits trusted source and unblocks the read.
      const fifo = join(root, "cfg.json");
      const mk = spawnSync("mkfifo", [fifo]);
      expect(mk.status).toBe(0);

      const probe = join(pkgRoot, "src", "runtime-digest.js");
      const originalProbe = readFileSync(probe);
      const child = spawn(process.execPath, [HONE_BIN, "run", "capsule", "--headless", "--backend", "stub", "--config", "cfg.json"], {
        cwd: root,
        env: { ...process.env, HONE_STUB_EPISODES: "1" },
        detached: true,
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      const closed = deferred<number | null>();
      child.on("close", (code) => closed.resolve(code));
      try {
        // The child's readFileSync has the FIFO open for reading exactly when
        // a nonblocking write-open stops failing with ENXIO.
        let wfd: number | null = null;
        const deadline = Date.now() + 60_000;
        while (wfd === null && Date.now() < deadline) {
          try {
            wfd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
          } catch {
            await sleep(50);
          }
        }
        expect(wfd, "child never opened the config FIFO").not.toBeNull();

        // The child is paused AFTER the exact helper bytes were captured,
        // executed, and sealed: replacing that same pathname cannot change
        // the already-loaded sealer or be pinned as its former bytes.
        writeFileSync(probe, Buffer.concat([originalProbe, Buffer.from("\n// post-seal helper swap\n")]));
        writeSync(wfd as number, "{}");
        closeSync(wfd as number);

        const code = await closed.promise;
        expect(code, stderr).not.toBe(0);
        expect(stderr).toContain("drift since process boot");
        // NOTHING was pinned and NO run event exists: the edit can never be
        // laundered into a run minted by pre-edit code.
        for (const id of runIds(root)) {
          const runDir = join(root, ".hone-runs", id);
          expect(existsSync(join(runDir, ".hone-version"))).toBe(false);
          expect(existsSync(join(runDir, "events.ndjson"))).toBe(false);
        }
      } finally {
        writeFileSync(probe, originalProbe);
        if (child.exitCode === null) {
          try {
            process.kill(-(child.pid ?? 0), "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }

      // Restored source: the same real-bin invocation completes end to end.
      const clean = spawn(process.execPath, [HONE_BIN, "run", "capsule", "--headless", "--backend", "stub"], {
        cwd: root,
        env: { ...process.env, HONE_STUB_EPISODES: "1" },
      });
      let cleanErr = "";
      clean.stderr?.on("data", (d: Buffer) => (cleanErr += d.toString()));
      const cleanClosed = deferred<number | null>();
      clean.on("close", (code) => cleanClosed.resolve(code));
      expect(await cleanClosed.promise, cleanErr).toBe(0);
    },
  );
});
