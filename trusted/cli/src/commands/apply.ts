import { UsageError, boolFlag, parseFlags, strFlag } from "../args.js";
import { alignedAuthoritySnapshot, assertAuthorityStillSelected } from "../authority.js";
import { authenticateCapsuleSnapshot } from "../admission.js";
import { deliver } from "../deliver.js";
import { assertTargetIdentity, resolveDeliveryTarget } from "../delivery-target.js";
import { bestArtifact } from "../eventlog.js";
import type { CmdIo } from "../io.js";
import { casRoot, resolveRun } from "../runs.js";

const APPLY_USAGE = "usage: hone apply --best --repo DIR [--branch NAME] [--run ID]";

export interface ApplyBestOptions {
  runDir?: string | undefined;
  runId?: string | undefined;
  /** Explicit delivery target — REQUIRED; manual apply never defaults to the working root. */
  repo?: string | undefined;
  branch?: string | undefined;
  /** Test seam: fires after selection/target validation, immediately before delivery — models an incumbent publishing mid-apply. */
  beforeDeliver?: (() => void) | undefined;
}

/**
 * Deterministic, artifact-specific default branch. A mid-run apply of
 * incumbent A and a later `stop --take-best` of final best B land on
 * DIFFERENT refs, so the second delivery can never collide with (or
 * clobber) the first — and re-running the same delivery converges on the
 * same ref idempotently.
 */
export function defaultApplyBranch(runId: string, artifactHash: string): string {
  return `hone/${runId}-${artifactHash.replace(/^sha256:/, "").slice(0, 12)}`;
}

/**
 * Manual anytime apply: land the current best on a branch of an EXPLICIT,
 * validated target repo, mid-run or after — never the working tree, never
 * stopping the run, and never a repository Git discovered on its own.
 */
export async function applyBest(io: CmdIo, opts: ApplyBestOptions): Promise<number> {
  const runDir = opts.runDir ?? resolveRun(io.root, opts.runId);
  // Durable-authority gate: never deliver an incumbent the broker journal
  // does not vouch for (crash window between journal fsync and log append).
  // The helper returns the EXACT replay it aligned; selecting from any other
  // read could deliver an incumbent the journal never proved.
  const snapshot = alignedAuthoritySnapshot(runDir, io);
  if (!snapshot.aligned) return 1;
  const { runId, state } = snapshot;
  const best = bestArtifact(state);
  if (best === null) {
    io.err("no incumbent artifact to apply yet");
    return 1;
  }
  // The snapshot names the frozen baseline that target validation checks
  // against — a swapped capsule-manifest.json must never re-point delivery.
  // Authenticate it (id recompute + run.started capsuleId + approved
  // contract hash) BEFORE it is consumed.
  authenticateCapsuleSnapshot(runDir);
  const target = resolveDeliveryTarget(io.root, runDir, opts.repo, "branch");
  opts.beforeDeliver?.();
  const result = deliver({
    mode: "branch",
    repo: target.repo,
    ...(target.gitDir !== undefined ? { gitDir: target.gitDir } : {}),
    baselineCommit: target.baselineCommit,
    runId,
    artifact: best.hash,
    casDir: casRoot(io.root),
    branch: opts.branch ?? defaultApplyBranch(runId, best.hash),
    improverSeat: false,
    env: io.env,
    // Immediately before the ref update the target must STILL be the exact
    // filesystem object resolveDeliveryTarget validated (dev:ino) — a repo
    // renamed/recreated between validation and publication fails closed —
    // AND the run's authority must still select the exact artifact we chose
    // — an incumbent that published after selection fails the delivery
    // closed, so a superseded artifact is never published.
    verifyTarget: () => {
      assertTargetIdentity(target);
      assertAuthorityStillSelected(runDir, best.hash, runId);
    },
  });
  io.out(`applied ${best.hash} to branch ${result.ref ?? "(none)"}`);
  for (const note of result.notes) io.err(note);
  return 0;
}

export async function applyCommand(args: string[], io: CmdIo): Promise<number> {
  const { flags } = parseFlags(args, { booleans: ["best"], strings: ["branch", "run", "repo"] });
  if (!boolFlag(flags, "best")) throw new UsageError(APPLY_USAGE);
  const repo = strFlag(flags, "repo");
  if (repo === undefined) {
    throw new UsageError(`${APPLY_USAGE}\n--repo is required: manual apply writes into a repository and never defaults to the current root`);
  }
  try {
    return await applyBest(io, {
      runId: strFlag(flags, "run"),
      repo,
      branch: strFlag(flags, "branch"),
    });
  } catch (e) {
    if (e instanceof UsageError) throw e;
    io.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
