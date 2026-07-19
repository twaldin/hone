import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  saturationCeilingReportJson,
  type SaturationCap,
  type SaturationCell,
  type SaturationCeilingOptions,
} from "./saturation.js";

export interface SaturationCliIo {
  /** Read stdin when path is undefined, otherwise read the named UTF-8 JSON file. */
  read: (path: string | undefined) => string;
  out: (text: string) => void;
  err: (text: string) => void;
}

interface SaturationCliRequest {
  cells: SaturationCell[];
  options: SaturationCeilingOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCap(value: unknown, coordinate: number): SaturationCap {
  if (value !== 2 && value !== 4 && value !== 8 && value !== 12) {
    throw new Error(`cell ${coordinate}: cap must be one of 2, 4, 8, or 12`);
  }
  return value;
}

function parseCell(value: unknown, coordinate: number): SaturationCell {
  if (!isRecord(value)) throw new Error(`cell ${coordinate}: expected an object`);
  const capsuleId = value.capsuleId;
  const cap = parseCap(value.cap, coordinate);
  const seed = value.seed;
  const status = value.status;
  if (typeof capsuleId !== "string") throw new Error(`cell ${coordinate}: capsuleId must be a string`);
  if (typeof seed !== "number") throw new Error(`cell ${coordinate}: seed must be a number`);
  if (status === "valid") {
    if (typeof value.normalizedGain !== "number") {
      throw new Error(`cell ${coordinate}: a valid cell requires numeric normalizedGain`);
    }
    return { capsuleId, cap, seed, status, normalizedGain: value.normalizedGain };
  }
  if (status === "invalid" || status === "incomplete") return { capsuleId, cap, seed, status };
  throw new Error(`cell ${coordinate}: status must be valid, invalid, or incomplete`);
}

function parseRequest(text: string): SaturationCliRequest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("input must be a JSON object");
  if (!Array.isArray(value.cells)) throw new Error("input.cells must be an array");
  if (typeof value.rngSeed !== "number") throw new Error("input.rngSeed must be a number");
  if (value.bootstrapSamples !== undefined && typeof value.bootstrapSamples !== "number") {
    throw new Error("input.bootstrapSamples must be a number when present");
  }
  const cells = value.cells.map(parseCell);
  const options: SaturationCeilingOptions =
    value.bootstrapSamples === undefined
      ? { rngSeed: value.rngSeed }
      : { rngSeed: value.rngSeed, bootstrapSamples: value.bootstrapSamples };
  return { cells, options };
}

/**
 * JSON-in/JSON-out CLI entry. With no argument it reads stdin; with one
 * argument it reads that file. The request is
 * `{ "cells": [...], "rngSeed": uint32, "bootstrapSamples"?: positive-int }`.
 */
export function runSaturationCli(argv: readonly string[], io: SaturationCliIo): number {
  try {
    if (argv.length > 1) throw new Error("usage: saturation-cli [calibration-cells.json]");
    const request = parseRequest(io.read(argv[0]));
    io.out(`${saturationCeilingReportJson(request.cells, request.options)}\n`);
    return 0;
  } catch (error) {
    io.err(`saturation-cli: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invoked = process.argv[1] === undefined ? "" : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  process.exitCode = runSaturationCli(process.argv.slice(2), {
    read: (path) => readFileSync(path ?? 0, "utf8"),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
}
