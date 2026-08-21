import { describe, expect, it } from "vitest";
import {
  RESERVED_EVALUATOR_UID_MAX,
  RESERVED_EVALUATOR_UID_MIN,
  acquireHostEvaluatorGate,
  acquireReservedEvaluatorUid,
} from "../src/host-evaluator-gate.js";
import { evaluatorSupportsReservedUid } from "../src/evaluator-isolation.js";
import { deferred } from "../src/deferred.js";


describe("host evaluator gate", () => {
  it("serializes four concurrent evaluator sections at the M2 child-concurrency shape", { timeout: 10_000 }, async () => {
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];

    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const lease = await acquireHostEvaluatorGate();
      try {
        active += 1;
        maxActive = Math.max(maxActive, active);
        // This is an integration test of the kernel socket claim itself. One
        // event-loop turn (not wall-clock time) lets every competing bind run.
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
    const lease = await acquireHostEvaluatorGate();
    const controller = new AbortController();
    const waiting = acquireHostEvaluatorGate(controller.signal);

    controller.abort();
    await expect(waiting).rejects.toThrow("host evaluator gate acquisition aborted");
    await lease.release();

    const leaseAfterAbort = await acquireHostEvaluatorGate();
    await leaseAfterAbort.release();
  });

  it("allows an idempotent release without opening overlapping leases", async () => {
    const lease = await acquireHostEvaluatorGate();
    await lease.release();
    await lease.release();

    const next = await acquireHostEvaluatorGate();
    await next.release();
  });

  it("admits shared-uid waiters in starvation-bounded FIFO order", { timeout: 10_000 }, async () => {
    const holder = await acquireHostEvaluatorGate();
    const aQueued = deferred<void>();
    const bQueued = deferred<void>();
    const aPromise = acquireHostEvaluatorGate(undefined, () => aQueued.resolve());
    await aQueued.promise;
    const bPromise = acquireHostEvaluatorGate(undefined, () => bQueued.resolve());
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
    const leases = await Promise.all(Array.from({ length: 4 }, () => acquireReservedEvaluatorUid()));
    const uids = leases.map((lease) => lease.uid);
    expect(new Set(uids).size).toBe(4);
    expect(uids.every((uid) => uid >= RESERVED_EVALUATOR_UID_MIN && uid <= RESERVED_EVALUATOR_UID_MAX)).toBe(true);
    await Promise.all(leases.map((lease) => lease.release()));
  });

  it("uses reserved uids only for reviewed frozen evaluator identities", () => {
    expect(evaluatorSupportsReservedUid("cap_21e8600c6f5a")).toBe(true);
    expect(evaluatorSupportsReservedUid("cap_d1f91ea72bcc")).toBe(false);
    expect(evaluatorSupportsReservedUid("cap_future_unknown")).toBe(false);
  });
});
