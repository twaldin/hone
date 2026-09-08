import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "@hone/broker";
import type { CmdOptions, CmdResult, RunCommand } from "@hone/broker";
import {
  DOCKER_CREATE_SIDECAR,
  DOCKER_CREATE_WAL,
  currentHostBootId,
  parseBootUuid,
  openDockerCreateGate,
  readOpenDockerCreateIntents,
  readDockerCgroupParent,
} from "../src/docker-create-gate.js";
import type { DockerCreateHelperTask, DockerCreateKind } from "../src/docker-create-gate.js";
import { deferred } from "../src/promise.js";
import { scriptedCreateHelper } from "./helpers.js";

/**
 * The docker-create gate is ONE uncertainty protocol: every resource create
 * is joined to a definitive daemon response, write-ahead latched
 * (intent -> dispatched -> settled), executed via a detached Dekker helper
 * when unclaimable (donor/volume/network), and provable after ANY crash
 * schedule — before the intent, before the dispatch marker, after the marker
 * but before the call, after POST acceptance with a signaled client. All
 * schedules below are deterministic scripted fakes — no sleeps, no retries.
 */

const RUN_ID = "run_gate";
const IMAGE = "img@sha256:feedface";
const OLD_DONOR = `hone-lease-${RUN_ID}-e1`;
const NEW_DONOR = `hone-lease-${RUN_ID}-e2`;

function res(overrides: Partial<CmdResult> = {}): CmdResult {
  return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
}

interface Call {
  argv: readonly string[];
  opts: CmdOptions | undefined;
}

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "hone-gate-"));
}

function sidecarPath(dir: string, seq: number, file: "started" | "outcome" | "abort"): string {
  return join(dir, DOCKER_CREATE_SIDECAR, `${seq}.${file}`);
}

function writeSidecar(dir: string, seq: number, file: "started" | "outcome" | "abort", text: string): void {
  mkdirSync(join(dir, DOCKER_CREATE_SIDECAR), { recursive: true });
  writeFileSync(sidecarPath(dir, seq, file), text);
}

describe("host boot identity witness", () => {
  it("normalizes the canonical boot-session UUID: case-folded, surrounding whitespace stripped", () => {
    expect(parseBootUuid("35579D1C-2186-42AB-B20E-3AEE321D7860\n", "sysctl kern.bootsessionuuid")).toBe(
      "35579d1c-2186-42ab-b20e-3aee321d7860",
    );
    expect(parseBootUuid("  0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6b  ", "kernel boot_id")).toBe(
      "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6b",
    );
  });

  it.each([
    "",
    " \n\t",
    "not-a-uuid",
    "0b5e7a2c9d144f6e8a3b1c2d3e4f5a6b", // unhyphenated hex
    "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6", // short final group
    "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6bb", // long final group
    "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6g", // non-hex digit
    "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6b\nf1e2d3c4-b5a6-4978-8123-456789abcdef", // multi-line
    "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6b trailing", // embedded text
    "uuid: 0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6b",
    "{ sec = 1721025021, usec = 453170 } Mon Jul 15 01:10:21 PDT 2024", // retired kern.boottime calendar rendering
    "1721025021:453170", // retired canonicalized boot instant — wall-clock text is NOT identity
  ])("rejects anything but exactly one canonical UUID: %j", (value) => {
    expect(() => parseBootUuid(value, "sysctl kern.bootsessionuuid")).toThrow(/host boot identity unavailable/);
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "reads a stable per-boot UUID from THIS host (real command, no seam)",
    () => {
      const first = currentHostBootId();
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(currentHostBootId()).toBe(first);
    },
  );
});

describe("aggregate calibration resource boundary", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("forces one group before the image for fenced, two-phase and detached-helper creates", async () => {
    const dir = newDir(); dirs.push(dir);
    const parent = "/hone-calibration";
    const seen: string[][] = [];
    const daemon: RunCommand = async (argv) => {
      if (argv[1] === "create") seen.push([...argv]);
      return res({ stdout: Buffer.from("container-id\n") });
    };
    const gate = openDockerCreateGate(dir, RUN_ID, { cgroupParent: parent, helper: scriptedCreateHelper(daemon) });
    const run = gate.wrap(daemon);
    await run(["docker", "create", "--name", "candidate", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"]);
    await run(["docker", "run", "--rm", "--name", "evaluation", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "--cgroup-parent", "/command-argument"]);
    await run(["docker", "create", `--cgroup-parent=${parent}`, "--name", "keeper", IMAGE, "true"]);
    expect(seen).toHaveLength(3);
    for (const argv of seen) {
      const flags = argv.slice(0, argv.indexOf(IMAGE));
      const index = flags.indexOf("--cgroup-parent");
      expect(index).toBeGreaterThan(1);
      expect(flags[index + 1]).toBe(parent);
      expect(flags.filter((arg) => arg === "--cgroup-parent" || arg.startsWith("--cgroup-parent="))).toHaveLength(1);
    }
    expect(seen[1]!.slice(seen[1]!.indexOf(IMAGE) + 1)).toEqual(["--cgroup-parent", "/command-argument"]);
    gate.assertTerminal();
  });

  it("refuses conflicting Docker group flags before any create intent or daemon call", async () => {
    const dir = newDir(); dirs.push(dir);
    let contacted = false;
    const daemon: RunCommand = async () => { contacted = true; return res(); };
    const gate = openDockerCreateGate(dir, RUN_ID, { cgroupParent: "/hone-calibration", helper: scriptedCreateHelper(daemon) });
    const run = gate.wrap(daemon);
    for (const flags of [["--cgroup-parent", "/unbounded"], ["--cgroup-parent=/unbounded"]]) {
      await expect(run(["docker", "create", ...flags, "--name", "escape", IMAGE])).rejects.toThrow(/cgroup/);
    }
    expect(contacted).toBe(false);
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("retains the group across resume and refuses adding, replacing or dropping it", async () => {
    const grouped = newDir(); const ungrouped = newDir(); dirs.push(grouped, ungrouped);
    openDockerCreateGate(grouped, RUN_ID, { cgroupParent: "hone-calibration.slice" });
    const resumed = openDockerCreateGate(grouped, RUN_ID, { cgroupParent: "hone-calibration.slice" });
    expect(readDockerCgroupParent(grouped)).toBe("hone-calibration.slice");
    expect(resumed.containerArgv(["docker", "create", IMAGE])).toEqual(["docker", "create", "--cgroup-parent", "hone-calibration.slice", IMAGE]);
    expect(() => openDockerCreateGate(grouped, RUN_ID)).toThrow(/cgroup/);
    expect(() => openDockerCreateGate(grouped, RUN_ID, { cgroupParent: "/other" })).toThrow(/cgroup/);
    openDockerCreateGate(ungrouped, RUN_ID);
    expect(() => openDockerCreateGate(ungrouped, RUN_ID, { cgroupParent: "/hone-calibration" })).toThrow(/cgroup/);
  });
});

describe("wrap: joined fenced creates with write-ahead intents", () => {
  it("strips the client timeout for `docker create`, journals intent AND dispatched marker BEFORE dispatch, settles on the daemon response", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const calls: Call[] = [];
    let walAtDispatch = "";
    const run: RunCommand = (argv, opts) => {
      calls.push({ argv, opts });
      walAtDispatch = readFileSync(join(dir, DOCKER_CREATE_WAL), "utf8");
      return Promise.resolve(res({ stdout: Buffer.from("cid\n") }));
    };
    const grun = gate.wrap(run);
    const result = await grun(["docker", "create", "--name", "c1", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], { timeoutMs: 5 });
    expect(result.exitCode).toBe(0);
    // JOIN: the create phase never carries a client timeout.
    expect(calls[0]?.opts?.timeoutMs).toBeUndefined();
    // Write-ahead: intent + dispatched marker are durable BEFORE the daemon
    // could have seen the request.
    expect(walAtDispatch).toContain('"t":"intent"');
    expect(walAtDispatch).toContain('"name":"c1"');
    expect(walAtDispatch).toContain(`"fence":"${OLD_DONOR}"`);
    expect(walAtDispatch).toContain('"t":"dispatched"');
    expect(walAtDispatch).not.toContain('"t":"settled"');
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
    gate.assertTerminal();
  });

  it("rewrites `docker run -d` two-phase: joined create (no -d), bounded start of the id, stdout mimics run -d", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const calls: Call[] = [];
    const run: RunCommand = (argv, opts) => {
      calls.push({ argv, opts });
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("abc123\n") }));
      return Promise.resolve(res());
    };
    const grun = gate.wrap(run);
    const result = await grun(
      ["docker", "run", "-d", "--name", "hone-keeper", "--label", `hone.runId=${RUN_ID}`, "-e", "K=V", IMAGE, "sleep", "1"],
      { timeoutMs: 120_000 },
    );
    expect(calls[0]?.argv.slice(0, 2)).toEqual(["docker", "create"]);
    expect(calls[0]?.argv).not.toContain("-d");
    expect(calls[0]?.argv).toContain("K=V"); // creation flags survive verbatim
    expect(calls[0]?.opts?.timeoutMs).toBeUndefined(); // joined
    expect(calls[1]?.argv).toEqual(["docker", "start", "abc123"]);
    expect(calls[1]?.opts?.timeoutMs).toBe(120_000); // bounded, killable
    // The caller sees `docker run -d` semantics: stdout is the container id.
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString("utf8").trim()).toBe("abc123");
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("foreground `docker run`: bounded `start -a` passes the container's streams and exit code through", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const run: RunCommand = (argv) => {
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("evalcid\n") }));
      if (argv[1] === "start") {
        expect(argv[2]).toBe("-a");
        return Promise.resolve(res({ exitCode: 7, stdout: Buffer.from("score 0.5\n"), stderr: Buffer.from("warn\n") }));
      }
      return Promise.resolve(res());
    };
    const result = await gate.wrap(run)(["docker", "run", "--rm", "--name", "hone-eval-1", IMAGE, "python3", "eval.py"], { timeoutMs: 9 });
    expect(result.exitCode).toBe(7);
    expect(result.stdout.toString("utf8")).toBe("score 0.5\n");
    expect(result.timedOut).toBe(false);
    // A normal nonzero container exit is DEFINITIVE — settled, no reap needed.
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("REGRESSION: a start-phase client timeout does NOT stop the container — the gate reaps the registered id (joined) BEFORE returning", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const sequence: string[] = [];
    const rmSettled = deferred<CmdResult>();
    const rmCalled = deferred<void>();
    const run: RunCommand = (argv) => {
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("liv3cid\n") }));
      if (argv[1] === "start") {
        sequence.push("start-timed-out");
        return Promise.resolve(res({ timedOut: true, exitCode: 1 }));
      }
      if (argv[1] === "rm") {
        sequence.push(`rm-called:${argv[3] ?? ""}`);
        rmCalled.resolve();
        return rmSettled.promise;
      }
      return Promise.resolve(res());
    };
    const pending = gate.wrap(run)(["docker", "run", "--name", "hone-eval-2", IMAGE, "sleep", "999"], { timeoutMs: 3 });
    let returned = false;
    void pending.then(() => {
      returned = true;
    });
    // Deterministic: wait for the chain to reach the (withheld) rm response.
    await rmCalled.promise;
    expect(sequence).toEqual(["start-timed-out", "rm-called:liv3cid"]);
    // The wrapped call MUST NOT resolve while the daemon-side reap is
    // pending: the rm response is withheld, so resolution here would prove
    // the gate abandoned the reap.
    expect(returned).toBe(false);
    rmSettled.resolve(res());
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(readOpenDockerCreateIntents(dir)).toEqual([]); // create itself was definitive
  });

  it("a detached start failure reaps the registered id before returning the failure", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const argvs: (readonly string[])[] = [];
    const run: RunCommand = (argv) => {
      argvs.push(argv);
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("dcid\n") }));
      if (argv[1] === "start") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("cannot start") }));
      return Promise.resolve(res());
    };
    const result = await gate.wrap(run)(["docker", "run", "-d", "--name", "hone-relay", IMAGE, "node", "-e", "x"], {});
    expect(result.exitCode).toBe(1);
    expect(argvs.map((a) => a[1])).toEqual(["create", "start", "rm"]);
    expect(argvs[2]).toEqual(["docker", "rm", "-f", "dcid"]);
  });

  it("P1(3): only a CONCLUSIVE Engine rejection settles failed; a signaled client or transport loss after POST acceptance stays OPEN", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const responses: CmdResult[] = [
      res({ exitCode: 125, stderr: Buffer.from("docker: Error response from daemon: No such image") }), // conclusive rejection
      res({ exitCode: -1, stderr: Buffer.alloc(0) }), // externally signaled client (SIGKILL): ambiguous
      res({ exitCode: 1, stderr: Buffer.from("error during connect: Post ...: unexpected EOF") }), // transport loss: ambiguous
    ];
    let i = 0;
    const run: RunCommand = () => Promise.resolve(responses[i++] ?? res());
    const grun = gate.wrap(run);
    await grun(["docker", "create", "--name", "r1", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], {});
    await grun(["docker", "create", "--name", "r2", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], {});
    await grun(["docker", "create", "--name", "r3", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], {});
    const open = readOpenDockerCreateIntents(dir).map((o) => o.name);
    expect(open).toEqual(["r2", "r3"]); // r1 settled failed; the ambiguous two latch
    expect(() => gate.assertTerminal()).toThrow(/r2.*r3|r3.*r2/);
  });

  it("a rejected create client leaves a DURABLE open intent; terminal refuses across gate reopens", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const run: RunCommand = (argv) =>
      argv[1] === "create" ? Promise.reject(new Error("client killed")) : Promise.resolve(res());
    await expect(
      gate.wrap(run)(["docker", "create", "--name", "ghost", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], {}),
    ).rejects.toThrow(/client killed/);
    expect(() => gate.assertTerminal()).toThrow(/unresolved.*ghost/);
    // Durability: a fresh process (new gate) still sees the latch.
    expect(readOpenDockerCreateIntents(dir).map((i) => i.name)).toEqual(["ghost"]);
  });

  it("a legacy timedOut-shaped create result stays open (a client timeout is not a daemon response)", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    const run: RunCommand = () => Promise.resolve(res({ timedOut: true }));
    const result = await gate.wrap(run)(["docker", "create", "--name", "maybe", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], {});
    expect(result.timedOut).toBe(true);
    expect(readOpenDockerCreateIntents(dir).map((i) => i.name)).toEqual(["maybe"]);
  });
});

describe("wrap: unclaimable creates (donor/volume/network) run through the detached Dekker helper", () => {
  it("volume + network + unfenced (donor) creates are journaled, dispatched via helper tasks, and settle from the durable outcome", async () => {
    const dir = newDir();
    const tasks: DockerCreateHelperTask[] = [];
    const daemon: RunCommand = () => Promise.resolve(res({ stdout: Buffer.from("ok\n") }));
    const scripted = scriptedCreateHelper(daemon);
    const gate = openDockerCreateGate(dir, RUN_ID, {
      helper: (task) => {
        tasks.push(task);
        return scripted(task);
      },
    });
    const run: RunCommand = () => {
      throw new Error("unclaimable creates must never dispatch through the RunCommand");
    };
    const grun = gate.wrap(run);
    const volume = await grun(["docker", "volume", "create", "--label", `hone.runId=${RUN_ID}`, "hone-scratch-x"], { timeoutMs: 30_000 });
    const network = await grun(["docker", "network", "create", "--internal", "hone-x"], { timeoutMs: 120_000 });
    const donor = await grun(["docker", "create", "--name", OLD_DONOR, IMAGE, "true"], {});
    expect(volume.exitCode).toBe(0);
    expect(network.exitCode).toBe(0);
    expect(donor.exitCode).toBe(0);
    expect(tasks.map((t) => t.argv[1] === "create" ? "container" : t.argv[1])).toEqual(["volume", "network", "container"]);
    // Dekker artifacts: started + outcome durable for each.
    for (const task of tasks) {
      expect(existsSync(task.startedPath)).toBe(true);
      expect(existsSync(task.outcomePath)).toBe(true);
    }
    const wal = readFileSync(join(dir, DOCKER_CREATE_WAL), "utf8");
    expect(wal).toContain('"kind":"volume"');
    expect(wal).toContain('"kind":"network"');
    expect(wal).toContain('"t":"dispatched"');
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
    gate.assertTerminal();
  });

  it("ADVERSARIAL LIVE SCHEDULE: a stalled helper blocks drain (terminalization) until its durable outcome lands", async () => {
    const dir = newDir();
    const stall = deferred<void>();
    const dispatched = deferred<void>();
    const gate = openDockerCreateGate(dir, RUN_ID, {
      helper: async (task) => {
        writeFileSync(task.startedPath, "");
        dispatched.resolve();
        await stall.promise;
        writeFileSync(task.outcomePath, JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
      },
    });
    const run: RunCommand = () => Promise.resolve(res());
    const pending = gate.wrap(run)(["docker", "network", "create", "--internal", "hone-late"], { timeoutMs: 5 });
    void pending.catch(() => {});
    let drained = false;
    const drain = gate.drain().then(() => {
      drained = true;
    });
    await dispatched.promise;
    expect(drained).toBe(false);
    expect(gate.openIntents().map((i) => i.name)).toEqual(["hone-late"]);
    expect(() => gate.assertTerminal()).toThrow(/unresolved.*hone-late/);
    // The helper finally records the daemon's answer.
    stall.resolve();
    await pending;
    await drain;
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
    gate.assertTerminal();
  });

  it("helper outcomes follow the conclusive-rejection rule: engine rejection settles failed, PROVEN pre-spawn error settles failed, a signaled client and a post-spawn client error stay open", async () => {
    const dir = newDir();
    const outcomes = [
      { exitCode: 1, stdout: "", stderr: Buffer.from("Error response from daemon: boom").toString("base64") },
      { exitCode: 127, pid: 0, stdout: "", stderr: "", spawnError: "Error: spawn docker ENOENT", spawnErrorCode: "ENOENT", spawned: false },
      { exitCode: -1, stdout: "", stderr: "" }, // signaled client after POST acceptance
      // ENOBUFS kills the client AFTER spawn: the create may already be in the daemon.
      { exitCode: -1, pid: 4242, stdout: "", stderr: "", spawnError: "SystemError: spawnSync docker ENOBUFS", spawnErrorCode: "ENOBUFS", spawned: true },
      // Legacy outcome: spawnError WITHOUT the spawn witness — unknown = fail closed, stays open.
      { exitCode: 127, stdout: "", stderr: "", spawnError: "Error: spawn docker ENOENT" },
    ];
    let i = 0;
    const gate = openDockerCreateGate(dir, RUN_ID, {
      helper: (task) => {
        writeFileSync(task.startedPath, "");
        writeFileSync(task.outcomePath, JSON.stringify(outcomes[i++]));
        return Promise.resolve();
      },
    });
    const grun = gate.wrap(() => Promise.resolve(res()));
    await grun(["docker", "volume", "create", "v-rejected"], {});
    await grun(["docker", "volume", "create", "v-nospawn"], {});
    await grun(["docker", "volume", "create", "v-signaled"], {});
    await grun(["docker", "volume", "create", "v-enobufs"], {});
    await grun(["docker", "volume", "create", "v-legacy"], {});
    expect(readOpenDockerCreateIntents(dir).map((o) => o.name)).toEqual(["v-signaled", "v-enobufs", "v-legacy"]);
  });

  it("REGRESSION: ENOBUFS after dispatch stays LATCHED — a late daemon registration is observed and reaped on resume, never escaping terminal", async () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID, {
      helper: (task) => {
        writeFileSync(task.startedPath, "");
        writeFileSync(
          task.outcomePath,
          JSON.stringify({
            exitCode: -1,
            pid: 4242,
            stdout: "",
            stderr: "",
            spawnError: "SystemError: spawnSync docker ENOBUFS (stdout or stderr buffer exceeded)",
            spawnErrorCode: "ENOBUFS",
            spawned: true,
          }),
        );
        return Promise.resolve();
      },
    });
    const result = await gate.wrap(() => Promise.resolve(res()))(["docker", "volume", "create", "v-late"], {});
    expect(result.exitCode).not.toBe(0);
    // NOT settled failed: the client ran, so the daemon may register late.
    expect(() => gate.assertTerminal()).toThrow(/unresolved/);
    expect(readOpenDockerCreateIntents(dir).map((o) => o.name)).toEqual(["v-late"]);
    // Resume: the volume DID register after the client died — observation reaps it.
    const calls: string[][] = [];
    const daemon: RunCommand = (argv) => {
      calls.push([...argv]);
      if (argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("[{}]\n") }));
      return Promise.resolve(res());
    };
    const resumed = openDockerCreateGate(dir, RUN_ID);
    await resumed.reapInheritedCreates(resumed.wrap(daemon));
    resumed.assertTerminal();
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
    expect(calls).toContainEqual(["docker", "volume", "rm", "-f", "v-late"]);
  });

  it("CONTROL: a PROVEN pre-spawn failure inherited on resume is undispatched without contacting the daemon; a witness-less legacy error stays open", async () => {
    const dir = newDir();
    crashWith(dir, [
      { kind: "volume", name: "v-prespawn", fence: null },
      { kind: "volume", name: "v-witnessless", fence: null },
    ]);
    for (const seq of [1, 2]) writeSidecar(dir, seq, "started", "");
    writeSidecar(
      dir,
      1,
      "outcome",
      JSON.stringify({ exitCode: 127, pid: 0, stdout: "", stderr: "", spawnError: "Error: spawn docker ENOENT", spawnErrorCode: "ENOENT", spawned: false }),
    );
    writeSidecar(dir, 2, "outcome", JSON.stringify({ exitCode: 127, stdout: "", stderr: "", spawnError: "Error: spawn docker ENOENT" }));
    const calls: string[][] = [];
    const daemon: RunCommand = (argv) => {
      calls.push([...argv]);
      if (argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("Error: No such object") }));
      return Promise.resolve(res());
    };
    const resumed = openDockerCreateGate(dir, RUN_ID);
    await resumed.reapInheritedCreates(resumed.wrap(daemon));
    // v-prespawn: provably never contacted the daemon — undispatched, no inspect.
    expect(calls.every((argv) => !argv.includes("v-prespawn"))).toBe(true);
    // v-witnessless: unknown spawn state fails closed — observed (inspected), absent-now on the
    // same boot stays ambiguous and latched.
    expect(calls).toContainEqual(["docker", "volume", "inspect", "v-witnessless"]);
    expect(() => resumed.assertTerminal()).toThrow(/unresolved/);
    expect(readOpenDockerCreateIntents(dir).map((o) => o.name)).toEqual(["v-witnessless"]);
  });
});

describe("journal durability", () => {
  it("epochs are monotonic across gate opens — an old donor epoch is never re-minted", () => {
    const dir = newDir();
    expect(openDockerCreateGate(dir, RUN_ID).epoch).toBe(1);
    expect(openDockerCreateGate(dir, RUN_ID).epoch).toBe(2);
    expect(openDockerCreateGate(dir, RUN_ID).epoch).toBe(3);
  });

  it("REGRESSION P1(4): a torn tail is PHYSICALLY truncated before append — the next epoch never fuses onto the fragment and a second restart replays cleanly", () => {
    const dir = newDir();
    const gate = openDockerCreateGate(dir, RUN_ID);
    gate.begin("container", "ok", OLD_DONOR).settle("created");
    appendFileSync(join(dir, DOCKER_CREATE_WAL), '{"v":1,"t":"intent","seq":99,"kind":"cont'); // torn tail (no LF)
    // Restart 1: torn tail dropped AND truncated; the epoch append lands on a clean boundary.
    const gate2 = openDockerCreateGate(dir, RUN_ID);
    expect(gate2.epoch).toBe(2);
    expect(gate2.openIntents()).toEqual([]);
    const raw = readFileSync(join(dir, DOCKER_CREATE_WAL), "utf8");
    expect(raw).not.toContain('"seq":99');
    expect(raw.endsWith("\n")).toBe(true);
    for (const line of raw.split("\n").filter((l) => l !== "")) JSON.parse(line); // every line parses
    // Restart 2: replay is permanently healthy.
    expect(openDockerCreateGate(dir, RUN_ID).epoch).toBe(3);
  });

  it("a file with NO newline at all truncates to empty and behaves as fresh; terminated corruption (tail or not) fails closed", () => {
    const noLf = newDir();
    writeFileSync(join(noLf, DOCKER_CREATE_WAL), '{"v":1,"t":"epoch","ep'); // never terminated
    expect(openDockerCreateGate(noLf, RUN_ID).epoch).toBe(1);

    const midCorrupt = newDir();
    writeFileSync(join(midCorrupt, DOCKER_CREATE_WAL), 'GARBAGE\n{"v":1,"t":"epoch","epoch":1,"at":"x"}\n');
    expect(() => openDockerCreateGate(midCorrupt, RUN_ID)).toThrow(/corrupt/);

    const tailCorrupt = newDir();
    writeFileSync(join(tailCorrupt, DOCKER_CREATE_WAL), '{"v":1,"t":"epoch","epoch":1,"at":"x"}\nGARBAGE\n');
    // LF-terminated garbage was FULLY appended — that is corruption, not a torn write.
    expect(() => openDockerCreateGate(tailCorrupt, RUN_ID)).toThrow(/corrupt/);
  });

  it("P1(2): short writes loop to completion; an append failure poisons the gate and fails BEFORE dispatch", async () => {
    // Short write: the io returns half the buffer per call — writeAll loops.
    const looped = newDir();
    let shorted = false;
    const gateLoop = openDockerCreateGate(looped, RUN_ID, {
      io: {
        write: (fd, buf, offset, length) => {
          const half = Math.max(1, Math.floor(length / 2));
          shorted = shorted || half < length;
          const { writeSync } = fsBits;
          return writeSync(fd, buf, offset, half);
        },
      },
    });
    gateLoop.begin("container", "half", OLD_DONOR).settle("created");
    expect(shorted).toBe(true);
    const raw = readFileSync(join(looped, DOCKER_CREATE_WAL), "utf8");
    for (const line of raw.split("\n").filter((l) => l !== "")) JSON.parse(line); // no torn interleaving

    // Failure: the dispatched-marker append throws — the create MUST NOT
    // dispatch, the gate is poisoned, and the intent resolves as
    // undispatched at the next open (never a permanent latch).
    const dir = newDir();
    let appends = 0;
    let fail = false;
    const gate = openDockerCreateGate(dir, RUN_ID, {
      io: {
        write: (fd, buf, offset, length) => {
          appends += 1;
          if (fail && appends > 2) throw new Error("disk full"); // epoch+intent ok, dispatched fails
          const { writeSync } = fsBits;
          return writeSync(fd, buf, offset, length);
        },
      },
    });
    fail = true;
    let dispatchedToDaemon = false;
    const run: RunCommand = () => {
      dispatchedToDaemon = true;
      return Promise.resolve(res());
    };
    await expect(gate.wrap(run)(["docker", "create", "--name", "px", "--volumes-from", `${OLD_DONOR}:ro`, IMAGE, "true"], {})).rejects.toThrow(
      /journal append failed.*poisoned/,
    );
    expect(dispatchedToDaemon).toBe(false); // fail-closed BEFORE contact
    expect(() => gate.begin("container", "py", null)).toThrow(/poisoned/);
    expect(() => gate.assertTerminal()).toThrow(/poisoned/);
    // The crashed-by-poison intent never carried a dispatched marker: the
    // next open proves it undispatched and the run can terminalize.
    const gate2 = openDockerCreateGate(dir, RUN_ID);
    gate2.assertTerminal();
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });
});

// node:fs bits used inside injected io fakes (kept off the top-level import
// list so the fakes read as what they are: pass-through with faults).
import * as fsBits from "node:fs";

/** Model a crashed attempt: journal intents (dispatched by default), optionally settled, then reopen as a resume would. */
function crashWith(
  dir: string,
  intents: { kind: DockerCreateKind; name: string; fence: string | null; settled?: boolean; dispatched?: boolean }[],
  bootId?: string,
): void {
  const gate = openDockerCreateGate(dir, RUN_ID, bootId !== undefined ? { bootId } : {});
  for (const intent of intents) {
    const handle = gate.begin(intent.kind, intent.name, intent.fence);
    if (intent.dispatched !== false) handle.dispatched();
    if (intent.settled === true) handle.settle("created");
  }
}

describe("host reboot death-proof (boot incarnation witness, locality-gated)", () => {
  const BOOT_A = "0b5e7a2c-9d14-4f6e-8a3b-1c2d3e4f5a6b";
  const BOOT_B = "f1e2d3c4-b5a6-4978-8123-456789abcdef";
  const missingDaemon: RunCommand = (argv) => {
    if (argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("Error: No such object") }));
    return Promise.resolve(res());
  };
  const crashRebootFixture = (dir: string): void => {
    crashWith(
      dir,
      [
        { kind: "container", name: OLD_DONOR, fence: null },
        { kind: "volume", name: "hone-scratch-x", fence: null },
        { kind: "network", name: "hone-x", fence: null },
      ],
      BOOT_A,
    );
    // Helpers durably started, then the HOST lost power before any outcome.
    for (const seq of [1, 2, 3]) writeSidecar(dir, seq, "started", "");
  };

  it("LOCAL unix engine: SAME boot stays ambiguous (helper/daemon may still deliver); a NEW boot with the resource absent proves the request dead and terminal is reachable", async () => {
    const dir = newDir();
    crashRebootFixture(dir);

    // Resume on the SAME boot: fail-closed, latched.
    const same = openDockerCreateGate(dir, RUN_ID, { bootId: BOOT_A, endpointIsLocal: true });
    await same.reapInheritedCreates(same.wrap(missingDaemon));
    expect(() => same.assertTerminal()).toThrow(/unresolved/);

    // Resume after a REBOOT on the sealed LOCAL engine: helper, client, and
    // the daemon's in-flight request all died with the host; the resource is
    // absent — causally dead, terminal reachable.
    const rebooted = openDockerCreateGate(dir, RUN_ID, { bootId: BOOT_B, endpointIsLocal: true });
    await rebooted.reapInheritedCreates(rebooted.wrap(missingDaemon));
    rebooted.assertTerminal();
    expect(readFileSync(join(dir, DOCKER_CREATE_WAL), "utf8")).toContain('"how":"rebooted"');
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("REMOTE/unverified endpoint: a changed boot with the resource missing-now STAYS OPEN — the remote engine survived the local reboot and may still register", async () => {
    const dir = newDir();
    crashRebootFixture(dir);
    const rebooted = openDockerCreateGate(dir, RUN_ID, { bootId: BOOT_B }); // endpointIsLocal defaults FALSE (fail closed)
    await rebooted.reapInheritedCreates(rebooted.wrap(missingDaemon));
    expect(() => rebooted.assertTerminal()).toThrow(/unresolved/);
    expect(readOpenDockerCreateIntents(dir).length).toBe(3);
    // The late remote registration is still caught by observation later.
    const observed = openDockerCreateGate(dir, RUN_ID, { bootId: BOOT_B });
    const registered: RunCommand = (argv) => {
      if (argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("[{}]\n") }));
      return Promise.resolve(res());
    };
    await observed.reapInheritedCreates(observed.wrap(registered));
    observed.assertTerminal();
  });

  it("refuses to open on a malformed injected boot witness — the gate never runs on a guessed identity", () => {
    expect(() => openDockerCreateGate(newDir(), RUN_ID, { bootId: "BOOT-2" })).toThrow(/host boot identity unavailable/);
    expect(() => openDockerCreateGate(newDir(), RUN_ID, { bootId: "{ sec = 1721025021, usec = 453170 } Mon Jul 15 01:10:21 PDT 2024" })).toThrow(
      /host boot identity unavailable/,
    );
  });

  it("retired calendar boot-time identity in an inherited WAL stays ambiguous on a LOCAL engine — mere inequality with the UUID witness proves nothing", async () => {
    const dir = newDir();
    // A WAL stamped by the retired kern.boottime identity scheme: dispatched,
    // helper durably started, no outcome — exactly the shape the reboot
    // proof used to fire on.
    appendFileSync(
      join(dir, DOCKER_CREATE_WAL),
      `{"v":1,"t":"intent","seq":1,"kind":"container","name":"${OLD_DONOR}","fence":null,"boot":"1721025021:453170","at":"2026-07-15T00:00:00.000Z"}\n` +
        '{"v":1,"t":"dispatched","seq":1,"at":"2026-07-15T00:00:00.000Z"}\n',
    );
    writeSidecar(dir, 1, "started", "");
    const resumed = openDockerCreateGate(dir, RUN_ID, { bootId: BOOT_B, endpointIsLocal: true });
    await resumed.reapInheritedCreates(resumed.wrap(missingDaemon));
    expect(() => resumed.assertTerminal()).toThrow(/unresolved/);
    expect(readOpenDockerCreateIntents(dir).length).toBe(1);
  });
});

describe("inherited open intents: deterministic crash schedules, every kind", () => {
  it("BEFORE-CALL crash (every kind, incl. unnamed): an intent without the dispatched marker is proven undispatched at the next open and never latches stop", async () => {
    const dir = newDir();
    crashWith(dir, [
      { kind: "container", name: "hone-scratch-keeper-x", fence: OLD_DONOR, dispatched: false },
      { kind: "container", name: OLD_DONOR, fence: null, dispatched: false },
      { kind: "volume", name: "hone-scratch-x", fence: null, dispatched: false },
      { kind: "network", name: "hone-x", fence: null, dispatched: false },
    ]);
    expect(readOpenDockerCreateIntents(dir)).toEqual([]); // stop finalization never latches on these
    const gate = openDockerCreateGate(dir, RUN_ID);
    expect(gate.openIntents()).toEqual([]);
    gate.assertTerminal(); // eventual terminal without any docker call
    expect(readFileSync(join(dir, DOCKER_CREATE_WAL), "utf8")).toContain('"how":"undispatched"');
  });

  it("POST-MARKER/PRE-CALL crash (helper kinds): the durable abort fences a straggler helper; proven undispatched, terminal reachable — and a helper that starts later aborts before contacting docker", async () => {
    const dir = newDir();
    crashWith(dir, [
      { kind: "container", name: OLD_DONOR, fence: null }, // donor: dispatched marker, helper never spawned
      { kind: "volume", name: "hone-scratch-x", fence: null },
      { kind: "network", name: "hone-x", fence: null },
    ]);
    expect(readOpenDockerCreateIntents(dir).length).toBe(3); // latched until causally resolved
    const gate = openDockerCreateGate(dir, RUN_ID);
    const run: RunCommand = () => {
      throw new Error("no docker call is needed for the Dekker proof");
    };
    await gate.reapInheritedCreates(gate.wrap(run));
    gate.assertTerminal(); // proven undispatched via the durable abort
    // Straggler: a helper for seq 1 fires AFTER the verdict — it observes the
    // abort and never invokes docker.
    let contacted = false;
    const straggler = scriptedCreateHelper(() => {
      contacted = true;
      return Promise.resolve(res());
    });
    await straggler({
      argv: ["docker", "create", "--name", OLD_DONOR, IMAGE, "true"],
      startedPath: sidecarPath(dir, 1, "started"),
      abortPath: sidecarPath(dir, 1, "abort"),
      outcomePath: sidecarPath(dir, 1, "outcome"),
    });
    expect(contacted).toBe(false);
    expect(JSON.parse(readFileSync(sidecarPath(dir, 1, "outcome"), "utf8"))).toMatchObject({ aborted: true });
  });

  it("SIGNALED LOSS AFTER POST ACCEPTANCE (helper kinds): the ambiguous outcome stays latched; the late registration is observed, reaped, and only then does terminal complete", async () => {
    const dir = newDir();
    crashWith(dir, [
      { kind: "container", name: OLD_DONOR, fence: null },
      { kind: "volume", name: "hone-scratch-x", fence: null },
      { kind: "network", name: "hone-x", fence: null },
    ]);
    for (const seq of [1, 2, 3]) {
      writeSidecar(dir, seq, "started", "");
      writeSidecar(dir, seq, "outcome", JSON.stringify({ exitCode: -1, stdout: "", stderr: "" })); // client SIGKILLed post-acceptance
    }
    // Resume 1: nothing registered yet — everything stays latched.
    const gate1 = openDockerCreateGate(dir, RUN_ID);
    const missing: RunCommand = (argv) => {
      if (argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("Error: No such object") }));
      return Promise.resolve(res());
    };
    await gate1.reapInheritedCreates(gate1.wrap(missing));
    await gate1.proveInheritedIntents(gate1.wrap(missing), { runId: RUN_ID, image: IMAGE, donorName: NEW_DONOR });
    expect(() => gate1.assertTerminal()).toThrow(/unresolved/);

    // The daemon then PUBLISHES all three. Resume 2 observes + reaps.
    const gate2 = openDockerCreateGate(dir, RUN_ID);
    const reaps: (readonly string[])[] = [];
    const registered: RunCommand = (argv) => {
      if (argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("[{}]\n") }));
      if (argv[1] === "rm" || argv[2] === "rm") {
        reaps.push(argv);
        return Promise.resolve(res());
      }
      return Promise.resolve(res());
    };
    await gate2.reapInheritedCreates(gate2.wrap(registered));
    expect(reaps.some((a) => a[1] === "rm" && a.includes(OLD_DONOR))).toBe(true);
    expect(reaps.some((a) => a[1] === "volume" && a.includes("hone-scratch-x"))).toBe(true);
    expect(reaps.some((a) => a[1] === "network" && a.includes("hone-x"))).toBe(true);
    gate2.assertTerminal();
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("HELPER STILL RUNNING: started-but-no-outcome latches transiently, never a false verdict; the helper's durable outcome settles the next resume", async () => {
    const dir = newDir();
    crashWith(dir, [{ kind: "volume", name: "hone-scratch-x", fence: null }]);
    writeSidecar(dir, 1, "started", ""); // helper mid-flight at resume time
    const gate1 = openDockerCreateGate(dir, RUN_ID);
    await gate1.reapInheritedCreates(gate1.wrap((argv) => {
      if (argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("no such volume") }));
      return Promise.resolve(res());
    }));
    expect(() => gate1.assertTerminal()).toThrow(/hone-scratch-x/);
    // The (never-killed) helper finishes and records the daemon's answer.
    writeSidecar(dir, 1, "outcome", JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
    const gate2 = openDockerCreateGate(dir, RUN_ID);
    await gate2.reapInheritedCreates(gate2.wrap((argv) => {
      if (argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("no such volume") }));
      return Promise.resolve(res());
    }));
    gate2.assertTerminal(); // settled created from the durable outcome; sweep owns the resource
  });

  it("SCHEDULE A (fenced): request resolved the lease, stalls in the daemon — startup refuses while the reservation is held; after the daemon publishes, the next startup reaps it and terminal completes", async () => {
    const dir = newDir();
    crashWith(dir, [{ kind: "container", name: "hone-scratch-keeper-x", fence: OLD_DONOR }]);

    const gate1 = openDockerCreateGate(dir, RUN_ID);
    const daemon1: RunCommand = (argv) => {
      if (argv[1] === "container" && argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("Error: No such container") }));
      if (argv[1] === "create") return Promise.resolve(res({ exitCode: 125, stderr: Buffer.from('Conflict. The container name "/hone-scratch-keeper-x" is already in use') }));
      return Promise.resolve(res());
    };
    await gate1.reapInheritedCreates(gate1.wrap(daemon1));
    await expect(
      gate1.proveInheritedIntents(gate1.wrap(daemon1), { runId: RUN_ID, image: IMAGE, donorName: NEW_DONOR }),
    ).rejects.toThrow(/still in flight in the daemon/);
    expect(() => gate1.assertTerminal()).toThrow(/unresolved/);

    const gate2 = openDockerCreateGate(dir, RUN_ID);
    const reaped: string[] = [];
    const daemon2: RunCommand = (argv) => {
      if (argv[1] === "container" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("[{}]\n") }));
      if (argv[1] === "rm") {
        reaped.push(argv[3] ?? "");
        return Promise.resolve(res({ stdout: Buffer.from("hone-scratch-keeper-x\n") }));
      }
      return Promise.resolve(res());
    };
    await gate2.reapInheritedCreates(gate2.wrap(daemon2));
    expect(reaped).toEqual(["hone-scratch-keeper-x"]);
    await gate2.proveInheritedIntents(gate2.wrap(daemon2), { runId: RUN_ID, image: IMAGE, donorName: NEW_DONOR });
    gate2.assertTerminal();
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("SCHEDULE B (fenced): never-registered is proven dead by a successful name claim (moby reserves names before resolving --volumes-from), and the claim is removed", async () => {
    const dir = newDir();
    crashWith(dir, [{ kind: "container", name: "hone-proxy-x", fence: OLD_DONOR }]);
    const gate = openDockerCreateGate(dir, RUN_ID);
    const argvs: (readonly string[])[] = [];
    const daemon: RunCommand = (argv) => {
      argvs.push(argv);
      if (argv[1] === "container" && argv[2] === "inspect") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("No such container") }));
      if (argv[1] === "rm") return Promise.resolve(res({ exitCode: 1, stderr: Buffer.from("No such container") }));
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("claimcid\n") }));
      return Promise.resolve(res());
    };
    const grun = gate.wrap(daemon);
    await gate.reapInheritedCreates(grun);
    await gate.proveInheritedIntents(grun, { runId: RUN_ID, image: IMAGE, donorName: NEW_DONOR });
    const claim = argvs.find((a) => a[1] === "create");
    expect(claim).toContain("hone-proxy-x");
    expect(claim).toContain(`${NEW_DONOR}:ro`);
    expect(claim).toContain("--pull=never");
    const claimIdx = argvs.findIndex((a) => a[1] === "create");
    const unclaim = argvs.findIndex((a, i) => i > claimIdx && a[1] === "rm" && a.includes("hone-proxy-x"));
    expect(unclaim).toBeGreaterThan(claimIdx);
    gate.assertTerminal();
    expect(readOpenDockerCreateIntents(dir)).toEqual([]);
  });

  it("attribution stays sound: an observed registration proves NOTHING when a later settled create shares the deterministic name", async () => {
    const dir = newDir();
    const gate0 = openDockerCreateGate(dir, RUN_ID);
    const crashed = gate0.begin("container", "hone-scratch-keeper-x", OLD_DONOR);
    crashed.dispatched(); // open (crashed mid-flight)
    const gateMid = openDockerCreateGate(dir, RUN_ID);
    const settled = gateMid.begin("container", "hone-scratch-keeper-x", `hone-lease-${RUN_ID}-e2`);
    settled.dispatched();
    settled.settle("created");

    const gate = openDockerCreateGate(dir, RUN_ID);
    const daemon: RunCommand = (argv) => {
      if (argv[1] === "container" && argv[2] === "inspect") return Promise.resolve(res({ stdout: Buffer.from("[{}]\n") }));
      if (argv[1] === "create") return Promise.resolve(res({ stdout: Buffer.from("claimcid\n") }));
      return Promise.resolve(res());
    };
    const grun = gate.wrap(daemon);
    await gate.reapInheritedCreates(grun);
    // Reaped as CLEANUP, but the open intent is NOT proven by ambiguous observation…
    expect(gate.openIntents().map((i) => i.name)).toEqual(["hone-scratch-keeper-x"]);
    // …the fenced claim is what proves it dead.
    await gate.proveInheritedIntents(grun, { runId: RUN_ID, image: IMAGE, donorName: `hone-lease-${RUN_ID}-e4` });
    gate.assertTerminal();
  });
});

const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;

describe("real Docker probe: the daemon-side facts the causal proof rests on", () => {
  it.skipIf(!hasDocker)(
    "a create referencing a missing --volumes-from donor fails without registering; the failed create releases its name (reservation precedes volumes-from resolution); a held reservation reports 'already in use'",
    { timeout: 120_000 },
    async (ctx) => {
      // No pulls, ever: the probe uses an image that is already local.
      const local = spawnSync("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8", timeout: 30_000 });
      const image = (local.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.includes("<none>"));
      if (image === undefined) return ctx.skip();

      const suffix = `${Date.now()}-${process.pid}`;
      const name = `hone-gate-probe-${suffix}`;
      try {
        const fenced = await runCommand(
          ["docker", "create", "--pull=never", "--name", name, "--volumes-from", `hone-gate-missing-${suffix}:ro`, image, "true"],
          { timeoutMs: 60_000 },
        );
        expect(fenced.exitCode).not.toBe(0);
        expect(fenced.stderr.toString("utf8")).toMatch(/no such container/i);
        const inspected = await runCommand(["docker", "container", "inspect", name], { timeoutMs: 30_000 });
        expect(inspected.exitCode).not.toBe(0);

        const claim = await runCommand(["docker", "create", "--pull=never", "--name", name, image, "true"], { timeoutMs: 60_000 });
        expect(claim.exitCode).toBe(0);
        expect(claim.stdout.toString("utf8").trim().length).toBeGreaterThan(0);

        const conflict = await runCommand(["docker", "create", "--pull=never", "--name", name, image, "true"], { timeoutMs: 60_000 });
        expect(conflict.exitCode).not.toBe(0);
        expect(conflict.stderr.toString("utf8")).toMatch(/already in use/i);
      } finally {
        await runCommand(["docker", "rm", "-f", name], { timeoutMs: 30_000 });
      }
    },
  );
});

describe("real detached helper process: Dekker order with a stubbed docker on PATH", () => {
  it("publishes started before invoking docker, records the client outcome durably; a pre-existing abort prevents any docker contact", { timeout: 60_000 }, async () => {
    const dir = newDir();
    const stubDir = join(dir, "bin");
    mkdirSync(stubDir, { recursive: true });
    const touched = join(dir, "docker-was-invoked");
    writeFileSync(join(stubDir, "docker"), `#!/bin/sh\necho contacted > ${JSON.stringify(touched)}\necho cid-from-stub\nexit 0\n`);
    chmodSync(join(stubDir, "docker"), 0o755);

    const originalPath = process.env["PATH"];
    process.env["PATH"] = `${stubDir}:${originalPath ?? ""}`;
    try {
      const gate = openDockerCreateGate(dir, RUN_ID); // default REAL detached helper
      const grun = gate.wrap(() => Promise.resolve(res()));
      const result = await grun(["docker", "volume", "create", "hone-real-helper"], {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf8")).toContain("cid-from-stub");
      expect(existsSync(touched)).toBe(true);
      expect(existsSync(sidecarPath(dir, 1, "started"))).toBe(true);
      expect(existsSync(sidecarPath(dir, 1, "outcome"))).toBe(true);
      gate.assertTerminal();

      // Dekker: a durable abort written BEFORE the helper starts prevents any
      // docker contact — the stub's witness file stays absent.
      const dir2 = newDir();
      const gate2 = openDockerCreateGate(dir2, RUN_ID);
      const touched2 = join(dir2, "docker-was-invoked");
      writeFileSync(join(stubDir, "docker"), `#!/bin/sh\necho contacted > ${JSON.stringify(touched2)}\nexit 0\n`);
      chmodSync(join(stubDir, "docker"), 0o755);
      writeSidecar(dir2, 1, "abort", "");
      const aborted = await gate2.wrap(() => Promise.resolve(res()))(["docker", "volume", "create", "hone-aborted"], {});
      expect(existsSync(touched2)).toBe(false);
      expect(JSON.parse(readFileSync(sidecarPath(dir2, 1, "outcome"), "utf8"))).toMatchObject({ aborted: true });
      expect(aborted.exitCode).toBe(-1);
    } finally {
      process.env["PATH"] = originalPath;
    }
  });
});
