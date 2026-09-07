import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Broker, journalIo, type BrokerConfig } from "../src/broker.js";
import { CasStore } from "../src/cas.js";
import { packDirAsArtifact } from "../src/artifact.js";
import type { CmdResult, RunCommand } from "../src/command.js";
import { TEST_CAPSULE_DIGEST, TEST_IMAGE, TEST_OPTIMIZER_DIGEST, buildTestCapsule } from "./helpers.js";

// ---------------------------------------------------------------------------
// Journal durability residual: a partial write/fsync failure used to leave the
// RunStateLog writer usable, so the NEXT append fused onto the torn tail and
// authority could be acknowledged over a corrupt journal. The writer must be
// permanently poisoned on the first append failure; only a restart — whose
// open() durably truncates the unterminated tail — may write again.
// ---------------------------------------------------------------------------

const BUDGET = { maxTokens: 1_000_000, maxUsd: 100, maxWallClockSec: 3_600, maxEvaluatorInvocations: 100 };

async function makeConfig(base: string): Promise<BrokerConfig> {
  const capsule = await buildTestCapsule(base, BUDGET);
  const runDir = path.join(base, "run");
  await mkdir(runDir, { recursive: true });
  return {
    runId: "run_journal_poison",
    manifest: capsule.manifest,
    capsuleRootDir: capsule.capsuleRootDir,
    baselineArtifactHash: `sha256:${"0".repeat(64)}`,
    capsuleDigest: TEST_CAPSULE_DIGEST,
    optimizerDigest: TEST_OPTIMIZER_DIGEST,
    holdoutLedgerPath: path.join(runDir, "holdout-ledger.ndjson"),
    image: TEST_IMAGE,
    runDir,
    casDir: path.join(base, "cas"),
    onEvent: () => {},
  };
}

const journalPath = (config: BrokerConfig): string => path.join(config.runDir, "broker-state.ndjson");

describe("RunStateLog append-failure poisoning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a partial write poisons the writer; restart truncates the torn tail and replays only intact facts", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-journal-"));
    const config = await makeConfig(base);
    const broker = new Broker(config);

    const origWrite = journalIo.write;
    const writeSpy = vi.spyOn(journalIo, "write").mockImplementationOnce((fd, buf, offset, length) => {
      // Simulate ENOSPC mid-line: a torn, non-newline-terminated prefix
      // reaches the file, then the write fails.
      origWrite(fd, buf, offset, Math.min(7, length));
      throw new Error("ENOSPC: injected partial write");
    });

    expect(() => broker.recordSpend({ tokens: 5, usd: 0 }, { privileged: true })).toThrow(
      /run state log append failed: ENOSPC/,
    );
    // Permanently poisoned: the next append is rejected BEFORE any byte could
    // fuse onto the torn tail.
    const writesAfterFailure = writeSpy.mock.calls.length;
    expect(() => broker.recordSpend({ tokens: 1, usd: 0 }, { privileged: true })).toThrow(
      /unusable after append failure/,
    );
    expect(writeSpy.mock.calls.length).toBe(writesAfterFailure);
    vi.restoreAllMocks();

    // The poisoned writer already closed its fd; close() must not double-close.
    await broker.close();
    const torn = await readFile(journalPath(config), "utf8");
    expect(torn.endsWith("\n")).toBe(false); // torn tail present on disk

    // Restart: the tail is durably truncated, every surviving line is intact
    // JSON, the un-acknowledged spend never happened, and appends work again.
    const second = new Broker(config);
    expect(second.getBudget({ privileged: true }).spent.tokens).toBe(0);
    second.recordSpend({ tokens: 2, usd: 0 }, { privileged: true });
    await second.close();
    const healed = await readFile(journalPath(config), "utf8");
    expect(healed.endsWith("\n")).toBe(true);
    for (const line of healed.split("\n").filter((l) => l.length > 0)) JSON.parse(line);
    expect(healed).not.toContain('"tokens":5');
    expect(healed).toContain('"tokens":2');
  });

  it("an fsync failure poisons the writer; the newline-terminated line replays after restart (budgets never rewind)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-journal-"));
    const config = await makeConfig(base);
    const broker = new Broker(config);

    vi.spyOn(journalIo, "fsync").mockImplementationOnce(() => {
      throw new Error("EIO: injected fsync failure");
    });
    expect(() => broker.recordSpend({ tokens: 5, usd: 0 }, { privileged: true })).toThrow(
      /run state log append failed: EIO/,
    );
    expect(() => broker.recordSpend({ tokens: 1, usd: 0 }, { privileged: true })).toThrow(
      /unusable after append failure/,
    );
    vi.restoreAllMocks();
    await broker.close();

    // The line was fully written (write-ahead): replay keeps the spend, so a
    // restart can only ever see MORE consumed budget, never less.
    const reopenOrder: string[] = [];
    const origFsync = journalIo.fsync;
    const origWrite = journalIo.write;
    vi.spyOn(journalIo, "fsync").mockImplementation((fd) => {
      reopenOrder.push("fsync");
      origFsync(fd);
    });
    vi.spyOn(journalIo, "write").mockImplementation((fd, buf, offset, length) => {
      reopenOrder.push("write");
      return origWrite(fd, buf, offset, length);
    });
    const second = new Broker(config);
    expect(reopenOrder[0]).toBe("fsync");
    expect(second.getBudget({ privileged: true }).spent.tokens).toBe(5);
    await second.close();
  });

  it("open() closes its fd on every post-open failure (corrupt journal never leaks descriptors)", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-journal-"));
    const config = await makeConfig(base);
    await writeFile(journalPath(config), "this is not json\n");

    // /dev/fd enumerates this process's open descriptors on macOS and Linux.
    const fdCount = (): number => readdirSync("/dev/fd").length;
    const before = fdCount();
    for (let i = 0; i < 20; i++) {
      expect(() => new Broker(config)).toThrow(/run state log corrupt at line 1/);
    }
    expect(fdCount()).toBeLessThanOrEqual(before + 1); // a leak would show +20
  });

  it("every open fsyncs the journal and parent directory before replay or append", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-journal-"));
    const config = await makeConfig(base);

    const order: string[] = [];
    const origFsync = journalIo.fsync;
    const origSyncDir = journalIo.syncDir;
    const origWrite = journalIo.write;
    vi.spyOn(journalIo, "fsync").mockImplementation((fd) => {
      order.push("fsync");
      origFsync(fd);
    });
    vi.spyOn(journalIo, "syncDir").mockImplementation((dir) => {
      order.push(`syncDir:${path.basename(dir)}`);
      origSyncDir(dir);
    });
    vi.spyOn(journalIo, "write").mockImplementation((fd, buf, offset, length) => {
      order.push("write");
      return origWrite(fd, buf, offset, length);
    });

    const broker = new Broker(config);
    expect(order.slice(0, 3)).toEqual(["fsync", "syncDir:run", "write"]);
    await broker.close();

    order.length = 0;
    const second = new Broker(config);
    expect(order).toEqual(["fsync", "syncDir:run"]);
    await second.close();
  });

  it("a failed first directory sync is re-established on reopen before any append", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-journal-"));
    const config = await makeConfig(base);
    vi.spyOn(journalIo, "syncDir").mockImplementationOnce(() => {
      throw new Error("EIO: injected directory fsync failure");
    });
    expect(() => new Broker(config)).toThrow(/injected directory fsync failure/);
    vi.restoreAllMocks();

    const order: string[] = [];
    const origSyncDir = journalIo.syncDir;
    const origWrite = journalIo.write;
    vi.spyOn(journalIo, "syncDir").mockImplementation((dir) => {
      order.push("syncDir");
      origSyncDir(dir);
    });
    vi.spyOn(journalIo, "write").mockImplementation((fd, buf, offset, length) => {
      order.push("write");
      return origWrite(fd, buf, offset, length);
    });
    const reopened = new Broker(config);
    expect(order[0]).toBe("syncDir");
    expect(order.indexOf("write")).toBeGreaterThan(0);
    await reopened.close();
  });

  it("a poisoned journal rejects EVERY new operation before any staging/CAS/Docker side effect", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-journal-"));
    const dockerCalls: string[][] = [];
    const config = await makeConfig(base);
    const gated: typeof config = {
      ...config,
      runCommand: (argv) => {
        dockerCalls.push([...argv]);
        return Promise.resolve({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false });
      },
    };
    const broker = new Broker(gated);
    vi.spyOn(journalIo, "fsync").mockImplementationOnce(() => {
      throw new Error("EIO: injected fsync failure");
    });
    expect(() => broker.recordSpend({ tokens: 1, usd: 0 }, { privileged: true })).toThrow(/append failed/);
    vi.restoreAllMocks();

    // Metered sync method: refused at the budget gate.
    expect(() => broker.getTask({ privileged: false })).toThrow(/unusable after append failure/);
    // Async ops: refused at admission — no container spawn, no asset staging,
    // no CAS write may begin for work that could never be acknowledged.
    await expect(
      broker.evaluate({ artifact: { hash: `sha256:${"1".repeat(64)}` }, assetGroupId: "train", seed: 1 }, { privileged: false }),
    ).rejects.toThrow(/unusable after append failure/);
    await expect(
      broker.createSandbox({ artifact: { hash: `sha256:${"1".repeat(64)}` }, role: "mutation" }, { privileged: false }),
    ).rejects.toThrow(/unusable after append failure/);
    expect(dockerCalls).toHaveLength(0);
    // Observability and teardown stay reachable.
    expect(broker.getBudget({ privileged: true }).spent.tokens).toBe(0);
    await broker.close();
  });
});

describe("createSandbox under journal failure (no ack, no leak, no unbounded creates)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function okRes(overrides: Partial<CmdResult> = {}): CmdResult {
    return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false, ...overrides };
  }

  interface CreateHarness {
    broker: Broker;
    baselineHash: string;
    calls: string[][];
  }

  async function makeCreateHarness(failRm: boolean, failUnpack: boolean): Promise<CreateHarness> {
    const base = await mkdtemp(path.join(os.tmpdir(), "hone-create-poison-"));
    const config = await makeConfig(base);
    const cas = new CasStore(config.casDir);
    const baselineHash = await packDirAsArtifact(path.join(base, "baseline"), cas);
    const calls: string[][] = [];
    const run: RunCommand = (argv) => {
      calls.push([...argv]);
      if (argv[0] !== "docker") return Promise.resolve(okRes());
      if (argv[1] === "run") return Promise.resolve(okRes({ stdout: Buffer.from("cid-1\n") }));
      if (argv[1] === "exec" && failUnpack) return Promise.resolve(okRes({ exitCode: 1, stderr: Buffer.from("unpack boom") }));
      if (argv[1] === "rm" && failRm) return Promise.resolve(okRes({ exitCode: 1, stderr: Buffer.from("driver busy") }));
      return Promise.resolve(okRes());
    };
    return { broker: new Broker({ ...config, runCommand: run }), baselineHash, calls };
  }

  it("a journal append failure during create rolls the container back with rm proof and refuses further creates", async () => {
    const h = await makeCreateHarness(false, false);
    // Poison exactly the episode fact's fsync (the constructor's start fact
    // already flushed before the spy is installed).
    vi.spyOn(journalIo, "fsync").mockImplementationOnce(() => {
      throw new Error("ENOSPC: injected fsync failure");
    });
    await expect(
      h.broker.createSandbox({ artifact: { hash: h.baselineHash }, role: "mutation" }, { privileged: false }),
    ).rejects.toThrow(/run state log append failed/);
    // The spawned container was reaped — never acknowledged, never leaked.
    expect(h.calls.some((c) => c[0] === "docker" && c[1] === "rm" && c[2] === "-f" && c[3] === "cid-1")).toBe(true);
    vi.restoreAllMocks();

    // Poisoned journal: repeated creates are refused at admission BEFORE any
    // docker call — no unbounded launch loop against a dead journal.
    const dockerCallsAfter = h.calls.length;
    for (let i = 0; i < 3; i++) {
      await expect(
        h.broker.createSandbox({ artifact: { hash: h.baselineHash }, role: "mutation" }, { privileged: false }),
      ).rejects.toThrow(/unusable after append failure/);
    }
    expect(h.calls.length).toBe(dockerCallsAfter);

    // Nothing tracked survives: teardown completes without live containers.
    await h.broker.close();
  });

  it("an unpack failure whose container removal cannot be proven fails loudly and stays tracked for close()", async () => {
    const h = await makeCreateHarness(true, true);
    await expect(
      h.broker.createSandbox({ artifact: { hash: h.baselineHash }, role: "mutation" }, { privileged: false }),
    ).rejects.toThrow(/cleanup unproven.*unpack boom/);
    // Fail closed at close() too: the unremovable container is still owned.
    await expect(h.broker.close()).rejects.toThrow(/containers still live: cid-1/);
  });
});
