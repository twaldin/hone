import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CapsuleManifest, DiagnosticOrderingReport, capsuleDigest, deriveCapsuleId, validateDiagnosticOrdering } from "@hone/schema";
import { UsageError } from "./args.js";
import { verifyAdmissionApproval, type VerifiedAdmissionApproval } from "./admission-receipts.js";
import { loadCapsule } from "./capsule.js";
import { contractHash } from "./contract.js";
import { replayRun, writeFileDurable } from "./eventlog.js";
import { assertBaselineMatchesGitCommit } from "./git-baseline.js";
import { CONTRACT_FILE } from "./runs.js";

/**
 * Frozen capsule admission (VI.4 / M0 conformance): every check here runs
 * BEFORE any run state exists, and the validated manifest is snapshotted into
 * the run dir so a resume can prove it is resuming the exact same capsule.
 *
 * Admission requires:
 *  - the manifest parses as schema v2 (immutable name@sha256 image);
 *  - the content-addressed id recomputes exactly (deriveCapsuleId);
 *  - contentHashes covers EXACTLY the asset-group file set — no missing
 *    entries, no unreferenced extras — and every hash matches the bytes;
 *  - the diagnostic ordering report exists, hashes to the manifest's pinned
 *    hash, parses against the schema, recorded zero failures, AND its
 *    semantic invariants recompute from the recorded aggregates
 *    (validateDiagnosticOrdering) — `failures: []` alone is never trusted;
 *  - a git baseline is a CLEAN nested worktree at the declared HEAD.
 */

/** Validated-manifest snapshot written into each run dir at admission. */
export const CAPSULE_SNAPSHOT_FILE = "capsule-manifest.json";
/** Run-local, immutable copy of every manifest-pinned evaluator asset. */
export const FROZEN_CAPSULE_ASSETS_DIR = "capsule-assets";
export interface AdmitCapsuleOptions {
  review?: "required" | "off";
}


export interface AdmittedCapsule {
  manifest: CapsuleManifest;
  /** Canonical full-manifest digest (sha256:<64 hex>) — the frozen identity runs and ledgers key on. */
  digest: string;
  orderingReport: DiagnosticOrderingReport;
  /** Verified Gate-2 authority. Null only for an explicitly review-free authoring/byte-validation path. */
  approval: VerifiedAdmissionApproval | null;
  /** True only for a delegated private apply:none approval. */
  provisional: boolean;
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function refuse(capsuleDir: string, why: string): never {
  throw new UsageError(`capsule admission refused (${capsuleDir}): ${why}`);
}

/** A capsule-relative path must stay inside the capsule root. */
function insideCapsule(capsuleDir: string, rel: string): string {
  const abs = resolve(capsuleDir, rel);
  if (abs !== capsuleDir && !abs.startsWith(`${capsuleDir}/`)) {
    refuse(capsuleDir, `path escapes the capsule root: ${rel}`);
  }
  return abs;
}

function sha256Bytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readRegularFileNoFollow(root: string, rel: string, why: string): Buffer {
  const abs = insideCapsule(root, rel);
  const realRoot = realpathSync.native(root);
  let canonical: string;
  try {
    canonical = realpathSync.native(abs);
  } catch (error) {
    refuse(root, `${why} missing on disk: ${rel} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (canonical !== realRoot && !canonical.startsWith(`${realRoot}${sep}`)) {
    refuse(root, `${why} escapes the admitted root after resolution: ${rel}`);
  }
  const lst = lstatSync(abs);
  if (!lst.isFile()) refuse(root, `${why} is not a regular file: ${rel}`);
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) refuse(root, `${why} is not a regular file: ${rel}`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size
    ) {
      refuse(root, `${why} changed while it was being frozen: ${rel}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function frozenCapsuleAssetsRoot(runDir: string): string {
  return join(runDir, FROZEN_CAPSULE_ASSETS_DIR);
}

function expectedAssetDirectories(manifest: CapsuleManifest): Set<string> {
  const directories = new Set<string>([""]);
  for (const rel of Object.keys(manifest.contentHashes)) {
    let parent = dirname(rel);
    while (parent !== "." && !directories.has(parent)) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return directories;
}

function collectFrozenEntries(root: string, rel: string, files: Set<string>, directories: Set<string>): void {
  const abs = rel === "" ? root : join(root, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) refuse(root, `frozen asset snapshot contains a symlink: ${rel || "."}`);
  if (st.isFile()) {
    files.add(rel);
    return;
  }
  if (!st.isDirectory()) refuse(root, `frozen asset snapshot contains a special file: ${rel || "."}`);
  directories.add(rel);
  for (const name of readdirSync(abs)) {
    collectFrozenEntries(root, rel === "" ? name : `${rel}/${name}`, files, directories);
  }
}

function makeOwnerWritableTree(root: string): void {
  if (!existsSync(root)) return;
  const st = lstatSync(root);
  if (!st.isDirectory()) {
    chmodSync(root, 0o600);
    return;
  }
  chmodSync(root, 0o700);
  for (const name of readdirSync(root)) makeOwnerWritableTree(join(root, name));
}

/**
 * Copy the admitted asset bytes into the run before any optimizer starts.
 * Broker evaluation uses only this owner-readable tree, never the live
 * capsule source, so mid-run source drift cannot change a measurement.
 */
export function freezeCapsuleAssets(runDir: string, capsuleDir: string, manifest: CapsuleManifest): string {
  const destination = frozenCapsuleAssetsRoot(runDir);
  if (existsSync(destination)) throw new UsageError(`run already has ${FROZEN_CAPSULE_ASSETS_DIR}; refusing to replace its frozen assets`);
  const temporary = join(runDir, `.${FROZEN_CAPSULE_ASSETS_DIR}-${randomUUID()}`);
  mkdirSync(temporary, { recursive: false, mode: 0o700 });
  try {
    for (const [rel, expected] of Object.entries(manifest.contentHashes)) {
      const bytes = readRegularFileNoFollow(capsuleDir, rel, "asset");
      const actual = sha256Bytes(bytes);
      if (actual !== expected) refuse(capsuleDir, `asset drift while freezing: ${rel} hashes ${actual}, manifest pins ${expected}`);
      const target = insideCapsule(temporary, rel);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
      chmodSync(target, 0o400);
    }
    const directories = [...expectedAssetDirectories(manifest)]
      .filter((rel) => rel !== "")
      .sort((a, b) => b.length - a.length);
    for (const rel of directories) chmodSync(join(temporary, rel), 0o700);
    renameSync(temporary, destination);
    chmodSync(destination, 0o700);
    return destination;
  } catch (error) {
    makeOwnerWritableTree(temporary);
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** Authenticate the exact frozen file set and every pinned byte on resume. */
export function authenticateFrozenCapsuleAssets(runDir: string, manifest: CapsuleManifest): string {
  const root = frozenCapsuleAssetsRoot(runDir);
  if (!existsSync(root)) {
    throw new UsageError(`run is missing ${FROZEN_CAPSULE_ASSETS_DIR} — cannot prove frozen evaluator assets; refusing to resume`);
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  collectFrozenEntries(root, "", files, directories);
  const expectedFiles = new Set(Object.keys(manifest.contentHashes));
  const expectedDirectories = expectedAssetDirectories(manifest);
  for (const rel of files) {
    if (!expectedFiles.has(rel)) refuse(root, `frozen asset snapshot contains an unregistered file: ${rel}`);
  }
  for (const rel of expectedFiles) {
    if (!files.has(rel)) refuse(root, `frozen asset snapshot is missing: ${rel}`);
    const actual = sha256Bytes(readRegularFileNoFollow(root, rel, "frozen asset"));
    const expected = manifest.contentHashes[rel];
    if (actual !== expected) refuse(root, `frozen asset drift: ${rel} hashes ${actual}, manifest pins ${expected}`);
  }
  for (const rel of directories) {
    if (!expectedDirectories.has(rel)) refuse(root, `frozen asset snapshot contains an unregistered directory: ${rel}`);
  }
  return root;
}

function checkAssetHashes(capsuleDir: string, manifest: CapsuleManifest): void {
  const referenced = new Set<string>();
  for (const group of manifest.assetGroups) {
    for (const path of group.paths) referenced.add(path);
  }
  const hashed = new Set(Object.keys(manifest.contentHashes));
  for (const path of referenced) {
    if (!hashed.has(path)) refuse(capsuleDir, `asset ${path} is referenced by an asset group but has no contentHashes entry`);
  }
  for (const path of hashed) {
    if (!referenced.has(path)) refuse(capsuleDir, `contentHashes names ${path}, which no asset group references — the hash set must be exact`);
  }
  for (const [rel, expected] of Object.entries(manifest.contentHashes)) {
    const abs = insideCapsule(capsuleDir, rel);
    if (!existsSync(abs)) refuse(capsuleDir, `asset missing on disk: ${rel}`);
    const actual = sha256File(abs);
    if (actual !== expected) refuse(capsuleDir, `asset drift: ${rel} hashes ${actual}, manifest pins ${expected} — re-run capsules/tools/scaffold.ts`);
  }
}

function checkOrderingReport(capsuleDir: string, manifest: CapsuleManifest): DiagnosticOrderingReport {
  const { path: rel, hash } = manifest.diagnosticOrdering;
  const abs = insideCapsule(capsuleDir, rel);
  if (!existsSync(abs)) refuse(capsuleDir, `diagnostic ordering report missing on disk: ${rel}`);
  const actual = sha256File(abs);
  if (actual !== hash) refuse(capsuleDir, `diagnostic ordering report drift: ${rel} hashes ${actual}, manifest pins ${hash}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    refuse(capsuleDir, `diagnostic ordering report ${rel} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = DiagnosticOrderingReport.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    refuse(capsuleDir, `diagnostic ordering report ${rel} does not match the schema: ${issues}`);
  }
  if (parsed.data.failures.length > 0) {
    refuse(capsuleDir, `diagnostic ordering report records ${parsed.data.failures.length} failure(s) — a capsule whose diagnostics failed cannot be admitted: ${parsed.data.failures.join("; ")}`);
  }
  // Never trust `failures: []` or the recorded booleans: recompute the
  // semantic invariants (ordering, split integrity, gates, stability) from
  // the recorded aggregates themselves. A byte-perfect, hash-valid report
  // whose numbers do not actually prove the ordering is a semantic forgery.
  const violations = validateDiagnosticOrdering(parsed.data);
  if (violations.length > 0) {
    refuse(capsuleDir, `diagnostic ordering report ${rel} violates recomputed semantic invariant(s): ${violations.join("; ")}`);
  }
  return parsed.data;
}

function checkGitBaseline(capsuleDir: string, commit: string): void {
  const baselineDir = join(capsuleDir, "baseline");
  if (!existsSync(baselineDir)) refuse(capsuleDir, "manifest declares a git baseline but the capsule has no baseline/ directory");
  try {
    assertBaselineMatchesGitCommit(baselineDir, commit);
  } catch (error) {
    refuse(capsuleDir, `baseline git inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Full frozen admission. Throws UsageError on any refusal; never touches run state. */
export function admitCapsule(
  capsuleDir: string,
  options: AdmitCapsuleOptions = {},
): AdmittedCapsule {
  const manifest = loadCapsule(capsuleDir);
  const derived = deriveCapsuleId({ ...manifest });
  if (derived !== manifest.id) {
    refuse(capsuleDir, `manifest id ${manifest.id} does not recompute (${derived}) — the id is content-addressed and frozen`);
  }
  checkAssetHashes(capsuleDir, manifest);
  const orderingReport = checkOrderingReport(capsuleDir, manifest);
  if (manifest.baseline.kind === "git") checkGitBaseline(capsuleDir, manifest.baseline.commit);
  const digest = capsuleDigest(manifest);
  let approval: VerifiedAdmissionApproval | null = null;
  if ((options.review ?? "off") === "required") {
    const capsuleParent = dirname(resolve(capsuleDir));
    const root = capsuleParent.endsWith(`${sep}capsules`) ? dirname(capsuleParent) : capsuleParent;
    approval = verifyAdmissionApproval(join(root, ".hone-cas"), digest);
  }
  return { manifest, digest, orderingReport, approval, provisional: approval?.provisional ?? false };
}

/** Snapshot the admitted manifest into the run dir (written once, at run creation; durable — resume identity depends on it). */
export function writeCapsuleSnapshot(runDir: string, manifest: CapsuleManifest): void {
  writeFileDurable(join(runDir, CAPSULE_SNAPSHOT_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readCapsuleSnapshot(runDir: string): CapsuleManifest {
  const path = join(runDir, CAPSULE_SNAPSHOT_FILE);
  if (!existsSync(path)) throw new UsageError(`run is missing ${CAPSULE_SNAPSHOT_FILE} (${path}) — cannot prove capsule identity; refusing to resume`);
  const parsed = CapsuleManifest.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new UsageError(`run snapshot ${path} does not parse as a capsule manifest — refusing to resume`);
  return parsed.data;
}

/**
 * Delivery-time authentication of the run's capsule snapshot. The snapshot
 * names the frozen baseline commit that every delivery validates its target
 * against, so a swapped capsule-manifest.json could silently re-point
 * delivery at a different repository/commit. Before ANY manual or automatic
 * delivery the snapshot must prove it is the one the owner approved:
 *  - its content-addressed id recomputes exactly (deriveCapsuleId);
 *  - that id equals the capsuleId sealed by run.started;
 *  - contract.md hashes to the run.started contractHash (the exact approved
 *    text — the event log line is the root of trust); and
 *  - the approved text literally binds this snapshot's identity: the capsule
 *    id line, the recomputed canonical digest line, and the baseline line.
 * Any mismatch refuses before a single object is written.
 */
export function authenticateCapsuleSnapshot(runDir: string): CapsuleManifest {
  if (!existsSync(join(runDir, CAPSULE_SNAPSHOT_FILE))) {
    throw new Error(
      `run has no sealed ${CAPSULE_SNAPSHOT_FILE} — it does not durably bind a delivery baseline; refusing to deliver`,
    );
  }
  const manifest = readCapsuleSnapshot(runDir);
  const derived = deriveCapsuleId({ ...manifest });
  if (derived !== manifest.id) {
    throw new Error(
      `capsule snapshot id ${manifest.id} does not recompute (${derived}) — the snapshot content was altered; refusing to deliver`,
    );
  }
  const state = replayRun(runDir);
  if (state.capsuleId === null) {
    throw new Error("run has no acknowledged run.started — cannot authenticate the capsule snapshot; refusing to deliver");
  }
  if (state.capsuleId !== manifest.id) {
    throw new Error(
      `capsule snapshot id ${manifest.id} != run.started capsuleId ${state.capsuleId} — the snapshot is not this run's frozen capsule; refusing to deliver`,
    );
  }
  const contractPath = join(runDir, CONTRACT_FILE);
  if (!existsSync(contractPath)) {
    throw new Error(`run is missing ${CONTRACT_FILE} — cannot authenticate the capsule snapshot against the approved contract; refusing to deliver`);
  }
  const text = readFileSync(contractPath, "utf8");
  if (state.contractHash === null || contractHash(text) !== state.contractHash) {
    throw new Error(`${CONTRACT_FILE} does not hash to the run.started contract seal — the approved contract was altered; refusing to deliver`);
  }
  const bindings = [
    `- capsule: \`${manifest.id}\``,
    `- capsule digest: \`${capsuleDigest(manifest)}\``,
    manifest.baseline.kind === "git" ? `- git commit \`${manifest.baseline.commit}\`` : `- cas artifact \`${manifest.baseline.hash}\``,
  ];
  for (const line of bindings) {
    if (!text.includes(line)) {
      throw new Error(
        `the approved contract does not bind the capsule snapshot (missing ${JSON.stringify(line)}) — snapshot/contract identity mismatch; refusing to deliver`,
      );
    }
  }
  return manifest;
}

/**
 * Resume gate: the capsule on disk must re-admit AND its digest must equal the
 * digest of the manifest snapshotted when the run was created. Any drift —
 * edited assets, changed budget, swapped image — refuses the resume.
 */
export function revalidateForResume(
  runDir: string,
  capsuleDir: string,
  options: AdmitCapsuleOptions = { review: "required" },
): AdmittedCapsule {
  const snapshot = readCapsuleSnapshot(runDir);
  const admitted = admitCapsule(capsuleDir, options);
  const frozen = capsuleDigest(snapshot);
  if (admitted.digest !== frozen) {
    throw new UsageError(
      `capsule drift since the run started: digest ${admitted.digest} != frozen snapshot ${frozen} — refusing to resume (start a fresh run)`,
    );
  }
  return admitted;
}
