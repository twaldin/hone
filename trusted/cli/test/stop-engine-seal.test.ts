import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunEvent } from "@hone/schema";
import type { CmdResult, RunCommand } from "@hone/broker";
import { stopCommand } from "../src/commands/stop.js";
import { DOCKER_CREATE_WAL } from "../src/docker-create-gate.js";
import { DOCKER_ENGINE_SEAL, openStopDockerClient } from "../src/docker-engine-seal.js";
import { fixtureEvents, makeIo, makeRoot, readLogLines, tarToCas, writeAlignedDispatchJournal, writeEvents } from "./helpers.js";

/**
 * Stop-time Docker Engine TOCTOU (release blocker): resources exist on
 * Engine A; stop preflights A; the ambient Docker context is switched to
 * Engine B before the sweep; a sweep against B finds nothing, "succeeds",
 * and stop writes run.finished while every resource (and any pending
 * create) survives on A. The fix freezes ONE endpoint/identity for the
 * whole attempt (explicit per-argv `--host`, canonicalized socket pinned
 * by inode) and re-verifies identity + zero resources on that exact
 * endpoint immediately before terminal success — a context change is
 * either irrelevant (production argv pin) or fails closed (identity drift).
 */

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

function sealEngine(runDir: string, engineId: string): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, DOCKER_ENGINE_SEAL), `${JSON.stringify({ v: 1, engineId, endpointKind: "unverified", at: "2026-07-16T00:00:00Z" })}\n`);
}

interface ScriptedEngine {
  run: RunCommand;
  calls: string[][];
  /** The daemon the seam currently "reaches" — flipping it between calls is exactly an ambient context switch. */
  state: { id: string; keeperPresentInProof: boolean; onInfo?: () => void };
}

/**
 * A deterministic daemon seam. Resource listings are always EMPTY (the
 * wrong engine looks clean, so a sweep against it "succeeds" — the sealed
 * engine's leak is invisible), except `keeperPresentInProof`, which makes
 * the post-sweep named-resource proof see a survivor.
 */
function scriptedEngine(initialId: string): ScriptedEngine {
  const calls: string[][] = [];
  const state: ScriptedEngine["state"] = { id: initialId, keeperPresentInProof: false };
  const missing = (what: string): CmdResult => res({ exitCode: 1, stderr: Buffer.from(`Error: No such object: ${what}`) });
  const run: RunCommand = (argv) => {
    calls.push([...argv]);
    const [cmd, sub] = argv;
    expect(cmd).toBe("docker");
    if (sub === "info") {
      const id = state.id;
      state.onInfo?.();
      return Promise.resolve(res({ stdout: Buffer.from(`${id}\n`) }));
    }
    if (sub === "inspect") return Promise.resolve(missing(argv[argv.length - 1] ?? "")); // sweep keeper probe
    if (sub === "ps") return Promise.resolve(res()); // no labeled containers on the current engine
    if (sub === "rm") return Promise.resolve(missing(argv[argv.length - 1] ?? ""));
    if (sub === "container" && argv[2] === "inspect") {
      // Post-sweep named-resource proof: presence comes from stdout even on a non-zero exit.
      if (state.keeperPresentInProof) {
        return Promise.resolve(res({ exitCode: 1, stdout: Buffer.from("deadbeefkeeper\n"), stderr: Buffer.from("Error: No such object: other") }));
      }
      return Promise.resolve(missing("named containers"));
    }
    if (sub === "volume" && argv[2] === "ls") return Promise.resolve(res());
    if (sub === "volume") return Promise.resolve(missing(argv[argv.length - 1] ?? ""));
    if (sub === "network") return Promise.resolve(missing(argv[argv.length - 1] ?? ""));
    throw new Error(`unscripted docker call: ${argv.join(" ")}`);
  };
  return { run, calls, state };
}

function deadRunFixture(runId: string): { root: string; runDir: string } {
  const root = makeRoot();
  const baselineHash = tarToCas(root, { "hello.txt": "baseline\n" });
  const runDir = writeEvents(root, runId, fixtureEvents({ runId, baselineHash, bestHash: baselineHash, finished: false }));
  writeAlignedDispatchJournal(root, runId);
  return { root, runDir };
}

/** Index of the last removal (`docker rm` / `docker volume|network rm`) in a scripted call log. */
function lastRemovalIndex(calls: string[][]): number {
  return calls.reduce((acc, c, i) => (c[1] === "rm" || c[2] === "rm" ? i : acc), -1);
}

describe("hone stop — Docker Engine context TOCTOU (fail closed on identity drift)", () => {
  it("EXPLOIT: preflight sees sealed Engine A, context switches to an empty Engine B before the sweep — stop must NOT terminalize", async () => {
    const runId = "run_ctx_switch";
    const { root, runDir } = deadRunFixture(runId);
    sealEngine(runDir, "ENGINE-A");
    const engine = scriptedEngine("ENGINE-A");
    // The context switch: the instant the preflight identity query answers
    // "ENGINE-A", every later docker call reaches ENGINE-B (which is empty,
    // so the sweep and every removal "succeed" while A keeps everything).
    engine.state.onInfo = () => {
      engine.state.id = "ENGINE-B";
    };
    const { io, err } = makeIo(root);
    const code = await stopCommand([], io, engine.run);
    expect(code, err.join("\n")).toBe(1);
    expect(err.join("\n")).toMatch(/sealed to Docker engine ENGINE-A.*ENGINE-B/);
    // The release blocker: run.finished must never be written.
    const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.some((e) => e.type === "run.finished")).toBe(false);
    // The drift was caught by a POST-sweep recheck on the same frozen client:
    // at least two identity queries, one strictly after the last removal.
    const infoIdx = engine.calls.flatMap((c, i) => (c[1] === "info" ? [i] : []));
    expect(infoIdx.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...infoIdx)).toBeGreaterThan(lastRemovalIndex(engine.calls));
  });

  it("success path: one sealed identity for the whole attempt — preflight, sweep, zero-resource proof, then a FINAL identity recheck", async () => {
    const runId = "run_ctx_clean";
    const { root, runDir } = deadRunFixture(runId);
    sealEngine(runDir, "ENGINE-A");
    const engine = scriptedEngine("ENGINE-A");
    const { io, err } = makeIo(root);
    const code = await stopCommand([], io, engine.run);
    expect(code, err.join("\n")).toBe(0);
    const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
    // Identity verified at least twice (preflight + post-sweep recheck)…
    const infoIdx = engine.calls.flatMap((c, i) => (c[1] === "info" ? [i] : []));
    expect(infoIdx.length).toBeGreaterThanOrEqual(2);
    // …the recheck is the LAST docker word before terminal success…
    expect(engine.calls[engine.calls.length - 1]?.[1]).toBe("info");
    // …and the zero-resource proof (named inspects) ran after every removal,
    // all through the same frozen client.
    const proofInspect = engine.calls.findIndex((c) => c[1] === "container" && c[2] === "inspect");
    expect(proofInspect).toBeGreaterThan(lastRemovalIndex(engine.calls));
  });

  it("a resource that still exists on the sealed engine after the sweep blocks terminal success (rm exits are never trusted alone)", async () => {
    const runId = "run_ctx_residual";
    const { root, runDir } = deadRunFixture(runId);
    sealEngine(runDir, "ENGINE-A");
    const engine = scriptedEngine("ENGINE-A");
    engine.state.keeperPresentInProof = true; // e.g. a crashed attempt's create landed daemon-side after the sweep's listing
    const { io, err } = makeIo(root);
    expect(await stopCommand([], io, engine.run)).toBe(1);
    expect(err.join("\n")).toMatch(/still exist/);
    const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.some((e) => e.type === "run.finished")).toBe(false);
  });

  it("an unreachable daemon at the post-sweep recheck fails closed", async () => {
    const runId = "run_ctx_down";
    const { root, runDir } = deadRunFixture(runId);
    sealEngine(runDir, "ENGINE-A");
    const engine = scriptedEngine("ENGINE-A");
    let infoSeen = 0;
    const run: RunCommand = (argv, opts) => {
      if (argv[1] === "info") {
        infoSeen += 1;
        if (infoSeen > 1) {
          engine.calls.push([...argv]);
          return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("Cannot connect to the Docker daemon") }));
        }
      }
      return engine.run(argv, opts);
    };
    const { io, err } = makeIo(root);
    expect(await stopCommand([], io, run)).toBe(1);
    expect(err.join("\n")).toMatch(/identity is unavailable/);
    const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
    expect(events.some((e) => e.type === "run.finished")).toBe(false);
  });
});

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

async function listenUnix(path: string): Promise<Server> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(path, resolve);
  });
  return srv;
}

describe("openStopDockerClient — one frozen, explicit endpoint for the whole stop attempt", () => {
  it("production: resolves the context endpoint ONCE, then pins every docker argv with --host <canonical unix socket> --config <trusted empty dir>; ambient env is never mutated", async () =>
    withCleanAmbient(async () => {
      const root = makeRoot();
      const runDir = join(root, ".hone-runs", "run_pin");
      mkdirSync(runDir, { recursive: true });
      sealEngine(runDir, "ENGINE-A"); // sealed: only a sealed run pins an endpoint (unsealed+no-journal skips Docker entirely)
      const sock = join(root, "a.sock");
      const srv = await listenUnix(sock);
      try {
        const calls: string[][] = [];
        const base: RunCommand = (argv) => {
          calls.push([...argv]);
          if (argv[1] === "context") return Promise.resolve(res({ stdout: Buffer.from(`unix://${sock}\n`) }));
          return Promise.resolve(res());
        };
        const client = await openStopDockerClient(runDir, "run_pin", base, true);
        // The ONLY unpinned call is the single endpoint resolution.
        expect(calls.length).toBe(1);
        expect(calls[0]?.slice(0, 3)).toEqual(["docker", "context", "inspect"]);
        const canonical = realpathSync(sock);
        // Every later docker call carries the frozen endpoint EXPLICITLY.
        await client.run(["docker", "ps", "-aq"]);
        const last = calls[calls.length - 1];
        expect(last?.slice(0, 3)).toEqual(["docker", "--host", `unix://${canonical}`]);
        expect(last?.slice(3, 5)).toEqual(["--config", join(runDir, "docker-config")]);
        expect(last?.slice(5)).toEqual(["ps", "-aq"]);
        // No ambient mutation: the pin lives in argv, not in the process env.
        expect(process.env["DOCKER_HOST"]).toBeUndefined();
        expect(process.env["DOCKER_CONFIG"]).toBeUndefined();
      } finally {
        srv.close();
      }
    }));

  it("production: DOCKER_HOST symlinks are canonicalized (a retargeted symlink steers nothing) and the socket INCARNATION is pinned — a replaced socket fails closed", async () =>
    withCleanAmbient(async () => {
      const root = makeRoot();
      const runDir = join(root, ".hone-runs", "run_sock");
      mkdirSync(runDir, { recursive: true });
      sealEngine(runDir, "ENGINE-A");
      const real = join(root, "real.sock");
      const other = join(root, "other.sock");
      const link = join(root, "link.sock");
      const srvA = await listenUnix(real);
      const srvB = await listenUnix(other);
      try {
        symlinkSync(real, link);
        process.env["DOCKER_HOST"] = `unix://${link}`;
        const seen: string[][] = [];
        const base: RunCommand = (argv) => {
          seen.push([...argv]);
          // verifyEngine queries identity through the pinned client; the
          // daemon behind the (intact) socket is ENGINE-A.
          if (argv.includes("info")) return Promise.resolve(res({ stdout: Buffer.from("ENGINE-A\n") }));
          return Promise.resolve(res());
        };
        const client = await openStopDockerClient(runDir, "run_sock", base, true);
        const canonical = realpathSync(real);
        await client.run(["docker", "ps"]);
        expect(seen[0]?.slice(0, 3)).toEqual(["docker", "--host", `unix://${canonical}`]);
        // Retargeting the symlink AFTER the freeze is irrelevant: the pin
        // is the canonical path + inode, not the mutable link.
        unlinkSync(link);
        symlinkSync(other, link);
        expect(await client.verifyEngine()).toBeNull();
        // Replacing the pinned socket itself (unbind + rebind = new inode)
        // is an endpoint retarget and MUST fail closed.
        await new Promise<void>((resolve) => srvA.close(() => resolve())); // close() unlinks the socket file
        expect(await client.verifyEngine()).toMatch(/disappeared mid-stop/);
        const srvA2 = await listenUnix(canonical);
        try {
          expect(await client.verifyEngine()).toMatch(/changed identity mid-stop/);
        } finally {
          srvA2.close();
        }
      } finally {
        srvB.close();
      }
    }));

  it("production: non-unix endpoints are REJECTED before any Docker contact — a --host string cannot pin one daemon behind a DNS/TCP name (A→B→A resolution flips would defeat both identity checks)", async () =>
    withCleanAmbient(async () => {
      const root = makeRoot();
      const runDir = join(root, ".hone-runs", "run_tcp");
      mkdirSync(runDir, { recursive: true });
      sealEngine(runDir, "ENGINE-A"); // rejection matters only for SEALED runs — unsealed+no-journal runs provably own nothing and skip Docker entirely
      const never: RunCommand = () => {
        throw new Error("no docker call may happen for a rejected endpoint");
      };
      // Plain TCP: rejected.
      process.env["DOCKER_HOST"] = "tcp://10.0.0.5:2375";
      await expect(openStopDockerClient(runDir, "run_tcp", never, true)).rejects.toThrow(/not a local unix socket.*unix:\/\/ engines only/);
      // TLS does not help: it authenticates a certificate, not ONE stable
      // daemon connection across the attempt's many docker invocations.
      process.env["DOCKER_HOST"] = "tcp://engine.internal:2376";
      process.env["DOCKER_TLS_VERIFY"] = "1";
      process.env["DOCKER_CERT_PATH"] = "/certs";
      await expect(openStopDockerClient(runDir, "run_tcp", never, true)).rejects.toThrow(/not a local unix socket/);
      // ssh:// forwards through a mutable ssh config — same rejection.
      delete process.env["DOCKER_TLS_VERIFY"];
      delete process.env["DOCKER_CERT_PATH"];
      process.env["DOCKER_HOST"] = "ssh://user@engine";
      await expect(openStopDockerClient(runDir, "run_tcp", never, true)).rejects.toThrow(/not a local unix socket/);
      // A context RESOLVING to a non-unix endpoint is rejected identically
      // (rejection is on the resolved endpoint, not just the env string).
      delete process.env["DOCKER_HOST"];
      const tcpContext: RunCommand = (argv) => {
        expect(argv.slice(0, 3)).toEqual(["docker", "context", "inspect"]);
        return Promise.resolve(res({ stdout: Buffer.from("tcp://10.0.0.9:2375\n") }));
      };
      await expect(openStopDockerClient(runDir, "run_tcp", tcpContext, true)).rejects.toThrow(/not a local unix socket/);
    }));

  it("fails closed on a create journal without a seal, and on unresolvable endpoints (no hardcoded default socket)", async () =>
    withCleanAmbient(async () => {
      const root = makeRoot();
      const runDir = join(root, ".hone-runs", "run_wal");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, DOCKER_CREATE_WAL), '{"v":1,"t":"epoch","epoch":1,"at":"x"}\n');
      const noContext: RunCommand = () => Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("no current context") }));
      await expect(openStopDockerClient(runDir, "run_wal", noContext, false)).rejects.toThrow(/journal but no engine seal/);

      const runDir2 = join(root, ".hone-runs", "run_noep");
      mkdirSync(runDir2, { recursive: true });
      sealEngine(runDir2, "ENGINE-A"); // sealed: an endpoint MUST be resolvable to touch its resources
      await expect(openStopDockerClient(runDir2, "run_noep", noContext, true)).rejects.toThrow(/endpoint resolution failed/);
    }));

  it("verifyEngine: vacuous for a run that provably never contacted Docker; binding (via the frozen client) for a sealed run", async () => {
    const root = makeRoot();
    const runDir = join(root, ".hone-runs", "run_verify");
    mkdirSync(runDir, { recursive: true });
    const never: RunCommand = () => {
      throw new Error("an unsealed run must not query engine identity");
    };
    const unsealed = await openStopDockerClient(runDir, "run_verify", never, false);
    expect(await unsealed.verifyEngine()).toBeNull();

    sealEngine(runDir, "ENGINE-A");
    let id = "ENGINE-A";
    const engine: RunCommand = (argv) => {
      expect(argv.slice(0, 2)).toEqual(["docker", "info"]);
      return Promise.resolve(res({ stdout: Buffer.from(`${id}\n`) }));
    };
    const sealed = await openStopDockerClient(runDir, "run_verify", engine, false);
    expect(await sealed.verifyEngine()).toBeNull();
    id = "ENGINE-B";
    expect(await sealed.verifyEngine()).toMatch(/sealed to Docker engine ENGINE-A.*ENGINE-B/);
  });

  it("a provably never-contacted run (no seal, no journal) needs NO endpoint resolution and NO daemon — even in production", async () =>
    withCleanAmbient(async () => {
      const root = makeRoot();
      const runDir = join(root, ".hone-runs", "run_never");
      mkdirSync(runDir, { recursive: true });
      // No DOCKER_HOST, no reachable context, no daemon: nothing may be asked.
      const never: RunCommand = () => {
        throw new Error("a never-contacted run must not resolve or query anything");
      };
      const client = await openStopDockerClient(runDir, "run_never", never, true);
      expect(client.neverContactedDocker).toBe(true);
      expect(await client.verifyEngine()).toBeNull();
    }));
});

describe("production stop end-to-end (fake docker on PATH): a ~/.docker currentContext switch mid-sweep steers NOTHING", () => {
  it("resolves once on context A, the context flips to B during the first sweep call, and every later argv stays on explicit A — only then terminal", async () =>
    withCleanAmbient(async () => {
      const runId = "run_e2e_pin";
      const { root, runDir } = deadRunFixture(runId);
      const sock = join(root, "a.sock");
      const srv = await listenUnix(sock);
      const canonical = realpathSync(sock);
      sealEngine(runDir, "ENGINE-A");
      const state = join(root, "docker-state");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "endpoint"), `unix://${sock}\n`);
      writeFileSync(join(state, "endpoint-a"), `unix://${canonical}\n`);
      writeFileSync(join(state, "endpoint-b"), `unix://${join(root, "b.sock")}\n`);
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const dockerPath = join(bin, "docker");
      writeFileSync(
        dockerPath,
        `#!/bin/sh
STATE=${JSON.stringify(state)}
printf '%s\\n' "$*" >> "$STATE/calls.log"
HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --config) shift 2 ;;
    *) break ;;
  esac
done
CMD="$1"
if [ "$CMD" = "context" ]; then
  cat "$STATE/endpoint"
  exit 0
fi
if [ -n "$HOST" ]; then EP="$HOST"; else EP="$(cat "$STATE/endpoint")"; fi
if [ "$EP" = "$(cat "$STATE/endpoint-a")" ]; then ENGINE=ENGINE-A; else ENGINE=ENGINE-B; fi
if [ "$CMD" != "info" ] && [ ! -f "$STATE/switched" ]; then
  cp "$STATE/endpoint-b" "$STATE/endpoint"
  : > "$STATE/switched"
fi
case "$CMD" in
  info) echo "$ENGINE" ;;
  ps) : ;;
  rm) echo "Error: No such container" >&2; exit 1 ;;
  inspect) echo "Error: No such object" >&2; exit 1 ;;
  container|volume|network)
    if [ "$2" = "ls" ]; then :; else echo "Error: No such object" >&2; exit 1; fi ;;
  *) : ;;
esac
exit 0
`,
      );
      chmodSync(dockerPath, 0o755);
      const savedPath = process.env["PATH"];
      process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
      try {
        const { io, err } = makeIo(root);
        // DEFAULT RunCommand: this is the real production path end to end.
        const code = await stopCommand([], io);
        expect(code, err.join("\n")).toBe(0);
        const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
        expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
        // The ambient context REALLY flipped to B mid-attempt…
        expect(readFileSync(join(state, "endpoint"), "utf8").trim()).toBe(`unix://${join(root, "b.sock")}`);
        const lines = readFileSync(join(state, "calls.log"), "utf8").split("\n").filter((l) => l.length > 0);
        const contextLines = lines.filter((l) => l.startsWith("context inspect"));
        expect(contextLines.length).toBe(1); // resolution happened EXACTLY once
        // …yet every daemon-touching call stayed on explicit, frozen A.
        const daemonLines = lines.filter((l) => !l.startsWith("context inspect"));
        expect(daemonLines.length).toBeGreaterThan(0);
        for (const line of daemonLines) {
          expect(line).toContain(`--host unix://${canonical}`);
        }
        // Identity was rechecked after the sweep; the last daemon word is `info`.
        expect(daemonLines.filter((l) => l.includes(" info ") || / info( |$)/.test(l)).length).toBeGreaterThanOrEqual(2);
        expect(/ info( |$)/.test(daemonLines[daemonLines.length - 1] ?? "")).toBe(true);
      } finally {
        process.env["PATH"] = savedPath;
        srv.close();
      }
    }));

  it("a production stop whose endpoint resolves non-unix refuses with ZERO docker contact and no terminal — the A→B→A DNS flip has nothing to steer", async () =>
    withCleanAmbient(async () => {
      const runId = "run_e2e_tcp";
      const { root, runDir } = deadRunFixture(runId);
      sealEngine(runDir, "ENGINE-A"); // sealed: resources may exist, so the endpoint must be pinnable
      // Canary docker on PATH: ANY invocation would be logged.
      const state = join(root, "docker-state");
      mkdirSync(state, { recursive: true });
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const dockerPath = join(bin, "docker");
      writeFileSync(dockerPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(state, "calls.log"))}\nexit 1\n`);
      chmodSync(dockerPath, 0o755);
      const savedPath = process.env["PATH"];
      process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
      process.env["DOCKER_HOST"] = "tcp://engine.internal:2375";
      try {
        const { io, err } = makeIo(root);
        const code = await stopCommand([], io); // DEFAULT RunCommand: real production path
        expect(code).toBe(1);
        expect(err.join("\n")).toMatch(/not a local unix socket.*refusing completion/);
        const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
        expect(events.some((e) => e.type === "run.finished")).toBe(false);
        // Rejection happened BEFORE the first resource observation.
        expect(existsSync(join(state, "calls.log"))).toBe(false);
      } finally {
        process.env["PATH"] = savedPath;
      }
    }));

  it("a dead run that provably never contacted Docker finalizes as stopped with ZERO docker contact — an unavailable daemon cannot block it", async () =>
    withCleanAmbient(async () => {
      const runId = "run_e2e_never";
      const { root, runDir } = deadRunFixture(runId); // NO seal, NO create journal
      writeFileSync(join(runDir, "proxy.sock"), ""); // stale host-side socket file
      // Canary docker on PATH that always fails: ANY invocation would both
      // log itself and break the stop.
      const state = join(root, "docker-state");
      mkdirSync(state, { recursive: true });
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const dockerPath = join(bin, "docker");
      writeFileSync(dockerPath, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(state, "calls.log"))}\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n`);
      chmodSync(dockerPath, 0o755);
      const savedPath = process.env["PATH"];
      process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
      try {
        const { io, err } = makeIo(root);
        const code = await stopCommand([], io); // DEFAULT RunCommand: real production path
        expect(code, err.join("\n")).toBe(0);
        const events = readLogLines(root, runId).map((l) => RunEvent.parse(JSON.parse(l)));
        expect(events.filter((e) => e.type === "run.finished").length).toBe(1);
        expect(existsSync(join(state, "calls.log"))).toBe(false); // provably zero Docker contact
        expect(existsSync(join(runDir, "proxy.sock"))).toBe(false); // fs-only cleanup still ran
      } finally {
        process.env["PATH"] = savedPath;
      }
    }));
});
