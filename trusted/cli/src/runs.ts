import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RunConfig } from "@hone/schema";
import { UsageError } from "./args.js";
import { EVENTS_FILE, replayRun, syncDir, writeFileDurable } from "./eventlog.js";
import type { RunState } from "./eventlog.js";

export const RUNS_DIR = ".hone-runs";
export const CAS_DIR = ".hone-cas";
export const RUN_CONFIG_FILE = "runconfig.json";
export const CONTRACT_FILE = "contract.md";
export const SUPERVISOR_FILE = "supervisor.json";

export function runsRoot(root: string): string {
  return join(root, RUNS_DIR);
}

export function casRoot(root: string): string {
  return join(root, CAS_DIR);
}

export function mintRunId(): string {
  return `run_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Durably mint a run dir: the new directory AND its runsRoot entry (and a first-run runsRoot entry in root) are fsynced. */
export function mintRunDirDurable(root: string, runId: string): string {
  const base = runsRoot(root);
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  syncDir(runDir);
  syncDir(base);
  syncDir(root);
  return runDir;
}

/** Run dirs that have an event log, oldest → newest by log mtime. */
export function listRunDirs(root: string): string[] {
  const base = runsRoot(root);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => join(base, name))
    .filter((dir) => existsSync(join(dir, EVENTS_FILE)))
    .sort((a, b) => statSync(join(a, EVENTS_FILE)).mtimeMs - statSync(join(b, EVENTS_FILE)).mtimeMs);
}

/** Resolve --run ID, or default to the most recent run. */
export function resolveRun(root: string, runId?: string): string {
  if (runId !== undefined) {
    const dir = join(runsRoot(root), runId);
    if (!existsSync(join(dir, EVENTS_FILE))) throw new UsageError(`unknown run ${runId} (no ${EVENTS_FILE} under ${dir})`);
    return dir;
  }
  const dirs = listRunDirs(root);
  const latest = dirs[dirs.length - 1];
  if (latest === undefined) throw new UsageError(`no runs found under ${runsRoot(root)}`);
  return latest;
}

/** Newest unfinished run for this capsule — the --resume target. */
export function findResumableRun(root: string, capsuleId: string): { runDir: string; runId: string; state: RunState } | null {
  const dirs = listRunDirs(root);
  for (let i = dirs.length - 1; i >= 0; i--) {
    const runDir = dirs[i];
    if (runDir === undefined) continue;
    const state = replayRun(runDir);
    if (state.capsuleId === capsuleId && state.finished === null && state.runId !== null) {
      return { runDir, runId: state.runId, state };
    }
  }
  return null;
}

export function writeRunConfigFile(runDir: string, config: RunConfig): void {
  writeFileDurable(join(runDir, RUN_CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export function loadRunConfigFile(runDir: string): RunConfig {
  const path = join(runDir, RUN_CONFIG_FILE);
  if (!existsSync(path)) throw new UsageError(`run is missing ${RUN_CONFIG_FILE} (${path}) — cannot resume`);
  return RunConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}
