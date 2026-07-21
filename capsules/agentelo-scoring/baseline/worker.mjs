import { createRequire } from "node:module";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const safeParse = JSON.parse.bind(JSON);
// Captured before any candidate code can run; used ONLY on primitives, where
// the serialization algorithm consults no user-reachable hook.
const safeStringify = JSON.stringify.bind(JSON);
const safeWrite = process.stdout.write.bind(process.stdout);
const safeExit = process.exit.bind(process);
const safeKeys = Object.keys;
const safeIsArray = Array.isArray;
const safeIsFinite = Number.isFinite;
const workspace = resolve(process.argv[2] ?? "/workspace");
const requestLine = readFileSync(0, "utf8");

const MAX_ENCODE_DEPTH = 64;

/**
 * Prototype-independent JSON encoder. JSON.stringify invokes an inherited
 * `toJSON` (e.g. one installed on Object.prototype by candidate code), which
 * would let a candidate rewrite the trusted result envelope. This encoder
 * never performs a prototype-chain method lookup: it delegates to the bound
 * JSON.stringify only for primitives and walks objects via captured
 * Object.keys over own enumerable properties.
 */
function encodeJson(value, depth) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return safeStringify(value);
    case "number":
      return safeIsFinite(value) ? safeStringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object":
      break;
    default:
      // function, symbol, bigint, undefined: not representable.
      return undefined;
  }
  if (depth <= 0) throw new RangeError("encode depth exceeded");
  if (safeIsArray(value)) {
    let out = "[";
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ",";
      const encoded = encodeJson(value[i], depth - 1);
      out += encoded === undefined ? "null" : encoded;
    }
    return `${out}]`;
  }
  let out = "{";
  let first = true;
  for (const key of safeKeys(value)) {
    const encoded = encodeJson(value[key], depth - 1);
    if (encoded === undefined) continue;
    out += `${first ? "" : ","}${safeStringify(key)}:${encoded}`;
    first = false;
  }
  return `${out}}`;
}

function respond(payload) {
  let line;
  try {
    line = encodeJson(payload, MAX_ENCODE_DEPTH);
  } catch {
    line = undefined;
  }
  if (typeof line !== "string") {
    line = '{"ok":false,"error":"unserializable candidate value"}';
  }
  safeWrite(`${line}\n`);
}

function withTranscript(input, invoke) {
  const submission = { ...(input.submission ?? {}) };
  if (typeof input.log !== "string" && typeof input.trajectory !== "string") {
    return invoke(submission);
  }
  const dir = mkdtempSync(join(tmpdir(), "agentelo-case-"));
  const logPath = join(dir, "run.log");
  try {
    writeFileSync(logPath, typeof input.log === "string" ? input.log : "", "utf8");
    if (typeof input.trajectory === "string") {
      writeFileSync(join(dir, "run.traj.json"), input.trajectory, "utf8");
    }
    submission.transcript_path = logPath;
    return invoke(submission);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const request = safeParse(requestLine);
  if (
    request === null ||
    typeof request !== "object" ||
    !["analyze", "score", "dedup"].includes(request.operation) ||
    request.input === null ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  ) {
    respond({ __proto__: null, ok: false, error: "invalid trusted request" });
    safeExit(0);
  }

  const require = createRequire(import.meta.url);
  const scoring = require(join(workspace, "core", "scoring.js"));
  let value;
  if (request.operation === "analyze") {
    if (typeof scoring.analyzeNoDiffSubmission !== "function") {
      throw new TypeError("analyzeNoDiffSubmission export missing");
    }
    value = withTranscript(request.input, (submission) =>
      scoring.analyzeNoDiffSubmission(submission),
    );
  } else if (request.operation === "score") {
    if (typeof scoring.computeScore !== "function") {
      throw new TypeError("computeScore export missing");
    }
    value = scoring.computeScore(
      { ...(request.input.a ?? {}) },
      { ...(request.input.b ?? {}) },
      { ...(request.input.options ?? {}) },
    );
    if (typeof value !== "number" || !safeIsFinite(value)) {
      respond({ __proto__: null, ok: false, error: "computeScore returned nonfinite or nonnumeric value" });
      safeExit(0);
    }
  } else {
    if (typeof scoring.pickBetterSubmission !== "function") {
      throw new TypeError("pickBetterSubmission export missing");
    }
    const current = request.input.current === null ? null : { ...(request.input.current ?? {}) };
    const candidate = request.input.candidate === null ? null : { ...(request.input.candidate ?? {}) };
    const picked = scoring.pickBetterSubmission(current, candidate);
    if (picked === current) value = "current";
    else if (picked === candidate) value = "candidate";
    else {
      respond({ __proto__: null, ok: false, error: "pickBetterSubmission returned foreign value" });
      safeExit(0);
    }
  }
  respond({ __proto__: null, ok: true, value });
} catch (error) {
  respond({
    __proto__: null,
    ok: false,
    error: error instanceof Error ? error.name : "candidate threw non-Error",
  });
}
