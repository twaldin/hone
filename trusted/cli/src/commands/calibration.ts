import { chmodSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson } from "@hone/schema";
import { UsageError, boolFlag, parseFlags, strFlag, type Flags } from "../args.js";
import {
  buildCalibrationReport, createCalibrationPlan, executeCalibration, initializeCalibration,
  readCalibrationState, validateCalibrationPlan, verifyCalibrationReport,
} from "../calibration.js";
import { createCalibrationRunner, loadCalibrationPlanInputs } from "../calibration-runner.js";
import { writeFileDurable } from "../eventlog.js";
import type { CmdIo } from "../io.js";

const USAGE = `usage:
  hone calibration plan --corpus FILE --out FILE [--drafts]
  hone calibration init --plan FILE --state DIR
  hone calibration status --state DIR
  hone calibration run --state DIR --acknowledge-execution [--max-cells N]
       [--cell KEY --resume | --cell KEY --retry-reason TEXT]
  hone calibration report --state DIR --out FILE
  hone calibration verify --state DIR --bundle FILE

Planning reserves no resources and grants no execution authority. Current task drafts
cannot run. Real execution requires separately authorized scope, admitted tasks and
selected-host/runtime validation. Runs default to one cell. Retries are supplementary;
they never replace a failed primary score. Keep state, run evidence and reports private.`;

function required(flags: Flags, name: string): string {
  const value = strFlag(flags, name);
  if (value === undefined || value.trim() === "") throw new UsageError(`--${name} is required`);
  return value;
}

function writeNewJson(path: string, value: unknown): void {
  if (existsSync(path)) throw new UsageError(`refusing to overwrite ${path}`);
  writeFileDurable(path, `${canonicalJson(value)}\n`);
  chmodSync(path, 0o600);
}

export async function calibrationCommand(args: string[], io: CmdIo): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || action === "--help" || action === "help") {
    io.out(USAGE);
    return action === undefined ? 2 : 0;
  }
  switch (action) {
    case "plan": {
      const { flags, positionals } = parseFlags(rest, { strings: ["corpus", "out"], booleans: ["drafts"] });
      if (positionals.length !== 0) throw new UsageError(USAGE);
      const output = resolve(io.root, required(flags, "out"));
      const inputs = loadCalibrationPlanInputs(io.root, resolve(io.root, required(flags, "corpus")), {
        drafts: boolFlag(flags, "drafts"),
      });
      const plan = createCalibrationPlan(inputs);
      writeNewJson(output, plan);
      io.out(canonicalJson({ plan: output, planDigest: plan.planDigest, cells: plan.cells.length,
        executable: plan.tasks.every((task) => task.admission === "admitted"),
        reservations: plan.reservations, authorization: "none" }));
      return 0;
    }
    case "init": {
      const { flags, positionals } = parseFlags(rest, { strings: ["plan", "state"] });
      if (positionals.length !== 0) throw new UsageError(USAGE);
      const plan = validateCalibrationPlan(JSON.parse(readFileSync(resolve(io.root, required(flags, "plan")), "utf8")));
      const mode = plan.tasks.every((task) => task.admission === "admitted") ? "trusted" : "offline";
      const state = await initializeCalibration(resolve(io.root, required(flags, "state")), plan, mode);
      io.out(canonicalJson({ stateDigest: state.stateDigest, mode: state.mode, attempts: state.attempts.length }));
      return 0;
    }
    case "status": {
      const { flags, positionals } = parseFlags(rest, { strings: ["state"] });
      if (positionals.length !== 0) throw new UsageError(USAGE);
      const state = readCalibrationState(resolve(io.root, required(flags, "state")));
      const counts = { valid: 0, invalid: 0, incomplete: 0 };
      for (const cell of state.plan.cells) {
        const primary = state.attempts.find((attempt) => attempt.cellKey === cell.key && attempt.ordinal === 0);
        const outcomes = primary?.outcomes;
        counts[outcomes?.[outcomes.length - 1]?.status ?? "incomplete"]++;
      }
      io.out(canonicalJson({ mode: state.mode, planDigest: state.plan.planDigest,
        stateDigest: state.stateDigest, counts, attempts: state.attempts }));
      return 0;
    }
    case "run": {
      const { flags, positionals } = parseFlags(rest, {
        strings: ["state", "cell", "retry-reason", "max-cells"], booleans: ["acknowledge-execution", "resume"],
      });
      if (positionals.length !== 0) throw new UsageError(USAGE);
      if (!boolFlag(flags, "acknowledge-execution")) {
        throw new UsageError("real calibration execution requires --acknowledge-execution and separately authorized scope; planning is not permission to spend");
      }
      const maxCells = Number(strFlag(flags, "max-cells") ?? "1");
      if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > 80) {
        throw new UsageError("--max-cells must be an integer from 1 to 80");
      }
      const cellKey = strFlag(flags, "cell");
      const retryReason = strFlag(flags, "retry-reason");
      const resume = boolFlag(flags, "resume");
      if ((resume || retryReason !== undefined) && cellKey === undefined) throw new UsageError("resume/retry requires --cell KEY");
      if (resume && retryReason !== undefined) throw new UsageError("resume and retry are distinct operations");
      const state = await executeCalibration(resolve(io.root, required(flags, "state")), createCalibrationRunner(io), {
        maxCells, ...(cellKey === undefined ? {} : { cellKey }),
        ...(resume ? { resume } : {}), ...(retryReason === undefined ? {} : { retryReason }),
      });
      io.out(canonicalJson({ stateDigest: state.stateDigest, attempts: state.attempts.length }));
      return 0;
    }
    case "report": {
      const { flags, positionals } = parseFlags(rest, { strings: ["state", "out"] });
      if (positionals.length !== 0) throw new UsageError(USAGE);
      const bundle = await buildCalibrationReport(resolve(io.root, required(flags, "state")), createCalibrationRunner(io));
      const output = resolve(io.root, required(flags, "out"));
      writeNewJson(output, bundle);
      io.out(canonicalJson({ bundle: output, bundleDigest: bundle.bundleDigest, reportDigest: bundle.reportDigest,
        selectedCeiling: bundle.report.selectedCeiling, mode: bundle.state.mode }));
      return 0;
    }
    case "verify": {
      const { flags, positionals } = parseFlags(rest, { strings: ["state", "bundle"] });
      if (positionals.length !== 0) throw new UsageError(USAGE);
      const supplied = verifyCalibrationReport(JSON.parse(readFileSync(resolve(io.root, required(flags, "bundle")), "utf8")));
      const current = await buildCalibrationReport(resolve(io.root, required(flags, "state")), createCalibrationRunner(io));
      if (canonicalJson(supplied) !== canonicalJson(current)) throw new UsageError("report bundle differs from current verified run evidence");
      io.out(canonicalJson({ verified: true, mode: current.state.mode, reportDigest: current.reportDigest }));
      return 0;
    }
    default:
      throw new UsageError(USAGE);
  }
}
