import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("holdout ledger — hard lifetime budget", () => {
  it("charges monotonically and reports { count, budget } for the holdout.accessed event", async () => {
    const ledger = await HoldoutLedger.open(join(tmp(), "holdout.ledger"), { budget: 3 });
    expect(ledger.state()).toEqual({ count: 0, budget: 3 });
    expect(await ledger.charge()).toEqual({ count: 1, budget: 3 });
    expect(await ledger.charge()).toEqual({ count: 2, budget: 3 });
    expect(ledger.state()).toEqual({ count: 2, budget: 3 });
    await ledger.close();
  });

  it("refuses charge #N+1 past budget — nothing is written for a refused charge", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 2 });
    await ledger.charge();
    await ledger.charge();
    await expect(ledger.charge()).rejects.toThrow(HoldoutBudgetExceededError);
    await ledger.close();
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3); // header + 2 charges, no third
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

  it("write-ahead: a torn trailing line (crash mid-write) is discarded — access was never granted", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 5 });
    await ledger.charge();
    await ledger.close();
    appendFileSync(path, '{"seq":2,"at":"2026'); // torn, no newline, fsync never returned
    const reopened = await HoldoutLedger.open(path);
    expect(reopened.state()).toEqual({ count: 1, budget: 5 });
    await reopened.close();
  });

  it("rejects opening a fresh ledger without a budget, and a budget mismatch on re-open", async () => {
    const path = join(tmp(), "holdout.ledger");
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/budget/i);
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    await ledger.close();
    await expect(HoldoutLedger.open(path, { budget: 4 })).rejects.toThrow(/mismatch/i);
  });

  it("rejects a corrupt interior line — the ledger never guesses", async () => {
    const path = join(tmp(), "holdout.ledger");
    const ledger = await HoldoutLedger.open(path, { budget: 3 });
    await ledger.charge();
    await ledger.close();
    appendFileSync(path, "garbage-line\n" + '{"seq":2,"at":"2026-07-14T12:00:00.000Z"}\n');
    await expect(HoldoutLedger.open(path)).rejects.toThrow(/corrupt/i);
  });
});
