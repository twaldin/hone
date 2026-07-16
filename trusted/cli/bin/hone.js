#!/usr/bin/env node
// The launcher is the explicit executable trust root. It admits no mutable
// JavaScript by pathname: runtime-digest.js is read once O_NOFOLLOW, hashed
// and executed from that same in-memory buffer, then supplied back to the
// sealer as the exact closure bytes to hash and stage. The generated resolver
// and boot stages are likewise read once from the sealed tree and executed as
// data URLs. Only node: builtins and canonical files below the private sealed
// root may resolve after that handoff.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ROOT_KEY = Symbol.for("hone.trusted-runtime-cli-root");
const SNAPSHOT_ROOT_KEY = Symbol.for("hone.trusted-runtime-snapshot-root");
const SNAPSHOT_PREFIX = "hone-runtime-seal-";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dataUrl = (bytes, label) =>
  `data:text/javascript;base64,${bytes.toString("base64")}#${encodeURIComponent(label)}-sha256=${sha256(bytes)}`;

const readExactFile = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`trusted launcher input ${path} is not a regular file`);
    return { bytes: readFileSync(fd), mode: st.mode & 0o7777 };
  } finally {
    closeSync(fd);
  }
};

const cliRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const priorCliRoot = globalThis[CLI_ROOT_KEY];
if (priorCliRoot !== undefined && priorCliRoot !== cliRoot) {
  throw new Error(`trusted CLI root was already pinned to ${String(priorCliRoot)}, not ${cliRoot}`);
}
if (priorCliRoot === undefined) {
  Object.defineProperty(globalThis, CLI_ROOT_KEY, {
    value: cliRoot,
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

const helperPath = join(cliRoot, "src", "runtime-digest.js");
const helper = readExactFile(helperPath);
const runtimeSeal = await import(dataUrl(helper.bytes, "runtime-sealer"));
if (
  typeof runtimeSeal.sealRuntimeSnapshot !== "function" ||
  typeof runtimeSeal.assertRuntimeSnapshotIntact !== "function"
) {
  throw new Error("captured runtime sealer does not expose the required seal API");
}
const seal = runtimeSeal.sealRuntimeSnapshot({
  helperPath,
  helperBytes: helper.bytes,
  helperMode: helper.mode,
});

// Independently constrain every helper-returned path. Self-attestation cannot
// make a malicious launcher trustworthy; this tiny file is the external trust
// root, while every later byte is confined here.
if (
  seal === null ||
  typeof seal !== "object" ||
  typeof seal.root !== "string" ||
  typeof seal.bootUrl !== "string" ||
  typeof seal.loaderUrl !== "string" ||
  !(seal.files instanceof Map)
) {
  throw new Error("runtime sealer returned a malformed snapshot");
}
const rootLstat = lstatSync(seal.root);
if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
  throw new Error(`runtime sealer returned a non-directory root ${seal.root}`);
}
const root = realpathSync(seal.root);
const tempRoot = realpathSync(tmpdir());
const tempRel = relative(tempRoot, root);
if (
  tempRel === "" ||
  tempRel === ".." ||
  tempRel.startsWith(`..${sep}`) ||
  isAbsolute(tempRel) ||
  !basename(root).startsWith(SNAPSHOT_PREFIX) ||
  resolve(root) !== resolve(seal.root) ||
  (rootLstat.mode & 0o7777) !== 0o700 ||
  (typeof process.getuid === "function" && rootLstat.uid !== process.getuid())
) {
  throw new Error(`runtime sealer returned an untrusted snapshot root ${seal.root}`);
}

const captureStage = (url, rel) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") throw new Error(`sealed ${rel} URL is not a file URL`);
  const path = fileURLToPath(parsed);
  if (resolve(path) !== resolve(join(root, rel))) {
    throw new Error(`sealed ${rel} URL escapes the snapshot root`);
  }
  const exact = readExactFile(path);
  const expected = seal.files.get(rel);
  if (
    expected === undefined ||
    expected.sha256 !== sha256(exact.bytes) ||
    expected.mode !== exact.mode
  ) {
    throw new Error(`sealed ${rel} bytes or mode do not match the authenticated snapshot`);
  }
  return exact.bytes;
};

runtimeSeal.assertRuntimeSnapshotIntact(seal);
const resolverBytes = captureStage(seal.loaderUrl, "sealed-resolver.mjs");
const bootBytes = captureStage(seal.bootUrl, "boot.mjs");
const bootDataUrl = dataUrl(bootBytes, "sealed-boot");
Object.defineProperty(globalThis, SNAPSHOT_ROOT_KEY, {
  value: root,
  writable: false,
  configurable: false,
  enumerable: false,
});
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // SIGKILL cannot run this hook; the next boot safely sweeps dead-owner roots.
  }
});
delete process.env.TSX_TSCONFIG_PATH;
delete process.env.ESBK_TSCONFIG_PATH;
register(dataUrl(resolverBytes, "sealed-resolver"), import.meta.url, {
  data: { root, allowedDataUrl: bootDataUrl },
});
runtimeSeal.assertRuntimeSnapshotIntact(seal);
await import(bootDataUrl);
