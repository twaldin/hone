'use strict';

// Trusted timed benchmark driver for the WHATWG URL capsule.
//
// The measurement LOOP lives here, in trusted code the candidate cannot skip
// or reshape. Candidate URL code (lib/internal/url.js and friends) can only
// influence the per-operation OUTPUT STRING that this driver materializes and
// validates. Two trusted accumulators bind every timed scale to the sealed
// expected observation the parent holds:
//   * lenAcc folds the length of the materialized output on EVERY iteration.
//     Producing a full-length output requires actually running the URL parse
//     and serialization, so a cheap short-circuit cannot pass, and the parent
//     recovers lenAcc in closed form from the expected length and the count.
//   * contentAcc folds the FULL output string at a set of iteration indices
//     derived from the parent's secret nonce. The candidate cannot predict
//     which iterations are content-checked, so it must return byte-correct
//     output on every iteration; serving cheap-WRONG output at a timed scale
//     changes contentAcc and the parent rejects the cell.
// Skipping real work while returning correct output (memoizing the single
// repeated input) makes base and boosted equally cheap, which the parent's
// marginal wall-clock floor rejects. A genuinely faster-but-correct path is
// the only way to move throughput.
//
// A parent-delivered nonce (read from a pipe and removed from the environment
// BEFORE any candidate-reachable module loads) authenticates the result line
// on a dedicated pipe whose read end only the trusted parent holds, so
// candidate code can neither learn the nonce nor fabricate the result line.

const fs = require('fs');
// Capture write primitives and the trusted heap probe before candidate URL
// code can replace them; the end-of-run heapUsed rides the same
// nonce-authenticated line so candidate code can neither forge a low value nor
// suppress it (an absent line fails the gate).
const readSync = fs.readSync;
const writeSync = fs.writeSync;
const closeSync = fs.closeSync;
const memoryUsage = process.memoryUsage;

// Rolling accumulators: acc_i = (acc_{i-1} * MULT + term) mod MOD. MOD is prime
// and (MULT-1) is a unit mod MOD, so the parent recovers lenAcc in closed form.
const MOD = 2147483647; // 2^31 - 1 (Mersenne prime)
const MULT = 48271; // MINSTD multiplier, coprime to MOD
const POLY = 257;
const CONTENT_SAMPLES = 64;

const challengeFd = Number.parseInt(process.env.HONE_CHALLENGE_FD || '', 10);
const receiptFd = Number.parseInt(process.env.HONE_RECEIPT_FD || '', 10);
delete process.env.HONE_CHALLENGE_FD;
delete process.env.HONE_RECEIPT_FD;
let nonce = '';
if (Number.isInteger(challengeFd) && challengeFd >= 0) {
  try {
    const buffer = Buffer.alloc(128);
    const bytes = readSync(challengeFd, buffer, 0, buffer.length, null);
    nonce = buffer.toString('utf8', 0, bytes).trim();
    closeSync(challengeFd);
  } catch {
    nonce = '';
  }
}

function fail(detail) {
  try {
    writeSync(2, `HONE_DRIVER_FAIL ${detail}\n`);
  } catch {
    // ignore
  }
  process.exit(1);
}

const mode = process.argv[2];
const id = process.argv[3];
const count = Number.parseInt(process.argv[4], 10);
const withBase = process.argv[5] === 'true';
if (!Number.isInteger(count) || count <= 0) fail('invalid iteration count');
if (!nonce) fail('missing trusted nonce');

function polyHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * POLY + text.charCodeAt(i)) % MOD;
  }
  return h;
}

// Content-check schedule: CONTENT_SAMPLES distinct ascending iteration indices
// derived from the secret nonce. The candidate cannot recover this schedule.
const sampleCount = Math.min(CONTENT_SAMPLES, count);
const sampleSet = new Set();
let seed = (polyHash(nonce) + 1) % MOD;
while (sampleSet.size < sampleCount) {
  seed = (seed * MULT + 12345) % MOD;
  sampleSet.add(seed % count);
}
const sortedSamples = Array.from(sampleSet).sort((a, b) => a - b);
sortedSamples.push(Number.POSITIVE_INFINITY);
let samplePtr = 0;
let nextSample = sortedSamples[0];

let lenAcc = 0;
let contentAcc = 0;
let processed = 0;

// common.js holds the protected input strings; requiring it (and the first
// URL/URLSearchParams construction) is what lazily loads candidate code, which
// is strictly after the nonce has been captured and scrubbed.
const common = require('/opt/node/benchmark/common.js');

function serialize(mode2, input) {
  if (mode2 === 'parse') {
    const u = withBase ? new URL(input, 'about:blank') : new URL(input);
    return u.href; // full serialization proves the parse actually ran
  }
  if (mode2 === 'sp-parse') {
    return new URLSearchParams(input).toString();
  }
  return null;
}

try {
  if (mode === 'parse' || mode === 'sp-parse') {
    const input = (mode === 'parse' ? common.urls : common.searchParams)[id];
    if (typeof input !== 'string') fail('unknown input id');
    for (let i = 0; i < count; i += 1) {
      const out = serialize(mode, input);
      if (typeof out !== 'string') fail('non-string output');
      lenAcc = (lenAcc * MULT + out.length) % MOD;
      if (i === nextSample) {
        contentAcc = (contentAcc * MULT + polyHash(out)) % MOD;
        samplePtr += 1;
        nextSample = sortedSamples[samplePtr];
      }
      processed += 1;
    }
  } else if (mode === 'href' || mode === 'sp-serialize') {
    const input = (mode === 'href' ? common.urls : common.searchParams)[id];
    if (typeof input !== 'string') fail('unknown input id');
    const holder =
      mode === 'href'
        ? (withBase ? new URL(input, 'about:blank') : new URL(input))
        : new URLSearchParams(input);
    for (let i = 0; i < count; i += 1) {
      const out = mode === 'href' ? holder.href : holder.toString();
      if (typeof out !== 'string') fail('non-string output');
      lenAcc = (lenAcc * MULT + out.length) % MOD;
      if (i === nextSample) {
        contentAcc = (contentAcc * MULT + polyHash(out)) % MOD;
        samplePtr += 1;
        nextSample = sortedSamples[samplePtr];
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
if (samplePtr !== sampleCount) fail('content sampling mismatch');

// The structural completion marker on stdout stays a NON-timing signal for the
// parent; the authoritative result is the nonce-authenticated checksum line.
process.stdout.write(`ops: ${processed}\n`);
const heapUsed = memoryUsage().heapUsed;
try {
  writeSync(receiptFd, `HONE_DRIVER_OK ${nonce} ${processed} ${lenAcc} ${contentAcc} ${heapUsed}\n`);
  closeSync(receiptFd);
} catch {
  // The trusted parent treats a missing checksum line as failure.
}
