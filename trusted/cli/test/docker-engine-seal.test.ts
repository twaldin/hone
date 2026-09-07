import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "@hone/broker";
import type { CmdResult, RunCommand } from "@hone/broker";
import { DOCKER_CREATE_WAL } from "../src/docker-create-gate.js";
import {
  DOCKER_ENGINE_SEAL,
  currentDockerEngineId,
  dockerEngineSealError,
  freezeDockerClientEnv,
  sealDockerEngine,
} from "../src/docker-engine-seal.js";

/**
 * Engine identity seal: every create-gate proof, sweep, and latch judgment is
 * only meaningful against THE Engine that executed the run's creates. The
 * seal binds a run to the stable daemon ID before any Docker contact; a
 * resume or dead-stop under a different DOCKER_HOST/context refuses,
 * non-terminal. Endpoint changes to the SAME engine stay legitimate.
 */

const RUN_ID = "run_seal";

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

function engine(id: string): RunCommand {
  return (argv) => {
    expect(argv.slice(0, 2)).toEqual(["docker", "info"]);
    return Promise.resolve(res({ stdout: Buffer.from(`${id}\n`) }));
  };
}

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "hone-seal-"));
}

describe("sealDockerEngine (no-clobber durable binding, written before any Docker contact)", () => {
  it("seals on first use, verifies (never rewrites) on later attempts, and refuses a different daemon naming both identities", async () => {
    const dir = newDir();
    expect(await sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"))).toEqual({ engineId: "ENGINE-A", endpointKind: "unverified" });
    const sealedBytes = readFileSync(join(dir, DOCKER_ENGINE_SEAL), "utf8");
    // Same engine (possibly via a different endpoint/context): verified, unchanged.
    expect((await sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"))).engineId).toBe("ENGINE-A");
    expect(readFileSync(join(dir, DOCKER_ENGINE_SEAL), "utf8")).toBe(sealedBytes);
    // Different engine: refuse, naming BOTH.
    await expect(sealDockerEngine(dir, RUN_ID, engine("ENGINE-B"))).rejects.toThrow(/ENGINE-A.*ENGINE-B/);
    expect(readFileSync(join(dir, DOCKER_ENGINE_SEAL), "utf8")).toBe(sealedBytes); // no clobber
  });

  it("fails closed when a create journal exists without a seal (the seal is ordered BEFORE the journal)", async () => {
    const dir = newDir();
    writeFileSync(join(dir, DOCKER_CREATE_WAL), '{"v":1,"t":"epoch","epoch":1,"at":"x"}\n');
    await expect(sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"))).rejects.toThrow(/journal but no engine seal/);
  });

  it("refuses to proceed when the daemon reports no identity", async () => {
    const dir = newDir();
    const down: RunCommand = () => Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("Cannot connect to the Docker daemon") }));
    await expect(sealDockerEngine(dir, RUN_ID, down)).rejects.toThrow(/identity is unavailable/);
    expect(existsSync(join(dir, DOCKER_ENGINE_SEAL))).toBe(false);
  });
});

describe("dockerEngineSealError (stop / dead-run finalization gate)", () => {
  it("null when the run provably never contacted Docker; fail-closed when the journal exists without a seal", async () => {
    const dir = newDir();
    expect(await dockerEngineSealError(dir, RUN_ID, engine("ENGINE-B"))).toBeNull();
    writeFileSync(join(dir, DOCKER_CREATE_WAL), '{"v":1,"t":"epoch","epoch":1,"at":"x"}\n');
    expect(await dockerEngineSealError(dir, RUN_ID, engine("ENGINE-B"))).toMatch(/journal but no engine seal/);
  });

  it("A/B schedule: sealed runs verify on A, refuse on B (naming both), and refuse when the daemon is unreachable", async () => {
    const dir = newDir();
    await sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"));
    expect(await dockerEngineSealError(dir, RUN_ID, engine("ENGINE-A"))).toBeNull();
    expect(await dockerEngineSealError(dir, RUN_ID, engine("ENGINE-B"))).toMatch(/sealed to Docker engine ENGINE-A.*ENGINE-B/);
    const down: RunCommand = () => Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("daemon down") }));
    expect(await dockerEngineSealError(dir, RUN_ID, down)).toMatch(/identity is unavailable/);
  });

  it("a malformed seal fails closed", async () => {
    const dir = newDir();
    writeFileSync(join(dir, DOCKER_ENGINE_SEAL), "{}");
    expect(await dockerEngineSealError(dir, RUN_ID, engine("ENGINE-A"))).toMatch(/malformed/);
    rmSync(join(dir, DOCKER_ENGINE_SEAL));
  });
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;

describe("real daemon identity smoke", () => {
  it.skipIf(!hasDocker)("the Engine reports a stable, non-empty ID and the seal round-trips against it", { timeout: 60_000 }, async () => {
    const first = await currentDockerEngineId(runCommand);
    const second = await currentDockerEngineId(runCommand);
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
    const dir = newDir();
    expect((await sealDockerEngine(dir, RUN_ID, runCommand)).engineId).toBe(first);
    expect(await dockerEngineSealError(dir, RUN_ID, runCommand)).toBeNull();
  });
});

describe("freezeDockerClientEnv (endpoint canonicalized + inode-pinned once; config/context mutations can never re-steer)", () => {
  const DOCKER_KEYS = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];
  function withCleanAmbient<T>(body: () => Promise<T>): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const key of DOCKER_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    return body().finally(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  /** ctxEnv base matching the ambient non-docker keys (HOME/PATH), so only DOCKER_* steering differences are under test. */
  const base = (): NodeJS.ProcessEnv => ({
    ...(process.env["PATH"] !== undefined ? { PATH: process.env["PATH"] } : {}),
    ...(process.env["HOME"] !== undefined ? { HOME: process.env["HOME"] } : {}),
  });
  /** A live unix socket bound at `path`; the returned closer also removes the file. */
  async function listenUnixSocket(path: string): Promise<() => Promise<void>> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    return () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          rmSync(path, { force: true });
          resolve();
        });
      });
  }
  const never: RunCommand = () => {
    throw new Error("no docker call may happen");
  };

  it("resolves the current context ONCE, pins the CANONICAL unix:// socket for every channel, and points DOCKER_CONFIG at an empty 0700 trusted dir — never copying credentials", async () =>
    withCleanAmbient(async () => {
      const dir = newDir();
      const sock = join(dir, "engine.sock");
      const close = await listenUnixSocket(sock);
      try {
        const canonical = realpathSync(sock);
        let contextInspects = 0;
        const run: RunCommand = (argv) => {
          expect(argv.slice(0, 3)).toEqual(["docker", "context", "inspect"]);
          contextInspects += 1;
          return Promise.resolve(res({ stdout: Buffer.from(`unix://${sock}\n`) }));
        };
        const ctxEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };
        const frozen = await freezeDockerClientEnv(dir, RUN_ID, ctxEnv, { run });
        expect(contextInspects).toBe(1);
        expect(frozen.endpointKind).toBe("local-unix");
        // Every channel gets ONLY unix://<canonical> — never the raw string.
        expect(frozen.env["DOCKER_HOST"]).toBe(`unix://${canonical}`);
        const configDir = frozen.env["DOCKER_CONFIG"] ?? "";
        expect(configDir).toBe(join(dir, "docker-config"));
        expect(readdirSync(configDir)).toEqual([]); // EMPTY: no credential-bearing config enters runDir
        expect(statSync(configDir).mode & 0o777).toBe(0o700);
        // The ambient channel (default RunCommand) is bound to the SAME canonical resolution.
        expect(process.env["DOCKER_HOST"]).toBe(`unix://${canonical}`);
        expect(process.env["DOCKER_CONFIG"]).toBe(configDir);
        expect(process.env["DOCKER_CONTEXT"]).toBeUndefined();
        expect(frozen.socketError()).toBeNull(); // clean control: the pinned socket is intact
      } finally {
        await close();
      }
    }));

  it("an explicit DOCKER_HOST wins without a context query; a symlinked endpoint canonicalizes and every docker argv is pinned per-invocation — retargeting the symlink steers NOTHING", async () =>
    withCleanAmbient(async () => {
      const dir = newDir();
      const sockB = join(dir, "b.sock");
      const closeB = await listenUnixSocket(sockB);
      const linkA = join(dir, "a.sock");
      symlinkSync(sockB, linkA); // endpoint A → daemon socket B
      try {
        const canonical = realpathSync(sockB);
        const argvs: string[][] = [];
        const recorder: RunCommand = (argv) => {
          argvs.push([...argv]);
          return Promise.resolve(res());
        };
        process.env["DOCKER_HOST"] = `unix://${linkA}`;
        const frozen = await freezeDockerClientEnv(dir, RUN_ID, { ...base(), DOCKER_HOST: `unix://${linkA}` }, { run: recorder });
        expect(argvs).toEqual([]); // no context query
        expect(frozen.env["DOCKER_HOST"]).toBe(`unix://${canonical}`); // the symlink string never leaves the freeze
        if (frozen.run === null) throw new Error("production freeze must return the pinned RunCommand");
        // Explicit per-invocation pinning: ambient env/context cannot steer this argv.
        await frozen.run(["docker", "ps", "-a"]);
        expect(argvs).toEqual([["docker", "--host", `unix://${canonical}`, "--config", join(dir, "docker-config"), "ps", "-a"]]);
        // Non-docker argvs pass through untouched.
        await frozen.run(["true"]);
        expect(argvs[1]).toEqual(["true"]);
        // Retargeting the ENDPOINT symlink after the freeze steers nothing:
        // only the canonical object was pinned, and it is intact.
        rmSync(linkA);
        symlinkSync(join(dir, "elsewhere.sock"), linkA);
        expect(frozen.socketError()).toBeNull();
      } finally {
        await closeB();
      }
    }));

  it("conflicting steering env between run env and process refuses BEFORE any Docker contact", async () =>
    withCleanAmbient(async () => {
      process.env["DOCKER_HOST"] = "unix:///var/run/a.sock";
      process.env["DOCKER_CONTEXT"] = "engine-a";
      await expect(
        freezeDockerClientEnv(newDir(), RUN_ID, { ...base(), DOCKER_HOST: "unix:///var/run/a.sock", DOCKER_CONTEXT: "engine-b" }, { run: never }),
      ).rejects.toThrow(/diverges.*DOCKER_CONTEXT|DOCKER_CONTEXT.*diverges/);
    }));

  it("refuses TLS forms and non-local endpoints (remote engines have no safe snapshot); scripted runs stay 'unverified' fail-closed with NOTHING pinned", async () =>
    withCleanAmbient(async () => {
      process.env["DOCKER_TLS_VERIFY"] = "1";
      await expect(freezeDockerClientEnv(newDir(), RUN_ID, { ...base(), DOCKER_TLS_VERIFY: "1" }, { run: never })).rejects.toThrow(/TLS/);
      delete process.env["DOCKER_TLS_VERIFY"];
      process.env["DOCKER_HOST"] = "tcp://10.0.0.5:2375";
      await expect(freezeDockerClientEnv(newDir(), RUN_ID, { ...base(), DOCKER_HOST: "tcp://10.0.0.5:2375" }, { run: never })).rejects.toThrow(
        /not a local unix socket/,
      );
      delete process.env["DOCKER_HOST"];
      const scripted = await freezeDockerClientEnv(newDir(), RUN_ID, { PATH: "/bin" }, null);
      expect(scripted.endpointKind).toBe("unverified");
      expect(scripted.env).toEqual({ PATH: "/bin" });
      expect(scripted.run).toBeNull(); // the injected seam is the only channel — no locality is ever pretended
      expect(scripted.socketError()).toBeNull();
    }));

  it("fails closed on a non-socket endpoint object and on an uncanonicalizable path — BEFORE any resource operation", async () =>
    withCleanAmbient(async () => {
      const dir = newDir();
      const file = join(dir, "not-a-socket");
      writeFileSync(file, "");
      process.env["DOCKER_HOST"] = `unix://${file}`;
      await expect(freezeDockerClientEnv(dir, RUN_ID, { ...base(), DOCKER_HOST: `unix://${file}` }, { run: never })).rejects.toThrow(
        /not a unix socket/,
      );
      const missing = join(dir, "missing.sock");
      process.env["DOCKER_HOST"] = `unix://${missing}`;
      await expect(freezeDockerClientEnv(dir, RUN_ID, { ...base(), DOCKER_HOST: `unix://${missing}` }, { run: never })).rejects.toThrow(
        /cannot be canonicalized/,
      );
    }));

  it("REGRESSION (replacement): a socket that disappears or is re-created at the frozen canonical path is a DIFFERENT object — the terminal recheck refuses", async () =>
    withCleanAmbient(async () => {
      const dir = newDir();
      const sock = join(dir, "engine.sock");
      const close1 = await listenUnixSocket(sock);
      process.env["DOCKER_HOST"] = `unix://${sock}`;
      const frozen = await freezeDockerClientEnv(dir, RUN_ID, { ...base(), DOCKER_HOST: `unix://${sock}` }, { run: never });
      expect(frozen.socketError()).toBeNull(); // clean control
      await close1();
      // Disappearance fails closed…
      expect(frozen.socketError()).toMatch(/disappeared mid-run/);
      // …and a REPLACEMENT socket at the same path (new inode — a different
      // daemon may answer there with ANY engine ID) fails closed too: no
      // terminal/resource-clean success against the wrong engine.
      const close2 = await listenUnixSocket(sock);
      try {
        expect(frozen.socketError()).toMatch(/changed identity mid-run/);
      } finally {
        await close2();
      }
    }));

  it("REGRESSION (A→B→A retarget): the canonical path re-planted as a symlink back to a live socket is drift — a naive path open reaches a daemon, the pinned OBJECT is gone", async () =>
    withCleanAmbient(async () => {
      const dir = newDir();
      const sockB = join(dir, "b.sock");
      const closeB = await listenUnixSocket(sockB);
      const sockC = join(dir, "c.sock"); // the wrong engine, fully alive
      const closeC = await listenUnixSocket(sockC);
      const linkA = join(dir, "a.sock");
      symlinkSync(sockB, linkA); // A → B at freeze time
      try {
        process.env["DOCKER_HOST"] = `unix://${linkA}`;
        const frozen = await freezeDockerClientEnv(dir, RUN_ID, { ...base(), DOCKER_HOST: `unix://${linkA}` }, { run: never });
        const canonical = realpathSync(sockB); // B is still alive here
        expect(frozen.env["DOCKER_HOST"]).toBe(`unix://${canonical}`);
        expect(frozen.socketError()).toBeNull(); // clean control
        // Retarget: remove B and re-plant its canonical path as a symlink to
        // the live wrong-engine socket C (A→B→A shape). Any client opening
        // the path now reaches C, which can report ANY engine ID — only the
        // inode pin proves the object changed.
        await closeB();
        symlinkSync(sockC, canonical);
        expect(frozen.socketError()).toMatch(/changed identity mid-run/);
      } finally {
        await closeC();
        rmSync(join(dir, "b.sock"), { force: true });
      }
    }));

  it("the sealed endpoint KIND is durable and binding: a later attempt resolving a different kind refuses", async () => {
    const dir = newDir();
    await sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"), "local-unix");
    await expect(sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"), "unverified")).rejects.toThrow(/locality-dependent proofs/);
    expect((await sealDockerEngine(dir, RUN_ID, engine("ENGINE-A"), "local-unix")).endpointKind).toBe("local-unix");
  });
});
