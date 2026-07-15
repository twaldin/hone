import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BudgetState,
  EvaluationRecord,
  type RunEvent,
  type SandboxRef,
  type ArtifactRef,
} from "@hone/schema";
import { z } from "zod";
import { startBroker, type RunningBroker, type SandboxNetworkMode } from "../src/index.js";
import { deferred } from "../src/deferred.js";
import { CasStore } from "../src/cas.js";
import { packDirAsArtifact } from "../src/artifact.js";
import { runCommand, type RunCommand } from "../src/command.js";
import { RpcClient, TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST, buildTestCapsule, ensureImage, waitForDocker } from "./helpers.js";

const GetTaskShape = z.object({
  capsuleId: z.string(),
  objective: z.string(),
  baselineArtifact: z.object({ hash: z.string() }),
  visibleAssetGroups: z.array(z.string()),
  budget: BudgetState,
});
const ExecShape = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});

// Test roots live under the repo so Docker Desktop file sharing covers every
// bind-mount source (/Users is shared by default; /var/folders may not be).
const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmpBase = path.join(pkgDir, ".test-tmp", `run-${randomBytes(4).toString("hex")}`);

const GENEROUS_BUDGET = { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 3_600, maxEvaluatorInvocations: 100 };

let cas: CasStore;
let baselineHash: string;
let capsuleRootDir: string;

let main: RunningBroker & { adminSocketPath: string };
let mainEvents: RunEvent[] = [];
let client: RpcClient;
let admin: RpcClient;
let dockerRunCount = 0;
/** Milliseconds added to the broker's injected clock — advances TTL deterministically. */
let clockOffsetMs = 0;
const testClock = () => Date.now() + clockOffsetMs;

/** Counts `docker run` spawns so memoization can prove no container started. */
const countingRunCommand: RunCommand = (argv, opts) => {
  if (argv[0] === "docker" && argv[1] === "run") dockerRunCount += 1;
  return runCommand(argv, opts);
};

interface BootExtras {
  events?: RunEvent[];
  runCommand?: RunCommand;
  scratchQuotaBytes?: number;
  reaperIntervalMs?: number;
  now?: () => number;
  sandboxNetwork?: SandboxNetworkMode;
  /** Overrides config.image (e.g. the uid-2000 sandbox-user image). */
  image?: string;
  /** Overrides the capsule's eval entrypoint (live containment probes). */
  evalEntrypoint?: string[];
}

async function makeBrokerConfig(
  name: string,
  budget: typeof GENEROUS_BUDGET,
  extras: BootExtras = {},
): Promise<{ config: Parameters<typeof startBroker>[0]; runDir: string }> {
  const runDir = path.join(tmpBase, "runs", name);
  await mkdir(runDir, { recursive: true });
  const capsule = await buildTestCapsule(path.join(tmpBase, "capsules", name), budget);
  capsule.manifest.baseline = { kind: "cas", hash: baselineHash };
  if (extras.evalEntrypoint) capsule.manifest.evalEntrypoint = extras.evalEntrypoint;
  const sink = extras.events;
  const config: Parameters<typeof startBroker>[0] = {
    runId: `run-${name}`,
    manifest: capsule.manifest,
    capsuleRootDir: capsule.capsuleRootDir,
    baselineArtifactHash: baselineHash,
    capsuleDigest: TEST_CAPSULE_DIGEST,
    optimizerDigest: TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: path.join(runDir, "holdout-ledger.ndjson"),
    image: extras.image ?? TEST_IMAGE,
    runDir,
    casDir: path.join(tmpBase, "cas"),
    onEvent: (event) => {
      if (sink) sink.push(event);
    },
    ...(extras.runCommand ? { runCommand: extras.runCommand } : {}),
    ...(extras.scratchQuotaBytes !== undefined ? { scratchQuotaBytes: extras.scratchQuotaBytes } : {}),
    ...(extras.reaperIntervalMs !== undefined ? { reaperIntervalMs: extras.reaperIntervalMs } : {}),
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.sandboxNetwork ? { sandboxNetwork: extras.sandboxNetwork } : {}),
  };
  return { config, runDir };
}

async function bootBroker(
  name: string,
  budget: typeof GENEROUS_BUDGET,
  extras: BootExtras = {},
): Promise<RunningBroker & { adminSocketPath: string }> {
  const { config, runDir } = await makeBrokerConfig(name, budget, extras);
  // Tests exercise privileged methods — explicit admin-socket opt-in (production default has none).
  return startBroker(config, { adminSocketPath: path.join(runDir, "broker-admin.sock") });
}

beforeAll(async () => {
  await waitForDocker();
  await ensureImage(TEST_IMAGE);
  await mkdir(tmpBase, { recursive: true });
  cas = new CasStore(path.join(tmpBase, "cas"));

  const capsule = await buildTestCapsule(path.join(tmpBase, "capsules", "seedfixture"), GENEROUS_BUDGET);
  capsuleRootDir = capsule.capsuleRootDir;
  baselineHash = await packDirAsArtifact(capsule.baselineDir, cas);

  mainEvents = [];
  main = await bootBroker("main", GENEROUS_BUDGET, {
    events: mainEvents,
    runCommand: countingRunCommand,
    reaperIntervalMs: 300,
    now: testClock,
  });
  client = await RpcClient.connect(main.socketPath);
  admin = await RpcClient.connect(main.adminSocketPath);
});

afterAll(async () => {
  client?.close();
  admin?.close();
  await main?.close();
  await rm(tmpBase, { recursive: true, force: true });
});

let sandboxId: string;
let candidateHash: string;

describe("wire protocol round-trip (every method)", () => {
  it("getTask returns capsule identity, baseline, and holdout-free asset groups", async () => {
    const task = GetTaskShape.parse(await client.call("getTask"));
    expect(task.capsuleId).toBe("cap_0123456789ab");
    expect(task.baselineArtifact.hash).toBe(baselineHash);
    expect(task.visibleAssetGroups.sort()).toEqual(["secret", "train"]);
    expect(task.visibleAssetGroups).not.toContain("holdout");
    expect(task.budget.envelope.maxEvaluatorInvocations).toBe(100);
  });

  it("createSandbox unpacks the artifact at /workspace", async () => {
    const ref = (await client.call("createSandbox", {
      artifact: { hash: baselineHash },
      role: "mutation",
    })) as SandboxRef;
    expect(ref.sandboxId).toBeTruthy();
    sandboxId = ref.sandboxId;

    const res = ExecShape.parse(await client.call("exec", { sandboxId, argv: ["cat", "/workspace/answer.txt"] }));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("1");
  });

  it("mounts the run proxy socket at /run/hone/proxy.sock (only egress)", async () => {
    const res = ExecShape.parse(
      await client.call("exec", { sandboxId, argv: ["ls", "/run/hone/proxy.sock"] }),
    );
    expect(res.exitCode).toBe(0);
  });

  it("mounts a writable persistent /scratch", async () => {
    const w = ExecShape.parse(
      await client.call("exec", { sandboxId, argv: ["sh", "-c", "echo persisted > /scratch/note.txt"] }),
    );
    expect(w.exitCode).toBe(0);
  });

  it("exec honors cwd and stdin", async () => {
    const res = ExecShape.parse(
      await client.call("exec", { sandboxId, argv: ["sh", "-c", "pwd && cat"], cwd: "/scratch", stdin: "from-stdin" }),
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("/scratch");
    expect(res.stdout).toContain("from-stdin");
  });

  it("putFile/getFile round-trip nested workspace paths", async () => {
    const content = Buffer.from("hello broker\n");
    await client.call("putFile", {
      sandboxId,
      path: "notes/deep/file.txt",
      contentBase64: content.toString("base64"),
    });
    const got = z
      .object({ contentBase64: z.string() })
      .parse(await client.call("getFile", { sandboxId, path: "notes/deep/file.txt" }));
    expect(Buffer.from(got.contentBase64, "base64")).toEqual(content);
  });

  it("saveArtifact captures the mutated workspace as a new CAS artifact", async () => {
    await client.call("putFile", { sandboxId, path: "answer.txt", contentBase64: Buffer.from("2").toString("base64") });
    const ref = (await client.call("saveArtifact", { sandboxId })) as ArtifactRef;
    expect(ref.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ref.hash).not.toBe(baselineHash);
    expect(await cas.has(ref.hash)).toBe(true);
    candidateHash = ref.hash;
  });

  it("evaluate runs the eval entrypoint against the artifact + public assets", async () => {
    const record = EvaluationRecord.parse(
      await client.call("evaluate", { artifact: { hash: candidateHash }, assetGroupId: "train", seed: 0 }),
    );
    expect(record.output.valid).toBe(true);
    expect(record.output.objectives["score"]).toBe(2);
    expect(record.output.perExample["ex1"]?.feedback).toBe("asset=train-data");
    expect(record.cached).toBe(false);
    expect(record.artifactHash).toBe(candidateHash);
    expect(record.durationMs).toBeGreaterThan(0);
  });

  it("getBudget reflects evaluator invocations", async () => {
    const budget = BudgetState.parse(await client.call("getBudget"));
    expect(budget.spent.evaluatorInvocations).toBe(1);
    expect(budget.envelope).toEqual(GENEROUS_BUDGET);
  });

  it("reportIncumbent promotes on paired trusted evidence; claimed metrics stay display-only", async () => {
    // Promotion authority needs a same-group/same-seed PAIR: measure the
    // parent (baseline) at the seed the candidate was measured at.
    await client.call("evaluate", { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 0 });
    const res = await client.call("reportIncumbent", { artifact: { hash: candidateHash }, claimed: { score: 999 } });
    expect(res).toEqual({});
    const promoted = mainEvents.filter((e) => e.type === "incumbent.new");
    expect(promoted).toHaveLength(1);
    // Aggregate is the broker's own measurement (2), never the claimed 999.
    expect(promoted[0]).toMatchObject({ artifact: { hash: candidateHash }, aggregate: 2, deltaVsBaseline: 1 });
  });

  it("reserved methods return NOT_IMPLEMENTED", async () => {
    const spawn = await client.callRaw("spawnRun", {
      subCapsuleId: "cap_ffffffffffff",
      budgetSlice: GENEROUS_BUDGET,
      maxDepth: 1,
    });
    expect(spawn.error?.data?.code).toBe("NOT_IMPLEMENTED");
    const corpus = await client.callRaw("queryCorpus", { query: "anything" });
    expect(corpus.error?.data?.code).toBe("NOT_IMPLEMENTED");
  });

  it("rejects malformed json with -32700 and unknown methods with -32601", async () => {
    const parseErr = await client.sendRawLine("this is not json");
    expect(parseErr.error?.code).toBe(-32700);
    const unknown = await client.callRaw("noSuchMethod");
    expect(unknown.error?.code).toBe(-32601);
    const badParams = await client.callRaw("exec", { sandboxId, argv: [] });
    expect(badParams.error?.code).toBe(-32602);
  });
});

describe("mutation sandbox isolation", () => {
  // saveArtifact is TERMINAL — the wire-protocol block above retired the
  // shared sandbox, so isolation probes run in a fresh one.
  let isoSandboxId: string;

  beforeAll(async () => {
    const ref = (await client.call("createSandbox", { artifact: { hash: baselineHash }, role: "mutation" })) as SandboxRef;
    isoSandboxId = ref.sandboxId;
  });

  it("retired the saved sandbox: exec on it now fails SANDBOX_NOT_FOUND", async () => {
    const res = await client.callRaw("exec", { sandboxId, argv: ["true"] });
    expect(res.error?.data?.code).toBe("SANDBOX_NOT_FOUND");
  });

  it("cannot read the protected/ capsule fixture", async () => {
    const attempts = [
      "/capsule/assets/protected/secret.txt",
      path.join(capsuleRootDir, "protected", "secret.txt"),
      "/capsule/assets/holdout/holdout.txt",
    ];
    for (const target of attempts) {
      const res = ExecShape.parse(await client.call("exec", { sandboxId: isoSandboxId, argv: ["cat", target] }));
      expect(res.exitCode, `should not be readable: ${target}`).not.toBe(0);
      expect(res.stdout).not.toContain("TOP-SECRET-FIXTURE");
      expect(res.stdout).not.toContain("holdout-data");
    }
  });

  it("has no network egress (wget to 1.1.1.1 fails)", async () => {
    const res = ExecShape.parse(
      await client.call("exec", {
        sandboxId: isoSandboxId,
        argv: ["wget", "-T", "3", "-q", "-O", "-", "http://1.1.1.1"],
        timeoutSec: 30,
      }),
    );
    expect(res.exitCode).not.toBe(0);
  });

  it("does not expose the docker socket", async () => {
    const res = ExecShape.parse(await client.call("exec", { sandboxId: isoSandboxId, argv: ["ls", "/var/run/docker.sock"] }));
    expect(res.exitCode).not.toBe(0);
  });
});

describe("evaluate memoization", () => {
  it("second identical evaluate is served from cache without spawning a container", async () => {
    const first = EvaluationRecord.parse(
      await client.call("evaluate", { artifact: { hash: candidateHash }, assetGroupId: "train", seed: 42 }),
    );
    expect(first.cached).toBe(false);
    const before = dockerRunCount;
    const budgetBefore = BudgetState.parse(await client.call("getBudget"));

    const second = EvaluationRecord.parse(
      await client.call("evaluate", { artifact: { hash: candidateHash }, assetGroupId: "train", seed: 42 }),
    );
    expect(second.cached).toBe(true);
    expect(second.output).toEqual(first.output);
    expect(dockerRunCount, "no docker run may happen for a memoized evaluate").toBe(before);

    const budgetAfter = BudgetState.parse(await client.call("getBudget"));
    expect(budgetAfter.spent.evaluatorInvocations).toBe(budgetBefore.spent.evaluatorInvocations);
  });
});

describe("protected path enforcement", () => {
  it("rejects evaluation of an artifact that modified a protected file", async () => {
    const ref = (await client.call("createSandbox", {
      artifact: { hash: baselineHash },
      role: "mutation",
    })) as SandboxRef;
    const write = ExecShape.parse(
      await client.call("exec", {
        sandboxId: ref.sandboxId,
        argv: ["sh", "-c", "echo hacked > /workspace/protected/frozen.txt"],
      }),
    );
    expect(write.exitCode).toBe(0);
    const tampered = (await client.call("saveArtifact", { sandboxId: ref.sandboxId })) as ArtifactRef;

    const resp = await client.callRaw("evaluate", { artifact: { hash: tampered.hash }, assetGroupId: "train", seed: 0 });
    expect(resp.error?.data?.code).toBe("PROTECTED_PATH_VIOLATION");
  });
});

describe("holdout gating", () => {
  it("refuses holdout evaluation on the client socket", async () => {
    const resp = await client.callRaw("evaluate", { artifact: { hash: candidateHash }, assetGroupId: "holdout", seed: 0 });
    expect(resp.error?.data?.code).toBe("HOLDOUT_ACCESS_DENIED");
    expect(mainEvents.filter((e) => e.type === "holdout.accessed")).toHaveLength(0);
  });

  it("allows holdout evaluation on the admin socket and emits holdout.accessed", async () => {
    const record = EvaluationRecord.parse(
      await admin.call("evaluate", { artifact: { hash: candidateHash }, assetGroupId: "holdout", seed: 0 }),
    );
    expect(record.output.valid).toBe(true);
    const accesses = mainEvents.filter((e) => e.type === "holdout.accessed");
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({ ledgerCount: 1, capsuleId: "cap_0123456789ab" });
  });

  it("hides recordSpend from the client socket", async () => {
    const resp = await client.callRaw("recordSpend", { tokens: 1, usd: 0 });
    expect(resp.error?.code).toBe(-32601);
  });
});

describe("budget enforcement", () => {
  it("rejects evaluations (and other methods) once evaluatorInvocations is exhausted", async () => {
    const events: RunEvent[] = [];
    const b = await bootBroker("evalcap", { ...GENEROUS_BUDGET, maxEvaluatorInvocations: 1 }, { events });
    const c = await RpcClient.connect(b.socketPath);
    try {
      const first = EvaluationRecord.parse(
        await c.call("evaluate", { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 100 }),
      );
      expect(first.cached).toBe(false);

      const second = await c.callRaw("evaluate", { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 101 });
      expect(second.error?.data?.code).toBe("BUDGET_EXCEEDED");

      const sandbox = await c.callRaw("createSandbox", { artifact: { hash: baselineHash }, role: "mutation" });
      expect(sandbox.error?.data?.code).toBe("BUDGET_EXCEEDED");

      const task = await c.callRaw("getTask");
      expect(task.error?.data?.code).toBe("BUDGET_EXCEEDED");

      // Observability survives exhaustion.
      const budget = BudgetState.parse(await c.call("getBudget"));
      expect(budget.spent.evaluatorInvocations).toBe(1);
      expect(events.some((e) => e.type === "budget.exhausted" && e.dimension === "evaluatorInvocations")).toBe(true);
    } finally {
      c.close();
      await b.close();
    }
  });

  it("recordSpend on the admin socket exhausts usd and blocks further evals", async () => {
    const b = await bootBroker("spendcap", { ...GENEROUS_BUDGET, maxUsd: 5 });
    const c = await RpcClient.connect(b.socketPath);
    const a = await RpcClient.connect(b.adminSocketPath);
    try {
      expect(await a.call("recordSpend", { tokens: 1234, usd: 5 })).toEqual({});
      const budget = BudgetState.parse(await c.call("getBudget"));
      expect(budget.spent.usd).toBe(5);
      expect(budget.spent.tokens).toBe(1234);

      const resp = await c.callRaw("evaluate", { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 200 });
      expect(resp.error?.data?.code).toBe("BUDGET_EXCEEDED");
    } finally {
      c.close();
      a.close();
      await b.close();
    }
  });
});

describe("sandbox lifecycle", () => {
  it("reaps sandboxes past their TTL", async () => {
    const ref = (await client.call("createSandbox", {
      artifact: { hash: baselineHash },
      role: "mutation",
      ttlSec: 1,
    })) as SandboxRef;
    clockOffsetMs += 5_000; // advance the injected broker clock past the TTL — no real wait
    const resp = await client.callRaw("exec", { sandboxId: ref.sandboxId, argv: ["true"] });
    expect(resp.error?.data?.code).toBe("SANDBOX_NOT_FOUND");
  });

  it("enforces the scratch quota", async () => {
    const b = await bootBroker("quota", GENEROUS_BUDGET, { scratchQuotaBytes: 4_096 });
    const c = await RpcClient.connect(b.socketPath);
    try {
      const ref = (await c.call("createSandbox", { artifact: { hash: baselineHash }, role: "mutation" })) as SandboxRef;
      const fill = ExecShape.parse(
        await c.call("exec", {
          sandboxId: ref.sandboxId,
          argv: ["dd", "if=/dev/zero", "of=/scratch/big.bin", "bs=1024", "count=64"],
        }),
      );
      expect(fill.exitCode).toBe(0);
      const over = await c.callRaw("createSandbox", { artifact: { hash: baselineHash }, role: "mutation" });
      expect(over.error?.data?.code).toBe("QUOTA_EXCEEDED");
    } finally {
      c.close();
      await b.close();
    }
  });

  it("sandboxNetwork: internal attaches mutation sandboxes to the named network; evals stay --network none", async () => {
    const netName = `hone-test-internal-${randomBytes(4).toString("hex")}`;
    const created = await runCommand(["docker", "network", "create", "--internal", netName]);
    expect(created.exitCode).toBe(0);
    const evalNetworks: string[] = [];
    const capturingRun: RunCommand = (argv, opts) => {
      if (argv[0] === "docker" && argv[1] === "run" && argv.includes("--rm")) {
        const flag = argv.indexOf("--network");
        evalNetworks.push(argv[flag + 1] ?? "missing");
      }
      return runCommand(argv, opts);
    };
    const b = await bootBroker("netmode", GENEROUS_BUDGET, {
      sandboxNetwork: { mode: "internal", network: netName },
      runCommand: capturingRun,
    });
    const c = await RpcClient.connect(b.socketPath);
    try {
      const ref = (await c.call("createSandbox", { artifact: { hash: baselineHash }, role: "mutation" })) as SandboxRef;
      const attached = await runCommand([
        "docker", "ps", "--filter", "label=hone.runId=run-netmode", "--format", "{{.Networks}}",
      ]);
      expect(attached.stdout.toString("utf8").trim()).toBe(netName);
      // --internal network: still no route to the outside world.
      const egress = ExecShape.parse(
        await c.call("exec", { sandboxId: ref.sandboxId, argv: ["wget", "-T", "3", "-q", "-O", "-", "http://1.1.1.1"], timeoutSec: 30 }),
      );
      expect(egress.exitCode).not.toBe(0);
      // Eval containers ignore sandboxNetwork entirely.
      await c.call("evaluate", { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 300 });
      expect(evalNetworks).toEqual(["none"]);
    } finally {
      c.close();
      await b.close();
      await runCommand(["docker", "network", "rm", netName]);
    }
  });

  it("finish records the best artifact", async () => {
    expect(await client.call("finish", { best: { hash: candidateHash } })).toEqual({});
  });
});

describe("production default surface (no admin endpoint exists at all)", () => {
  it("startBroker(config) exposes neither an admin socket nor a TCP listener", async () => {
    const { config, runDir } = await makeBrokerConfig("noadmin", GENEROUS_BUDGET);
    const b = await startBroker(config);
    try {
      expect(b.adminSocketPath).toBeUndefined();
      expect(b.publicTcpAddress).toBeUndefined();
      // Nothing admin-shaped on disk — a same-UID child finds no privileged endpoint.
      const entries = await readdir(runDir);
      expect(entries).toContain("broker.sock");
      expect(entries.some((e) => e.includes("admin"))).toBe(false);
      // Privileged methods are not even name-visible on the public socket.
      const c = await RpcClient.connect(b.socketPath);
      const resp = await c.callRaw("recordSpend", { tokens: 1, usd: 0 });
      expect(resp.error?.code).toBe(-32601);
      c.close();
    } finally {
      await b.close();
    }
  });
});

describe("opt-in authenticated public TCP listener", () => {
  it("binds {host,port:0}, returns the resolved address, and gates every request on the exact token before method lookup", async () => {
    const token = randomBytes(32).toString("hex");
    const { config } = await makeBrokerConfig("tcp", GENEROUS_BUDGET);
    const b = await startBroker(config, { publicTcp: { host: "127.0.0.1", port: 0, token } });
    try {
      expect(b.adminSocketPath).toBeUndefined();
      const addr = b.publicTcpAddress;
      if (!addr) throw new Error("publicTcpAddress missing");
      expect(addr.host).toBe("127.0.0.1");
      expect(addr.port).toBeGreaterThan(0);

      const good = await RpcClient.connectTcp(addr.host, addr.port, token);
      const task = GetTaskShape.parse(await good.call("getTask"));
      expect(task.baselineArtifact.hash).toBe(baselineHash);

      // Wrong token: refused with -32060 BEFORE any method lookup — an
      // unknown method probes the same -32060, never -32601.
      const wrong = await RpcClient.connectTcp(addr.host, addr.port, `${token.slice(0, 63)}${token.endsWith("0") ? "1" : "0"}`);
      const denied = await wrong.callRaw("getTask");
      expect(denied.error?.code).toBe(-32060);
      expect(denied.error?.message).toBe("unauthorized");
      expect((await wrong.callRaw("noSuchMethod")).error?.code).toBe(-32060);

      const missing = await RpcClient.connectTcp(addr.host, addr.port);
      expect((await missing.callRaw("getTask")).error?.code).toBe(-32060);

      // TCP is PUBLIC privilege only — admin methods stay invisible even authenticated.
      expect((await good.callRaw("recordSpend", { tokens: 1, usd: 0 })).error?.code).toBe(-32601);

      // The unix public socket is untouched: token-free requests still served.
      const unix = await RpcClient.connect(b.socketPath);
      GetTaskShape.parse(await unix.call("getTask"));

      good.close();
      wrong.close();
      missing.close();
      unix.close();
    } finally {
      await b.close();
    }
  });

  it("refuses a sub-256-bit token and tears the partial listeners back down", async () => {
    const { config, runDir } = await makeBrokerConfig("tcpshort", GENEROUS_BUDGET);
    await expect(startBroker(config, { publicTcp: { host: "127.0.0.1", port: 0, token: "short" } })).rejects.toThrow(/32 bytes/);
    // The public unix listener bound before the token check must not leak.
    await expect(RpcClient.connect(path.join(runDir, "broker.sock"))).rejects.toThrow();
  });
});

describe("eval asset confidentiality (live docker uid boundary)", () => {
  const SANDBOX_USER_IMAGE = "hone-test-busybox-sandbox:1.36";
  /** Probe entrypoint: reads the staged asset as root, then re-tries as the uid-2000 `sandbox` user. */
  const UID_PROBE_SCRIPT = [
    'R="$(cat /capsule/assets/train/data.txt 2>/dev/null || echo root-denied)"',
    "U=\"$(su sandbox -c 'cat /capsule/assets/train/data.txt' 2>/dev/null || echo uid2000-denied)\"",
    "L=\"$(su sandbox -c 'ls /capsule/assets' 2>/dev/null || echo uid2000-ls-denied)\"",
    'printf \'{"valid":true,"objectives":{"score":1},"perExample":{"ex1":{"score":1,"feedback":"root=%s uid=%s ls=%s"}}}\' "$R" "$U" "$L"',
  ].join("\n");

  it("the root evaluator reads staged assets; the uid-2000 candidate user can neither read nor enumerate them", async () => {
    const inspect = await runCommand(["docker", "image", "inspect", SANDBOX_USER_IMAGE]);
    if (inspect.exitCode !== 0) {
      const build = await runCommand(["docker", "build", "-t", SANDBOX_USER_IMAGE, "-"], {
        stdin: `FROM ${TEST_IMAGE}\nRUN adduser -D -H -u 2000 sandbox\n`,
        timeoutMs: 240_000,
      });
      if (build.exitCode !== 0) throw new Error(`sandbox-user image build failed: ${build.stderr.toString("utf8")}`);
    }
    const b = await bootBroker("uiddenial", GENEROUS_BUDGET, {
      image: SANDBOX_USER_IMAGE,
      evalEntrypoint: ["sh", "-c", UID_PROBE_SCRIPT],
    });
    const c = await RpcClient.connect(b.socketPath);
    try {
      // Suite-unique seed: the memo index lives in the SHARED test CAS and is
      // keyed by digests+artifact+group+seed, not by the eval entrypoint.
      const rec = EvaluationRecord.parse(
        await c.call("evaluate", { artifact: { hash: baselineHash }, assetGroupId: "train", seed: 424242 }),
      );
      expect(rec.output.valid).toBe(true);
      expect(rec.output.perExample["ex1"]?.feedback).toBe("root=train-data uid=uid2000-denied ls=uid2000-ls-denied");
      // The per-eval staging copy never outlives the evaluation.
      const tmpEntries = await readdir(path.join(tmpBase, "runs", "uiddenial", "tmp"));
      expect(tmpEntries.filter((e) => e.startsWith("assets-"))).toHaveLength(0);
    } finally {
      c.close();
      await b.close();
    }
  }, 300_000);
});

describe("quiescent close under live in-flight work", () => {
  it("close() aborts a sleeping exec's container, drains the handler, and refuses the socket afterwards", async () => {
    const b = await bootBroker("quiesce", GENEROUS_BUDGET);
    const c = await RpcClient.connect(b.socketPath);
    const ref = (await c.call("createSandbox", { artifact: { hash: baselineHash }, role: "mutation" })) as SandboxRef;

    const slow = c.callRaw("exec", { sandboxId: ref.sandboxId, argv: ["sleep", "600"], timeoutSec: 590 });
    // Yield event-loop turns (no wall-clock wait) until the server accounts
    // the exec handler as in flight — then close() must drain THROUGH it.
    while (b.server.stats.inFlight === 0) {
      const turn = deferred<void>();
      setImmediate(turn.resolve);
      await turn.promise;
    }

    // The test timeout is far below `sleep 600`: close() returning at all
    // proves the container was aborted rather than waited out.
    await b.close();

    // The drained handler settled its frame before teardown (or the teardown
    // closed the socket) — either way the client is released, never deadlocked.
    await Promise.race([slow, c.closed]);
    await expect(RpcClient.connect(b.socketPath)).rejects.toThrow();
    c.close();
  }, 120_000);
});
