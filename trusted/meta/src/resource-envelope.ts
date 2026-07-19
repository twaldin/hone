import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  BudgetEnvelope as BudgetEnvelopeSchema,
  M2EnvelopeIdentity as M2EnvelopeIdentitySchema,
  M2RecursiveBudgets as M2RecursiveBudgetsSchema,
  canonicalJson,
  type BudgetEnvelope,
  type M2EnvelopeIdentity,
  type M2RecursiveBudgets,
} from "@hone/schema";
import { z } from "zod";

const DIGEST = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const SAFE_ID = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const ResourceUsage = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().finite().nonnegative(),
  wallClockSec: z.number().finite().nonnegative(),
  evaluatorInvocations: z.number().int().nonnegative(),
}).strict();

const ReservationRequest = z.object({
  reservationId: SAFE_ID,
  parentReservationId: SAFE_ID.nullable(),
  reserved: BudgetEnvelopeSchema,
}).strict();

const ReservationRecord = ReservationRequest.extend({
  version: z.literal(1),
  type: z.literal("reservation"),
  envelope: M2EnvelopeIdentitySchema,
  depth: z.union([z.literal(1), z.literal(2)]),
}).strict();

const SettlementRecord = z.object({
  version: z.literal(1),
  type: z.literal("settlement"),
  reservationId: SAFE_ID,
  observed: ResourceUsage,
}).strict();


const RecordFileHeader = z.object({
  version: z.literal(1),
  type: z.literal("header"),
  ledgerId: DIGEST,
}).strict();
const AllocationRecord = z.discriminatedUnion("type", [ReservationRecord, SettlementRecord]);

export interface MetaEnvelopeReservationRequest {
  readonly reservationId: string;
  readonly parentReservationId: string | null;
  readonly reserved: BudgetEnvelope;
}

export interface MetaEnvelopeResourceUsage {
  readonly tokens: number;
  readonly usd: number;
  readonly wallClockSec: number;
  readonly evaluatorInvocations: number;
}

export type MetaEnvelopeAllocationRecord = z.infer<typeof AllocationRecord>;

/**
 * The append must be durable before returning. A restart supplies every record
 * from readAll in original append order, making reservation identity the
 * idempotency key rather than relying on best-effort in-memory deduplication.
 */
export interface MetaEnvelopeRecordPort {
  readAll(): readonly unknown[];
  append(record: MetaEnvelopeAllocationRecord): void;
}

export interface MetaEnvelopeReservation {
  readonly reservationId: string;
  readonly parentReservationId: string | null;
  readonly envelope: M2EnvelopeIdentity;
  readonly depth: 1 | 2;
  readonly reserved: BudgetEnvelope;
  readonly observed: MetaEnvelopeResourceUsage | null;
  readonly settled: boolean;
}

interface MutableReservation {
  request: z.infer<typeof ReservationRecord>;
  observed: z.infer<typeof ResourceUsage> | null;
}

type Purpose = M2EnvelopeIdentity["purpose"];
type BudgetDimension = keyof BudgetEnvelope;

const BUDGET_DIMENSIONS: readonly BudgetDimension[] = [
  "maxTokens",
  "maxUsd",
  "maxWallClockSec",
  "maxEvaluatorInvocations",
];

const USAGE_BY_BUDGET: Record<BudgetDimension, keyof MetaEnvelopeResourceUsage> = {
  maxTokens: "tokens",
  maxUsd: "usd",
  maxWallClockSec: "wallClockSec",
  maxEvaluatorInvocations: "evaluatorInvocations",
};

/** Owner-only append/fsync record port suitable for production campaign wiring. */
export class MetaEnvelopeFileRecordPortV1 implements MetaEnvelopeRecordPort {
  private closed = false;

  private constructor(
    readonly file: string,
    readonly ledgerId: string,
    private readonly fd: number,
    private readonly rows: MetaEnvelopeAllocationRecord[],
  ) {}

  static open(fileInput: string, ledgerIdInput: string): MetaEnvelopeFileRecordPortV1 {
    const file = path.resolve(fileInput);
    const ledgerId = DIGEST.parse(ledgerIdInput);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let createdFd: number | null = null;
    try {
      createdFd = openSync(
        file,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      writeBytes(createdFd, Buffer.from(`${canonicalJson({ version: 1, type: "header", ledgerId })}\n`));
      fsyncSync(createdFd);
      closeSync(createdFd);
      createdFd = null;
    } catch (error) {
      if (createdFd !== null) closeSync(createdFd);
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : null;
      if (code !== "EEXIST") throw error;
    }

    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`meta envelope record path is not a regular owner file: ${file}`);
    }
    const owner = process.getuid?.();
    if (owner !== undefined && stat.uid !== owner) {
      throw new Error(`meta envelope record file is not owned by the current uid: ${file}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(file, 0o600);
    }
    const content = readFileSync(file, "utf8");
    if (!content.endsWith("\n")) {
      throw new Error(`meta envelope record file has a torn final line: ${file}`);
    }
    const lines = content.slice(0, -1).split("\n");
    const header = RecordFileHeader.parse(JSON.parse(lines[0] ?? ""));
    if (header.ledgerId !== ledgerId) {
      throw new Error(`meta envelope ledger ${header.ledgerId} does not match ${ledgerId}`);
    }
    const rows = lines.slice(1).map((line, index) => {
      try {
        return AllocationRecord.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(
          `meta envelope record is corrupt at line ${index + 2}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND);
    return new MetaEnvelopeFileRecordPortV1(file, ledgerId, fd, rows);
  }

  readAll(): readonly MetaEnvelopeAllocationRecord[] {
    if (this.closed) throw new Error("meta envelope record port is closed");
    return structuredClone(this.rows);
  }

  append(recordInput: MetaEnvelopeAllocationRecord): void {
    if (this.closed) throw new Error("meta envelope record port is closed");
    const record = AllocationRecord.parse(recordInput);
    writeBytes(this.fd, Buffer.from(`${canonicalJson(record)}\n`));
    fsyncSync(this.fd);
    this.rows.push(record);
  }

  close(): void {
    if (this.closed) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.closed = true;
  }
}

/**
 * Trusted, replayable componentwise allocator for one campaign cell.
 * Search, confirmation, and terminal methods select their authority envelope;
 * optimizer input never chooses a pool and therefore cannot cross-borrow.
 */
export class MetaResourceEnvelopeLedger {
  readonly budgets: M2RecursiveBudgets;
  private readonly reservations = new Map<string, MutableReservation>();

  constructor(
    budgetsInput: M2RecursiveBudgets,
    private readonly records: MetaEnvelopeRecordPort,
  ) {
    this.budgets = M2RecursiveBudgetsSchema.parse(budgetsInput);
    for (const input of records.readAll()) this.replay(AllocationRecord.parse(input));
  }

  reserveSearchDescendant(input: MetaEnvelopeReservationRequest): MetaEnvelopeReservation {
    return this.reserve("search", input);
  }

  /**
   * Atomically validates a top-level optimizer schedule before appending any
   * new slice. Durable appends may stop partway on I/O failure, but no caller
   * receives the batch (and therefore no child may launch); replay completes
   * the same reservation identities without minting capacity.
   */
  reserveSearchDescendants(
    inputs: readonly MetaEnvelopeReservationRequest[],
  ): MetaEnvelopeReservation[] {
    const parsed = inputs.map((input) => ReservationRequest.parse(input));
    const seen = new Set<string>();
    const total: BudgetEnvelope = {
      maxTokens: 0,
      maxUsd: 0,
      maxWallClockSec: 0,
      maxEvaluatorInvocations: 0,
    };
    for (const input of parsed) {
      if (input.parentReservationId !== null) {
        throw new Error("batched search reservations must be top-level descendants");
      }
      if (seen.has(input.reservationId)) {
        throw new Error(`duplicate durable identity ${input.reservationId} in search reservation batch`);
      }
      seen.add(input.reservationId);
      if (this.reservations.has(input.reservationId)) {
        this.reserve("search", input);
        continue;
      }
      for (const dimension of BUDGET_DIMENSIONS) {
        total[dimension] += input.reserved[dimension];
      }
    }
    this.assertFits(total, this.remainingSearch(), "search envelope batch");
    return parsed.map((input) => this.reserve("search", input));
  }

  reserveConfirmationDescendant(input: MetaEnvelopeReservationRequest): MetaEnvelopeReservation {
    return this.reserve("confirmation", input);
  }

  reserveTerminalDescendant(input: MetaEnvelopeReservationRequest): MetaEnvelopeReservation {
    return this.reserve("terminal", input);
  }

  settleDescendant(reservationIdInput: string, observedInput: MetaEnvelopeResourceUsage): MetaEnvelopeReservation {
    const reservationId = SAFE_ID.parse(reservationIdInput);
    const observed = ResourceUsage.parse(observedInput);
    const state = this.reservations.get(reservationId);
    if (state === undefined) throw new Error(`unknown envelope reservation ${reservationId}`);
    if (state.observed !== null) {
      if (canonicalJson(state.observed) !== canonicalJson(observed)) {
        throw new Error(`conflicting settlement replay for envelope reservation ${reservationId}`);
      }
      return snapshot(state);
    }

    const unsettledChild = [...this.reservations.values()].find(
      (candidate) => candidate.request.parentReservationId === reservationId && candidate.observed === null,
    );
    if (unsettledChild !== undefined) {
      throw new Error(`cannot settle ${reservationId} before descendant ${unsettledChild.request.reservationId}`);
    }
    this.assertObservedWithinReservation(state.request.reserved, observed, reservationId);
    this.assertIncludesSettledDescendants(reservationId, observed);

    const record: z.infer<typeof SettlementRecord> = {
      version: 1,
      type: "settlement",
      reservationId,
      observed,
    };
    this.records.append(record);
    state.observed = observed;
    return snapshot(state);
  }

  remainingSearch(): BudgetEnvelope {
    return this.remainingRoot("search");
  }

  remainingConfirmation(): BudgetEnvelope {
    return this.remainingRoot("confirmation");
  }

  remainingTerminal(): BudgetEnvelope {
    return this.remainingRoot("terminal");
  }

  reservation(reservationIdInput: string): MetaEnvelopeReservation | undefined {
    const reservationId = SAFE_ID.parse(reservationIdInput);
    const state = this.reservations.get(reservationId);
    return state === undefined ? undefined : snapshot(state);
  }

  private reserve(purpose: Purpose, inputValue: MetaEnvelopeReservationRequest): MetaEnvelopeReservation {
    const input = ReservationRequest.parse(inputValue);
    const envelope = this.envelope(purpose);
    const existing = this.reservations.get(input.reservationId);
    if (existing !== undefined) {
      const expected = {
        reservationId: existing.request.reservationId,
        parentReservationId: existing.request.parentReservationId,
        reserved: existing.request.reserved,
      };
      if (
        existing.request.envelope.envelopeId !== envelope.identity.envelopeId ||
        existing.request.envelope.purpose !== purpose ||
        canonicalJson(expected) !== canonicalJson(input)
      ) {
        throw new Error(`conflicting reservation replay for durable identity ${input.reservationId}`);
      }
      return snapshot(existing);
    }

    const parent = input.parentReservationId === null
      ? null
      : this.reservations.get(input.parentReservationId);
    if (input.parentReservationId !== null && parent === undefined) {
      throw new Error(`missing parent envelope reservation ${input.parentReservationId}`);
    }
    if (parent?.observed !== null && parent !== null) {
      throw new Error(`parent envelope reservation ${input.parentReservationId} is already settled`);
    }
    if (
      parent !== null &&
      (parent.request.envelope.envelopeId !== envelope.identity.envelopeId ||
        parent.request.envelope.purpose !== envelope.identity.purpose)
    ) {
      throw new Error(`descendant reservation ${input.reservationId} cannot cross envelope identities`);
    }
    const depth = parent === null ? 1 : parent.request.depth + 1;
    if (depth > 2) throw new Error("M2 envelope descendants may not exceed depth 2");

    const available = parent === null
      ? this.remainingRoot(purpose)
      : this.remainingWithinReservation(parent.request.reservationId);
    this.assertFits(input.reserved, available, `${purpose} envelope`);

    // Every ancestor is checked before append/launch. A child's slice is carved
    // from its direct parent, so it is not charged to the root a second time.
    let ancestor = parent;
    while (ancestor !== null) {
      this.assertFits(input.reserved, ancestor.request.reserved, `ancestor ${ancestor.request.reservationId}`);
      ancestor = ancestor.request.parentReservationId === null
        ? null
        : this.reservations.get(ancestor.request.parentReservationId) ?? null;
    }

    const record: z.infer<typeof ReservationRecord> = {
      version: 1,
      type: "reservation",
      reservationId: input.reservationId,
      parentReservationId: input.parentReservationId,
      envelope: envelope.identity,
      depth: depth as 1 | 2,
      reserved: input.reserved,
    };
    this.records.append(record);
    const state: MutableReservation = { request: record, observed: null };
    this.reservations.set(record.reservationId, state);
    return snapshot(state);
  }

  private replay(record: MetaEnvelopeAllocationRecord): void {
    if (record.type === "reservation") {
      const existing = this.reservations.get(record.reservationId);
      if (existing !== undefined) {
        if (canonicalJson(existing.request) !== canonicalJson(record)) {
          throw new Error(`conflicting durable reservation record ${record.reservationId}`);
        }
        return;
      }
      const envelope = this.envelope(record.envelope.purpose);
      if (canonicalJson(envelope.identity) !== canonicalJson(record.envelope)) {
        throw new Error(`durable reservation ${record.reservationId} names an unknown envelope identity`);
      }
      let parent: MutableReservation | null;
      if (record.parentReservationId === null) {
        parent = null;
      } else {
        const found = this.reservations.get(record.parentReservationId);
        if (found === undefined) {
          throw new Error(`durable reservation ${record.reservationId} precedes its parent`);
        }
        parent = found;
      }
      if (parent !== null && parent.observed !== null) {
        throw new Error(`durable reservation ${record.reservationId} follows settled parent ${parent.request.reservationId}`);
      }
      if (
        parent !== null &&
        (parent.request.envelope.envelopeId !== record.envelope.envelopeId ||
          parent.request.envelope.purpose !== record.envelope.purpose)
      ) {
        throw new Error(`durable reservation ${record.reservationId} crosses envelope identities`);
      }
      if (record.depth !== (parent === null ? 1 : parent.request.depth + 1)) {
        throw new Error(`durable reservation ${record.reservationId} has an invalid depth`);
      }
      const available = parent === null
        ? this.remainingRoot(record.envelope.purpose)
        : this.remainingWithinReservation(parent.request.reservationId);
      this.assertFits(record.reserved, available, `replayed ${record.envelope.purpose} envelope`);
      this.reservations.set(record.reservationId, { request: record, observed: null });
      return;
    }

    const state = this.reservations.get(record.reservationId);
    if (state === undefined) throw new Error(`durable settlement precedes reservation ${record.reservationId}`);
    if (state.observed !== null) {
      if (canonicalJson(state.observed) !== canonicalJson(record.observed)) {
        throw new Error(`conflicting durable settlement ${record.reservationId}`);
      }
      return;
    }
    const unsettledChild = [...this.reservations.values()].find(
      (candidate) => candidate.request.parentReservationId === record.reservationId && candidate.observed === null,
    );
    if (unsettledChild !== undefined) {
      throw new Error(`durable parent settlement precedes descendant ${unsettledChild.request.reservationId}`);
    }
    this.assertObservedWithinReservation(state.request.reserved, record.observed, record.reservationId);
    this.assertIncludesSettledDescendants(record.reservationId, record.observed);
    state.observed = record.observed;
  }

  private envelope(purpose: Purpose): { identity: M2EnvelopeIdentity; budget: BudgetEnvelope } {
    if (purpose === "search") {
      return { identity: this.budgets.search.identity, budget: this.budgets.search.outerTrajectory };
    }
    return this.budgets[purpose];
  }

  private remainingRoot(purpose: Purpose): BudgetEnvelope {
    const envelope = this.envelope(purpose);
    const committed = this.sumReservations(
      (state) =>
        state.request.parentReservationId === null &&
        state.request.envelope.envelopeId === envelope.identity.envelopeId,
    );
    return subtract(envelope.budget, committed);
  }

  private remainingWithinReservation(reservationId: string): BudgetEnvelope {
    const state = this.reservations.get(reservationId);
    if (state === undefined) throw new Error(`unknown parent reservation ${reservationId}`);
    const committed = this.sumReservations(
      (candidate) => candidate.request.parentReservationId === reservationId,
    );
    return subtract(state.request.reserved, committed);
  }

  private sumDirectChildren(reservationId: string): BudgetEnvelope {
    return this.sumReservations(
      (candidate) => candidate.request.parentReservationId === reservationId && candidate.observed !== null,
    );
  }

  private sumReservations(include: (state: MutableReservation) => boolean): BudgetEnvelope {
    const total: BudgetEnvelope = {
      maxTokens: 0,
      maxUsd: 0,
      maxWallClockSec: 0,
      maxEvaluatorInvocations: 0,
    };
    for (const state of this.reservations.values()) {
      if (!include(state)) continue;
      for (const dimension of BUDGET_DIMENSIONS) {
        const usageDimension = USAGE_BY_BUDGET[dimension];
        total[dimension] += state.observed === null
          ? state.request.reserved[dimension]
          : state.observed[usageDimension];
      }
    }
    return total;
  }

  private assertFits(requested: BudgetEnvelope, available: BudgetEnvelope, label: string): void {
    for (const dimension of BUDGET_DIMENSIONS) {
      if (requested[dimension] > available[dimension] + Number.EPSILON) {
        throw new Error(
          `${label} ${dimension} exceeded: requested ${requested[dimension]}, available ${available[dimension]}`,
        );
      }
    }
  }

  private assertIncludesSettledDescendants(
    reservationId: string,
    observed: z.infer<typeof ResourceUsage>,
  ): void {
    const childObserved = this.sumDirectChildren(reservationId);
    for (const dimension of BUDGET_DIMENSIONS) {
      const usageDimension = USAGE_BY_BUDGET[dimension];
      if (observed[usageDimension] < childObserved[dimension]) {
        throw new Error(
          `settlement ${reservationId} ${usageDimension} ${observed[usageDimension]} is below settled descendant spend ${childObserved[dimension]}`,
        );
      }
    }
  }

  private assertObservedWithinReservation(
    reserved: BudgetEnvelope,
    observed: z.infer<typeof ResourceUsage>,
    reservationId: string,
  ): void {
    for (const dimension of BUDGET_DIMENSIONS) {
      const usageDimension = USAGE_BY_BUDGET[dimension];
      if (observed[usageDimension] > reserved[dimension] + Number.EPSILON) {
        throw new Error(
          `settlement ${reservationId} exceeds reserved ${dimension}: ${observed[usageDimension]} > ${reserved[dimension]}`,
        );
      }
    }
  }
}

function writeBytes(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("failed to append meta envelope record");
    offset += written;
  }
}

function subtract(capacity: BudgetEnvelope, committed: BudgetEnvelope): BudgetEnvelope {
  return {
    maxTokens: Math.max(0, capacity.maxTokens - committed.maxTokens),
    maxUsd: Math.max(0, capacity.maxUsd - committed.maxUsd),
    maxWallClockSec: Math.max(0, capacity.maxWallClockSec - committed.maxWallClockSec),
    maxEvaluatorInvocations: Math.max(
      0,
      capacity.maxEvaluatorInvocations - committed.maxEvaluatorInvocations,
    ),
  };
}

function snapshot(state: MutableReservation): MetaEnvelopeReservation {
  return {
    reservationId: state.request.reservationId,
    parentReservationId: state.request.parentReservationId,
    envelope: { ...state.request.envelope },
    depth: state.request.depth,
    reserved: { ...state.request.reserved },
    observed: state.observed === null ? null : { ...state.observed },
    settled: state.observed !== null,
  };
}
