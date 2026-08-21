import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RESERVED_EVALUATOR_UID_MAX, RESERVED_EVALUATOR_UID_MIN } from "@hone/schema";
import {
  acquireHostEvaluatorGate,
  acquireReservedEvaluatorUid,
  type HostEvaluatorGateLease,
  type OwnerlessUidClaim,
  type ReservedEvaluatorUidLease,
  type UidClaimRecovery,
} from "../src/host-evaluator-gate.js";
import { evaluatorSupportsReservedUid } from "../src/evaluator-isolation.js";
import { deferred } from "../src/deferred.js";

let containerSequence = 0;
function nextEvaluatorContainer(label: string): string {
  containerSequence += 1;
  return `hone-test-${label}-eval-${containerSequence.toString(16).padStart(12, "0")}`;
}

function serializedClaim(uid: number, allocationId: string, evaluatorContainer: string): string {
  return `${JSON.stringify({
    version: 1,
    uid,
    allocationId,
    evaluatorContainer,
    createdAt: "2026-08-21T00:00:00.000Z",
  })}\n`;
}

function recoveryProbe(absent: boolean = true): {
  blocked: OwnerlessUidClaim[];
  takenOver: Array<OwnerlessUidClaim & { newAllocationId: string; newEvaluatorContainer: string }>;
  recovery: UidClaimRecovery;
} {
  const blocked: OwnerlessUidClaim[] = [];
  const takenOver: Array<OwnerlessUidClaim & { newAllocationId: string; newEvaluatorContainer: string }> = [];
  return {
    blocked,
    takenOver,
    recovery: {
      onBlocked: (claim) => {
        blocked.push(claim);
      },
      proveContainerAbsent: async () => ({ absent, detail: absent ? "container absent" : "container still live" }),
      onTakenOver: (claim) => {
        takenOver.push(claim);
      },
    },
  };
}

describe("host evaluator gate", () => {
  it("serializes four concurrent evaluator sections at the M2 child-concurrency shape", { timeout: 10_000 }, async () => {
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];

    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const lease = await acquireHostEvaluatorGate({ evaluatorContainer: nextEvaluatorContainer(`concurrent-${index}`) });
      try {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const turn = deferred<void>();
        setImmediate(turn.resolve);
        await turn.promise;
        completed.push(index);
        active -= 1;
      } finally {
        await lease.release();
      }
    }));

    expect(maxActive).toBe(1);
    expect(completed).toHaveLength(4);
  });

  it("does not let a waiting broker burn work after shutdown", { timeout: 10_000 }, async () => {
    const lease = await acquireHostEvaluatorGate({ evaluatorContainer: nextEvaluatorContainer("shutdown-holder") });
    const controller = new AbortController();
    const waiting = acquireHostEvaluatorGate({
      evaluatorContainer: nextEvaluatorContainer("shutdown-waiter"),
      signal: controller.signal,
    });

    controller.abort();
    await expect(waiting).rejects.toThrow("host evaluator gate acquisition aborted");
    await lease.release();

    const leaseAfterAbort = await acquireHostEvaluatorGate({ evaluatorContainer: nextEvaluatorContainer("after-abort") });
    await leaseAfterAbort.release();
  });

  it("allows an idempotent release without opening overlapping leases", async () => {
    const lease = await acquireHostEvaluatorGate({ evaluatorContainer: nextEvaluatorContainer("idempotent") });
    await lease.release();
    await lease.release();

    const next = await acquireHostEvaluatorGate({ evaluatorContainer: nextEvaluatorContainer("idempotent-next") });
    await next.release();
  });

  it("admits shared-uid waiters in starvation-bounded FIFO order", { timeout: 10_000 }, async () => {
    const holder = await acquireHostEvaluatorGate({ evaluatorContainer: nextEvaluatorContainer("fifo-holder") });
    const aQueued = deferred<void>();
    const bQueued = deferred<void>();
    const aPromise = acquireHostEvaluatorGate({
      evaluatorContainer: nextEvaluatorContainer("fifo-a"),
      onQueued: () => aQueued.resolve(),
    });
    await aQueued.promise;
    const bPromise = acquireHostEvaluatorGate({
      evaluatorContainer: nextEvaluatorContainer("fifo-b"),
      onQueued: () => bQueued.resolve(),
    });
    await bQueued.promise;

    await holder.release();
    const a = await aPromise;
    let bAcquired = false;
    void bPromise.then(() => { bAcquired = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bAcquired).toBe(false);
    await a.release();
    const b = await bPromise;
    await b.release();
  });

  it("allocates collision-free reserved real uids and releases their slots", async () => {
    const leases = await Promise.all(Array.from(
      { length: 4 },
      (_, index) => acquireReservedEvaluatorUid({ evaluatorContainer: nextEvaluatorContainer(`reserved-${index}`) }),
    ));
    const uids = leases.map((lease) => lease.uid);
    expect(new Set(uids).size).toBe(4);
    expect(uids.every((uid) => uid >= RESERVED_EVALUATOR_UID_MIN && uid <= RESERVED_EVALUATOR_UID_MAX)).toBe(true);
    await Promise.all(leases.map((lease) => lease.release()));
  });

  it("diagnoses and takes over an ownerless shared-uid claim only after container-absence proof", async () => {
    const queueDir = join(tmpdir(), "hone-evaluator-nproc-v2.queue");
    const claimPath = join(queueDir, ".uid-claim-2000.json");
    const ownerAllocationId = "a".repeat(32);
    const ownerContainer = "hone-orphan-shared-eval-deadbeef0001";
    await mkdir(queueDir, { recursive: true, mode: 0o700 });
    await writeFile(claimPath, serializedClaim(2_000, ownerAllocationId, ownerContainer), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    let lease: HostEvaluatorGateLease | undefined;
    try {
      const blockedProbe = recoveryProbe(false);
      await expect(acquireHostEvaluatorGate({
        evaluatorContainer: nextEvaluatorContainer("shared-blocked"),
        recovery: blockedProbe.recovery,
      })).rejects.toThrow(claimPath);
      expect(blockedProbe.blocked).toEqual([
        { claimPath, workerUid: 2_000, ownerAllocationId, evaluatorContainer: ownerContainer },
      ]);

      const takeoverProbe = recoveryProbe();
      const newContainer = nextEvaluatorContainer("shared-takeover");
      lease = await acquireHostEvaluatorGate({ evaluatorContainer: newContainer, recovery: takeoverProbe.recovery });
      expect(takeoverProbe.takenOver).toEqual([
        expect.objectContaining({
          claimPath,
          workerUid: 2_000,
          ownerAllocationId,
          evaluatorContainer: ownerContainer,
          newAllocationId: lease.allocationId,
          newEvaluatorContainer: newContainer,
        }),
      ]);
      expect(JSON.parse(await readFile(claimPath, "utf8"))).toMatchObject({
        allocationId: lease.allocationId,
        evaluatorContainer: newContainer,
      });
    } finally {
      await lease?.release();
      await rm(claimPath, { force: true });
    }
  });

  it("takes over an ownerless reserved claim instead of permanently shrinking the pool", { timeout: 10_000 }, async () => {
    const queueDir = join(tmpdir(), "hone-evaluator-nproc-v2.queue");
    const leases: ReservedEvaluatorUidLease[] = [];
    let finalLease: ReservedEvaluatorUidLease | undefined;
    let claimPath = "";
    await mkdir(queueDir, { recursive: true, mode: 0o700 });
    try {
      for (let index = RESERVED_EVALUATOR_UID_MIN; index < RESERVED_EVALUATOR_UID_MAX; index += 1) {
        leases.push(await acquireReservedEvaluatorUid({
          evaluatorContainer: nextEvaluatorContainer(`reserved-holder-${index}`),
        }));
      }
      const occupied = new Set(leases.map((lease) => lease.uid));
      const orphanUid = Array.from(
        { length: RESERVED_EVALUATOR_UID_MAX - RESERVED_EVALUATOR_UID_MIN + 1 },
        (_, index) => RESERVED_EVALUATOR_UID_MIN + index,
      ).find((uid) => !occupied.has(uid));
      expect(orphanUid).toBeDefined();
      claimPath = join(queueDir, `.uid-claim-${orphanUid}.json`);
      const ownerAllocationId = "b".repeat(32);
      const ownerContainer = "hone-orphan-reserved-eval-deadbeef0002";
      await writeFile(claimPath, serializedClaim(orphanUid!, ownerAllocationId, ownerContainer), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const probe = recoveryProbe();
      finalLease = await acquireReservedEvaluatorUid({
        evaluatorContainer: nextEvaluatorContainer("reserved-takeover"),
        recovery: probe.recovery,
      });
      expect(finalLease.uid).toBe(orphanUid);
      expect(probe.takenOver).toHaveLength(1);
      expect(probe.takenOver[0]).toMatchObject({ claimPath, ownerAllocationId, evaluatorContainer: ownerContainer });
    } finally {
      await finalLease?.release();
      await rm(claimPath, { force: true });
      await Promise.all(leases.map((lease) => lease.release()));
    }
  });

  it("will not delete a uid claim that a different allocation took over", async () => {
    const lease = await acquireReservedEvaluatorUid({ evaluatorContainer: nextEvaluatorContainer("release-owner") });
    const claimPath = join(tmpdir(), "hone-evaluator-nproc-v2.queue", `.uid-claim-${lease.uid}.json`);
    const replacementAllocationId = "c".repeat(32);
    const replacementContainer = "hone-replacement-owner-eval-cafebabe0001";
    try {
      expect(JSON.parse(await readFile(claimPath, "utf8"))).toMatchObject({
        allocationId: lease.allocationId,
        evaluatorContainer: expect.stringContaining("release-owner"),
      });
      await writeFile(claimPath, serializedClaim(lease.uid, replacementAllocationId, replacementContainer), "utf8");
      await lease.release();
      expect(JSON.parse(await readFile(claimPath, "utf8"))).toMatchObject({
        allocationId: replacementAllocationId,
        evaluatorContainer: replacementContainer,
      });
    } finally {
      await lease.release();
      await rm(claimPath, { force: true });
    }
  });

  it("uses reserved uids only for reviewed frozen evaluator identities", () => {
    expect(evaluatorSupportsReservedUid("cap_21e8600c6f5a")).toBe(true);
    expect(evaluatorSupportsReservedUid("cap_d1f91ea72bcc")).toBe(false);
    expect(evaluatorSupportsReservedUid("cap_future_unknown")).toBe(false);
  });
});
