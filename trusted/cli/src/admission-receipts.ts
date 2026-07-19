import { randomUUID } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";
import {
  AdmissionReceiptRecord as AdmissionReceiptRecordSchema,
  type AdmissionReceiptRecord,
} from "@hone/schema";
import { UsageError } from "./args.js";

export const ADMISSION_RECEIPTS_DIR = "admission-receipts";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const appendPoison = new Map<string, string>();

export interface VerifiedAdmissionApproval {
  approved: true;
  provisional: boolean;
  receipt: AdmissionReceiptRecord;
}

function receiptError(message: string): UsageError {
  return new UsageError(`admission receipt verification failed: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertDigest(digest: string): void {
  if (!SHA256_PATTERN.test(digest)) throw receiptError(`invalid capsule digest ${JSON.stringify(digest)}`);
}

function ledgerDirectory(casRoot: string): string {
  return resolve(casRoot, ADMISSION_RECEIPTS_DIR);
}

export function admissionReceiptLedgerPath(casRoot: string, capsuleDigest: string): string {
  assertDigest(capsuleDigest);
  return join(ledgerDirectory(casRoot), `${capsuleDigest.slice("sha256:".length)}.ndjson`);
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertOwnedPath(pathname: string, kind: "file" | "directory", ownerOnly: boolean): void {
  const stat = lstatSync(pathname);
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`${pathname} is not a regular ${kind}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${pathname} is not owned by the current operator`);
  if (ownerOnly && (stat.mode & 0o077) !== 0) throw new Error(`${pathname} is not owner-only`);
}

function ensureLedgerDirectory(casRoot: string): string {
  if (!existsSync(casRoot)) {
    mkdirSync(casRoot, { recursive: true, mode: 0o700 });
    chmodSync(casRoot, 0o700);
    syncDirectory(dirname(casRoot));
  }
  assertOwnedPath(casRoot, "directory", false);

  const directory = ledgerDirectory(casRoot);
  if (!existsSync(directory)) {
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    syncDirectory(casRoot);
  }
  assertOwnedPath(directory, "directory", true);
  return directory;
}

function existingLedgerDirectory(casRoot: string): string {
  if (!existsSync(casRoot)) throw receiptError("no admission receipt ledger exists for this capsule");
  assertOwnedPath(casRoot, "directory", false);
  const directory = ledgerDirectory(casRoot);
  if (!existsSync(directory)) throw receiptError("no admission receipt ledger exists for this capsule");
  assertOwnedPath(directory, "directory", true);
  return directory;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error(`receipt write stalled at ${offset}/${bytes.length} bytes`);
    offset += written;
  }
}

function writePrivateFileDurable(pathname: string, bytes: Buffer): void {
  const fd = openSync(pathname, "wx", 0o600);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(pathname, 0o600);
  syncDirectory(dirname(pathname));
}

interface LockOwner {
  pid: number;
  token: string;
}

function parseLockOwner(lockPath: string): LockOwner {
  assertOwnedPath(lockPath, "file", true);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    throw new Error(`admission receipt lock is corrupt: ${errorMessage(error)}`);
  }
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value["pid"])
    || typeof value["pid"] !== "number"
    || value["pid"] <= 0
    || typeof value["token"] !== "string"
    || value["token"].length === 0
  ) {
    throw new Error("admission receipt lock owner is invalid");
  }
  return { pid: value["pid"], token: value["token"] };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function acquireLedgerLock(directory: string, digest: string): () => void {
  const stem = digest.slice("sha256:".length);
  const lockPath = join(directory, `.${stem}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const temporary = join(directory, `.${stem}.lock.${process.pid}.${token}.tmp`);
    writePrivateFileDurable(
      temporary,
      Buffer.from(`${JSON.stringify({ pid: process.pid, token })}\n`, "utf8"),
    );
    try {
      linkSync(temporary, lockPath);
      unlinkSync(temporary);
      syncDirectory(directory);
      assertOwnedPath(lockPath, "file", true);
      return (): void => {
        if (!existsSync(lockPath)) return;
        const owner = parseLockOwner(lockPath);
        if (owner.token !== token) throw new Error("admission receipt lock ownership changed");
        unlinkSync(lockPath);
        syncDirectory(directory);
      };
    } catch (error) {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
        syncDirectory(directory);
      }
      if (errorCode(error) !== "EEXIST") throw error;
      const owner = parseLockOwner(lockPath);
      if (processIsAlive(owner.pid)) throw new Error(`admission receipt ledger is busy under pid ${owner.pid}`);
      const stale = join(directory, `.${stem}.lock.stale.${randomUUID()}`);
      try {
        renameSync(lockPath, stale);
        syncDirectory(directory);
        unlinkSync(stale);
        syncDirectory(directory);
      } catch (reclaimError) {
        if (errorCode(reclaimError) !== "ENOENT") throw reclaimError;
      }
    }
  }
  throw new Error("could not acquire admission receipt ledger lock");
}

function repairTornTail(ledgerPath: string): void {
  if (!existsSync(ledgerPath)) return;
  assertOwnedPath(ledgerPath, "file", true);
  const readFd = openSync(ledgerPath, "r");
  let keep: number | undefined;
  try {
    const size = fstatSync(readFd).size;
    if (size > MAX_LEDGER_BYTES) throw new Error("admission receipt ledger exceeds size limit");
    if (size === 0) return;
    const finalByte = Buffer.alloc(1);
    readSync(readFd, finalByte, 0, 1, size - 1);
    if (finalByte[0] === 0x0a) return;
    const content = Buffer.alloc(size);
    readSync(readFd, content, 0, size, 0);
    keep = content.lastIndexOf(0x0a) + 1;
  } finally {
    closeSync(readFd);
  }
  const writeFd = openSync(ledgerPath, "r+");
  try {
    ftruncateSync(writeFd, keep);
    fsyncSync(writeFd);
  } finally {
    closeSync(writeFd);
  }
  syncDirectory(dirname(ledgerPath));
}

type AdmissionWorkflowState =
  | "awaiting-gate1"
  | "revision-required"
  | "gate1-accepted"
  | "approved"
  | "gate2-rejected"
  | "revoked";

interface ReplayedAdmissionLedger {
  receipts: AdmissionReceiptRecord[];
  state: AdmissionWorkflowState;
}

function advanceAdmissionWorkflow(
  state: AdmissionWorkflowState,
  action: AdmissionReceiptRecord["action"],
  sequence: number,
): AdmissionWorkflowState {
  if (state === "awaiting-gate1" || state === "revision-required") {
    if (action === "gate1-revise") return "revision-required";
    if (action === "gate1-accept") return "gate1-accepted";
  } else if (state === "gate1-accepted") {
    if (action === "gate1-revise") return "revision-required";
    if (action === "gate2-approve") return "approved";
    if (action === "gate2-reject") return "gate2-rejected";
  } else if (state === "approved") {
    if (action === "revoke") return "revoked";
    if (action === "gate2-reject") return "gate2-rejected";
  } else if (state === "gate2-rejected" || state === "revoked") {
    if (action === "gate1-revise") return "revision-required";
    if (action === "gate1-accept") return "gate1-accepted";
  }
  throw new Error(
    `invalid admission workflow transition at sequence ${sequence}: ${state} -> ${action}`,
  );
}

function replayLedger(
  ledgerPath: string,
  capsuleDigest: string,
): ReplayedAdmissionLedger {
  repairTornTail(ledgerPath);
  if (!existsSync(ledgerPath)) return { receipts: [], state: "awaiting-gate1" };
  const content = readFileSync(ledgerPath, "utf8");
  if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) throw new Error("admission receipt ledger exceeds size limit");
  const lines = content.length === 0 ? [] : content.slice(0, -1).split("\n");
  const receipts: AdmissionReceiptRecord[] = [];
  let previousReceiptHash: string | null = null;
  let state: AdmissionWorkflowState = "awaiting-gate1";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.length === 0) throw new Error(`empty admission receipt line ${index + 1}`);
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`corrupt admission receipt line ${index + 1}: unparseable JSON`);
    }
    const parsed = AdmissionReceiptRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`corrupt admission receipt line ${index + 1}: ${issues}`);
    }
    const receipt = parsed.data;
    if (receipt.sequence !== index) {
      throw new Error(`admission receipt sequence mismatch at line ${index + 1}: expected ${index}, received ${receipt.sequence}`);
    }
    if (receipt.previousReceiptHash !== previousReceiptHash) {
      throw new Error(`admission receipt chain mismatch at sequence ${receipt.sequence}: previousReceiptHash does not match`);
    }
    if (receipt.capsuleDigest !== capsuleDigest) {
      throw new Error(`admission receipt capsule digest mismatch at sequence ${receipt.sequence}`);
    }
    state = advanceAdmissionWorkflow(state, receipt.action, receipt.sequence);
    receipts.push(receipt);
    previousReceiptHash = receipt.recordHash;
  }
  return { receipts, state };
}

function appendRecord(ledgerPath: string, receipt: AdmissionReceiptRecord): void {
  const priorPoison = appendPoison.get(ledgerPath);
  if (priorPoison !== undefined) {
    throw new Error(`ledger is unusable after append failure: ${priorPoison}`);
  }

  let fd: number | undefined;
  try {
    if (existsSync(ledgerPath)) assertOwnedPath(ledgerPath, "file", true);
    fd = openSync(ledgerPath, "a", 0o600);
    writeAll(fd, Buffer.from(`${JSON.stringify(receipt)}\n`, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(ledgerPath, 0o600);
    syncDirectory(dirname(ledgerPath));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The ledger remains poisoned regardless of the descriptor state.
      }
    }
    const reason = errorMessage(error);
    appendPoison.set(ledgerPath, reason);
    throw new Error(`admission receipt append failed; ledger poisoned until restart: ${reason}`);
  }
}

/** Validate and durably append one caller-authored, hash-bound receipt. */
export function appendAdmissionReceipt(
  casRoot: string,
  record: AdmissionReceiptRecord,
): AdmissionReceiptRecord {
  const parsed = AdmissionReceiptRecordSchema.safeParse(record);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw receiptError(`refusing malformed append: ${issues}`);
  }
  const receipt = parsed.data;
  const directory = ensureLedgerDirectory(casRoot);
  const ledgerPath = admissionReceiptLedgerPath(casRoot, receipt.capsuleDigest);
  const priorPoison = appendPoison.get(ledgerPath);
  if (priorPoison !== undefined) {
    throw receiptError(`ledger is unusable after append failure: ${priorPoison}`);
  }
  let release: (() => void) | undefined;
  try {
    release = acquireLedgerLock(directory, receipt.capsuleDigest);
    const replayed = replayLedger(ledgerPath, receipt.capsuleDigest);
    const previous = replayed.receipts[replayed.receipts.length - 1];
    const expectedSequence = replayed.receipts.length;
    if (receipt.sequence !== expectedSequence) {
      throw new Error(`append sequence mismatch: expected ${expectedSequence}, received ${receipt.sequence}`);
    }
    if (receipt.previousReceiptHash !== (previous?.recordHash ?? null)) {
      throw new Error("append previousReceiptHash does not match the durable chain head");
    }
    advanceAdmissionWorkflow(replayed.state, receipt.action, receipt.sequence);
    appendRecord(ledgerPath, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw receiptError(errorMessage(error));
  } finally {
    try {
      release?.();
    } catch (error) {
      throw receiptError(`could not release ledger lock: ${errorMessage(error)}`);
    }
  }
}

/** Strictly replay the digest ledger and require its latest state to approve. */
export function verifyAdmissionApproval(
  casRoot: string,
  capsuleDigest: string,
): VerifiedAdmissionApproval {
  assertDigest(capsuleDigest);
  const ledgerPath = admissionReceiptLedgerPath(casRoot, capsuleDigest);
  const priorPoison = appendPoison.get(ledgerPath);
  if (priorPoison !== undefined) {
    throw receiptError(`ledger is unusable after append failure: ${priorPoison}`);
  }
  let release: (() => void) | undefined;
  try {
    const directory = existingLedgerDirectory(casRoot);
    release = acquireLedgerLock(directory, capsuleDigest);
    const replayed = replayLedger(ledgerPath, capsuleDigest);
    const receipt = replayed.receipts[replayed.receipts.length - 1];
    if (receipt === undefined) throw new Error("no admission approval exists for this capsule");
    if (replayed.state !== "approved" || receipt.action !== "gate2-approve") {
      throw new Error(`capsule is not approved: latest receipt action is ${receipt.action}`);
    }

    const finalReviewer = receipt.identities["final-reviewer"];
    if (finalReviewer.kind === "agent") {
      if (receipt.delegation === undefined) {
        throw new Error("an agent final-reviewer approval requires a durable owner delegation");
      }
      if (receipt.delegation.delegator.kind !== "owner") {
        throw new Error("an agent final-reviewer delegation must be issued by an owner");
      }
      if (!receipt.provisional) {
        throw new Error("a delegated agent approval must be provisional");
      }
    }

    return { approved: true, provisional: receipt.provisional, receipt };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw receiptError(errorMessage(error));
  } finally {
    try {
      release?.();
    } catch (error) {
      throw receiptError(`could not release ledger lock: ${errorMessage(error)}`);
    }
  }
}
