/**
 * Trusted ordering check for the seeded-astar capsule (build plan WP6).
 *
 * Composes candidate artifacts (baseline tree + diagnostic overlay), packs
 * each one as a canonical CAS artifact, and measures every one of them
 * through the REAL hardened broker evaluation path — `docker run` of the
 * capsule's pinned image with `--network none`, read-only rootfs, resource
 * caps, the frozen baseline evaluator at /trusted/baseline, the candidate
 * artifact as data-only /workspace, and the selected asset group staged
 * root-only into /capsule/assets. Diagnostic candidate Python NEVER executes
 * on the trusted host: the only host processes this tool spawns are `docker`
 * and `tar` (canonical artifact unpack), and that is enforced at the broker's
 * RunCommand seam.
 *
 * Asserted ordering invariants (trusted admission evidence):
 *
 *   1. broken < naive < baseline < improved   on train+validation aggregate
 *      (aggregate = mean perExample score across both splits)
 *   2. shortcut > baseline on TRAIN, but NOT on validation — the memorizing
 *      cheat inverts across the split boundary, which is the split-integrity
 *      proof
 *   3. stability: 3 evaluations of the baseline stay within a relative spread
 *      band of 0.15 on aggregate ((max-min)/mean). Measured spread through
 *      the broker Docker path on an M3 Max: ~0.02, dominated by wall-clock
 *      noise in the 1/(1+ms) term — the band leaves >7x headroom.
 *   4. sanity: baseline and improved pass the trusted correctness constraint
 *      with quality 1.0
 *
 * Isolation contract of the check itself:
 *   - fresh throwaway CAS, run dir, and diagnostic-only holdout ledger under
 *     <repo>/tmp (gitignored, Docker-Desktop-shareable), removed on every exit;
 *   - default mode declares ONLY non-holdout groups, preserving the frozen
 *     seeded/public ordering path byte-for-byte;
 *   - trusted terminal-holdout mode is admitted only when BOTH
 *     --holdout-diagnostic and HONE_TERMINAL_HOLDOUT_DIAGNOSTIC=1 are present,
 *     and selects only holdout train+validation groups;
 *   - no proxy, no model, no optimizer, no credentials — eval sandboxes only;
 *   - every measurement must be a fresh container run (memo hits are
 *     rejected) and the container/volume/temp footprint must be zero after
 *     the run, on success AND on failure.
 *
 * Usage: npx tsx capsules/tools/ordering-check.ts [--report [path]]
 *   --report writes the schema-validated compact aggregate JSON summary
 *   (default path: <capsule>/diagnostics/ordering-report.json) on success.
 *
 * Capsule selection: the check targets capsules/seeded-astar by default. Set
 * HONE_CAPSULE_DIR to the absolute path of another capsule directory (with
 * capsule.config.json, baseline/, diagnostics/{broken,naive,shortcut,improved})
 * to run the identical trusted check against it:
 *
 *   HONE_CAPSULE_DIR=/abs/path/to/capsule npx tsx capsules/tools/ordering-check.ts --report
 *
 * Owner-only pre-freeze terminal-holdout admission diagnostic:
 *
 *   HONE_CAPSULE_DIR=/abs/path/to/capsule \
 *   HONE_TERMINAL_HOLDOUT_DIAGNOSTIC=1 \
 *   npx tsx capsules/tools/ordering-check.ts --holdout-diagnostic --report
 */

import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Broker,
  CasStore,
  packDirAsArtifact,
  runCommand,
  type CallContext,
  type RunCommand,
} from "@hone/broker";
import {
  CapsuleManifest,
  DIAGNOSTIC_ORDERING_REPORT_VERSION,
  DiagnosticOrderingReport,
  SCHEMA_VERSION,
  canonicalJson,
  capsuleDigest,
  deriveCapsuleId,
  type EvaluatorOutput,
} from "@hone/schema";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
/** Frozen default target: the seeded-astar capsule this tool was originally built around (WP6). */
const DEFAULT_CAPSULE_DIR = resolve(TOOL_DIR, "..", "seeded-astar");
/** Throwaway roots live under <repo>/tmp: gitignored AND under /Users, so Docker Desktop file sharing covers every bind-mount source. */
const TMP_ROOT = resolve(TOOL_DIR, "..", "..", "tmp");
const SPLITS = ["train", "validation"] as const;
const DIAGNOSTICS = ["broken", "naive", "shortcut", "improved"] as const;
const STABILITY_RUNS = 3;
const STABILITY_BAND = 0.15;
/** Every ordering datapoint is a fresh container eval: (baseline + 4 diagnostics + 2 extra stability passes) x 2 splits. */
const EXPECTED_EVALS = (1 + DIAGNOSTICS.length + (STABILITY_RUNS - 1)) * SPLITS.length;

/** Environment override consumed by {@link resolveCapsuleDir}. */
export const CAPSULE_DIR_ENV_VAR = "HONE_CAPSULE_DIR";
/** Second half of the owner/trusted terminal-holdout diagnostic admission gate. */
export const TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR =
  "HONE_TERMINAL_HOLDOUT_DIAGNOSTIC";
/** First half of the owner/trusted terminal-holdout diagnostic admission gate. */
export const TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG = "--holdout-diagnostic";

/**
 * The terminal-holdout diagnostic is deliberately impossible to enable with
 * ambient environment OR a stray command-line flag alone. This is a
 * pre-freeze owner admission path, never an optimizer-facing mode.
 */
export function resolveTerminalHoldoutDiagnosticMode(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  const hasFlag = args.includes(TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG);
  const rawEnv = env[TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR];
  if (rawEnv !== undefined && rawEnv !== "1") {
    throw new Error(
      `${TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR} must be exactly "1" when set`,
    );
  }
  const hasEnv = rawEnv === "1";
  if (hasFlag !== hasEnv) {
    throw new Error(
      `terminal holdout diagnostic requires both ${TERMINAL_HOLDOUT_DIAGNOSTIC_FLAG} and ${TERMINAL_HOLDOUT_DIAGNOSTIC_ENV_VAR}=1`,
    );
  }
  return hasFlag;
}

/**
 * Resolve the capsule directory this check targets. Deterministic in its
 * argument — it never reads ambient process state: pass a NodeJS env object
 * (or the raw override string directly) and get back either the frozen
 * seeded-astar default (override unset) or the canonical absolute path of
 * the override capsule.
 *
 * An override is validated up front, before any CAS/Docker setup exists:
 *   - it must already be absolute, with no ".." traversal segments;
 *   - it must exist and be a real directory (not a symlink);
 *   - it must contain a readable regular capsule.config.json, a baseline/
 *     directory, and diagnostics/{broken,naive,shortcut,improved} directories.
 * Violations throw an error naming the offending path — never file contents.
 */
export function resolveCapsuleDir(source: NodeJS.ProcessEnv | string): string {
  const raw = typeof source === "string" ? source : source[CAPSULE_DIR_ENV_VAR];
  if (raw === undefined) return DEFAULT_CAPSULE_DIR;

  const fail = (problem: string): never => {
    throw new Error(`${CAPSULE_DIR_ENV_VAR} ${problem}`);
  };
  if (raw.length === 0) {
    return fail("is set but empty; unset it for the default capsule or provide an absolute capsule directory");
  }
  if (!isAbsolute(raw)) return fail(`must be an absolute path, got relative path: ${raw}`);
  if (raw.split(sep).includes("..")) {
    return fail(`must not contain ".." traversal segments: ${raw}`);
  }
  const dir = resolve(raw);

  const statNoFollow = (path: string) => {
    try {
      return lstatSync(path);
    } catch {
      return undefined;
    }
  };
  const requireRealDir = (path: string): void => {
    const st = statNoFollow(path);
    if (st === undefined) fail(`requires a directory that does not exist: ${path}`);
    else if (st.isSymbolicLink()) fail(`requires a real directory, but found a symlink: ${path}`);
    else if (!st.isDirectory()) fail(`requires a directory, but the path is not one: ${path}`);
  };

  requireRealDir(dir);
  const configPath = join(dir, "capsule.config.json");
  const configStat = statNoFollow(configPath);
  if (configStat === undefined) fail(`capsule is missing required file: ${configPath}`);
  else if (configStat.isSymbolicLink() || !configStat.isFile()) {
    fail(`capsule config must be a regular file (not a symlink): ${configPath}`);
  }
  try {
    accessSync(configPath, fsConstants.R_OK);
  } catch {
    fail(`capsule config is not readable: ${configPath}`);
  }
  requireRealDir(join(dir, "baseline"));
  for (const diagnostic of DIAGNOSTICS) {
    requireRealDir(join(dir, "diagnostics", diagnostic));
  }
  return dir;
}

/** Resolved once at module load: an invalid override fails right here, before any CAS/Docker setup can exist. */
const CAPSULE_DIR = resolveCapsuleDir(process.env);

type Split = (typeof SPLITS)[number];
type Variant = "baseline" | (typeof DIAGNOSTICS)[number];

/**
 * This tool IS the trusted admission side (admin-socket equivalent): it needs
 * the unredacted perExample scores of the protected validation split. The
 * provisional manifest contains no holdout group at all, so privilege can
 * never reach holdout data here.
 */
const TRUSTED_CTX: CallContext = { privileged: true };

/**
 * Deterministic placeholder for the report the check is about to produce —
 * the manifest identity is provisional by construction (chicken-and-egg:
 * scaffold pins the REAL report hash after this tool succeeds).
 */
const PROVISIONAL_ORDERING_HASH = `sha256:${createHash("sha256")
  .update("hone ordering-check: provisional diagnosticOrdering placeholder")
  .digest("hex")}`;

/** Digest slot for the memo key; no optimizer is involved in admission measurements. */
const ORDERING_TOOL_DIGEST = `sha256:${createHash("sha256")
  .update("hone ordering-check: trusted admission tool (no optimizer)")
  .digest("hex")}`;

const SKIP_ENTRIES: Record<string, true> = {
  ".git": true,
  ".gitdir": true,
  __pycache__: true,
  ".pytest_cache": true,
};

/** Baseline tree + (for diagnostics) variant overlay -> temp compose dir (host-side only; only its packed CAS tar ever reaches a container). */
function composeArtifact(variant: Variant): string {
  const artifact = mkdtempSync(join(tmpdir(), `hone-astar-${variant}-`));
  for (const entry of readdirSync(join(CAPSULE_DIR, "baseline"))) {
    if (SKIP_ENTRIES[entry]) continue;
    cpSync(join(CAPSULE_DIR, "baseline", entry), join(artifact, entry), {
      recursive: true,
    });
  }
  if (variant !== "baseline") {
    for (const entry of readdirSync(join(CAPSULE_DIR, "diagnostics", variant))) {
      cpSync(join(CAPSULE_DIR, "diagnostics", variant, entry), join(artifact, entry), {
        recursive: true,
      });
    }
  }
  return artifact;
}

/**
 * Structural slice of capsule.config.json this tool needs — the pre-manifest
 * source of truth. The ordering report is an INPUT to the manifest (scaffold
 * hashes it into diagnosticOrdering), so this tool cannot depend on
 * manifest.json; scaffold emits the same fields verbatim into the manifest.
 * Semantic validation happens in CapsuleManifest.parse on the provisional
 * manifest below.
 */
interface CapsuleConfig {
  objective: string;
  image: string;
  evalEntrypoint: string[];
  protectedPaths: string[];
  assetGroups: { id: string; visibility: string; paths: string[] }[];
  budget: Record<string, number>;
  diagnosticOrdering: { path: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function loadCapsuleConfig(): CapsuleConfig {
  const fail = (field: string): never => {
    throw new Error(`capsule.config.json: invalid or missing "${field}"`);
  };
  const raw: unknown = JSON.parse(readFileSync(join(CAPSULE_DIR, "capsule.config.json"), "utf8"));
  if (!isRecord(raw)) return fail("<root>");
  const { objective, image, evalEntrypoint, protectedPaths, assetGroups, budget, diagnosticOrdering } = raw;
  if (typeof objective !== "string" || objective.length === 0) return fail("objective");
  if (typeof image !== "string" || image.length === 0) return fail("image");
  if (!isStringArray(evalEntrypoint) || evalEntrypoint.length === 0) return fail("evalEntrypoint");
  if (protectedPaths !== undefined && !isStringArray(protectedPaths)) return fail("protectedPaths");
  if (!Array.isArray(assetGroups) || assetGroups.length === 0) return fail("assetGroups");
  const groups = assetGroups.map((g, index) => {
    if (!isRecord(g)) return fail(`assetGroups[${index}]`);
    const { id, visibility, paths } = g;
    if (typeof id !== "string" || id.length === 0) return fail(`assetGroups[${index}].id`);
    if (typeof visibility !== "string") return fail(`assetGroups[${index}].visibility`);
    if (!isStringArray(paths) || paths.length === 0) return fail(`assetGroups[${index}].paths`);
    return { id, visibility, paths };
  });
  if (!isRecord(budget)) return fail("budget");
  const budgetNumbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(budget)) {
    if (typeof value !== "number") return fail(`budget.${key}`);
    budgetNumbers[key] = value;
  }
  if (!isRecord(diagnosticOrdering) || typeof diagnosticOrdering.path !== "string" || diagnosticOrdering.path.length === 0) {
    return fail("diagnosticOrdering.path");
  }
  return {
    objective,
    image,
    evalEntrypoint,
    protectedPaths: protectedPaths ?? [],
    assetGroups: groups,
    budget: budgetNumbers,
    diagnosticOrdering: { path: diagnosticOrdering.path },
  };
}
type ExpandedAssetGroup = CapsuleConfig["assetGroups"][number];

/**
 * Select and expand asset groups before any CAS or Docker setup. The default
 * branch is the original non-holdout selection verbatim. Terminal mode
 * instead admits exactly the selected train+validation groups, and refuses
 * missing, public, protected, or mixed visibility without reading asset bytes.
 */
function selectAssetGroups(
  config: CapsuleConfig,
  terminalHoldoutDiagnostic: boolean,
): ExpandedAssetGroup[] {
  if (!terminalHoldoutDiagnostic) {
    return config.assetGroups
      .filter((g) => g.visibility !== "holdout")
      .map((g) => ({ ...g, paths: g.paths.flatMap((p) => expandPaths(p)) }));
  }

  const selected = config.assetGroups.filter((group) =>
    SPLITS.some((split) => split === group.id),
  );
  for (const split of SPLITS) {
    const splitGroups = selected.filter((group) => group.id === split);
    if (splitGroups.length === 0) {
      throw new Error(
        `capsule.config.json: missing holdout asset group "${split}" required by the terminal holdout diagnostic`,
      );
    }
    if (splitGroups.some((group) => group.visibility !== "holdout")) {
      throw new Error(
        `capsule.config.json: terminal holdout diagnostic rejects public/mixed visibility for selected asset group "${split}"; every selected group must be holdout`,
      );
    }
  }
  return selected.map((group) => ({
    ...group,
    paths: group.paths.flatMap((path) => expandPaths(path)),
  }));
}

/** Expand a capsule-relative path (file or directory) to sorted file rel paths. Never follows symlinks. */
function expandPaths(rel: string): string[] {
  const abs = join(CAPSULE_DIR, rel);
  const st = lstatSync(abs);
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) {
    throw new Error(`asset path is neither a regular file nor a directory: ${rel}`);
  }
  const out: string[] = [];
  for (const entry of [...readdirSync(abs)].sort()) {
    out.push(...expandPaths(posix.join(rel, entry)));
  }
  return out;
}

/**
 * Provisional, schema-valid manifest identity for the admission measurement.
 * Asset selection and directory expansion already completed before CAS/Docker
 * setup. Default mode supplies only non-holdout groups; the explicit trusted
 * terminal mode supplies only all-holdout train+validation groups.
 */
function provisionalManifest(
  config: CapsuleConfig,
  baselineHash: string,
  assetGroups: ExpandedAssetGroup[],
): CapsuleManifest {
  for (const split of SPLITS) {
    if (!assetGroups.some((g) => g.id === split)) {
      throw new Error(`capsule.config.json: missing non-holdout asset group "${split}" required by the ordering check`);
    }
  }
  const contentHashes: Record<string, string> = {};
  for (const group of assetGroups) {
    for (const rel of group.paths) {
      contentHashes[rel] = `sha256:${createHash("sha256").update(readFileSync(join(CAPSULE_DIR, rel))).digest("hex")}`;
    }
  }
  const sansId: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    objective: config.objective,
    baseline: { kind: "cas", hash: baselineHash },
    image: config.image,
    evalEntrypoint: config.evalEntrypoint,
    protectedPaths: config.protectedPaths,
    assetGroups,
    budget: config.budget,
    diagnosticOrdering: { path: config.diagnosticOrdering.path, hash: PROVISIONAL_ORDERING_HASH },
    contentHashes,
  };
  return CapsuleManifest.parse({ ...sansId, id: deriveCapsuleId(sansId) });
}

/** Mean perExample score across one or more evaluator outputs. */
function aggregate(...outputs: EvaluatorOutput[]): number {
  const scores = outputs.flatMap((o) =>
    Object.values(o.perExample).map((e) => e.score),
  );
  if (scores.length === 0) throw new Error("no perExample scores to aggregate");
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

interface VariantResult {
  bySplit: Record<Split, EvaluatorOutput>;
  train: number;
  validation: number;
  combined: number;
}

/**
 * One variant, both splits, through the real broker eval path. The seed is
 * memo-key material — stability re-measurements pass distinct seeds so the
 * broker can never serve a cached record; a cache hit is rejected outright.
 */
async function evaluateVariant(
  broker: Broker,
  cas: CasStore,
  variant: Variant,
  seed: number,
): Promise<VariantResult> {
  const artifactDir = composeArtifact(variant);
  let hash: string;
  try {
    hash = await packDirAsArtifact(artifactDir, cas);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
  const bySplit = {} as Record<Split, EvaluatorOutput>;
  for (const split of SPLITS) {
    const record = await broker.evaluate({ artifact: { hash }, assetGroupId: split, seed }, TRUSTED_CTX);
    if (record.cached) {
      throw new Error(
        `ordering-check: ${variant}/${split} (seed ${seed}) was served from the eval memo — every ordering datapoint must be a fresh container evaluation`,
      );
    }
    bySplit[split] = record.output;
  }
  return {
    bySplit,
    train: aggregate(bySplit.train),
    validation: aggregate(bySplit.validation),
    combined: aggregate(bySplit.train, bySplit.validation),
  };
}

/**
 * Trust-but-verify over the recorded host-command transcript: the broker seam
 * already REJECTS anything but docker/tar, this re-asserts it after the fact
 * and pins the two acceptance-critical container properties — no host Python
 * (the evaluator and every diagnostic candidate ran in-container only) and
 * every eval container was started with `--network none` and never saw a
 * holdout path.
 */
function assertHostTranscriptClean(commands: readonly (readonly string[])[]): void {
  for (const argv of commands) {
    const head = argv[0] ?? "";
    if (head !== "docker" && head !== "tar") {
      throw new Error(`ordering-check: non-docker/tar host command was spawned: ${argv.join(" ")}`);
    }
    if (/python/i.test(head)) {
      throw new Error(`ordering-check: host Python execution detected: ${argv.join(" ")}`);
    }
    for (const token of argv) {
      if (token.includes("assets/holdout")) {
        throw new Error(`ordering-check: holdout path leaked into a host command: ${argv.join(" ")}`);
      }
    }
    if (head === "docker" && argv[1] === "run") {
      const netFlag = argv.indexOf("--network");
      if (netFlag === -1 || argv[netFlag + 1] !== "none") {
        throw new Error(`ordering-check: eval container without --network none: ${argv.join(" ")}`);
      }
    }
  }
}

/**
 * Zero-footprint verification + teardown, used on success AND failure:
 * containers labeled with this run, scratch volumes named for this run, and
 * the throwaway temp root must all be gone. Leaked containers/volumes are
 * reaped best-effort AFTER being reported — the leak is still an error.
 */
async function findAndReapLeaks(runId: string, tempRoot: string): Promise<string[]> {
  const leaks: string[] = [];
  const ps = await runCommand(["docker", "ps", "-aq", "--filter", `label=hone.runId=${runId}`]);
  if (ps.exitCode !== 0) {
    leaks.push(`docker ps leak-check failed: ${ps.stderr.toString("utf8").slice(0, 500)}`);
  } else {
    const ids = ps.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length > 0) {
      leaks.push(`containers leaked (label hone.runId=${runId}): ${ids.join(", ")}`);
      await runCommand(["docker", "rm", "-f", ...ids]);
    }
  }
  const vol = await runCommand(["docker", "volume", "ls", "-q", "--filter", `name=hone-scratch-${runId}`]);
  if (vol.exitCode !== 0) {
    leaks.push(`docker volume leak-check failed: ${vol.stderr.toString("utf8").slice(0, 500)}`);
  } else {
    const names = vol.stdout.toString("utf8").split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    if (names.length > 0) {
      leaks.push(`volumes leaked: ${names.join(", ")}`);
      await runCommand(["docker", "volume", "rm", "-f", ...names]);
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
  if (existsSync(tempRoot)) leaks.push(`temp root still present: ${tempRoot}`);
  return leaks;
}

export interface OrderingReport {
  results: Record<Variant, VariantResult>;
  stabilityAggregates: number[];
  stabilitySpread: number;
  failures: string[];
  /** Real broker eval containers spawned — asserted equal to EXPECTED_EVALS (no memo hits, no host evals). */
  evalInvocations: number;
  /** Wall-clock duration of the full check, ms. */
  wallMs: number;
}

export async function runOrderingCheck(): Promise<OrderingReport> {
  const startedMs = Date.now();
  const terminalHoldoutDiagnostic = resolveTerminalHoldoutDiagnosticMode(
    process.argv.slice(2),
    process.env,
  );
  const config = loadCapsuleConfig();
  const assetGroups = selectAssetGroups(config, terminalHoldoutDiagnostic);
  mkdirSync(TMP_ROOT, { recursive: true });
  const tempRoot = mkdtempSync(join(TMP_ROOT, "ordering-check-"));
  const runId = `ordering-${randomBytes(4).toString("hex")}`;

  // The broker's single seam to the host: everything it spawns is recorded,
  // and anything that is not the docker CLI or the canonical tar unpack is
  // rejected before it runs. Host Python is structurally impossible.
  const commands: string[][] = [];
  const guardedRun: RunCommand = (argv, opts) => {
    commands.push([...argv]);
    const head = argv[0] ?? "";
    if (head !== "docker" && head !== "tar") {
      return Promise.reject(
        new Error(`ordering-check: blocked host command (only docker/tar are permitted): ${argv.join(" ")}`),
      );
    }
    return runCommand(argv, opts);
  };

  let broker: Broker | undefined;
  let failed = false;
  try {
    const casDir = join(tempRoot, "cas");
    const cas = new CasStore(casDir);
    const baselineHash = await packDirAsArtifact(join(CAPSULE_DIR, "baseline"), cas);
    const manifest = provisionalManifest(config, baselineHash, assetGroups);

    broker = new Broker({
      runId,
      manifest,
      capsuleRootDir: CAPSULE_DIR,
      baselineArtifactHash: baselineHash,
      capsuleDigest: capsuleDigest(manifest),
      optimizerDigest: ORDERING_TOOL_DIGEST,
      holdoutLedgerPath: join(tempRoot, "holdout-ledger.ndjson"),
      ...(terminalHoldoutDiagnostic ? { holdoutBudget: EXPECTED_EVALS } : {}),
      image: manifest.image,
      runDir: join(tempRoot, "run"),
      casDir,
      onEvent: () => {},
      runCommand: guardedRun,
    });
    await broker.init();

    const failures: string[] = [];
    const check = (label: string, ok: boolean): void => {
      if (!ok) failures.push(label);
    };

    const results = {} as Record<Variant, VariantResult>;
    for (const variant of ["baseline", ...DIAGNOSTICS] as const) {
      results[variant] = await evaluateVariant(broker, cas, variant, 0);
    }

    // 1. Discrimination ordering on the combined train+validation aggregate.
    check(
      `broken(${results.broken.combined}) < naive(${results.naive.combined})`,
      results.broken.combined < results.naive.combined,
    );
    check(
      `naive(${results.naive.combined}) < baseline(${results.baseline.combined})`,
      results.naive.combined < results.baseline.combined,
    );
    check(
      `baseline(${results.baseline.combined}) < improved(${results.improved.combined})`,
      results.baseline.combined < results.improved.combined,
    );

    // 2. Split integrity: the train-memorizing cheat inverts across splits.
    check(
      `shortcut beats baseline on train (${results.shortcut.train} > ${results.baseline.train})`,
      results.shortcut.train > results.baseline.train,
    );
    check(
      `shortcut does NOT beat baseline on validation (${results.shortcut.validation} < ${results.baseline.validation})`,
      results.shortcut.validation < results.baseline.validation,
    );

    // 3. Stability: repeated baseline evals within the relative spread band.
    //    Distinct seeds keep the memo key distinct — each pass is a fresh
    //    container measurement of the SAME baseline artifact.
    const stabilityAggregates = [results.baseline.combined];
    for (let i = 1; i < STABILITY_RUNS; i += 1) {
      stabilityAggregates.push((await evaluateVariant(broker, cas, "baseline", i)).combined);
    }
    const mean =
      stabilityAggregates.reduce((a, b) => a + b, 0) / stabilityAggregates.length;
    const stabilitySpread =
      (Math.max(...stabilityAggregates) - Math.min(...stabilityAggregates)) / mean;
    check(
      `baseline stability spread ${stabilitySpread.toFixed(4)} < ${STABILITY_BAND}`,
      stabilitySpread < STABILITY_BAND,
    );

    // 4. Sanity: the correct candidates actually satisfy the constraint gates.
    for (const variant of ["baseline", "improved"] as const) {
      for (const split of SPLITS) {
        const out = results[variant].bySplit[split];
        check(
          `${variant}/${split} tests_pass`,
          out.constraints["tests_pass"] === true,
        );
        check(
          `${variant}/${split} quality == 1`,
          out.diagnostics?.["quality"] === 1.0,
        );
      }
    }

    // Measurement-integrity assertions (tool bugs, not ordering failures —
    // they THROW): every datapoint was a distinct real container eval and the
    // host transcript is clean.
    const evalInvocations = commands.filter((c) => c[0] === "docker" && c[1] === "run").length;
    if (evalInvocations !== EXPECTED_EVALS) {
      throw new Error(
        `ordering-check: expected exactly ${EXPECTED_EVALS} container evaluations, observed ${evalInvocations}`,
      );
    }
    assertHostTranscriptClean(commands);

    return {
      results,
      stabilityAggregates,
      stabilitySpread,
      failures,
      evalInvocations,
      wallMs: Date.now() - startedMs,
    };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    try {
      await broker?.close();
    } catch (closeErr) {
      if (!failed) throw closeErr;
      console.error(`ordering-check: broker close failed after error: ${String(closeErr)}`);
    }
    const leaks = await findAndReapLeaks(runId, tempRoot);
    if (leaks.length > 0) {
      const message = `ordering-check: resource leaks detected:\n- ${leaks.join("\n- ")}`;
      // Never mask the primary failure; a leak on the success path is fatal.
      if (failed) console.error(message);
      else throw new Error(message);
    }
  }
}

/**
 * Compact persisted summary of a full ordering check — the shape the capsule
 * manifest pins by hash (`diagnosticOrdering`). Parsed through the shared
 * schema so a malformed summary can never be generated in the first place.
 */
export function summarizeOrderingReport(report: OrderingReport): DiagnosticOrderingReport {
  const variant = (r: VariantResult) => ({
    train: r.train,
    validation: r.validation,
    combined: r.combined,
    trainTestsPass: r.bySplit.train.constraints["tests_pass"] === true,
    validationTestsPass: r.bySplit.validation.constraints["tests_pass"] === true,
  });
  return DiagnosticOrderingReport.parse({
    version: DIAGNOSTIC_ORDERING_REPORT_VERSION,
    variants: {
      baseline: variant(report.results.baseline),
      broken: variant(report.results.broken),
      naive: variant(report.results.naive),
      shortcut: variant(report.results.shortcut),
      improved: variant(report.results.improved),
    },
    stability: {
      aggregates: report.stabilityAggregates,
      spread: report.stabilitySpread,
      band: STABILITY_BAND,
    },
    failures: report.failures,
  });
}

/**
 * Deterministic bytes for the persisted report: the canonical JSON (sorted
 * keys, no whitespace) plus a trailing newline. Serializing the same summary
 * twice is byte-identical, so a scaffold rerun over the persisted file
 * reproduces the same hash and capsule id.
 */
export function serializeOrderingReport(summary: DiagnosticOrderingReport): string {
  return `${canonicalJson(summary)}\n`;
}

function formatReport(report: OrderingReport): string {
  const lines: string[] = [];
  lines.push("variant    train        validation   combined     tests_pass(train/val)");
  for (const [variant, r] of Object.entries(report.results)) {
    lines.push(
      `${variant.padEnd(10)} ${r.train.toExponential(3).padEnd(12)} ` +
        `${r.validation.toExponential(3).padEnd(12)} ` +
        `${r.combined.toExponential(3).padEnd(12)} ` +
        `${String(r.bySplit.train.constraints["tests_pass"])}/${String(
          r.bySplit.validation.constraints["tests_pass"],
        )}`,
    );
  }
  lines.push(
    `stability: aggregates [${report.stabilityAggregates
      .map((a) => a.toExponential(3))
      .join(", ")}], spread ${report.stabilitySpread.toFixed(4)} (band ${STABILITY_BAND})`,
  );
  lines.push(
    `measurements: ${report.evalInvocations} broker container evals (network none, host-exec free), wall ${(report.wallMs / 1000).toFixed(1)}s`,
  );
  return lines.join("\n");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--report");
  const reportArg = flagIndex === -1 ? undefined : args[flagIndex + 1];
  const reportPath =
    flagIndex === -1
      ? undefined
      : (reportArg === undefined || reportArg.startsWith("--")
        ? join(CAPSULE_DIR, "diagnostics", "ordering-report.json")
        : reportArg);

  const report = await runOrderingCheck();
  console.log(formatReport(report));
  if (report.failures.length > 0) {
    console.error(`\nORDERING CHECK FAILED:\n- ${report.failures.join("\n- ")}`);
    process.exit(1);
  }
  if (reportPath !== undefined) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, serializeOrderingReport(summarizeOrderingReport(report)));
    console.log(`\nreport -> ${reportPath}`);
  }
  console.log("\nordering check PASSED");
}
