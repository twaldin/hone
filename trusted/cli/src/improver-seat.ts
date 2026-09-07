import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export type SeatSha256Digest = `sha256:${string}`;

export interface ImproverChampionIdentity {
  readonly optimizerDigest: SeatSha256Digest;
  readonly sourceArtifactDigest: SeatSha256Digest;
  readonly sourceCommit: string;
  readonly promotionEvidenceHash: SeatSha256Digest;
}

export interface ImproverSeatSnapshot {
  readonly champion: ImproverChampionIdentity | null;
  readonly generation: number;
  readonly receiptHash: SeatSha256Digest | null;
}

export interface ImproverSeatCas {
  readonly champion: ImproverChampionIdentity | null;
  readonly receiptHash: SeatSha256Digest | null;
}

export interface ImproverSeatRequest {
  readonly expected: ImproverSeatCas;
  readonly champion: ImproverChampionIdentity;
  readonly operator: string;
  readonly operatorTimestamp: string;
}

export interface ImproverRollbackRequest {
  readonly expected: ImproverSeatCas;
  readonly operator: string;
  readonly operatorTimestamp: string;
}

export type ImproverSeatAction = "seat" | "rollback";

export interface ImproverSeatReceiptRecord {
  readonly version: 1;
  readonly sequence: number;
  readonly action: ImproverSeatAction;
  readonly previousReceiptHash: SeatSha256Digest | null;
  readonly oldChampion: ImproverChampionIdentity | null;
  readonly newChampion: ImproverChampionIdentity;
  readonly operator: string;
  readonly operatorTimestamp: string;
}

export interface ImproverSeatReceipt {
  readonly record: ImproverSeatReceiptRecord;
  readonly receiptHash: SeatSha256Digest;
}

interface ChampionDocument {
  readonly version: 1;
  readonly generation: number;
  readonly champion: ImproverChampionIdentity;
  readonly receiptHash: SeatSha256Digest;
  readonly stateHash: SeatSha256Digest;
}

interface ReplayedSeat {
  readonly receipts: readonly ImproverSeatReceipt[];
  readonly snapshot: ImproverSeatSnapshot;
  readonly document: ChampionDocument | null;
  readonly previousDocument: ChampionDocument | null;
}

export const IMPROVER_CHAMPION_FILE = "champion.json";
export const IMPROVER_SEAT_RECEIPTS_FILE = "receipts.ndjson";
const PENDING_CHAMPION_FILE = "champion.pending";
const SEAT_LOCK_FILE = ".seat.lock";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
function isSeatSha256Digest(value: unknown): value is SeatSha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error["code"] === "string" ? error["code"] : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("seat state contains a nonfinite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!isRecord(value)) throw new Error("seat state contains an unsupported value");
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function digestCanonical(value: unknown): SeatSha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function identitiesEqual(left: ImproverChampionIdentity | null, right: ImproverChampionIdentity | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validateChampionIdentity(identity: ImproverChampionIdentity): ImproverChampionIdentity {
  if (!SHA256_PATTERN.test(identity.optimizerDigest)) throw new Error("invalid optimizer digest");
  if (!SHA256_PATTERN.test(identity.sourceArtifactDigest)) throw new Error("invalid source artifact digest");
  if (!COMMIT_PATTERN.test(identity.sourceCommit)) throw new Error("invalid source commit");
  if (!SHA256_PATTERN.test(identity.promotionEvidenceHash)) throw new Error("invalid promotion evidence hash");
  return {
    optimizerDigest: identity.optimizerDigest,
    sourceArtifactDigest: identity.sourceArtifactDigest,
    sourceCommit: identity.sourceCommit,
    promotionEvidenceHash: identity.promotionEvidenceHash,
  };
}

function parseChampionIdentity(value: unknown): ImproverChampionIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["optimizerDigest", "sourceArtifactDigest", "sourceCommit", "promotionEvidenceHash"])) {
    throw new Error("invalid champion identity shape");
  }
  const optimizerDigest = value["optimizerDigest"];
  const sourceArtifactDigest = value["sourceArtifactDigest"];
  const sourceCommit = value["sourceCommit"];
  const promotionEvidenceHash = value["promotionEvidenceHash"];
  if (
    !isSeatSha256Digest(optimizerDigest) ||
    !isSeatSha256Digest(sourceArtifactDigest) ||
    typeof sourceCommit !== "string" ||
    !COMMIT_PATTERN.test(sourceCommit) ||
    !isSeatSha256Digest(promotionEvidenceHash)
  ) {
    throw new Error("invalid champion identity values");
  }
  return { optimizerDigest, sourceArtifactDigest, sourceCommit, promotionEvidenceHash };
}

function validateOperator(operator: string, operatorTimestamp: string): void {
  if (operator.length === 0 || operator.length > 256 || /[\u0000-\u001f\u007f]/.test(operator)) throw new Error("invalid seat operator");
  const timestamp = new Date(operatorTimestamp);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== operatorTimestamp) {
    throw new Error("operatorTimestamp must be a canonical ISO-8601 instant");
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error(`seat state write stalled at ${offset}/${bytes.length}`);
    offset += written;
  }
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function verifyOwnerOnly(pathname: string, kind: "file" | "directory"): void {
  const stat = lstatSync(pathname);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error(`seat ${kind} is not a regular ${kind}: ${pathname}`);
  if (stat.isSymbolicLink()) throw new Error(`seat ${kind} must not be a symlink: ${pathname}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`seat ${kind} is not owned by the current operator: ${pathname}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`seat ${kind} is not owner-only: ${pathname}`);
}

function ensureSeatDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    syncDirectory(path.dirname(directory));
  }
  verifyOwnerOnly(directory, "directory");
}

function writePrivateFileDurable(pathname: string, bytes: Buffer): void {
  const fd = openSync(pathname, "w", 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(pathname, 0o600);
  syncDirectory(path.dirname(pathname));
}

function parseLockOwner(pathname: string): number {
  verifyOwnerOnly(pathname, "file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    throw new Error("seat lock metadata is corrupt");
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["pid", "token"]) || !Number.isSafeInteger(parsed["pid"]) || typeof parsed["token"] !== "string") {
    throw new Error("seat lock metadata is corrupt");
  }
  const pid = parsed["pid"];
  if (typeof pid !== "number" || pid <= 0) throw new Error("seat lock pid is invalid");
  return pid;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) === "EPERM";
  }
}

function acquireSeatLock(directory: string): () => void {
  const lockPath = path.join(directory, SEAT_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const temporary = path.join(directory, `.seat-lock.${process.pid}.${token}.tmp`);
    writePrivateFileDurable(temporary, Buffer.from(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8"));
    try {
      linkSync(temporary, lockPath);
      unlinkSync(temporary);
      syncDirectory(directory);
      verifyOwnerOnly(lockPath, "file");
      return (): void => {
        if (existsSync(lockPath)) {
          unlinkSync(lockPath);
          syncDirectory(directory);
        }
      };
    } catch (error: unknown) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (errorCode(error) !== "EEXIST") throw error;
      const ownerPid = parseLockOwner(lockPath);
      if (processIsAlive(ownerPid)) throw new Error(`improver seat is busy under pid ${ownerPid}`);
      const stale = path.join(directory, `.seat-lock.stale.${randomUUID()}`);
      try {
        renameSync(lockPath, stale);
        syncDirectory(directory);
        unlinkSync(stale);
        syncDirectory(directory);
      } catch (reclaimError: unknown) {
        if (errorCode(reclaimError) !== "ENOENT") throw reclaimError;
      }
    }
  }
  throw new Error("could not acquire improver seat lock");
}

function repairTornReceiptTail(receiptsPath: string): void {
  if (!existsSync(receiptsPath)) return;
  verifyOwnerOnly(receiptsPath, "file");
  const fd = openSync(receiptsPath, "r+");
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_RECEIPT_BYTES) throw new Error("improver seat receipt log exceeds size limit");
    if (size === 0) return;
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, size - 1);
    if (byte[0] === 0x0a) return;
    const content = Buffer.alloc(size);
    readSync(fd, content, 0, size, 0);
    const lastNewline = content.lastIndexOf(0x0a);
    ftruncateSync(fd, lastNewline + 1);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(path.dirname(receiptsPath));
}

function parseReceipt(value: unknown): ImproverSeatReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ["record", "receiptHash"])) throw new Error("invalid seat receipt envelope");
  const rawRecord = value["record"];
  const receiptHash = value["receiptHash"];
  if (!isRecord(rawRecord) || !isSeatSha256Digest(receiptHash)) throw new Error("invalid seat receipt fields");
  if (!hasExactKeys(rawRecord, ["version", "sequence", "action", "previousReceiptHash", "oldChampion", "newChampion", "operator", "operatorTimestamp"])) {
    throw new Error("invalid seat receipt record shape");
  }
  const version = rawRecord["version"];
  const sequence = rawRecord["sequence"];
  const action = rawRecord["action"];
  const previousReceiptHash = rawRecord["previousReceiptHash"];
  const operator = rawRecord["operator"];
  const operatorTimestamp = rawRecord["operatorTimestamp"];
  if (
    version !== 1 ||
    !Number.isSafeInteger(sequence) ||
    typeof sequence !== "number" ||
    sequence <= 0 ||
    (action !== "seat" && action !== "rollback") ||
    (previousReceiptHash !== null && !isSeatSha256Digest(previousReceiptHash)) ||
    typeof operator !== "string" ||
    typeof operatorTimestamp !== "string"
  ) {
    throw new Error("invalid seat receipt record fields");
  }
  validateOperator(operator, operatorTimestamp);
  const oldChampion = rawRecord["oldChampion"] === null ? null : parseChampionIdentity(rawRecord["oldChampion"]);
  const newChampion = parseChampionIdentity(rawRecord["newChampion"]);
  const record: ImproverSeatReceiptRecord = {
    version: 1,
    sequence,
    action,
    previousReceiptHash,
    oldChampion,
    newChampion,
    operator,
    operatorTimestamp,
  };
  if (digestCanonical(record) !== receiptHash) throw new Error(`seat receipt ${sequence} hash mismatch`);
  return { record, receiptHash };
}

function makeChampionDocument(champion: ImproverChampionIdentity, generation: number, receiptHash: SeatSha256Digest): ChampionDocument {
  const state = { version: 1 as const, generation, champion, receiptHash };
  return { ...state, stateHash: digestCanonical(state) };
}

function parseChampionDocument(value: unknown): ChampionDocument {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "generation", "champion", "receiptHash", "stateHash"])) {
    throw new Error("invalid champion document shape");
  }
  const version = value["version"];
  const generation = value["generation"];
  const receiptHash = value["receiptHash"];
  const stateHash = value["stateHash"];
  if (
    version !== 1 ||
    !Number.isSafeInteger(generation) ||
    typeof generation !== "number" ||
    generation <= 0 ||
    !isSeatSha256Digest(receiptHash) ||
    !isSeatSha256Digest(stateHash)
  ) {
    throw new Error("invalid champion document fields");
  }
  const champion = parseChampionIdentity(value["champion"]);
  const state = { version: 1 as const, generation, champion, receiptHash };
  if (digestCanonical(state) !== stateHash) throw new Error("champion state hash mismatch");
  return { ...state, stateHash };
}

function readChampionDocument(pathname: string): ChampionDocument | null {
  if (!existsSync(pathname)) return null;
  verifyOwnerOnly(pathname, "file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    throw new Error("champion file is corrupt");
  }
  return parseChampionDocument(parsed);
}

function championDocumentsEqual(left: ChampionDocument | null, right: ChampionDocument | null): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function replayReceipts(directory: string): ReplayedSeat {
  const receiptsPath = path.join(directory, IMPROVER_SEAT_RECEIPTS_FILE);
  repairTornReceiptTail(receiptsPath);
  const receipts: ImproverSeatReceipt[] = [];
  if (existsSync(receiptsPath)) {
    const content = readFileSync(receiptsPath, "utf8");
    if (Buffer.byteLength(content) > MAX_RECEIPT_BYTES) throw new Error("improver seat receipt log exceeds size limit");
    const lines = content.length === 0 ? [] : content.slice(0, -1).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.length === 0) throw new Error(`empty seat receipt line ${index + 1}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`corrupt seat receipt line ${index + 1}`);
      }
      receipts.push(parseReceipt(parsed));
    }
  }

  let currentChampion: ImproverChampionIdentity | null = null;
  let currentDocument: ChampionDocument | null = null;
  let previousDocument: ChampionDocument | null = null;
  let previousReceipt: ImproverSeatReceipt | null = null;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    if (receipt === undefined) throw new Error("seat receipt replay index failure");
    const expectedSequence = index + 1;
    if (receipt.record.sequence !== expectedSequence) throw new Error(`seat receipt sequence mismatch at ${expectedSequence}`);
    if (receipt.record.previousReceiptHash !== (previousReceipt?.receiptHash ?? null)) throw new Error(`seat receipt chain mismatch at ${expectedSequence}`);
    if (!identitiesEqual(receipt.record.oldChampion, currentChampion)) throw new Error(`seat receipt old champion mismatch at ${expectedSequence}`);
    if (receipt.record.action === "rollback") {
      if (previousReceipt === null || previousReceipt.record.oldChampion === null) throw new Error(`rollback receipt ${expectedSequence} has no prior sealed champion`);
      if (!identitiesEqual(receipt.record.newChampion, previousReceipt.record.oldChampion)) {
        throw new Error(`rollback receipt ${expectedSequence} does not restore the exact prior champion`);
      }
    }
    previousDocument = currentDocument;
    currentChampion = receipt.record.newChampion;
    currentDocument = makeChampionDocument(currentChampion, expectedSequence, receipt.receiptHash);
    previousReceipt = receipt;
  }
  return {
    receipts,
    snapshot: {
      champion: currentChampion,
      generation: receipts.length,
      receiptHash: previousReceipt?.receiptHash ?? null,
    },
    document: currentDocument,
    previousDocument,
  };
}

function recoverSeatState(directory: string): ReplayedSeat {
  const replayed = replayReceipts(directory);
  const championPath = path.join(directory, IMPROVER_CHAMPION_FILE);
  const pendingPath = path.join(directory, PENDING_CHAMPION_FILE);
  const onDisk = readChampionDocument(championPath);

  if (championDocumentsEqual(onDisk, replayed.document)) {
    if (existsSync(pendingPath)) {
      verifyOwnerOnly(pendingPath, "file");
      unlinkSync(pendingPath);
      syncDirectory(directory);
    }
    return replayed;
  }

  if (!championDocumentsEqual(onDisk, replayed.previousDocument)) {
    throw new Error("champion file disagrees with the append-only receipt history");
  }
  if (replayed.document === null || !existsSync(pendingPath)) {
    throw new Error("champion publication is missing its durable pending file");
  }
  const pending = readChampionDocument(pendingPath);
  if (!championDocumentsEqual(pending, replayed.document)) throw new Error("pending champion does not match the durable receipt history");
  renameSync(pendingPath, championPath);
  syncDirectory(directory);
  return replayed;
}

function assertCas(snapshot: ImproverSeatSnapshot, expected: ImproverSeatCas): void {
  if ((expected.receiptHash !== null && !SHA256_PATTERN.test(expected.receiptHash)) || !identitiesEqual(snapshot.champion, expected.champion)) {
    throw new Error("improver seat compare-and-swap failed");
  }
  if (snapshot.receiptHash !== expected.receiptHash) throw new Error("improver seat compare-and-swap failed");
}

function appendReceipt(directory: string, receipt: ImproverSeatReceipt): void {
  const receiptsPath = path.join(directory, IMPROVER_SEAT_RECEIPTS_FILE);
  if (existsSync(receiptsPath)) verifyOwnerOnly(receiptsPath, "file");
  const fd = openSync(receiptsPath, "a", 0o600);
  try {
    writeAll(fd, Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(receiptsPath, 0o600);
  syncDirectory(directory);
}

function publishTransition(
  directory: string,
  replayed: ReplayedSeat,
  action: ImproverSeatAction,
  newChampion: ImproverChampionIdentity,
  operator: string,
  operatorTimestamp: string,
): ImproverSeatReceipt {
  validateOperator(operator, operatorTimestamp);
  const record: ImproverSeatReceiptRecord = {
    version: 1,
    sequence: replayed.snapshot.generation + 1,
    action,
    previousReceiptHash: replayed.snapshot.receiptHash,
    oldChampion: replayed.snapshot.champion,
    newChampion,
    operator,
    operatorTimestamp,
  };
  const receipt: ImproverSeatReceipt = { record, receiptHash: digestCanonical(record) };
  const document = makeChampionDocument(newChampion, record.sequence, receipt.receiptHash);
  const pendingPath = path.join(directory, PENDING_CHAMPION_FILE);
  writePrivateFileDurable(pendingPath, Buffer.from(`${JSON.stringify(document)}\n`, "utf8"));
  appendReceipt(directory, receipt);
  renameSync(pendingPath, path.join(directory, IMPROVER_CHAMPION_FILE));
  syncDirectory(directory);
  return receipt;
}

/** Read and, when needed, complete a receipt-authorized interrupted champion rename. */
export function readImproverSeat(directory: string): ImproverSeatSnapshot {
  ensureSeatDirectory(directory);
  const release = acquireSeatLock(directory);
  try {
    return recoverSeatState(directory).snapshot;
  } finally {
    release();
  }
}

/** Explicit owner action. No promotion decision invokes this API automatically. */
export function seatImproverChampion(directory: string, request: ImproverSeatRequest): ImproverSeatReceipt {
  ensureSeatDirectory(directory);
  const release = acquireSeatLock(directory);
  try {
    const replayed = recoverSeatState(directory);
    assertCas(replayed.snapshot, request.expected);
    const champion = validateChampionIdentity(request.champion);
    if (identitiesEqual(replayed.snapshot.champion, champion)) throw new Error("refusing a no-op champion seat");
    return publishTransition(directory, replayed, "seat", champion, request.operator, request.operatorTimestamp);
  } finally {
    release();
  }
}

/** Restore the exact full identity sealed immediately before the current receipt. */
export function rollbackImproverChampion(directory: string, request: ImproverRollbackRequest): ImproverSeatReceipt {
  ensureSeatDirectory(directory);
  const release = acquireSeatLock(directory);
  try {
    const replayed = recoverSeatState(directory);
    assertCas(replayed.snapshot, request.expected);
    const lastReceipt = replayed.receipts[replayed.receipts.length - 1];
    if (lastReceipt === undefined || lastReceipt.record.oldChampion === null) throw new Error("no prior sealed champion is available for rollback");
    return publishTransition(
      directory,
      replayed,
      "rollback",
      lastReceipt.record.oldChampion,
      request.operator,
      request.operatorTimestamp,
    );
  } finally {
    release();
  }
}

/** Strictly replay and return the fsynced append-only seat/rollback receipts. */
export function readImproverSeatReceipts(directory: string): readonly ImproverSeatReceipt[] {
  ensureSeatDirectory(directory);
  const release = acquireSeatLock(directory);
  try {
    return recoverSeatState(directory).receipts;
  } finally {
    release();
  }
}
