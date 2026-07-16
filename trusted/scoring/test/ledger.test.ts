import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HoldoutLedger, HoldoutBudgetExceededError } from "../src/index.js";
import { ledgerIo } from "../src/ledger.js";

const tmpDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hone-ledger-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fileLines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("holdout ledger — hard lifetime budget, append order is the authority", () => {
  it("charges monotonically and reports { count, budget } for the holdout.accessed event", async () => {
    const ledger = await HoldoutLedger.open(join(tmp(), "holdout.ledger"), { budget: 3 });
    expect(ledger.state()).toEqual({ count: 0, budget: 3 });
    expect(await ledger.charge()).toEqual({ count: 1, budget: 3 });
    expect(await ledger.charge()).toEqual({ count: 2, budget: 3 });
    expect(ledger.state()).toEqual({ count: 2, budget: 3 });
    await ledger.close();
  });

  it("writes a v2 header and refuses charge #N+1 past budget — a known-full ledger appends nothing", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 2 });
    await ledger.charge();
    await ledger.charge();
    await expect(ledger.charge()).rejects.toThrow(HoldoutBudgetExceededError);
    await ledger.close();
    const lines = fileLines(path);
    expect(lines).toHaveLength(3); // header + 2 attempts; the locally-known-full denial wrote nothing
    expect(JSON.parse(lines[0]!)).toEqual({ v: 2, budget: 2 });
    const nonces = lines.slice(1).map((l) => JSON.parse(l).nonce as string);
    expect(new Set(nonces).size).toBe(2); // one unique nonce per attempt
  });

  it("survives a process 'crash': re-open mid-test and the count persists; budget still binds", async () => {
    const path = join(tmp(), "holdout.ledger");
    const first = await HoldoutLedger.open(path, { budget: 3 });
    await first.charge();
    await first.charge();
    // 'crash': no close(), just abandon the handle and re-open from disk.
    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 2, budget: 3 });
    expect(await reopened.charge()).toEqual({ count: 3, budget: 3 });
    await expect(reopened.charge()).rejects.toThrow(HoldoutBudgetExceededError);
    await reopened.close();
    await first.close();

    // And once more: budget refusal survives yet another re-open.
    const third = await HoldoutLedger.open(path);
    await expect(third.charge()).rejects.toThrow(HoldoutBudgetExceededError);
    await third.close();
  });

  it("two independently opened instances racing the final slot: it is granted exactly once", async () => {
    const path = join(tmp(), "holdout.ledger");
    const a = await HoldoutLedger.open(path, { budget: 1 });
    const b = await HoldoutLedger.open(path); // second handle, own view — as a second broker process would hold
    const results = await Promise.allSettled([a.charge(), b.charge()]);
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(granted).toEqual([{ count: 1, budget: 1 }]); // exactly ONE winner
    const denied = results.filter((r) => r.status === "rejected");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toBeInstanceOf(HoldoutBudgetExceededError);
    // Both attempts are on disk: the loser's line REMAINS as a durable denial record.
    expect(fileLines(path)).toHaveLength(3); // header + winner + denial record
    await a.close();
    await b.close();
  });

  it("interleaved charges across two instances grant each ordinal exactly once, up to budget", async () => {
    const path = join(tmp(), "holdout.ledger");
    const a = await HoldoutLedger.open(path, { budget: 3 });
    const b = await HoldoutLedger.open(path, { budget: 3 });
    const results = await Promise.allSettled([
      a.charge(), b.charge(), a.charge(), b.charge(), a.charge(), b.charge(),
    ]);
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.count] : []));
    expect(granted.sort((x, y) => x - y)).toEqual([1, 2, 3]); // each slot granted once across BOTH handles
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(HoldoutBudgetExceededError);
    }
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    await a.close();
    await b.close();

    // Replay from disk: attempts may exceed budget (denial records), count clamps.
    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 3, budget: 3 });
    await reopened.close();
  });

  it("over-budget denial records persist across reopen: count clamps at budget, refusal still binds", async () => {
    const path = join(tmp(), "holdout.ledger");
    const a = await HoldoutLedger.open(path, { budget: 1 });
    const b = await HoldoutLedger.open(path);
    await Promise.allSettled([a.charge(), b.charge()]); // one grant + one durable denial record
    await a.close();
    await b.close();
    expect(fileLines(path)).toHaveLength(3);

    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 1, budget: 1 }); // clamped: 2 attempts, 1 grant
    await expect(reopened.charge()).rejects.toThrow(HoldoutBudgetExceededError);
    await reopened.close();
    expect(fileLines(path)).toHaveLength(3); // known-full refusal appended nothing; the denial record remains
  });

  it("concurrent fresh opens race no-clobber publication: the loser recovers the winner's initialized ledger", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    const [a, b] = await Promise.all([
      HoldoutLedger.open(path, { budget: 2 }),
      HoldoutLedger.open(path, { budget: 2 }),
    ]);
    expect(a.state()).toEqual({ count: 0, budget: 2 });
    expect(b.state()).toEqual({ count: 0, budget: 2 });
    // Exactly ONE header was published; winner and loser both cleaned their own temps.
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":2}\n');
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // Both handles charge against the SAME shared order.
    const results = await Promise.allSettled([a.charge(), b.charge(), a.charge(), b.charge()]);
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.count] : []));
    expect(granted.sort((x, y) => x - y)).toEqual([1, 2]);
    await a.close();
    await b.close();
  });

  it("rejects opening a fresh ledger without a budget, and a budget mismatch on re-open", async () => {
    const path = join(tmp(), "holdout.ledger");
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/budget/i);
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    await ledger.close();
    await expect(HoldoutLedger.open(path, { budget: 4 })).rejects.toThrow(/mismatch/i);
  });

  it("fails closed on a torn (non-newline-terminated) tail — the ledger never reinterprets torn bytes", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 5 });
    await ledger.charge();
    await ledger.close();
    appendFileSync(path, '{"nonce":"aaaa","at":"2026'); // crash mid-write: no newline
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/torn/i);
  });

  it("fails closed on a corrupt interior line — the ledger never guesses", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    await ledger.charge();
    await ledger.close();
    appendFileSync(path, "garbage-line\n" + '{"nonce":"bbbb","at":"2026-07-14T12:00:00.000Z"}\n');
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/corrupt/i);
  });

  it("fails closed on a duplicate nonce — ordinal ownership must be unambiguous", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    await ledger.charge();
    await ledger.close();
    const existing = JSON.parse(fileLines(path)[1]!) as { nonce: string };
    appendFileSync(path, `${JSON.stringify({ nonce: existing.nonce, at: "2026-07-14T12:00:00.000Z" })}\n`);
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/duplicate nonce/i);
  });

  it("fails closed on malformed UTF-8 — never decoded permissively", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    await ledger.close();
    appendFileSync(path, Buffer.concat([Buffer.from('{"nonce":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","at":"x"}\n')]));
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/UTF-8/i);
  });

  it("fails closed when its own durable append is missing on reread (ledger file swapped underneath)", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 2 });
    // Swap the file: the open O_APPEND handle now points at an orphaned inode,
    // so the reread can never find the charge's own line.
    unlinkSync(path);
    writeFileSync(path, '{"v":2,"budget":2}\n');
    await expect(ledger.charge()).rejects.toThrow(/own charge line/i);
    await ledger.close();
  });

  it("rejects a v1 ledger file — the format version is part of the fail-closed surface", async () => {
    const path = join(tmp(), "holdout.ledger");
    writeFileSync(path, '{"v":1,"budget":3}\n');
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/corrupt header/i);
  });

  it("serializes concurrent charges on one instance — the last slot is never double-granted", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.charge()));
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.count] : []));
    expect(granted.sort((x, y) => x - y)).toEqual([1, 2, 3]);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(HoldoutBudgetExceededError);
    }
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(7);
    await ledger.close();

    // The on-disk ledger replays cleanly: header + exactly 3 attempt lines.
    expect(fileLines(path)).toHaveLength(4);
    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 3, budget: 3 });
    await reopened.close();
  });
});

describe("holdout ledger directory-chain durability — every opener confirms it, power loss never orphans a charge", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Record every ledgerIo call, in COMPLETION order, delegating to the real fsyncs. */
  function recordIo(): string[] {
    const ops: string[] = [];
    const origDir = ledgerIo.syncDir;
    const origFile = ledgerIo.syncFile;
    vi.spyOn(ledgerIo, "syncDir").mockImplementation(async (d) => {
      await origDir(d);
      ops.push(`dir:${d}`);
    });
    vi.spyOn(ledgerIo, "syncFile").mockImplementation(async (f) => {
      await origFile(f);
      ops.push(`file:${f}`);
    });
    return ops;
  }

  it("fresh create builds and fsyncs the whole chain leaf-first through the durable root's parent — header durable BEFORE the first dirent sync", async () => {
    const root = tmp();
    const casDir = join(root, ".hone-cas");
    const ledgersDir = join(casDir, "ledgers");
    const ledgerPath = join(ledgersDir, "holdout.ndjson");

    const ops: string[] = [];
    const origDir = ledgerIo.syncDir;
    vi.spyOn(ledgerIo, "syncDir").mockImplementation(async (d) => {
      if (ops.length === 0) {
        // Write-ahead proof: at the moment of the FIRST directory sync the
        // header line is already complete on disk (appended + fsynced).
        expect(readFileSync(ledgerPath, "utf8")).toBe('{"v":2,"budget":2}\n');
      }
      await origDir(d);
      ops.push(d);
    });

    // No mkdir here: open() itself must create .hone-cas/ledgers.
    const ledger = await HoldoutLedger.open(ledgerPath, { budget: 2, durableRoot: casDir });
    expect(ops).toEqual([ledgersDir, casDir, root]); // leaf first, through the root's PARENT
    expect(await ledger.charge()).toEqual({ count: 1, budget: 2 });
    await ledger.close();
  });

  it("EVERY re-open re-establishes bytes + full chain durability (repeated open/replay), and works on a pre-created tree", async () => {
    const root = tmp();
    const casDir = join(root, ".hone-cas");
    const ledgersDir = join(casDir, "ledgers");
    const ledgerPath = join(ledgersDir, "holdout.ndjson");
    // Existing pre-created tree: the opener created none of these levels and
    // must STILL sync them — their creator may never have fsynced anything.
    mkdirSync(ledgersDir, { recursive: true });

    const ops = recordIo();
    const first = await HoldoutLedger.open(ledgerPath, { budget: 3, durableRoot: casDir });
    expect(ops).toEqual([`dir:${ledgersDir}`, `dir:${casDir}`, `dir:${root}`]);
    await first.charge();
    await first.close();

    for (let i = 2; i <= 3; i += 1) {
      ops.length = 0;
      const reopened = await HoldoutLedger.open(ledgerPath, { budget: 3, durableRoot: casDir });
      // Bytes first (the creator may have crashed before ITS fsync), then the chain leaf-first.
      expect(ops).toEqual([`file:${ledgerPath}`, `dir:${ledgersDir}`, `dir:${casDir}`, `dir:${root}`]);
      expect(reopened.state()).toEqual({ count: i - 1, budget: 3 });
      expect(await reopened.charge()).toEqual({ count: i, budget: 3 });
      await reopened.close();
    }
  });

  it("without durableRoot the chain still covers the ledger dir and its parent", async () => {
    const dir = tmp();
    const ops = recordIo();
    const ledger = await HoldoutLedger.open(join(dir, "holdout.ledger"), { budget: 1 });
    expect(ops).toEqual([`dir:${dir}`, `dir:${dirname(dir)}`]);
    await ledger.close();
  });

  it("winner paused before its dirent syncs: a loser that observes the complete header syncs the chain ITSELF before its open resolves or charges", async () => {
    const root = tmp();
    const casDir = join(root, ".hone-cas");
    const ledgersDir = join(casDir, "ledgers");
    const ledgerPath = join(ledgersDir, "holdout.ndjson");

    let releaseWinner!: () => void;
    const winnerGate = new Promise<void>((r) => {
      releaseWinner = r;
    });
    let winnerParked!: () => void;
    const parked = new Promise<void>((r) => {
      winnerParked = r;
    });

    const events: string[] = [];
    const origDir = ledgerIo.syncDir;
    const origFile = ledgerIo.syncFile;
    let dirCalls = 0;
    vi.spyOn(ledgerIo, "syncDir").mockImplementation(async (d) => {
      dirCalls += 1;
      if (dirCalls === 1) {
        // The winner's FIRST chain sync: header already durable, dirents not
        // confirmed. Park it here — the power-loss window.
        winnerParked();
        await winnerGate;
      }
      await origDir(d);
      events.push(`dir:${d}`);
    });
    vi.spyOn(ledgerIo, "syncFile").mockImplementation(async (f) => {
      await origFile(f);
      events.push(`file:${f}`);
    });

    const winnerOpen = HoldoutLedger.open(ledgerPath, { budget: 2, durableRoot: casDir });
    await parked; // header on disk, winner frozen before ANY dirent sync

    const loser = await HoldoutLedger.open(ledgerPath, { budget: 2, durableRoot: casDir });
    events.push("loser.open.resolved");
    // The loser must NOT have trusted the parked winner: its own open
    // re-established bytes + full-chain durability before resolving.
    expect(events).toEqual([
      `file:${ledgerPath}`,
      `dir:${ledgersDir}`,
      `dir:${casDir}`,
      `dir:${root}`,
      "loser.open.resolved",
    ]);
    // Only now may the loser charge — the dirents its charge depends on are durable.
    expect(await loser.charge()).toEqual({ count: 1, budget: 2 });

    releaseWinner();
    const winner = await winnerOpen;
    expect(await winner.charge()).toEqual({ count: 2, budget: 2 });
    await loser.close();
    await winner.close();
  });

  it("kill before the chain sync (parent dirent lost): the open never resolves as success, and a replay recreates the chain from nothing", async () => {
    const root = tmp();
    const casDir = join(root, ".hone-cas");
    const ledgersDir = join(casDir, "ledgers");
    const ledgerPath = join(ledgersDir, "holdout.ndjson");

    // Injected kill: the process dies in the window between the durable
    // header append and the first dirent sync.
    vi.spyOn(ledgerIo, "syncDir").mockImplementation(async () => {
      throw new Error("injected power loss");
    });
    await expect(HoldoutLedger.open(ledgerPath, { budget: 2, durableRoot: casDir })).rejects.toThrow(
      /injected power loss/,
    );

    // Power loss discards the never-synced dirents: the WHOLE chain is gone.
    rmSync(casDir, { recursive: true, force: true });
    vi.restoreAllMocks();

    // Replay: open() rebuilds .hone-cas/ledgers and syncs it before accepting.
    const ops = recordIo();
    const ledger = await HoldoutLedger.open(ledgerPath, { budget: 2, durableRoot: casDir });
    expect(ops).toEqual([`dir:${ledgersDir}`, `dir:${casDir}`, `dir:${root}`]);
    expect(await ledger.charge()).toEqual({ count: 1, budget: 2 });
    await ledger.close();
  });

  it("rejects a durableRoot that is not an ancestor of the ledger dir — before creating anything", async () => {
    const root = tmp();
    const ledgerPath = join(root, "a", "holdout.ndjson");
    await expect(
      HoldoutLedger.open(ledgerPath, { budget: 1, durableRoot: join(root, "elsewhere") }),
    ).rejects.toThrow(/escapes durable root/);
    expect(existsSync(join(root, "a"))).toBe(false); // fails closed before any I/O
  });
});

describe("holdout ledger atomic publication & legacy crash repair — a crash at any phase never bricks resume", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const tempFiles = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

  it("legacy empty final (crash after O_EXCL create, before header): budgetless reopen refuses recoverably, budgeted reopen repairs one exact header and charges persist", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    writeFileSync(path, ""); // the old creator crashed between open('ax') and its header write
    // Without a budget the leftover is a RECOVERABLE refusal — never an accepted empty ledger.
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/explicit budget/i);
    expect(readFileSync(path, "utf8")).toBe(""); // refusal mutated nothing
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":3}\n'); // ONE exact header
    expect(tempFiles(dir)).toEqual([]); // in-place repair creates no temp
    expect(await ledger.charge()).toEqual({ count: 1, budget: 3 });
    await ledger.close();
    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 1, budget: 3 }); // subsequent charges persisted
    await reopened.close();
  });

  it("every crashed header write prefix (all truncation points, including complete-sans-newline) repairs to the same exact header", async () => {
    const header = '{"v":2,"budget":3}';
    for (let len = 1; len <= header.length; len += 1) {
      const dir = tmp();
      const path = join(dir, "holdout.ledger");
      writeFileSync(path, header.slice(0, len));
      const ledger = await HoldoutLedger.open(path, { budget: 3 });
      expect(readFileSync(path, "utf8")).toBe(`${header}\n`);
      expect(tempFiles(dir)).toEqual([]);
      expect(await ledger.charge()).toEqual({ count: 1, budget: 3 });
      await ledger.close();
    }
  });

  it("a crash after repair but before chain durability is confirmed: open fails, replay adopts the repaired header", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    writeFileSync(path, '{"v":2,"bud');
    // Injected crash: the repair itself completes, but the process dies in
    // the adopt path before chain durability is confirmed — open MUST fail,
    // and the repaired header MUST still be recoverable on replay.
    const err = new Error("injected power loss after repair");
    vi.spyOn(ledgerIo, "syncDir").mockImplementation(async () => {
      throw err;
    });
    await expect(HoldoutLedger.open(path, { budget: 3 })).rejects.toThrow(/injected power loss/);
    vi.restoreAllMocks();
    // On-disk state after the 'crash' is a complete header or a longer prefix — never garbage.
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":3}\n');
    expect(await ledger.charge()).toEqual({ count: 1, budget: 3 });
    await ledger.close();
  });

  it("refuses a crashed prefix that pins a DIFFERENT budget — identities never overwrite each other", async () => {
    const path = join(tmp(), "holdout.ledger");
    writeFileSync(path, '{"v":2,"budget":7');
    await expect(HoldoutLedger.open(path, { budget: 5 })).rejects.toThrow(/mismatch/i);
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":7'); // refusal mutated nothing
    const ledger = await HoldoutLedger.open(path, { budget: 7 }); // the pinned identity still repairs
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":7}\n');
    await ledger.close();
  });

  it("refuses any other malformed headerless file, even with a budget — repair only touches provable header prefixes", async () => {
    for (const junk of ["garbage", '{"v":1,"budget":3', '{"v":2,"budget":03', '{"v":2,"budget":3}}', '{"v":2,"budget":x']) {
      const path = join(tmp(), "holdout.ledger");
      writeFileSync(path, junk);
      await expect(HoldoutLedger.open(path, { budget: 3 })).rejects.toThrow(/corrupt/i);
      expect(readFileSync(path, "utf8")).toBe(junk); // refusal mutated nothing
    }
    // Headerless invalid UTF-8 is refused too, never treated as a prefix.
    const path = join(tmp(), "holdout.ledger");
    writeFileSync(path, Buffer.from([0xc3, 0x28]));
    await expect(HoldoutLedger.open(path, { budget: 3 })).rejects.toThrow(/corrupt/i);
  });

  it("a crashed creator's orphan temps (write prefix AND fully-fsynced) never block creation, and recovery adds no temp growth", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    // crash after a temp write prefix: final absent, orphan temp holds partial header bytes
    writeFileSync(`${path}.dead-partial.tmp`, '{"v":2,"bud');
    // crash after the full temp write + fsync, before the publication link
    writeFileSync(`${path}.dead-full.tmp`, '{"v":2,"budget":3}\n');
    expect(tempFiles(dir)).toHaveLength(2);
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":3}\n');
    expect(tempFiles(dir)).toHaveLength(2); // own temp cleaned; foreign temps untouched (may be live contenders)
    expect(await ledger.charge()).toEqual({ count: 1, budget: 3 });
    await ledger.close();
    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 1, budget: 3 });
    await reopened.close();
    expect(tempFiles(dir)).toHaveLength(2); // still zero growth across reopen
  });

  it("crash before the publication link: the final path stays ABSENT (recoverable), own temp cleaned, replay creates from scratch", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    vi.spyOn(ledgerIo, "linkNoClobber").mockImplementation(async () => {
      throw new Error("injected crash at publication");
    });
    await expect(HoldoutLedger.open(path, { budget: 2 })).rejects.toThrow(/injected crash/);
    expect(existsSync(path)).toBe(false); // the final pathname was never exposed
    expect(tempFiles(dir)).toEqual([]); // own temp cleaned on the failure path
    vi.restoreAllMocks();
    const ledger = await HoldoutLedger.open(path, { budget: 2 });
    expect(await ledger.charge()).toEqual({ count: 1, budget: 2 });
    await ledger.close();
  });

  it("crash between the publication link and the dir fsync: open fails, the final is COMPLETE (never partial), replay adopts it", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    vi.spyOn(ledgerIo, "syncDir").mockImplementation(async () => {
      throw new Error("injected power loss");
    });
    await expect(HoldoutLedger.open(path, { budget: 2 })).rejects.toThrow(/injected power loss/);
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":2}\n'); // exact header, fsynced before the link
    expect(tempFiles(dir)).toEqual([]);
    vi.restoreAllMocks();
    const reopened = await HoldoutLedger.open(path); // budget recovered from disk
    expect(await reopened.charge()).toEqual({ count: 1, budget: 2 });
    await reopened.close();
  });

  it("winner parked mid-publication while a concurrent creator publishes: the parked one loses cleanly, adopts, and ONE header exists", async () => {
    const dir = tmp();
    const path = join(dir, "holdout.ledger");
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let firstParked!: () => void;
    const parked = new Promise<void>((r) => {
      firstParked = r;
    });
    const origLink = ledgerIo.linkNoClobber;
    let calls = 0;
    vi.spyOn(ledgerIo, "linkNoClobber").mockImplementation(async (src, dest) => {
      calls += 1;
      if (calls === 1) {
        firstParked();
        await gate; // the pause/crash window: temp fully durable, final not yet published
      }
      await origLink(src, dest);
    });

    const first = HoldoutLedger.open(path, { budget: 2 });
    await parked;
    expect(existsSync(path)).toBe(false); // nothing exposed before publication

    const second = await HoldoutLedger.open(path, { budget: 2 }); // publishes while first is parked
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":2}\n');

    releaseFirst();
    const firstLedger = await first; // loses the no-clobber link (EEXIST), cleans its temp, adopts the winner
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":2}\n'); // never clobbered
    expect(tempFiles(dir)).toEqual([]); // loser cleanup

    // Both contenders hold authority over the SAME shared append order.
    const results = await Promise.allSettled([firstLedger.charge(), second.charge(), firstLedger.charge()]);
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.count] : []));
    expect(granted.sort((x, y) => x - y)).toEqual([1, 2]);
    await firstLedger.close();
    await second.close();
  });

  it("two concurrent creators with DIFFERENT identities: exactly one wins, the other is refused with a mismatch, never overwritten", async () => {
    const path = join(tmp(), "holdout.ledger");
    const results = await Promise.allSettled([
      HoldoutLedger.open(path, { budget: 3 }),
      HoldoutLedger.open(path, { budget: 4 }),
    ]);
    const winners = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(Error);
    expect((losers[0]!.reason as Error).message).toMatch(/mismatch/i);
    // The published header is exactly the winner's identity.
    expect(JSON.parse(fileLines(path)[0]!)).toEqual({ v: 2, budget: winners[0]!.state().budget });
    expect(await winners[0]!.charge()).toEqual({ count: 1, budget: winners[0]!.state().budget });
    await winners[0]!.close();
  });

  it("two concurrent openers repairing the SAME legacy prefix (same identity) both succeed and converge on one exact header", async () => {
    const path = join(tmp(), "holdout.ledger");
    writeFileSync(path, '{"v":2,"bud');
    const [a, b] = await Promise.all([
      HoldoutLedger.open(path, { budget: 2 }),
      HoldoutLedger.open(path, { budget: 2 }),
    ]);
    expect(readFileSync(path, "utf8")).toBe('{"v":2,"budget":2}\n'); // idempotent fixed-offset writes converge
    const results = await Promise.allSettled([a.charge(), b.charge(), a.charge()]);
    const granted = results.flatMap((r) => (r.status === "fulfilled" ? [r.value.count] : []));
    expect(granted.sort((x, y) => x - y)).toEqual([1, 2]);
    await a.close();
    await b.close();
  });
});
