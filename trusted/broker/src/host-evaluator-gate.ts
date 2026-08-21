import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RESERVED_EVALUATOR_UID_MAX, RESERVED_EVALUATOR_UID_MIN } from "@hone/schema";

import { deferred } from "./deferred.js";

/**
 * Linux accounts RLIMIT_NPROC against the real uid across container PID
 * namespaces. Evaluators that can consume CAPSULE_WORKER_UID receive a unique
 * host uid lease; frozen evaluators that still hard-code uid 2000 share the
 * starvation-bounded FIFO gate below. Abstract sockets arbitrate live claims.
 * An operator-owned filesystem claim remains until the owning Broker proves
 * its evaluator container gone, so a Broker crash cannot silently return a
 * still-running container's uid to another process.
 */

const SHARED_QUEUE_DIR = join(tmpdir(), "hone-evaluator-nproc-v2.queue");
const SHARED_QUEUE_FILE_RE = /^([0-9a-f]{32})\.json$/;
const SHARED_LIVENESS_PREFIX = "\0hone-evaluator-nproc-ticket-v2-";
const RESERVED_UID_SOCKET_PREFIX = "\0hone-evaluator-nproc-uid-v1-";
const UID_CLAIM_PREFIX = ".uid-claim-";


export interface HostEvaluatorGateLease {
  allocationId: string;
  waitMs: number;
  release: () => Promise<void>;
}

export interface ReservedEvaluatorUidLease extends HostEvaluatorGateLease {
  uid: number;
}

export interface OwnerlessUidClaim {
  claimPath: string;
  workerUid: number;
  ownerAllocationId: string;
  evaluatorContainer: string;
}

export interface UidClaimRecovery {
  onBlocked: (claim: OwnerlessUidClaim) => void | Promise<void>;
  proveContainerAbsent: (claim: OwnerlessUidClaim) => Promise<{ absent: boolean; detail: string }>;
  onTakenOver: (
    claim: OwnerlessUidClaim & { newAllocationId: string; newEvaluatorContainer: string },
  ) => void | Promise<void>;
}


export interface AcquireEvaluatorUidOptions {
  evaluatorContainer: string;
  signal?: AbortSignal;
  onQueued?: (allocationId: string) => void | Promise<void>;
  recovery?: UidClaimRecovery;
}

interface UidClaim {
  version: 1;
  uid: number;
  allocationId: string;
  evaluatorContainer: string;
  createdAt: string;
}


interface ListeningLease {
  server: Server;
  waiters: Set<Socket>;
  state: { releasing: boolean };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortedError();
}

interface QueueEntry {
  version: 1;
  id: string;
  address: string;
  state: "choosing" | "waiting";
  ticket?: number;
}

function abortedError(): Error {
  return new Error("host evaluator gate acquisition aborted");
}

function requireLinux(): void {
  if (process.platform !== "linux") {
    throw new Error("host evaluator isolation requires Linux abstract Unix sockets");
  }
}

function isRetryableConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOENT" || code === "EADDRNOTAVAIL";
}

async function tryListen(address: string, signal?: AbortSignal): Promise<ListeningLease | null> {
  if (signal?.aborted === true) throw abortedError();

  const waiters = new Set<Socket>();
  const state = { releasing: false };
  const server = createServer((socket) => {
    socket.on("error", () => {
      // Close is the only transition the ticket waiter needs.
    });
    if (state.releasing) {
      socket.destroy();
      return;
    }
    waiters.add(socket);
    socket.once("close", () => waiters.delete(socket));
  });
  // A pending bind can report after abort settled the acquisition promise.
  server.on("error", () => {});

  const result = deferred<ListeningLease | null>();
  let settled = false;
  const cleanup = (): void => {
    server.off("error", onError);
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = (value: ListeningLease | null): void => {
    if (settled) return;
    settled = true;
    cleanup();
    result.resolve(value);
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    result.reject(error);
  };
  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EADDRINUSE") finish(null);
    else fail(error);
  };
  const onAbort = (): void => {
    try {
      server.close();
    } catch {
      // A server still blocked in bind is not closeable yet.
    }
    fail(abortedError());
  };

  server.once("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  server.listen(address, () => finish({ server, waiters, state }));
  return await result.promise;
}

async function closeListeningLease(lease: ListeningLease): Promise<void> {
  lease.state.releasing = true;
  for (const waiter of lease.waiters) waiter.destroy();
  const closed = deferred<void>();
  lease.server.close((error) => {
    if (error === undefined) closed.resolve();
    else closed.reject(error);
  });
  await closed.promise;
}

async function socketIsAlive(address: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) throw abortedError();
  const socket = createConnection(address);
  const result = deferred<boolean>();
  let settled = false;
  const cleanup = (): void => {
    signal?.removeEventListener("abort", onAbort);
    socket.removeAllListeners();
  };
  const finish = (alive: boolean): void => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.destroy();
    result.resolve(alive);
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.destroy();
    result.reject(error);
  };
  const onAbort = (): void => fail(abortedError());
  socket.once("connect", () => finish(true));
  socket.once("error", (error) => {
    if (isRetryableConnectError(error)) finish(false);
    else fail(error);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  return await result.promise;
}

/** Wait until the named live ticket/uid holder releases or dies. */
async function waitForRelease(address: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw abortedError();
  const socket = createConnection(address);
  const result = deferred<void>();
  let settled = false;
  const cleanup = (): void => {
    signal?.removeEventListener("abort", onAbort);
    socket.removeAllListeners();
  };
  const finish = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.destroy();
    result.resolve();
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.destroy();
    result.reject(error);
  };
  const onAbort = (): void => fail(abortedError());
  socket.once("close", finish);
  socket.once("error", (error) => {
    // Release can land between directory scan and connect.
    if (isRetryableConnectError(error)) finish();
    else fail(error);
  });
  signal?.addEventListener("abort", onAbort, { once: true });
  await result.promise;
}

async function ensureSharedQueueDir(): Promise<void> {
  await mkdir(SHARED_QUEUE_DIR, { recursive: true, mode: 0o700 });
  const st = await lstat(SHARED_QUEUE_DIR);
  const uid = process.getuid?.();
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("host evaluator FIFO path is not a directory");
  if ((st.mode & 0o777) !== 0o700) throw new Error("host evaluator FIFO directory must be mode 0700");
  if (uid !== undefined && st.uid !== uid) throw new Error("host evaluator FIFO directory is not operator-owned");
}

function uidClaimPath(uid: number): string {
  return join(SHARED_QUEUE_DIR, `${UID_CLAIM_PREFIX}${uid}.json`);
}

function parseUidClaim(raw: string, claimPath: string, expectedUid: number): UidClaim {
  const value = JSON.parse(raw) as Partial<UidClaim>;
  if (
    value.version !== 1
    || value.uid !== expectedUid
    || typeof value.allocationId !== "string"
    || !/^[0-9a-f]{32}$/.test(value.allocationId)
    || typeof value.evaluatorContainer !== "string"
    || !/^hone-[A-Za-z0-9_.-]+-eval-[0-9a-f]{12}$/.test(value.evaluatorContainer)
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error(`invalid host evaluator uid claim at ${claimPath}`);
  }
  return value as UidClaim;
}

async function readUidClaim(claimPath: string, expectedUid: number): Promise<UidClaim> {
  const st = await lstat(claimPath);
  const operatorUid = process.getuid?.();
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`host evaluator uid claim is not regular: ${claimPath}`);
  if ((st.mode & 0o777) !== 0o600) throw new Error(`host evaluator uid claim must be mode 0600: ${claimPath}`);
  if (operatorUid !== undefined && st.uid !== operatorUid) {
    throw new Error(`host evaluator uid claim is not operator-owned: ${claimPath}`);
  }
  return parseUidClaim(await readFile(claimPath, "utf8"), claimPath, expectedUid);
}

async function restoreMovedClaim(movedPath: string, claimPath: string): Promise<void> {
  try {
    await rename(movedPath, claimPath);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await rm(movedPath, { force: true });
  }
}

function ownedClaimRelease(claim: UidClaim, claimPath: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    const movedPath = join(SHARED_QUEUE_DIR, `.release-${claim.uid}-${randomUUID().replaceAll("-", "")}.tmp`);
    try {
      await rename(claimPath, movedPath);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        released = true;
        return;
      }
      throw error;
    }
    try {
      const current = await readUidClaim(movedPath, claim.uid);
      if (current.allocationId !== claim.allocationId) {
        await restoreMovedClaim(movedPath, claimPath);
        released = true;
        return;
      }
      await rm(movedPath, { force: true });
      released = true;
    } catch (error) {
      await restoreMovedClaim(movedPath, claimPath);
      throw error;
    }
  };
}

async function tryCreateUidClaim(
  uid: number,
  allocationId: string,
  evaluatorContainer: string,
): Promise<(() => Promise<void>) | null> {
  const claimPath = uidClaimPath(uid);
  const claim: UidClaim = {
    version: 1,
    uid,
    allocationId,
    evaluatorContainer,
    createdAt: new Date().toISOString(),
  };
  try {
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    await readUidClaim(claimPath, uid);
    return ownedClaimRelease(claim, claimPath);
  } catch (error) {
    await rm(claimPath, { force: true });
    throw error;
  }
}

async function acquireUidClaim(
  uid: number,
  allocationId: string,
  evaluatorContainer: string,
  signal?: AbortSignal,
  recovery?: UidClaimRecovery,
): Promise<() => Promise<void>> {
  for (;;) {
    throwIfAborted(signal);
    const direct = await tryCreateUidClaim(uid, allocationId, evaluatorContainer);
    if (direct !== null) return direct;
    const claimPath = uidClaimPath(uid);
    let owner: UidClaim;
    try {
      owner = await readUidClaim(claimPath, uid);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const ownerless: OwnerlessUidClaim = {
      claimPath,
      workerUid: uid,
      ownerAllocationId: owner.allocationId,
      evaluatorContainer: owner.evaluatorContainer,
    };
    if (recovery === undefined) {
      throw new Error(
        `ownerless host evaluator uid ${uid} claim blocks acquisition at ${claimPath}`
        + ` (container ${owner.evaluatorContainer}, allocation ${owner.allocationId})`,
      );
    }
    await recovery.onBlocked(ownerless);
    const proof = await recovery.proveContainerAbsent(ownerless);
    if (!proof.absent) {
      throw new Error(
        `ownerless host evaluator uid ${uid} claim remains blocked at ${claimPath}`
        + ` (container ${owner.evaluatorContainer}): ${proof.detail}`,
      );
    }

    const movedPath = join(SHARED_QUEUE_DIR, `.takeover-${uid}-${randomUUID().replaceAll("-", "")}.tmp`);
    try {
      throwIfAborted(signal);
      await rename(claimPath, movedPath);
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let release: (() => Promise<void>) | null = null;
    try {
      const moved = await readUidClaim(movedPath, uid);
      if (moved.allocationId !== owner.allocationId) {
        await restoreMovedClaim(movedPath, claimPath);
        continue;
      }
      release = await tryCreateUidClaim(uid, allocationId, evaluatorContainer);
      if (release === null) {
        await restoreMovedClaim(movedPath, claimPath);
        continue;
      }
      await recovery.onTakenOver({
        ...ownerless,
        newAllocationId: allocationId,
        newEvaluatorContainer: evaluatorContainer,
      });
      await rm(movedPath, { force: true });
      return release;
    } catch (error) {
      await release?.();
      await restoreMovedClaim(movedPath, claimPath);
      throw error;
    }
  }
}

function queueEntryPath(id: string): string {
  return join(SHARED_QUEUE_DIR, `${id}.json`);
}

function parseQueueEntry(raw: string, expectedId: string): QueueEntry {
  const value = JSON.parse(raw) as Partial<QueueEntry>;
  if (
    value.version !== 1
    || value.id !== expectedId
    || value.address !== `${SHARED_LIVENESS_PREFIX}${expectedId}`
    || (value.state !== "choosing" && value.state !== "waiting")
    || (value.state === "waiting" && (!Number.isSafeInteger(value.ticket) || (value.ticket ?? 0) <= 0))
  ) {
    throw new Error(`invalid host evaluator FIFO entry ${expectedId}`);
  }
  return value as QueueEntry;
}

async function writeQueueEntry(entry: QueueEntry): Promise<void> {
  const target = queueEntryPath(entry.id);
  const temporary = join(SHARED_QUEUE_DIR, `.${entry.id}.${randomUUID().replaceAll("-", "")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readLiveQueueEntries(selfId: string, signal?: AbortSignal): Promise<QueueEntry[]> {
  const entries: QueueEntry[] = [];
  for (const dirent of await readdir(SHARED_QUEUE_DIR, { withFileTypes: true })) {
    const match = SHARED_QUEUE_FILE_RE.exec(dirent.name);
    if (match === null) continue;
    if (!dirent.isFile()) throw new Error(`host evaluator FIFO entry is not regular: ${dirent.name}`);
    const id = match[1]!;
    let raw: string;
    try {
      raw = await readFile(join(SHARED_QUEUE_DIR, dirent.name), "utf8");
    } catch (error) {
      // A live holder can release between readdir and readFile. Its liveness
      // socket closed before the unlink, so treating the vanished entry as
      // absent is the only correct snapshot result.
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const entry = parseQueueEntry(raw, id);
    if (id === selfId || await socketIsAlive(entry.address, signal)) {
      entries.push(entry);
    } else {
      // An abstract liveness socket is incarnation proof. A dead ticket file is
      // safe to reap; a PID or timestamp alone would not be.
      await rm(queueEntryPath(id), { force: true });
    }
  }
  return entries;
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Acquire the uid-2000 lease through a Lamport bakery queue. The choosing file
 * is published only after the ticket's liveness socket is listening; entrants
 * wait for every overlapping chooser, then for the immediately preceding live
 * ticket. Concurrent doorway arrivals may tie and are ordered by random id,
 * while every later arrival receives a larger ticket: finite holders imply a
 * starvation-bounded FIFO acquisition.
 */
export async function acquireHostEvaluatorGate(
  options: AcquireEvaluatorUidOptions,
): Promise<HostEvaluatorGateLease> {
  const { evaluatorContainer, signal, onQueued, recovery } = options;
  requireLinux();
  if (signal?.aborted === true) throw abortedError();
  await ensureSharedQueueDir();

  const startedMs = Date.now();
  const allocationId = randomUUID().replaceAll("-", "");
  const address = `${SHARED_LIVENESS_PREFIX}${allocationId}`;
  const liveness = await tryListen(address, signal);
  if (liveness === null) throw new Error("host evaluator FIFO allocation id collided");
  const choosing: QueueEntry = { version: 1, id: allocationId, address, state: "choosing" };
  let published = false;
  let released = false;
  let releaseUidClaim: (() => Promise<void>) | undefined;

  const release = async (): Promise<void> => {
    if (released) return;
    try {
      await releaseUidClaim?.();
    } finally {
      await closeListeningLease(liveness);
      if (published) await rm(queueEntryPath(allocationId), { force: true });
      released = true;
    }
  };

  try {
    await writeQueueEntry(choosing);
    published = true;
    const initial = await readLiveQueueEntries(allocationId, signal);
    const maxTicket = initial.reduce((max, entry) => entry.state === "waiting" ? Math.max(max, entry.ticket!) : max, 0);
    const waiting: QueueEntry = { ...choosing, state: "waiting", ticket: maxTicket + 1 };
    await onQueued?.(allocationId);
    await writeQueueEntry(waiting);

    for (;;) {
      throwIfAborted(signal);
      const live = await readLiveQueueEntries(allocationId, signal);
      if (live.some((entry) => entry.id !== allocationId && entry.state === "choosing")) {
        await nextTurn();
        continue;
      }
      const ordered = live
        .filter((entry): entry is QueueEntry & { state: "waiting"; ticket: number } => entry.state === "waiting")
        .sort((left, right) => left.ticket - right.ticket || left.id.localeCompare(right.id));
      const selfIndex = ordered.findIndex((entry) => entry.id === allocationId);
      if (selfIndex < 0) throw new Error("host evaluator FIFO lost its live ticket");
      if (selfIndex === 0) {
        releaseUidClaim = await acquireUidClaim(2_000, allocationId, evaluatorContainer, signal, recovery);
        return { allocationId, waitMs: Date.now() - startedMs, release };
      }
      await waitForRelease(ordered[selfIndex - 1]!.address, signal);
    }
  } catch (error) {
    await release();
    throw error;
  }
}

/**
 * Acquire one collision-free reserved real uid. Each slot has a kernel
 * address plus an operator-owned filesystem claim. Both remain held until the
 * evaluator container is proven reaped. Pool exhaustion waits for any slot
 * claim to clear rather than falling back to shared uid 2000.
 */
export async function acquireReservedEvaluatorUid(
  options: AcquireEvaluatorUidOptions,
): Promise<ReservedEvaluatorUidLease> {
  const { evaluatorContainer, signal, recovery } = options;
  requireLinux();
  if (signal?.aborted === true) throw abortedError();
  await ensureSharedQueueDir();

  const startedMs = Date.now();
  const allocationId = randomUUID().replaceAll("-", "");
  const count = RESERVED_EVALUATOR_UID_MAX - RESERVED_EVALUATOR_UID_MIN + 1;
  const start = Number.parseInt(allocationId.slice(0, 8), 16) % count;

  for (;;) {
    for (let offset = 0; offset < count; offset += 1) {
      const uid = RESERVED_EVALUATOR_UID_MIN + ((start + offset) % count);
      const lease = await tryListen(`${RESERVED_UID_SOCKET_PREFIX}${uid}`, signal);
      if (lease === null) continue;
      let releaseUidClaim: () => Promise<void>;
      try {
        releaseUidClaim = await acquireUidClaim(uid, allocationId, evaluatorContainer, signal, recovery);
      } catch (error) {
        await closeListeningLease(lease);
        throw error;
      }
      let released = false;
      return {
        allocationId,
        uid,
        waitMs: Date.now() - startedMs,
        release: async () => {
          if (released) return;
          try {
            await releaseUidClaim();
          } finally {
            await closeListeningLease(lease);
            released = true;
          }
        },
      };
    }
    try {
      await delay(50, undefined, { signal });
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
  }
}
