/**
 * Durable evidence for the ordering check CLI.
 *
 * A full ordering run is hours of measured container time. Nothing the run
 * has already measured may be lost to a later failure, so this writer persists
 * state as it happens instead of once at the end:
 *
 *   - the raw measurements file is rewritten (atomically) after EVERY
 *     measurement, `status: "in-progress"`;
 *   - the aggregate-only partial report is written as soon as every variant
 *     is measured and BEFORE any measurement-integrity assertion (container
 *     counts, host transcript) can throw, `status: "unverified"`;
 *   - a failure at any later point flips both files to `status: "failed"`
 *     with the explanation, keeping every completed measurement and the
 *     partial report; success flips them to `status: "complete"`.
 *
 * The partial report is deliberately NOT the schema-valid compact summary the
 * capsule manifest pins: it wraps that summary (aggregates only, never
 * per-example content) with its verification status, so it can never be
 * mistaken for an admitted `ordering-report.json`. Its `failure` text is the
 * tool's own error message (the same text printed to the console), truncated.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonicalJson, type DiagnosticOrderingReport } from "@hone/schema";
import type { OrderingMeasurement } from "./ordering-check.js";

export type OrderingEvidenceStatus = "in-progress" | "unverified" | "complete" | "failed";

/** Observed evaluator container counts at the moment the partial report was taken. */
export interface OrderingEvidenceCounts {
  logicalEvaluations: number;
  decodeLaunches: number;
  earlyInvalidEncodes: number;
  physicalContainers: number;
}

export interface OrderingEvidenceOptions {
  stabilityRuns: number;
  /** Raw per-measurement evidence; omitted = not recorded. */
  rawPath?: string;
  /** Partial (aggregate-only, status-wrapped) report; omitted = not recorded. */
  partialPath?: string;
}

/** Cap on the recorded failure explanation (broker errors can embed evaluator stderr). */
const MAX_FAILURE_CHARS = 4000;

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Durable write: temp file in the same directory, full write, fsync, atomic
 * rename, then fsync the directory — and the parent of every directory this
 * call had to create, so the new entries themselves survive power loss.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const dir = dirname(path);
  const created: string[] = [];
  for (let d = dir; !existsSync(d); d = dirname(d)) created.push(d);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  const bytes = Buffer.from(contents, "utf8");
  const fd = openSync(temp, "w");
  try {
    let written = 0;
    while (written < bytes.length) {
      const n = writeSync(fd, bytes, written);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`ordering-check: write to ${temp} stalled at ${written}/${bytes.length} bytes`);
      written += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  for (const target of new Set([dir, ...created.map((d) => dirname(d))])) fsyncPath(target);
}

export class OrderingEvidenceWriter {
  private readonly measurements: OrderingMeasurement[] = [];
  private status: OrderingEvidenceStatus = "in-progress";
  private failure: string | undefined;
  private summary: DiagnosticOrderingReport | undefined;
  private summaryError: string | undefined;
  private counts: OrderingEvidenceCounts | undefined;

  constructor(private readonly options: OrderingEvidenceOptions) {}

  /** Record one completed measurement and persist the raw file immediately. */
  measurement(measurement: OrderingMeasurement): void {
    this.measurements.push(measurement);
    this.writeRaw();
  }

  /**
   * Every variant is measured; the aggregate report exists but its container
   * counts have not been verified yet. Persist it NOW. `summary` is a string
   * when the aggregates cannot form a schema-valid summary (for example a
   * zero-mean stability sample): the reason is kept instead of the summary,
   * never allowed to abort the run before the integrity gate.
   */
  unverified(summary: DiagnosticOrderingReport | string, counts: OrderingEvidenceCounts): void {
    if (typeof summary === "string") this.summaryError = summary;
    else this.summary = summary;
    this.counts = counts;
    this.status = "unverified";
    this.writeAll();
  }

  /** Verified end of run. */
  complete(): void {
    this.status = "complete";
    this.failure = undefined;
    this.writeAll();
  }

  /** Any failure after (or before) the partial report: keep everything, add the explanation. */
  fail(error: unknown): void {
    this.status = "failed";
    this.failure = (error instanceof Error ? error.message : String(error)).slice(0, MAX_FAILURE_CHARS);
    this.writeAll();
  }

  private writeAll(): void {
    this.writeRaw();
    this.writePartial();
  }

  private writeRaw(): void {
    const { rawPath, stabilityRuns } = this.options;
    if (rawPath === undefined) return;
    writeFileAtomic(
      rawPath,
      `${canonicalJson({
        schemaVersion: 1,
        stabilityRuns,
        status: this.status,
        ...(this.failure === undefined ? {} : { failure: this.failure }),
        measurements: this.measurements,
      })}\n`,
    );
  }

  private writePartial(): void {
    const { partialPath, stabilityRuns } = this.options;
    if (partialPath === undefined) return;
    writeFileAtomic(
      partialPath,
      `${canonicalJson({
        schemaVersion: 1,
        stabilityRuns,
        status: this.status,
        ...(this.failure === undefined ? {} : { failure: this.failure }),
        completedMeasurements: this.measurements.length,
        counts: this.counts ?? null,
        summary: this.summary ?? null,
        ...(this.summaryError === undefined ? {} : { summaryError: this.summaryError }),
      })}\n`,
    );
  }
}
