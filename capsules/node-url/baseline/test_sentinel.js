'use strict';

// Trusted per-test completion receipt for the URL test gate.
//
// The nonce arrives over a parent-written pipe that this preload drains before
// the test body (or any lazily loaded mutable module) runs, and the receipt
// leaves over a dedicated pipe whose read end only the trusted parent holds.
// The environment carries only descriptor numbers, never the nonce, and both
// numbers are removed from process.env immediately so no descendant the test
// spawns ever sees them.
//
// Completion is bound to a boundary the candidate EventEmitter cannot forge:
//   * The receipt is written ONLY from a 'beforeExit' handler (never 'exit'),
//     so an explicit process.exit() — which node runs WITHOUT emitting
//     'beforeExit' — cannot deliver a receipt for a test body cut short.
//   * The handler ignores any invocation that does not carry node core's
//     numeric exit-code argument, so `process.rawListeners('beforeExit')[0]()`
//     called directly by candidate code is a no-op.
//   * The actual write is deferred to a `setImmediate`. A genuine natural drain
//     re-enters the event loop and runs that immediate before terminating; an
//     `process.emit('beforeExit', 0)` followed by `process.exit(0)` forge
//     terminates the process before the immediate can run, so no receipt is
//     produced. The immediate additionally refuses to write while any libuv
//     request is still in flight, rejecting a mid-test forged emit.
//   * The write is single-shot and closes the receipt fd, so a second forged
//     invocation cannot append.
const fs = require('fs');
// Capture the primitives at preload time, before candidate-reachable modules
// get a chance to replace them.
const readSync = fs.readSync;
const writeSync = fs.writeSync;
const closeSync = fs.closeSync;
const getActiveRequests =
  typeof process._getActiveRequests === 'function'
    ? process._getActiveRequests.bind(process)
    : () => [];
const challengeFd = Number.parseInt(process.env.HONE_CHALLENGE_FD || '', 10);
let receiptFd = Number.parseInt(process.env.HONE_RECEIPT_FD || '', 10);
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

let armed = true;
let written = false;

function deliverReceipt() {
  if (written) return;
  // Refuse to certify completion while libuv still has requests in flight: a
  // forged `process.emit('beforeExit', 0)` mid-test is rejected here.
  try {
    if (getActiveRequests().length !== 0) return;
  } catch {
    return;
  }
  written = true;
  if (nonce && Number.isInteger(receiptFd) && receiptFd >= 0) {
    try {
      writeSync(receiptFd, `HONE_TEST_COMPLETE ${nonce}\n`);
    } catch {
      // The trusted parent treats a missing receipt as failure.
    }
    try {
      closeSync(receiptFd);
    } catch {
      // ignore
    }
    receiptFd = -1;
  }
}

process.on('beforeExit', (code) => {
  // node core always passes the numeric exit code; a direct invocation via
  // process.rawListeners('beforeExit')[0]() passes undefined and is ignored.
  if (!armed || typeof code !== 'number') return;
  armed = false;
  // Deferring the write means an explicit process.exit() after a forged emit
  // terminates before this runs, so only a genuine natural drain (which
  // re-enters the loop to service the immediate) produces the receipt.
  setImmediate(deliverReceipt);
});
