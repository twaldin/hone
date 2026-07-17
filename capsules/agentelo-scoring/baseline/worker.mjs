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
const safeStringify = JSON.stringify.bind(JSON);
const safeWrite = process.stdout.write.bind(process.stdout);
const workspace = resolve(process.argv[2] ?? "/workspace");
const requestLine = readFileSync(0, "utf8");

function respond(payload) {
  safeWrite(`${safeStringify(payload)}\n`);
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
    respond({ ok: false, error: "invalid trusted request" });
    process.exit(0);
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
    if (typeof value !== "number" || !Number.isFinite(value)) {
      respond({ ok: false, error: "computeScore returned nonfinite or nonnumeric value" });
      process.exit(0);
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
      respond({ ok: false, error: "pickBetterSubmission returned foreign value" });
      process.exit(0);
    }
  }
  respond({ ok: true, value });
} catch (error) {
  respond({
    ok: false,
    error: error instanceof Error ? error.name : "candidate threw non-Error",
  });
}
