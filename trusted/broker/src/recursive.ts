import {
  closeSync,
  chmodSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  BudgetEnvelope,
  ChildRunAdmission,
  ChildRunTerminal,
  ResourceUsage,
  SpawnRunParams,
  SpawnRunResult,
  canonicalJson,
  type RunDepth,
  type SpawnRunParams as SpawnRunRequest,
  type SpawnRunResult as SpawnRunResponse,
  type ChildRunAdmission as ChildRunAdmissionRecord,
} from "@hone/schema";
import { BrokerError } from "./errors.js";

const RESOURCE_DIMENSIONS = [
  ["maxTokens", "tokens"],
  ["maxUsd", "usd"],
  ["maxWallClockSec", "wallClockSec"],
  ["maxEvaluatorInvocations", "evaluatorInvocations"],
] as const;

const AccountLine = z.object({
  v: z.literal(1),
  t: z.literal("account"),
  runId: z.string().min(1),
  depth: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  ancestors: z.array(z.string().min(1)),
  envelope: BudgetEnvelope,
});

const ReservationLine = z.object({
  v: z.literal(1),
  t: z.literal("reservation"),
  ancestors: z.array(z.string().min(1)).min(1),
  request: SpawnRunParams,
  admission: ChildRunAdmission,
});

const UsageLine = z.object({
  v: z.literal(1),
  t: z.literal("usage"),
  runId: z.string().min(1),
  usage: ResourceUsage,
});

const SettlementLine = z.object({
  v: z.literal(1),
  t: z.literal("settlement"),
  childRunId: z.string().min(1),
  usage: ResourceUsage,
  terminal: ChildRunTerminal,
});

const LedgerLine = z.discriminatedUnion("t", [AccountLine, ReservationLine, UsageLine, SettlementLine]);
type LedgerLine = z.infer<typeof LedgerLine>;
type Envelope = z.infer<typeof BudgetEnvelope>;
type Usage = z.infer<typeof ResourceUsage>;
type Terminal = z.infer<typeof ChildRunTerminal>;

interface AccountState {
  depth: RunDepth;
  ancestors: string[];
  envelope: Envelope;
  remaining: Envelope;
  directUsage: Usage;
  closed: boolean;
}

interface ReservationState {
  ancestors: string[];
  request: SpawnRunRequest;
  admission: ChildRunAdmissionRecord;
  usage?: Usage;
  terminal?: Terminal;
}

export interface RecursiveBudgetState {
  runId: string;
  depth: RunDepth;
  envelope: Envelope;
  remaining: Envelope;
  closed: boolean;
  directUsage: Usage;
  reservations: number;
  openReservations: number;
}

export interface RecursiveReservationAdmission {
  request: SpawnRunRequest;
  admission: ChildRunAdmissionRecord;
  replay: boolean;
  settled: SpawnRunResponse | undefined;
}

const openedLedgers = new Map<string, RecursiveResourceLedger>();

function copyEnvelope(envelope: Envelope): Envelope {
  return { ...envelope };
}

function copyUsage(usage: Usage): Usage {
  return { ...usage };
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Trusted, durable authority for recursive componentwise reservations.
 * One shared instance is passed to every broker in a recursive run tree.
 */
export class RecursiveResourceLedger {
  private readonly accounts = new Map<string, AccountState>();
  private readonly reservations = new Map<string, ReservationState>();
  private poisoned: string | undefined;
  private closed = false;

  private constructor(
    readonly filePath: string,
    private readonly fd: number,
  ) {}

  static open(filePath: string): RecursiveResourceLedger {
    const resolved = path.resolve(filePath);
    if (openedLedgers.has(resolved)) {
      throw new BrokerError("INTERNAL", `recursive resource ledger is already open: ${resolved}`);
    }

    const dir = path.dirname(resolved);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let content = Buffer.alloc(0);
    try {
      content = readFileSync(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const keep = content.lastIndexOf(0x0a) + 1;
    const fd = openSync(resolved, "a", 0o600);
    try {
      chmodSync(resolved, 0o600);
      if (keep !== content.length) ftruncateSync(fd, keep);
      fsyncSync(fd);
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }

      const ledger = new RecursiveResourceLedger(resolved, fd);
      const lines = content.subarray(0, keep).toString("utf8").split("\n");
      lines.pop();
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        try {
          ledger.apply(LedgerLine.parse(JSON.parse(raw ?? "")));
        } catch (error) {
          throw new BrokerError(
            "INTERNAL",
            `recursive resource ledger corrupt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      openedLedgers.set(resolved, ledger);
      return ledger;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  registerRun(runId: string, depth: RunDepth, ancestors: readonly string[], envelopeInput: Envelope): void {
    this.assertUsable();
    const envelope = BudgetEnvelope.parse(envelopeInput);
    this.validateChain(runId, depth, ancestors);
    const existing = this.accounts.get(runId);
    if (existing !== undefined) {
      if (existing.depth !== depth || !same(existing.ancestors, ancestors) || !same(existing.envelope, envelope)) {
        throw new BrokerError("INTERNAL", `recursive run identity collision: ${runId}`);
      }
      return;
    }
    if (depth !== 0) {
      throw new BrokerError("INTERNAL", `recursive child ${runId} has no durable ancestor reservation`);
    }
    const line = AccountLine.parse({ v: 1, t: "account", runId, depth, ancestors: [...ancestors], envelope });
    this.append(line);
    this.apply(line);
  }

  syncRunUsage(runId: string, usageInput: Usage): void {
    this.assertUsable();
    const usage = ResourceUsage.parse(usageInput);
    const account = this.accounts.get(runId);
    if (account === undefined || account.closed) {
      throw new BrokerError("RESERVATION_EXCEEDED", `recursive resource account is unavailable: ${runId}`);
    }
    let changed = false;
    for (const [envelopeKey, usageKey] of RESOURCE_DIMENSIONS) {
      const delta = usage[usageKey] - account.directUsage[usageKey];
      if (delta < 0) throw new BrokerError("INTERNAL", `recursive direct usage rewound ${usageKey} for ${runId}`);
      if (delta > account.remaining[envelopeKey]) {
        throw new BrokerError("BUDGET_EXCEEDED", `recursive direct usage exceeded ${envelopeKey} for ${runId}`);
      }
      if (delta > 0) changed = true;
    }
    if (!changed) return;
    const line = UsageLine.parse({ v: 1, t: "usage", runId, usage });
    this.append(line);
    this.apply(line);
  }

  hasChild(childRunId: string): boolean {
    return this.reservations.has(childRunId);
  }

  reserveChild(
    requestInput: SpawnRunRequest,
    ancestorsInput: readonly string[],
    admissionInput: ChildRunAdmissionRecord,
  ): RecursiveReservationAdmission {
    this.assertUsable();
    const request = SpawnRunParams.parse(requestInput);
    const admission = ChildRunAdmission.parse(admissionInput);
    const ancestors = [...ancestorsInput];
    const childRunId = request.child.runId;
    this.validateChain(childRunId, request.depth, ancestors);

    const duplicate = this.reservations.get(childRunId);
    if (duplicate !== undefined) {
      if (!same(duplicate.request, request) || !same(duplicate.ancestors, ancestors) || !same(duplicate.admission, admission)) {
        throw new BrokerError("INTERNAL", `durable child identity collision: ${childRunId}`);
      }
      return {
        request: SpawnRunParams.parse(duplicate.request),
        admission: ChildRunAdmission.parse(duplicate.admission),
        replay: true,
        settled: this.resultFor(duplicate),
      };
    }

    this.assertReservationFits(request, ancestors);

    const line = ReservationLine.parse({ v: 1, t: "reservation", ancestors, request, admission });
    this.append(line);
    this.apply(line);
    const stored = this.reservations.get(childRunId);
    if (stored === undefined) throw new BrokerError("INTERNAL", "recursive reservation was not applied");
    return {
      request: SpawnRunParams.parse(stored.request),
      admission: ChildRunAdmission.parse(stored.admission),
      replay: false,
      settled: undefined,
    };
  }

  settleChild(childRunId: string, usageInput: Usage, terminalInput: Terminal): SpawnRunResponse {
    this.assertUsable();
    const usage = ResourceUsage.parse(usageInput);
    const terminal = ChildRunTerminal.parse(terminalInput);
    const reservation = this.reservations.get(childRunId);
    if (reservation === undefined) throw new BrokerError("INTERNAL", `unknown recursive child: ${childRunId}`);
    if (terminal.runId !== childRunId) throw new BrokerError("INTERNAL", "terminal event belongs to a different child run");

    if (reservation.usage !== undefined && reservation.terminal !== undefined) {
      if (!same(reservation.usage, usage) || !same(reservation.terminal, terminal)) {
        throw new BrokerError("INTERNAL", `conflicting settlement replay for child ${childRunId}`);
      }
      const replayed = this.resultFor(reservation);
      if (replayed === undefined) throw new BrokerError("INTERNAL", "settled recursive result is missing");
      return replayed;
    }

    for (const [envelopeKey, usageKey] of RESOURCE_DIMENSIONS) {
      if (usage[usageKey] > reservation.request.reservation[envelopeKey]) {
        throw new BrokerError("RESERVATION_EXCEEDED", `child ${childRunId} exceeded reserved ${envelopeKey}`);
      }
    }
    const childAccount = this.accounts.get(childRunId);
    if (childAccount === undefined || !same(childAccount.directUsage, usage)) {
      throw new BrokerError("INTERNAL", `child ${childRunId} usage is not durably synchronized`);
    }
    const openDescendant = [...this.reservations.entries()].find(
      ([otherRunId, other]) => otherRunId !== childRunId && other.terminal === undefined && other.ancestors.includes(childRunId),
    );
    if (openDescendant !== undefined) {
      throw new BrokerError("INTERNAL", `child ${childRunId} cannot settle with open descendant ${openDescendant[0]}`);
    }

    const line = SettlementLine.parse({ v: 1, t: "settlement", childRunId, usage, terminal });
    this.append(line);
    this.apply(line);
    const settled = this.reservations.get(childRunId);
    const result = settled === undefined ? undefined : this.resultFor(settled);
    if (result === undefined) throw new BrokerError("INTERNAL", "recursive settlement was not applied");
    return result;
  }

  budgetState(runId: string): RecursiveBudgetState {
    const account = this.accounts.get(runId);
    if (account === undefined) throw new BrokerError("INTERNAL", `unknown recursive resource account: ${runId}`);
    const reservations = [...this.reservations.values()].filter((reservation) => reservation.ancestors.includes(runId));
    return {
      runId,
      depth: account.depth,
      envelope: copyEnvelope(account.envelope),
      remaining: copyEnvelope(account.remaining),
      directUsage: copyUsage(account.directUsage),
      closed: account.closed,
      reservations: reservations.length,
      openReservations: reservations.filter((reservation) => reservation.terminal === undefined).length,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    openedLedgers.delete(this.filePath);
    if (this.poisoned === undefined) closeSync(this.fd);
  }

  private apply(line: LedgerLine): void {
    switch (line.t) {
      case "account": {
        if (this.accounts.has(line.runId)) throw new Error(`duplicate recursive account: ${line.runId}`);
        this.validateChain(line.runId, line.depth, line.ancestors);
        this.accounts.set(line.runId, {
          depth: line.depth,
          ancestors: [...line.ancestors],
          envelope: copyEnvelope(line.envelope),
          remaining: copyEnvelope(line.envelope),
          directUsage: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
          closed: false,
        });
        return;
      }
      case "reservation": {
        const childRunId = line.request.child.runId;
        if (this.reservations.has(childRunId) || this.accounts.has(childRunId)) {
          throw new Error(`duplicate recursive child identity: ${childRunId}`);
        }
        this.assertReservationFits(line.request, line.ancestors);
        for (const ancestorRunId of line.ancestors) {
          const account = this.accounts.get(ancestorRunId);
          if (account === undefined) throw new Error(`missing recursive ancestor: ${ancestorRunId}`);
          for (const [envelopeKey] of RESOURCE_DIMENSIONS) {
            account.remaining[envelopeKey] -= line.request.reservation[envelopeKey];
          }
        }
        this.reservations.set(childRunId, {
          ancestors: [...line.ancestors],
          request: SpawnRunParams.parse(line.request),
          admission: ChildRunAdmission.parse(line.admission),
        });
        this.accounts.set(childRunId, {
          depth: line.request.depth,
          ancestors: [...line.ancestors],
          envelope: copyEnvelope(line.request.reservation),
          remaining: copyEnvelope(line.request.reservation),
          directUsage: { tokens: 0, usd: 0, wallClockSec: 0, evaluatorInvocations: 0 },
          closed: false,
        });
        return;
      }
      case "usage": {
        const account = this.accounts.get(line.runId);
        if (account === undefined || account.closed) throw new Error(`unavailable recursive usage account: ${line.runId}`);
        for (const [envelopeKey, usageKey] of RESOURCE_DIMENSIONS) {
          const delta = line.usage[usageKey] - account.directUsage[usageKey];
          if (delta < 0 || delta > account.remaining[envelopeKey]) {
            throw new Error(`invalid recursive direct usage for ${line.runId} ${usageKey}`);
          }
        }
        for (const [envelopeKey, usageKey] of RESOURCE_DIMENSIONS) {
          account.remaining[envelopeKey] -= line.usage[usageKey] - account.directUsage[usageKey];
        }
        account.directUsage = copyUsage(line.usage);
        return;
      }
      case "settlement": {
        const reservation = this.reservations.get(line.childRunId);
        if (reservation === undefined || reservation.terminal !== undefined) {
          throw new Error(`invalid recursive settlement: ${line.childRunId}`);
        }
        if (line.terminal.runId !== line.childRunId) throw new Error("recursive settlement terminal identity mismatch");
        const childAccount = this.accounts.get(line.childRunId);
        if (childAccount === undefined || !same(childAccount.directUsage, line.usage)) {
          throw new Error(`recursive settlement has unsynchronized child usage: ${line.childRunId}`);
        }
        for (const [envelopeKey, usageKey] of RESOURCE_DIMENSIONS) {
          if (line.usage[usageKey] > reservation.request.reservation[envelopeKey]) {
            throw new Error(`recursive settlement exceeds ${envelopeKey}`);
          }
        }
        const openDescendant = [...this.reservations.entries()].find(
          ([otherRunId, other]) =>
            otherRunId !== line.childRunId &&
            other.terminal === undefined &&
            other.ancestors.includes(line.childRunId),
        );
        if (openDescendant !== undefined) {
          throw new Error(`recursive settlement has open descendant: ${openDescendant[0]}`);
        }
        for (const ancestorRunId of reservation.ancestors) {
          const account = this.accounts.get(ancestorRunId);
          if (account === undefined) throw new Error(`missing recursive ancestor: ${ancestorRunId}`);
          for (const [envelopeKey, usageKey] of RESOURCE_DIMENSIONS) {
            account.remaining[envelopeKey] += reservation.request.reservation[envelopeKey] - line.usage[usageKey];
          }
        }
        reservation.usage = copyUsage(line.usage);
        reservation.terminal = { ...line.terminal };
        const child = this.accounts.get(line.childRunId);
        if (child === undefined) throw new Error(`missing recursive child account: ${line.childRunId}`);
        child.closed = true;
        return;
      }
    }
  }

  private resultFor(reservation: ReservationState): SpawnRunResponse | undefined {
    if (reservation.usage === undefined || reservation.terminal === undefined) return undefined;
    return SpawnRunResult.parse({
      child: reservation.request.child,
      depth: reservation.request.depth,
      reservation: reservation.request.reservation,
      usage: reservation.usage,
      terminal: reservation.terminal,
    });
  }

  private assertReservationFits(request: SpawnRunRequest, ancestors: readonly string[]): void {
    const childRunId = request.child.runId;
    this.validateChain(childRunId, request.depth, ancestors);
    const parentRunId = ancestors[ancestors.length - 1];
    const parent = parentRunId === undefined ? undefined : this.accounts.get(parentRunId);
    if (parent === undefined || parent.closed) {
      throw new BrokerError("RESERVATION_EXCEEDED", `recursive parent is unavailable: ${parentRunId ?? "missing"}`);
    }
    if (parent.depth !== request.depth - 1 || !same([...parent.ancestors, parentRunId], ancestors)) {
      throw new BrokerError("DEPTH_EXCEEDED", "child depth does not match its durable ancestor chain");
    }
    if (parent.depth === 0 && request.child.purpose !== "capsule") {
      throw new BrokerError("DEPTH_EXCEEDED", "depth-0 controllers may spawn only depth-1 capsule runs");
    }
    if (parent.depth === 1 && request.child.purpose === "capsule") {
      throw new BrokerError("DEPTH_EXCEEDED", "depth-1 optimizers may spawn only a delegated or self-A/B depth-2 run");
    }
    if (
      parent.depth === 1 &&
      [...this.reservations.values()].some(
        (reservation) => reservation.ancestors[reservation.ancestors.length - 1] === parentRunId,
      )
    ) {
      throw new BrokerError("DEPTH_EXCEEDED", "a depth-1 optimizer may reserve exactly one depth-2 child run");
    }
    for (const ancestorRunId of ancestors) {
      const account = this.accounts.get(ancestorRunId);
      if (account === undefined || account.closed) {
        throw new BrokerError("RESERVATION_EXCEEDED", `recursive ancestor is unavailable: ${ancestorRunId}`);
      }
      for (const [envelopeKey] of RESOURCE_DIMENSIONS) {
        if (account.remaining[envelopeKey] < request.reservation[envelopeKey]) {
          throw new BrokerError("RESERVATION_EXCEEDED", `ancestor ${ancestorRunId} has insufficient ${envelopeKey}`);
        }
      }
    }
  }

  private validateChain(runId: string, depth: RunDepth, ancestors: readonly string[]): void {
    if (ancestors.length !== depth) throw new BrokerError("DEPTH_EXCEEDED", `depth ${depth} requires ${depth} ancestors`);
    if (new Set(ancestors).size !== ancestors.length || ancestors.includes(runId)) {
      throw new BrokerError("DEPTH_EXCEEDED", "recursive ancestor chain must be unique and exclude the child");
    }
  }

  private append(line: LedgerLine): void {
    this.assertUsable();
    const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset);
      fsyncSync(this.fd);
    } catch (error) {
      this.poisoned = error instanceof Error ? error.message : String(error);
      try {
        closeSync(this.fd);
      } catch {
        // The original durability failure wins.
      }
      throw new BrokerError("INTERNAL", `recursive resource ledger append failed: ${this.poisoned}`);
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new BrokerError("INTERNAL", "recursive resource ledger is closed");
    if (this.poisoned !== undefined) {
      throw new BrokerError("INTERNAL", `recursive resource ledger is poisoned: ${this.poisoned}`);
    }
  }
}
