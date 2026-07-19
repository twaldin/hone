import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AdmissionReceiptRecord,
  admissionReceiptRecordHash,
  capsuleDigest,
  type AdmissionReceiptRecordBody,
  type ReviewIdentity,
} from "@hone/schema";
import { z } from "zod";
import { admitCapsule } from "../admission.js";
import { appendAdmissionReceipt } from "../admission-receipts.js";
import { UsageError, boolFlag, parseFlags, strFlag, type Flags } from "../args.js";
import { loadCapsule } from "../capsule.js";
import { assertTreeMatchesStage } from "../deliver.js";
import { writeFileDurable } from "../eventlog.js";
import { materializeGitCommit } from "../git-baseline.js";
import type { CmdIo } from "../io.js";
import { casRoot, mintRunDirDurable, runsRoot } from "../runs.js";

const AUTHOR_USAGE = `usage:
  hone author <capsule-objective> [--repo DIR] [--headless] [--acknowledge-dirty]
  hone author --workflow ID [--gate1 accept|revise|reject | --gate2 approve|reject]
              [--feedback TEXT] [--author owner|agent:ID]
              [--adversarial-validator owner|agent:ID] [--final-reviewer owner|agent:ID]
              [--provisional --delegator owner:ID --delegation-budget-usd N]`;

const AuthorRole = z.enum(["capsule-author", "evaluator-author", "adversarial-validator"]);
export type AuthorRole = z.infer<typeof AuthorRole>;

const ReviewIdentitySchema = z.object({
  identity: z.string().min(1),
  kind: z.enum(["owner", "agent"]),
}).strict();

const AdmissionIdentitiesSchema = z.object({
  author: ReviewIdentitySchema,
  "adversarial-validator": ReviewIdentitySchema,
  "final-reviewer": ReviewIdentitySchema,
}).strict();
type AdmissionIdentities = z.infer<typeof AdmissionIdentitiesSchema>;

const SessionRecord = z.object({
  role: AuthorRole,
  completedAt: z.string().datetime(),
  summary: z.string().min(1),
  capsuleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

const AuthorWorkflowState = z.object({
  version: z.literal(1),
  workflowId: z.string().regex(/^author_[a-zA-Z0-9_.-]+$/),
  objective: z.string().min(1),
  status: z.enum([
    "awaiting-capsule-author",
    "awaiting-gate1",
    "revision-required",
    "gate1-rejected",
    "building-evaluators",
    "admission-refused",
    "awaiting-gate2",
    "gate2-approved",
    "gate2-rejected",
    "admitted",
  ]),
  source: z.object({
    repo: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    tree: z.string().regex(/^[0-9a-f]{40,64}$/),
    snapshotDir: z.string().min(1),
    dirtyAcknowledged: z.boolean(),
  }).strict(),
  outputDir: z.string().min(1),
  capsuleDir: z.string().min(1).nullable(),
  capsuleDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  sessions: z.array(SessionRecord),
  identities: AdmissionIdentitiesSchema.nullable(),
  receiptSequence: z.number().int().nonnegative(),
  previousReceiptHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  feedback: z.string().nullable(),
  technicalAdmission: z.enum(["pending", "passed", "refused"]),
  updatedAt: z.string().datetime(),
}).strict();
export type AuthorWorkflowState = z.infer<typeof AuthorWorkflowState>;

export interface AuthorSessionRequest {
  readonly workflowId: string;
  readonly role: AuthorRole;
  readonly objective: string;
  readonly sourceSnapshot: string;
  readonly outputDir: string;
  readonly capsuleDir: string | null;
  readonly capsuleDigest: string | null;
  readonly feedback: string | null;
  readonly requestPath: string;
}

export interface AuthorSessionResult {
  readonly capsuleDir: string;
  readonly summary: string;
}

/**
 * Trusted seam for the sealed coding-session worker. A null result means the
 * request is durably queued, never that the role succeeded.
 */
export interface AuthorSessionBoundary {
  run(request: AuthorSessionRequest): Promise<AuthorSessionResult | null>;
}

export interface TrustedAuthorOptions {
  readonly sessions?: AuthorSessionBoundary;
  readonly workflowId?: string;
  readonly now?: () => string;
  readonly streams?: {
    readonly input: NodeJS.ReadableStream;
    readonly output: NodeJS.WritableStream;
  };
}

const WORKFLOW_FILE = "author-workflow.v1.json";

function workflowPath(root: string, workflowId: string): string {
  if (!/^author_[a-zA-Z0-9_.-]+$/.test(workflowId)) throw new UsageError("invalid author workflow id");
  return join(runsRoot(root), workflowId, WORKFLOW_FILE);
}

function persistWorkflow(root: string, state: AuthorWorkflowState): void {
  const path = workflowPath(root, state.workflowId);
  writeFileDurable(path, `${JSON.stringify(state, null, 2)}\n`);
  chmodSync(path, 0o600);
}

export function readAuthorWorkflow(root: string, workflowId: string): AuthorWorkflowState {
  const path = workflowPath(root, workflowId);
  if (!existsSync(path)) throw new UsageError(`unknown author workflow ${workflowId}`);
  return AuthorWorkflowState.parse(JSON.parse(readFileSync(path, "utf8")));
}

function gitEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PATH: env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "none",
    GIT_PROTOCOL_FROM_USER: "0",
    LC_ALL: "C",
  };
}

function gitBytes(repo: string, args: string[], env: NodeJS.ProcessEnv, maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args],
    {
      env: gitEnvironment(env),
      encoding: "buffer",
      maxBuffer,
      timeout: 60_000,
      killSignal: "SIGKILL",
    },
  );
  if (result.error !== undefined) throw new UsageError(`source snapshot git failed: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new UsageError(`source snapshot git ${args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`);
  }
  return result.stdout;
}

function gitText(repo: string, args: string[], env: NodeJS.ProcessEnv): string {
  return gitBytes(repo, args, env).toString("utf8").trim();
}

function secretBearingPath(pathname: string): boolean {
  const name = basename(pathname).toLowerCase();
  return name === ".env"
    || name.startsWith(".env.")
    || name.endsWith(".env")
    || name === ".netrc"
    || name === ".npmrc"
    || name === ".pypirc"
    || name === "credentials.json"
    || name === "secrets.json"
    || name === "id_rsa"
    || name === "id_ed25519";
}

function assertHeadHasNoSecretFiles(repo: string, commit: string, env: NodeJS.ProcessEnv): void {
  const listing = gitBytes(repo, ["ls-tree", "-r", "-z", "--name-only", commit], env);
  for (const pathname of listing.toString("utf8").split("\0")) {
    if (pathname !== "" && secretBearingPath(pathname)) {
      throw new UsageError(
        `source HEAD contains secret-bearing path ${JSON.stringify(pathname)}; remove it from history before authoring`,
      );
    }
  }
}

function makeReadOnlyTree(pathname: string): void {
  const stat = lstatSync(pathname);
  if (stat.isDirectory()) {
    for (const name of readdirSync(pathname)) makeReadOnlyTree(join(pathname, name));
    chmodSync(pathname, 0o500);
    return;
  }
  if (!stat.isFile()) throw new UsageError(`source snapshot contains non-regular entry ${pathname}`);
  chmodSync(pathname, (stat.mode & 0o111) !== 0 ? 0o500 : 0o400);
}

function removeTree(pathname: string): void {
  if (!existsSync(pathname)) return;
  const makeWritable = (candidate: string): void => {
    const stat = lstatSync(candidate);
    if (stat.isDirectory()) {
      chmodSync(candidate, 0o700);
      for (const name of readdirSync(candidate)) makeWritable(join(candidate, name));
    } else if (stat.isFile()) {
      chmodSync(candidate, 0o600);
    }
  };
  makeWritable(pathname);
  rmSync(pathname, { recursive: true, force: true });
}

async function acknowledgeDirtyTree(
  dirtyCount: number,
  headless: boolean,
  acknowledged: boolean,
  io: CmdIo,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
): Promise<boolean> {
  if (dirtyCount === 0) return false;
  if (acknowledged) return true;
  if (headless) {
    throw new UsageError(
      `ambient source tree has ${dirtyCount} staged, unstaged, untracked, or ignored entr${dirtyCount === 1 ? "y" : "ies"}; headless authoring requires --acknowledge-dirty`,
    );
  }
  if (!io.isTTY) {
    throw new UsageError("dirty-tree acknowledgement requires a TTY or explicit --acknowledge-dirty");
  }
  const rl = createInterface({ input: streams.input, output: streams.output });
  try {
    const answer = (await rl.question(
      `Ambient tree has ${dirtyCount} dirty/untracked/ignored entr${dirtyCount === 1 ? "y" : "ies"}. Author from committed HEAD only? [y/N] `,
    )).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new UsageError("dirty source tree was not acknowledged");
    return true;
  } finally {
    rl.close();
  }
}

export interface FreshHeadSnapshot {
  readonly repo: string;
  readonly commit: string;
  readonly tree: string;
  readonly snapshotDir: string;
  readonly dirtyAcknowledged: boolean;
}

/** Capture only verified blobs reachable from the exact local HEAD commit. */
export async function captureFreshHead(
  repoInput: string,
  snapshotDir: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly io: CmdIo;
    readonly headless: boolean;
    readonly acknowledgeDirty: boolean;
    readonly streams?: { readonly input: NodeJS.ReadableStream; readonly output: NodeJS.WritableStream };
  },
): Promise<FreshHeadSnapshot> {
  const repo = realpathSync(resolve(repoInput));
  const commit = gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"], options.env);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new UsageError("source repository has no valid committed HEAD");
  const tree = gitText(repo, ["rev-parse", "--verify", `${commit}^{tree}`], options.env);
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new UsageError("source HEAD has no valid tree identity");
  const status = gitBytes(
    repo,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
    options.env,
  );
  const dirtyCount = status.length === 0 ? 0 : status.subarray(0, status.length - 1).toString("utf8").split("\0").length;
  const dirtyAcknowledged = await acknowledgeDirtyTree(
    dirtyCount,
    options.headless,
    options.acknowledgeDirty,
    options.io,
    options.streams ?? { input: process.stdin, output: process.stdout },
  );
  assertHeadHasNoSecretFiles(repo, commit, options.env);
  if (existsSync(snapshotDir)) throw new UsageError(`source snapshot destination already exists: ${snapshotDir}`);
  try {
    materializeGitCommit(repo, commit, snapshotDir);
    assertTreeMatchesStage(repo, commit, snapshotDir, gitEnvironment(options.env));
    const headAfter = gitText(repo, ["rev-parse", "--verify", "HEAD^{commit}"], options.env);
    const treeAfter = gitText(repo, ["rev-parse", "--verify", `${headAfter}^{tree}`], options.env);
    if (headAfter !== commit || treeAfter !== tree) {
      throw new UsageError("source HEAD changed during snapshot capture; refusing a mixed source identity");
    }
    makeReadOnlyTree(snapshotDir);
    return { repo, commit, tree, snapshotDir, dirtyAcknowledged };
  } catch (error) {
    removeTree(snapshotDir);
    throw error;
  }
}

class DurablePendingSessionBoundary implements AuthorSessionBoundary {
  async run(request: AuthorSessionRequest): Promise<null> {
    writeFileDurable(request.requestPath, `${JSON.stringify({
      version: 1,
      workflowId: request.workflowId,
      role: request.role,
      objective: request.objective,
      sourceSnapshot: request.sourceSnapshot,
      outputDir: request.outputDir,
      capsuleDir: request.capsuleDir,
      capsuleDigest: request.capsuleDigest,
      feedback: request.feedback,
      status: "awaiting-sealed-session",
    }, null, 2)}\n`);
    chmodSync(request.requestPath, 0o600);
    return null;
  }
}

function roleRequestPath(root: string, workflowId: string, role: AuthorRole): string {
  return join(runsRoot(root), workflowId, `session-${role}.request.json`);
}

function exactCapsuleOutput(outputDir: string, capsuleDirInput: string): string {
  const output = realpathSync(outputDir);
  const capsuleDir = realpathSync(resolve(capsuleDirInput));
  if (capsuleDir !== output) {
    throw new UsageError("author session must materialize the capsule at the exact workflow output directory");
  }
  return capsuleDir;
}

async function driveRole(
  root: string,
  state: AuthorWorkflowState,
  role: AuthorRole,
  boundary: AuthorSessionBoundary,
  now: () => string,
): Promise<{ state: AuthorWorkflowState; completed: boolean }> {
  const result = await boundary.run({
    workflowId: state.workflowId,
    role,
    objective: state.objective,
    sourceSnapshot: state.source.snapshotDir,
    outputDir: state.outputDir,
    capsuleDir: state.capsuleDir,
    capsuleDigest: state.capsuleDigest,
    feedback: state.feedback,
    requestPath: roleRequestPath(root, state.workflowId, role),
  });
  if (result === null) return { state, completed: false };
  if (result.summary.trim() === "") throw new UsageError(`${role} session returned an empty summary`);
  const capsuleDir = exactCapsuleOutput(state.outputDir, result.capsuleDir);
  const digest = capsuleDigest(loadCapsule(capsuleDir));
  if (role !== "capsule-author" && state.capsuleDigest !== digest) {
    throw new UsageError(`${role} changed the Gate-1-bound capsule digest; return through Gate 1 with a revised contract`);
  }
  const capsuleIdentityChanged = role === "capsule-author"
    && state.capsuleDigest !== null
    && state.capsuleDigest !== digest;
  const updated: AuthorWorkflowState = {
    ...state,
    capsuleDir,
    capsuleDigest: digest,
    sessions: [...state.sessions, { role, completedAt: now(), summary: result.summary, capsuleDigest: digest }],
    ...(capsuleIdentityChanged ? { receiptSequence: 0, previousReceiptHash: null } : {}),
    feedback: null,
    updatedAt: now(),
  };
  persistWorkflow(root, updated);
  return { state: updated, completed: true };
}

function parseIdentity(spec: string, flag: string): ReviewIdentity {
  const colon = spec.indexOf(":");
  if (colon <= 0 || colon === spec.length - 1) throw new UsageError(`${flag} must be owner:ID or agent:ID`);
  const kind = spec.slice(0, colon);
  const identity = spec.slice(colon + 1);
  const parsed = ReviewIdentitySchema.safeParse({ kind, identity });
  if (!parsed.success) throw new UsageError(`${flag} must be owner:ID or agent:ID`);
  return parsed.data;
}

function identitiesFromFlags(
  flags: Flags,
  existing: AdmissionIdentities | null,
): AdmissionIdentities {
  const author = strFlag(flags, "author");
  const validator = strFlag(flags, "adversarial-validator");
  const reviewer = strFlag(flags, "final-reviewer");
  if (author === undefined && validator === undefined && reviewer === undefined && existing !== null) return existing;
  if (author === undefined || validator === undefined || reviewer === undefined) {
    throw new UsageError("Gate 1 requires --author, --adversarial-validator, and --final-reviewer identity specs");
  }
  const parsed = AdmissionIdentitiesSchema.parse({
    author: parseIdentity(author, "--author"),
    "adversarial-validator": parseIdentity(validator, "--adversarial-validator"),
    "final-reviewer": parseIdentity(reviewer, "--final-reviewer"),
  });
  if (existing !== null && JSON.stringify(parsed) !== JSON.stringify(existing)) {
    throw new UsageError("author workflow review identities are immutable after the first Gate-1 receipt");
  }
  return parsed;
}

function appendGateReceipt(
  root: string,
  state: AuthorWorkflowState,
  action: AdmissionReceiptRecordBody["action"],
  identities: AdmissionIdentities,
  flags: Flags,
  now: () => string,
): AuthorWorkflowState {
  if (state.capsuleDigest === null) throw new UsageError("author workflow has no capsule digest to review");
  const provisional = boolFlag(flags, "provisional");
  const delegatorFlag = strFlag(flags, "delegator");
  const budgetFlag = strFlag(flags, "delegation-budget-usd");
  const delegatedApproval = action === "gate2-approve" && identities["final-reviewer"].kind === "agent";
  if (action !== "gate2-approve" && (provisional || delegatorFlag !== undefined || budgetFlag !== undefined)) {
    throw new UsageError("--provisional and delegation flags are valid only for Gate-2 approval");
  }
  if ((delegatorFlag === undefined) !== (budgetFlag === undefined)) {
    throw new UsageError("delegated approval requires both --delegator owner:ID and --delegation-budget-usd N");
  }
  const budgetUsd = budgetFlag === undefined ? undefined : Number(budgetFlag);
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    throw new UsageError("--delegation-budget-usd must be a positive number");
  }
  const delegation = delegatorFlag === undefined || budgetUsd === undefined
    ? undefined
    : {
        delegator: parseIdentity(delegatorFlag, "--delegator"),
        delegate: identities["final-reviewer"],
        scope: "provisional-private-apply-none" as const,
        budgetUsd,
      };
  if (delegation !== undefined && delegation.delegator.kind !== "owner") {
    throw new UsageError("Gate-2 delegation must be issued by an owner identity");
  }
  if (delegatedApproval && (delegation === undefined || !provisional)) {
    throw new UsageError("an agent final reviewer requires --provisional, --delegator owner:ID, and --delegation-budget-usd N");
  }
  if (!delegatedApproval && action === "gate2-approve" && (delegation !== undefined || provisional)) {
    throw new UsageError("an owner Gate-2 approval is final and must not carry provisional delegation flags");
  }
  const body: AdmissionReceiptRecordBody = {
    v: 1,
    sequence: state.receiptSequence,
    previousReceiptHash: state.previousReceiptHash,
    capsuleDigest: state.capsuleDigest,
    action,
    identities,
    ...(delegation === undefined ? {} : { delegation }),
    provisional,
    timestamp: now(),
  };
  const receipt = AdmissionReceiptRecord.parse({ ...body, recordHash: admissionReceiptRecordHash(body) });
  appendAdmissionReceipt(casRoot(root), receipt);
  return {
    ...state,
    identities: receipt.identities,
    receiptSequence: state.receiptSequence + 1,
    previousReceiptHash: receipt.recordHash,
    updatedAt: now(),
  };
}

async function completeBuildRoles(
  root: string,
  initial: AuthorWorkflowState,
  boundary: AuthorSessionBoundary,
  now: () => string,
): Promise<AuthorWorkflowState> {
  let state = initial;
  const completedRoles = new Set(
    state.sessions
      .filter((session) => session.capsuleDigest === state.capsuleDigest)
      .map((session) => session.role),
  );
  for (const role of ["evaluator-author", "adversarial-validator"] as const) {
    if (completedRoles.has(role)) continue;
    const driven = await driveRole(root, state, role, boundary, now);
    state = driven.state;
    if (!driven.completed) return state;
  }
  if (state.capsuleDir === null || state.capsuleDigest === null) throw new UsageError("author workflow lost its capsule identity");
  try {
    const admitted = admitCapsule(state.capsuleDir, { review: "off" });
    if (admitted.digest !== state.capsuleDigest) throw new UsageError("trusted admission returned a foreign capsule digest");
    state = { ...state, status: "awaiting-gate2", technicalAdmission: "passed", updatedAt: now() };
  } catch (error) {
    state = { ...state, status: "admission-refused", technicalAdmission: "refused", updatedAt: now() };
    persistWorkflow(root, state);
    throw error;
  }
  persistWorkflow(root, state);
  return state;
}

function finalizeGate2(root: string, state: AuthorWorkflowState, now: () => string): AuthorWorkflowState {
  if (state.capsuleDir === null || state.capsuleDigest === null) {
    throw new UsageError("author workflow lost its capsule identity");
  }
  const admitted = admitCapsule(state.capsuleDir, { review: "required" });
  if (admitted.digest !== state.capsuleDigest) throw new UsageError("Gate-2 admission returned a foreign capsule digest");
  const finalized: AuthorWorkflowState = { ...state, status: "admitted", feedback: null, updatedAt: now() };
  persistWorkflow(root, finalized);
  return finalized;
}

function emitWorkflow(state: AuthorWorkflowState, io: CmdIo): void {
  io.out(`author workflow: ${state.workflowId}`);
  io.out(`status: ${state.status}`);
  io.out(`source commit: ${state.source.commit}`);
  io.out(`source tree: ${state.source.tree}`);
  if (state.capsuleDigest !== null) io.out(`capsule digest: ${state.capsuleDigest}`);
}

export async function authorCommand(
  args: string[],
  io: CmdIo,
  trusted: TrustedAuthorOptions = {},
): Promise<number> {
  const { positionals, flags } = parseFlags(args, {
    booleans: ["headless", "acknowledge-dirty", "provisional"],
    strings: [
      "repo",
      "workflow",
      "gate1",
      "gate2",
      "feedback",
      "author",
      "adversarial-validator",
      "final-reviewer",
      "delegator",
      "delegation-budget-usd",
    ],
  });
  const now = trusted.now ?? (() => new Date().toISOString());
  const boundary = trusted.sessions ?? new DurablePendingSessionBoundary();
  const workflowFlag = strFlag(flags, "workflow");
  const gate1 = strFlag(flags, "gate1");
  const gate2 = strFlag(flags, "gate2");
  if (gate1 !== undefined && !["accept", "revise", "reject"].includes(gate1)) throw new UsageError(AUTHOR_USAGE);
  if (gate2 !== undefined && !["approve", "reject"].includes(gate2)) throw new UsageError(AUTHOR_USAGE);
  if (gate1 !== undefined && gate2 !== undefined) throw new UsageError("one invocation may record only one authoring gate action");

  if (workflowFlag === undefined) {
    if (positionals.length !== 1 || gate1 !== undefined || gate2 !== undefined) throw new UsageError(AUTHOR_USAGE);
    const objective = positionals[0]?.trim();
    if (objective === undefined || objective === "") throw new UsageError(AUTHOR_USAGE);
    const headless = boolFlag(flags, "headless");
    if (!headless && !io.isTTY) throw new UsageError("interactive authoring requires a TTY; use --headless for agent-driven authoring");
    const workflowId = trusted.workflowId ?? `author_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const temporary = mkdtempSync(join(tmpdir(), "hone-author-source-"));
    const temporarySnapshot = join(temporary, "source");
    let workflowDir: string | null = null;
    let outputDir: string | null = null;
    try {
      const repoFlag = strFlag(flags, "repo");
      const captured = await captureFreshHead(resolve(io.root, repoFlag ?? "."), temporarySnapshot, {
        env: io.env,
        io,
        headless,
        acknowledgeDirty: boolFlag(flags, "acknowledge-dirty"),
        ...(trusted.streams === undefined ? {} : { streams: trusted.streams }),
      });
      workflowDir = mintRunDirDurable(io.root, workflowId);
      const snapshotDir = join(workflowDir, "source");
      outputDir = join(io.root, "capsules", workflowId);
      chmodSync(temporarySnapshot, 0o700);
      renameSync(temporarySnapshot, snapshotDir);
      makeReadOnlyTree(snapshotDir);
      if (existsSync(outputDir)) throw new UsageError(`author capsule output already exists: ${outputDir}`);
      mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const source: FreshHeadSnapshot = { ...captured, snapshotDir };
      let state: AuthorWorkflowState = AuthorWorkflowState.parse({
        version: 1,
        workflowId,
        objective,
        status: "awaiting-capsule-author",
        source,
        outputDir,
        capsuleDir: null,
        capsuleDigest: null,
        sessions: [],
        identities: null,
        receiptSequence: 0,
        previousReceiptHash: null,
        feedback: null,
        technicalAdmission: "pending",
        updatedAt: now(),
      });
      persistWorkflow(io.root, state);
      const driven = await driveRole(io.root, state, "capsule-author", boundary, now);
      state = driven.completed
        ? { ...driven.state, status: "awaiting-gate1", updatedAt: now() }
        : driven.state;
      persistWorkflow(io.root, state);
      emitWorkflow(state, io);
      return 0;
    } catch (error) {
      if (workflowDir !== null) removeTree(workflowDir);
      if (outputDir !== null) removeTree(outputDir);
      throw error;
    } finally {
      removeTree(temporary);
    }
  }

  if (positionals.length !== 0 || strFlag(flags, "repo") !== undefined || boolFlag(flags, "acknowledge-dirty")) {
    throw new UsageError(AUTHOR_USAGE);
  }
  let state = readAuthorWorkflow(io.root, workflowFlag);
  if (gate1 === undefined && gate2 === undefined) {
    if (state.status === "awaiting-capsule-author" || state.status === "revision-required") {
      const driven = await driveRole(io.root, state, "capsule-author", boundary, now);
      state = driven.completed
        ? { ...driven.state, status: "awaiting-gate1", updatedAt: now() }
        : driven.state;
      persistWorkflow(io.root, state);
    } else if (state.status === "building-evaluators") {
      state = await completeBuildRoles(io.root, state, boundary, now);
    } else if (state.status === "gate2-approved") {
      state = finalizeGate2(io.root, state, now);
    }
    emitWorkflow(state, io);
    return 0;
  }

  const identities = identitiesFromFlags(flags, state.identities);
  if (gate1 !== undefined) {
    if (!["awaiting-gate1", "revision-required", "gate1-rejected", "admission-refused", "gate2-rejected"].includes(state.status)) {
      throw new UsageError(`Gate 1 cannot run while author workflow is ${state.status}`);
    }
    if ((state.status === "gate1-rejected" || state.status === "admission-refused") && gate1 !== "revise") {
      throw new UsageError(`${state.status} may return only through Gate 1 revise`);
    }
    const revisionFeedback = gate1 === "revise" ? strFlag(flags, "feedback") : undefined;
    if (gate1 === "revise" && (revisionFeedback === undefined || revisionFeedback.trim() === "")) {
      throw new UsageError("Gate 1 revise requires --feedback TEXT");
    }
    const action = `gate1-${gate1}` as "gate1-accept" | "gate1-revise" | "gate1-reject";
    state = appendGateReceipt(io.root, state, action, identities, flags, now);
    if (gate1 === "reject") {
      state = { ...state, status: "gate1-rejected", feedback: strFlag(flags, "feedback") ?? null, updatedAt: now() };
    } else if (gate1 === "revise" && revisionFeedback !== undefined) {
      state = { ...state, status: "revision-required", feedback: revisionFeedback, technicalAdmission: "pending", updatedAt: now() };
    } else {
      state = { ...state, status: "building-evaluators", feedback: null, technicalAdmission: "pending", updatedAt: now() };
    }
    persistWorkflow(io.root, state);
    if (gate1 === "accept") state = await completeBuildRoles(io.root, state, boundary, now);
    emitWorkflow(state, io);
    return 0;
  }

  if (state.status !== "awaiting-gate2" || state.technicalAdmission !== "passed") {
    throw new UsageError(`Gate 2 requires passed trusted admission; author workflow is ${state.status}`);
  }
  if (gate2 === "approve") {
    if (state.capsuleDir === null || state.capsuleDigest === null) throw new UsageError("author workflow lost its capsule identity");
    const technical = admitCapsule(state.capsuleDir, { review: "off" });
    if (technical.digest !== state.capsuleDigest) throw new UsageError("Gate-2 technical recheck returned a foreign capsule digest");
  }
  const action = gate2 === "approve" ? "gate2-approve" : "gate2-reject";
  state = appendGateReceipt(io.root, state, action, identities, flags, now);
  if (gate2 === "reject") {
    state = { ...state, status: "gate2-rejected", feedback: strFlag(flags, "feedback") ?? null, updatedAt: now() };
    persistWorkflow(io.root, state);
  } else {
    state = { ...state, status: "gate2-approved", feedback: null, updatedAt: now() };
    persistWorkflow(io.root, state);
    state = finalizeGate2(io.root, state, now);
  }
  emitWorkflow(state, io);
  return 0;
}
