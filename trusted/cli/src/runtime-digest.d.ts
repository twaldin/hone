/**
 * Type surface of the plain-JS trusted-runtime digest bootstrap
 * (runtime-digest.js). The implementation is dependency-free JavaScript so
 * `bin/hone.js` can seal the boot digest BEFORE tsx registers or any trusted
 * TypeScript loads; the supervisor imports the same module for recomputation.
 */

export interface TsconfigClosureFile {
  /** repo-relative path — the digest key. */
  rel: string;
  abs: string;
}

/** Expected content hash + on-disk mode of one sealed snapshot file. */
export interface SealedSnapshotFile {
  sha256: string;
  mode: number;
}

/** A sealed execution snapshot: the immutable exact bytes this process executes. */
export interface SealedRuntimeSnapshot {
  /** The boot digest — the hash of the exact bytes staged into the snapshot. */
  digest: string;
  /** Snapshot directory (fresh, no-clobber, mode 0o700). */
  root: string;
  /** Device/inode/owner identity pinned from lstat + no-follow fstat. */
  rootId: { dev: number; ino: number; uid: number };
  /** file:// URL of the generated boot stage inside the snapshot. */
  bootUrl: string;
  /** file:// URL of the generated ESM resolution guard inside the snapshot. */
  loaderUrl: string;
  /** Snapshot-relative path → expected hash/mode, verified at handoff. */
  files: Map<string, SealedSnapshotFile>;
}

/** Nearest package root above `startPath` (throws when none exists). */
export function packageRootOf(startPath: string): string;

/** The trusted CLI package root in the LIVE repository (pinned write-once at boot). */
export function trustedCliRoot(): string;

/** The hone repository root above the pinned trusted CLI package root. */
export function trustedRepoRoot(): string;

/**
 * Every tsconfig the tsx loader can consult for the trusted runtime —
 * fail-closed against escapes from the trusted workspace closure.
 */
export function collectTsconfigClosure(repoRoot: string, packageRoots: string[]): TsconfigClosureFile[];

/** Deterministic digest of the complete trusted runtime closure (v3; symlinks refuse). */
export function computeTrustedRuntimeDigest(): string;

/** Compute-and-seal the immutable boot digest (idempotent; seals on first use when no bootstrap ran). */
export function sealBootRuntimeDigest(): string;

/**
 * Recompute the closure digest now, refuse on drift from the boot seal, and
 * return the BOOT value for persistence.
 */
export function verifiedBootRuntimeDigest(): string;

/**
 * Capture the trusted closure ONCE (hash + stage from the same buffers) into
 * a fresh no-clobber, fsynced, mode-restricted snapshot, seal/verify the boot
 * digest, and rehash the snapshot at the execution handoff. The production
 * launcher supplies runtime-digest.js from the exact in-memory buffer it is
 * executing, eliminating the bootstrap helper pathname reread.
 */
export function sealRuntimeSnapshot(
  launcherCapture?: { helperPath: string; helperBytes: Buffer; helperMode: number },
): SealedRuntimeSnapshot;

/** Rehash a sealed snapshot on disk against its recorded capture and root identity; any deviation throws. */
export function assertRuntimeSnapshotIntact(
  snapshot: Pick<SealedRuntimeSnapshot, "root" | "rootId" | "files">,
): void;
