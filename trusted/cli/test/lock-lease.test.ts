import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { stopCommand } from "../src/commands/stop.js";
import {
  acquireRunLock,
  leaseRunLockIdentity,
  pidAlive,
  probeRunLockIdentity,
  processBirthToken,
  runLockPath,
} from "../src/supervisor.js";
import { fakeHash, fixtureEvents, makeIo, makeRoot, pkgRoot, sleep, tsxBin, writeEvents } from "./helpers.js";

/**
 * Run-lock lease lifecycle: the two PID/lock identity races (PID reuse
 * between proof and stop; A-release/B-bind-before-B-publish), the claim
 * window that serializes bind+publication, holder identification without
 * any event-loop progress (blocked synchronous delivery), the lease stop
 * channel, and the normal acquire → lease → release handoff.
 *
 * These are integration tests against real kernel sockets and real child
 * processes: the bounded polling loops await genuine OS events (process
 * death, marker files), which fake timers cannot drive.
 */

const RUN_ID = "run_lease1";

function makeRunDir(root: string): string {
  const runDir = join(root, ".hone-runs", RUN_ID);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** A live unrelated process wearing a "supervisor" pid; it records any SIGTERM into `marker`. */
function spawnSigtermRecorder(marker: string): { pid: number; kill: () => void } {
  const helper = spawn(
    process.execPath,
    ["-e", `process.on("SIGTERM", () => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "signalled")); setInterval(() => {}, 1000);`],
    { stdio: "ignore" },
  );
  const pid = helper.pid;
  if (pid === undefined) throw new Error("helper failed to spawn");
  return {
    pid,
    kill: () => {
      try {
        helper.kill("SIGKILL");
      } catch {
        // already gone
      }
    },
  };
}

describe("run-lock lease lifecycle (normal handoff)", () => {
  it("leases the holder's identity, observes release, and never confirms after it", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const a = { pid: process.pid, runId: RUN_ID, nonce: "nonce-a" };
    const release = await acquireRunLock(runDir, RUN_ID, a);
    const lease = await leaseRunLockIdentity(runDir);
    expect(lease).not.toBeNull();
    if (lease === null) throw new Error("unreachable");
    expect(lease.identity).toEqual(a);
    expect(lease.isReleased()).toBe(false);

    await release();
    await lease.released; // the identity-bound release signal
    expect(lease.isReleased()).toBe(true);
    lease.close();

    // Nothing is confirmable after release…
    expect(await probeRunLockIdentity(runDir)).toBeNull();

    // …and a successor binds and is proven as ITSELF.
    const b = { pid: process.pid, runId: RUN_ID, nonce: "nonce-b" };
    const releaseB = await acquireRunLock(runDir, RUN_ID, b);
    expect(await probeRunLockIdentity(runDir)).toEqual(b);
    await releaseB();
  });
});

describe("A-release/B-bind-before-B-publish (metadata is pinned to the socket incarnation)", () => {
  it("A's stale metadata is never confirmed against B's live socket", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const metaPath = `${runLockPath(runDir)}.id`;

    const releaseA = await acquireRunLock(runDir, RUN_ID, { pid: process.pid, runId: RUN_ID, nonce: "nonce-a" });
    const staleMeta = readFileSync(metaPath);
    await releaseA();

    // B binds a FRESH socket incarnation — and A's metadata lands back in
    // B's bind-to-publish window (node may unlink the old path at
    // close-initiation while the release callback is still pending).
    const releaseB = await acquireRunLock(runDir, RUN_ID, { pid: process.pid, runId: RUN_ID, nonce: "nonce-b" });
    try {
      writeFileSync(metaPath, staleMeta);
      // The connect succeeds (B's socket is live) and the metadata is stable
      // across the whole probe — but it pins A's dead incarnation, so
      // identity resolves null instead of confirming a stale supervisor.
      expect(await leaseRunLockIdentity(runDir)).toBeNull();
      expect(await probeRunLockIdentity(runDir)).toBeNull();
    } finally {
      await releaseB();
    }
  });

  it("stop never disturbs a sentinel vouched only by stale metadata over a successor's socket", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = writeEvents(root, RUN_ID, fixtureEvents({ runId: RUN_ID, baselineHash: fakeHash("b"), bestHash: fakeHash("c"), finished: false }));
    const metaPath = `${runLockPath(runDir)}.id`;
    const marker = join(root, "helper-signalled");
    const helper = spawnSigtermRecorder(marker);
    try {
      await sleep(400); // real child: wait for its SIGTERM handler install

      // Supervisor A (wearing the helper's pid) once held the lock and wrote
      // a matching sentinel…
      const releaseA = await acquireRunLock(runDir, RUN_ID, { pid: helper.pid, runId: RUN_ID, nonce: "nonce-a" });
      const staleMeta = readFileSync(metaPath);
      writeFileSync(join(runDir, "supervisor.json"), `${JSON.stringify({ pid: helper.pid, runId: RUN_ID, nonce: "nonce-a" })}\n`);
      await releaseA();
      // …then B bound the same path, with A's metadata reappearing in B's
      // bind-to-publish window.
      const releaseB = await acquireRunLock(runDir, RUN_ID, { pid: process.pid, runId: RUN_ID, nonce: "nonce-b" });
      try {
        writeFileSync(metaPath, staleMeta);
        const { io } = makeIo(root);
        const code = await stopCommand([], io);
        // B holds the run: stop can neither confirm A's sentinel (incarnation
        // mismatch) nor finalize under the lock — and the live process
        // wearing A's recycled pid is never touched.
        expect(code).toBe(1);
        expect(existsSync(marker)).toBe(false);
        expect(pidAlive(helper.pid)).toBe(true);
      } finally {
        await releaseB();
      }
    } finally {
      helper.kill();
    }
  });
});

describe("publication claim window (probers fail closed while a claimant is live)", () => {
  it("a live claimant makes identity unprovable; a dead claimant's leftover does not block probing", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const claimPath = `${runLockPath(runDir)}.claim`;
    const a = { pid: process.pid, runId: RUN_ID, nonce: "nonce-claim" };
    const release = await acquireRunLock(runDir, RUN_ID, a);
    try {
      expect(await probeRunLockIdentity(runDir)).toEqual(a);

      if (process.platform === "darwin") {
        // A live claimant is the fd-held kernel lock. Its pathname persists
        // after close/crash, but without the lock it cannot block probing.
        const fd = openSync(
          claimPath,
          fsConstants.O_RDWR | fsConstants.O_NONBLOCK | 0x20,
        );
        try {
          expect(await leaseRunLockIdentity(runDir)).toBeNull();
        } finally {
          closeSync(fd);
        }
        expect(await probeRunLockIdentity(runDir)).toEqual(a);
      } else {
        // Linux retains the high-resolution /proc birth-token claim.
        const birth = processBirthToken(process.pid);
        expect(birth).not.toBeNull();
        symlinkSync(JSON.stringify({ pid: process.pid, birth, nonce: randomUUID() }), claimPath);
        expect(await leaseRunLockIdentity(runDir)).toBeNull();
        rmSync(claimPath);

        const ghost = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
        const ghostPid = ghost.pid;
        if (ghostPid === undefined) throw new Error("ghost failed to spawn");
        const ghostBirth = processBirthToken(ghostPid);
        expect(ghostBirth).not.toBeNull();
        ghost.kill("SIGKILL");
        const dead = Date.now() + 10_000;
        while (pidAlive(ghostPid) && Date.now() < dead) await sleep(50);
        expect(pidAlive(ghostPid)).toBe(false);
        symlinkSync(JSON.stringify({ pid: ghostPid, birth: ghostBirth, nonce: randomUUID() }), claimPath);
        expect(await probeRunLockIdentity(runDir)).toEqual(a);
        rmSync(claimPath);
      }
    } finally {
      await release();
    }
  });

  it("Darwin claim liveness is the kernel-held exclusive lock, not a persistent pathname or PID timestamp", { timeout: 30_000 }, async () => {
    if (process.platform !== "darwin") return;
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const claimPath = `${runLockPath(runDir)}.claim`;
    const identity = { pid: process.pid, runId: RUN_ID, nonce: "nonce-kernel-claim" };
    const release = await acquireRunLock(runDir, RUN_ID, identity);
    try {
      const fd = openSync(
        claimPath,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NONBLOCK | 0x20,
        0o600,
      );
      try {
        expect(await leaseRunLockIdentity(runDir)).toBeNull();
      } finally {
        closeSync(fd);
      }
      expect(existsSync(claimPath)).toBe(true);
      expect(await probeRunLockIdentity(runDir)).toEqual(identity);
    } finally {
      await release();
    }
  });
});

describe("PID reuse between proof and stop (no PID is ever signalled)", () => {
  it("a holder that released after confirmation is re-observed; the pid's unrelated wearer is never touched", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const marker = join(root, "helper-signalled");
    const helper = spawnSigtermRecorder(marker);
    try {
      await sleep(400); // real child: wait for its SIGTERM handler install
      const identity = { pid: helper.pid, runId: RUN_ID, nonce: "nonce-reuse" };
      let stops = 0;
      const release = await acquireRunLock(runDir, RUN_ID, identity, () => {
        stops += 1;
      });
      const lease = await leaseRunLockIdentity(runDir);
      expect(lease).not.toBeNull();
      if (lease === null) throw new Error("unreachable");
      expect(lease.identity).toEqual(identity);

      // Proof, then release BEFORE the stop — the exact window in which the
      // OS may hand the proven PID to an unrelated process.
      await release();
      await lease.released;
      expect(lease.requestStop()).toBe(false); // lease gone: stop refuses, caller re-observes
      await sleep(300); // grace for any (incorrect) signal to land
      expect(existsSync(marker)).toBe(false); // the pid's wearer was never signalled
      expect(pidAlive(helper.pid)).toBe(true);
      expect(stops).toBe(0);
      lease.close();
    } finally {
      helper.kill();
    }
  });
});

describe("lease stop channel (stop reaches exactly the proven holder)", () => {
  it("requestStop() on a held lease invokes the holder's stop handler; never a signal", { timeout: 30_000 }, async () => {
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const identity = { pid: process.pid, runId: RUN_ID, nonce: "nonce-chan" };
    let stops = 0;
    const release = await acquireRunLock(runDir, RUN_ID, identity, () => {
      stops += 1;
    });
    const lease = await leaseRunLockIdentity(runDir);
    expect(lease).not.toBeNull();
    if (lease === null) throw new Error("unreachable");
    expect(lease.requestStop()).toBe(true);
    const deadline = Date.now() + 5000;
    while (stops === 0 && Date.now() < deadline) await sleep(10); // real socket delivery
    expect(stops).toBeGreaterThan(0);

    await release();
    await lease.released;
    expect(lease.requestStop()).toBe(false);
    lease.close();
  });
});

describe("blocked-event-loop identification (proof without holder progress)", () => {
  it("leases a holder whose JS loop is synchronously blocked; the lease resolves on its release", { timeout: 90_000 }, async () => {
    const root = makeRoot();
    const runDir = makeRunDir(root);
    const lockedMarker = join(root, "locked");
    const releasedMarker = join(root, "released");
    const script = join(root, "blocked-holder.mts");
    const supervisorUrl = pathToFileURL(join(pkgRoot, "src", "supervisor.ts")).href;
    writeFileSync(
      script,
      [
        `import { writeFileSync } from "node:fs";`,
        `import { acquireRunLock } from ${JSON.stringify(supervisorUrl)};`,
        `const [runDir, lockedMarker, releasedMarker] = process.argv.slice(2);`,
        `const release = await acquireRunLock(runDir, ${JSON.stringify(RUN_ID)}, { pid: process.pid, runId: ${JSON.stringify(RUN_ID)}, nonce: "nonce-blocked" });`,
        `writeFileSync(lockedMarker, "1");`,
        `const end = Date.now() + 8000;`,
        `while (Date.now() < end) { /* synchronously blocked, like a long synchronous delivery */ }`,
        `await release();`,
        `writeFileSync(releasedMarker, "1");`,
        ``,
      ].join("\n"),
    );
    const child = spawn(tsxBin, [script, runDir, lockedMarker, releasedMarker], { stdio: "ignore" });
    try {
      const armed = Date.now() + 60_000; // tsx cold start under a docker-heavy parallel suite
      while (!existsSync(lockedMarker) && Date.now() < armed) await sleep(50); // real child startup
      expect(existsSync(lockedMarker)).toBe(true);

      // The holder is now inside its 4s synchronous block: identification
      // must complete from kernel-level facts alone (metadata + backlog
      // connect) — no accept, no event-loop progress.
      const lease = await leaseRunLockIdentity(runDir);
      expect(lease).not.toBeNull();
      if (lease === null) throw new Error("unreachable");
      expect(lease.identity.nonce).toBe("nonce-blocked");
      expect(pidAlive(lease.identity.pid)).toBe(true);
      expect(existsSync(releasedMarker)).toBe(false); // proof needed no loop progress
      expect(lease.isReleased()).toBe(false);

      // The lease resolves on the holder's RELEASE (not merely its death).
      await lease.released;
      const settle = Date.now() + 5000;
      while (!existsSync(releasedMarker) && Date.now() < settle) await sleep(50); // real child write
      expect(existsSync(releasedMarker)).toBe(true);
      lease.close();
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});
