import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HoldoutLedger, HoldoutBudgetExceededError } from "../src/index.js";

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

  it("concurrent fresh opens race O_EXCL creation: the loser recovers the winner's initialized ledger", async () => {
    const path = join(tmp(), "holdout.ledger");
    const [a, b] = await Promise.all([
      HoldoutLedger.open(path, { budget: 2 }),
      HoldoutLedger.open(path, { budget: 2 }),
    ]);
    expect(a.state()).toEqual({ count: 0, budget: 2 });
    expect(b.state()).toEqual({ count: 0, budget: 2 });
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
