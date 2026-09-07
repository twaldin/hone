'use strict';

// Trusted timed benchmark driver for the WHATWG URL capsule (round-6 revision).
//
// EXEC-BOUNDARY note. The scored parse/serialize loop runs inside a node
// binary that links candidate-mutable URL code (src/node_url.cc, deps/ada,
// lib/internal/url.js), so a C++ static constructor / .init_array routine can
// run before ANY JavaScript. Two structural properties bound what such a
// pre-main routine can achieve:
//
//   1. READINESS HANDSHAKE (hygiene, NOT a boundary). The trusted parent sends
//      no go-token until it has read the readiness marker written below on a
//      DEDICATED inherited descriptor (HONE_READY_FD) that carries nothing
//      else; the receipt descriptor's first line must therefore be the
//      nonce-authenticated receipt, and readiness bytes can never be conflated
//      with it. A pre-main routine shares this process's descriptor table and
//      environment, so it CAN write the marker early — that is explicitly not
//      where the binding lives. Early impersonation only makes the parent
//      start its clock during process bootstrap, LENGTHENING that leg's own
//      measured window; it can never shorten the window, because the clock
//      runs from go-token release to the receipt regardless of who signalled
//      readiness. For an honest driver the marker keeps interpreter/module
//      bootstrap out of the timed window.
//
//   2. GO-TIME PER-ITERATION CONTENT (the actual binding). Every timed
//      iteration's input URL / URLSearchParams string is drawn from a bank of
//      structurally-distinct shape templates — scheme case, default and
//      leading-zero ports, dot and %2e segments, backslash separators,
//      userinfo, IDN hosts, IPv4/IPv6 normalization, tab stripping, space /
//      percent / plus / separator handling — with both the shape and its
//      variable content selected by a nonce the parent delivers only at
//      clock-start (after readiness). The per-iteration outputs are folded
//      into a nonce-salted accumulator the parent independently reproduces
//      from a PRISTINE reference leg run over the identical nonce stream.
//      Because the inputs do not exist before the go-token, no correct
//      accumulator can be precomputed in the untimed window; because each
//      iteration normalizes a fresh, structurally-varied, non-idempotent
//      input, no single-template fast path, per-input parse cache, or
//      closed-form fold over public constants can stand in for the work. The
//      only way to produce the reference-matching accumulator is to run the
//      real per-iteration URL work inside the timed window.
//
// The candidate URL code influences only the per-operation OUTPUT STRING; the
// loop, the clock, the reference expectation, and the memory accounting all
// live in the trusted parent.

const fs = require('fs');
// Capture write/read primitives and the heap probe before candidate URL code
// can replace them.
const readSync = fs.readSync;
const writeSync = fs.writeSync;
const closeSync = fs.closeSync;
const memoryUsage = process.memoryUsage;

// Rolling accumulator ring shared with the trusted parent's reference leg.
// MOD is a Mersenne prime; the fold is order-sensitive so a candidate cannot
// permute work. There is deliberately NO closed form: inputs vary per
// iteration, so the parent obtains the expected value from the reference leg,
// never from arithmetic on these constants.
const MOD = 2147483647; // 2^31 - 1
const MULT = 1000003;
const POLY = 257;

const goFd = Number.parseInt(process.env.HONE_GO_FD || '', 10);
const receiptFd = Number.parseInt(process.env.HONE_RECEIPT_FD || '', 10);
const readyFd = Number.parseInt(process.env.HONE_READY_FD || '', 10);
delete process.env.HONE_GO_FD;
delete process.env.HONE_RECEIPT_FD;
delete process.env.HONE_READY_FD;

function fail(detail) {
  try {
    writeSync(2, `HONE_DRIVER_FAIL ${detail}\n`);
  } catch {
    // ignore
  }
  process.exit(1);
}

const mode = process.argv[2];
const cellId = process.argv[3];
const count = Number.parseInt(process.argv[4], 10);
const family = process.argv[5];
if (!Number.isInteger(count) || count <= 0) fail('invalid iteration count');
if (family !== 'train' && family !== 'validation') fail('invalid workload family');
if (!Number.isInteger(receiptFd) || receiptFd < 0) fail('missing receipt channel');
if (!Number.isInteger(goFd) || goFd < 0) fail('missing go channel');
if (!Number.isInteger(readyFd) || readyFd < 0) fail('missing readiness channel');

function polyHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * POLY + text.charCodeAt(i)) % MOD;
  }
  return h;
}

// --- Readiness echo on the DEDICATED readiness descriptor, from JS top level.
// Single line, then EOF: the parent requires the marker followed by channel
// close before it releases the go nonce. This is clock hygiene, not a
// boundary: pre-main native code sharing this process could write the same
// bytes, but doing so only starts the parent's clock earlier (during
// bootstrap) and gains nothing — the credited result is the go-nonce-derived
// output fold, checked against the pristine reference leg. ---
try {
  writeSync(readyFd, 'HONE_DRIVER_READY\n');
  closeSync(readyFd);
} catch {
  fail('could not emit readiness marker');
}

// --- Read the go nonce delivered at clock-start (blocks until the parent has
// seen readiness and started its clock). ---
let nonce = '';
try {
  const buffer = Buffer.alloc(64);
  let total = 0;
  // The parent writes "<hex-nonce>\n"; read until newline.
  for (;;) {
    const n = readSync(goFd, buffer, total, buffer.length - total, null);
    if (n <= 0) break;
    total += n;
    const nl = buffer.indexOf(0x0a);
    if (nl >= 0) {
      nonce = buffer.toString('utf8', 0, nl).trim();
      break;
    }
    if (total >= buffer.length) break;
  }
  closeSync(goFd);
} catch {
  nonce = '';
}
if (!nonce || !/^[0-9a-f]{8,}$/.test(nonce)) fail('missing go nonce');

// A fast per-iteration mixer seeded by the go nonce. Distinct i -> distinct
// state -> distinct input, and the whole stream shifts with every fresh nonce.
const seedHi = Number.parseInt(nonce.slice(0, 8), 16) >>> 0;
const seedLo = Number.parseInt(nonce.slice(8, 16) || nonce.slice(0, 8), 16) >>> 0;
const nonceSeed = (polyHash(nonce) + 1) % MOD;

function mix(i) {
  // xorshift-ish 32-bit mix of (seed, i); returns a non-negative 31-bit int.
  let x = (seedHi ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x = (x + seedLo) >>> 0;
  x ^= x << 5; x >>>= 0;
  return x & 0x7fffffff;
}

// Source reference only. Frozen split-specific input factories are withheld.
function makeUrl() { throw new Error("Use the original private terminal capsule bundle"); }
function makeParams() { throw new Error("Use the original private terminal capsule bundle"); }


let acc = nonceSeed;
let processed = 0;

// K repeated serializations per fresh instance. The first serialization of
// each distinct instance is unfakeable real work (the encoded output cannot be
// predicted without doing it); the repeats are what a legitimate per-instance
// serialization cache (the "improved" control) or a genuine encoder speedup
// gets to bite on. A gaming path that "caches" the repeats does no better than
// that legitimate optimization, and still owes the per-instance real work.
const SERIALIZE_REPEATS = 64;

try {
  if (mode === 'url-parse') {
    for (let i = 0; i < count; i += 1) {
      const u = new URL(makeUrl(i));
      const out = u.href;
      if (typeof out !== 'string') fail('non-string url output');
      acc = (acc * MULT + polyHash(out)) % MOD;
      processed += 1;
    }
  } else if (mode === 'sp-parse') {
    for (let i = 0; i < count; i += 1) {
      const sp = new URLSearchParams(makeParams(i));
      const out = sp.toString();
      if (typeof out !== 'string') fail('non-string params output');
      acc = (acc * MULT + polyHash(out)) % MOD;
      processed += 1;
    }
  } else if (mode === 'sp-serialize') {
    for (let i = 0; i < count; i += 1) {
      const sp = new URLSearchParams(makeParams(i));
      for (let k = 0; k < SERIALIZE_REPEATS; k += 1) {
        const out = sp.toString();
        if (typeof out !== 'string') fail('non-string params output');
        acc = (acc * MULT + polyHash(out)) % MOD;
      }
      processed += 1;
    }
  } else {
    fail('unknown mode');
  }
} catch (error) {
  fail(error && error.message ? String(error.message).slice(0, 200) : 'driver error');
}

if (processed !== count) fail('iteration accounting mismatch');

// Structural completion marker on stdout stays a NON-timing signal; the
// authoritative result is the nonce-authenticated line on the receipt pipe.
try {
  process.stdout.write(`ops: ${processed}\n`);
} catch {
  // ignore
}
const heapUsed = memoryUsage().heapUsed;
try {
  writeSync(receiptFd, `HONE_DRIVER_OK ${nonce} ${processed} ${acc} ${heapUsed}\n`);
} catch {
  // The trusted parent treats a missing receipt line as failure.
}
