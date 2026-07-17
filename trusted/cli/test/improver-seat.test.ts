import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  IMPROVER_CHAMPION_FILE,
  IMPROVER_SEAT_RECEIPTS_FILE,
  readImproverSeat,
  readImproverSeatReceipts,
  rollbackImproverChampion,
  seatImproverChampion,
  type ImproverChampionIdentity,
  type ImproverSeatCas,
} from "../src/improver-seat.js";

const temporaryDirectories: string[] = [];

const championA: ImproverChampionIdentity = {
  optimizerDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceArtifactDigest: "sha256:abababababababababababababababababababababababababababababababab",
  sourceCommit: "1111111111111111111111111111111111111111",
  promotionEvidenceHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
};
const championB: ImproverChampionIdentity = {
  optimizerDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  sourceArtifactDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  sourceCommit: "2222222222222222222222222222222222222222",
  promotionEvidenceHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
};
const championC: ImproverChampionIdentity = {
  optimizerDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  sourceArtifactDigest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  sourceCommit: "3333333333333333333333333333333333333333",
  promotionEvidenceHash: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
};

function seatDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "hone-improver-seat-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "seat");
}

function casOf(directory: string): ImproverSeatCas {
  const snapshot = readImproverSeat(directory);
  return { champion: snapshot.champion, receiptHash: snapshot.receiptHash };
}

function seat(directory: string, champion: ImproverChampionIdentity, timestamp = "2026-07-16T00:00:00.000Z"): void {
  seatImproverChampion(directory, {
    expected: casOf(directory),
    champion,
    operator: "release-owner",
    operatorTimestamp: timestamp,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("explicit improver seat storage", () => {
  it("atomically seats owner-only champion state and appends explicit fsynced receipts", () => {
    const directory = seatDirectory();
    expect(readImproverSeat(directory)).toEqual({ champion: null, generation: 0, receiptHash: null });
    seat(directory, championA);
    const snapshot = readImproverSeat(directory);
    expect(snapshot.champion).toEqual(championA);
    expect(snapshot.generation).toBe(1);
    const receipts = readImproverSeatReceipts(directory);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.record).toMatchObject({
      action: "seat",
      oldChampion: null,
      newChampion: championA,
      operator: "release-owner",
      operatorTimestamp: "2026-07-16T00:00:00.000Z",
    });
    expect(statSync(path.join(directory, IMPROVER_CHAMPION_FILE)).mode & 0o077).toBe(0);
    expect(statSync(path.join(directory, IMPROVER_SEAT_RECEIPTS_FILE)).mode & 0o077).toBe(0);
  });

  it("makes one of two stale compare-and-swap contenders lose deterministically", () => {
    const directory = seatDirectory();
    seat(directory, championA);
    const stale = casOf(directory);
    seatImproverChampion(directory, {
      expected: stale,
      champion: championB,
      operator: "owner-one",
      operatorTimestamp: "2026-07-16T00:01:00.000Z",
    });
    expect(() =>
      seatImproverChampion(directory, {
        expected: stale,
        champion: championC,
        operator: "owner-two",
        operatorTimestamp: "2026-07-16T00:01:01.000Z",
      }),
    ).toThrow(/compare-and-swap failed/);
    expect(readImproverSeat(directory).champion).toEqual(championB);
    expect(readImproverSeatReceipts(directory)).toHaveLength(2);
  });

  it("recovers an interrupted receipt-authorized champion rename", () => {
    const directory = seatDirectory();
    seat(directory, championA);
    const oldChampionDocument = readFileSync(path.join(directory, IMPROVER_CHAMPION_FILE));
    seat(directory, championB, "2026-07-16T00:02:00.000Z");

    renameSync(path.join(directory, IMPROVER_CHAMPION_FILE), path.join(directory, "champion.pending"));
    writeFileSync(path.join(directory, IMPROVER_CHAMPION_FILE), oldChampionDocument, { mode: 0o600 });
    chmodSync(path.join(directory, IMPROVER_CHAMPION_FILE), 0o600);

    const recovered = readImproverSeat(directory);
    expect(recovered.champion).toEqual(championB);
    expect(recovered.generation).toBe(2);
    expect(readImproverSeatReceipts(directory)).toHaveLength(2);
  });

  it("rolls back the exact full prior sealed identity and records old/new metadata", () => {
    const directory = seatDirectory();
    seat(directory, championA);
    seat(directory, championB, "2026-07-16T00:03:00.000Z");
    const receipt = rollbackImproverChampion(directory, {
      expected: casOf(directory),
      operator: "rollback-owner",
      operatorTimestamp: "2026-07-16T00:04:00.000Z",
    });
    expect(receipt.record).toMatchObject({ action: "rollback", oldChampion: championB, newChampion: championA });
    expect(readImproverSeat(directory).champion).toEqual(championA);
    expect(readImproverSeatReceipts(directory).map((entry) => entry.record.action)).toEqual(["seat", "seat", "rollback"]);
  });

  it("refuses receipt tampering, champion corruption, and permissive state modes", () => {
    const receiptDirectory = seatDirectory();
    seat(receiptDirectory, championA);
    const receiptsPath = path.join(receiptDirectory, IMPROVER_SEAT_RECEIPTS_FILE);
    const line = readFileSync(receiptsPath, "utf8").trimEnd();
    const tampered = line.replace("release-owner", "release-other");
    writeFileSync(receiptsPath, `${tampered}\n`, { mode: 0o600 });
    expect(() => readImproverSeat(receiptDirectory)).toThrow(/hash mismatch/);

    const championDirectory = seatDirectory();
    seat(championDirectory, championA);
    const championPath = path.join(championDirectory, IMPROVER_CHAMPION_FILE);
    writeFileSync(championPath, "{}\n", { mode: 0o600 });
    expect(() => readImproverSeat(championDirectory)).toThrow(/champion/);

    const modeDirectory = seatDirectory();
    seat(modeDirectory, championA);
    chmodSync(path.join(modeDirectory, IMPROVER_CHAMPION_FILE), 0o644);
    expect(() => readImproverSeat(modeDirectory)).toThrow(/not owner-only/);
  });

  it("refuses rollback without a prior champion and refuses noncanonical operator timestamps", () => {
    const directory = seatDirectory();
    seat(directory, championA);
    expect(() =>
      rollbackImproverChampion(directory, {
        expected: casOf(directory),
        operator: "rollback-owner",
        operatorTimestamp: "2026-07-16T00:05:00.000Z",
      }),
    ).toThrow(/no prior sealed champion/);
    expect(() =>
      seatImproverChampion(directory, {
        expected: casOf(directory),
        champion: championB,
        operator: "release-owner",
        operatorTimestamp: "2026-07-16T00:05:00Z",
      }),
    ).toThrow(/canonical ISO-8601/);
  });
});
