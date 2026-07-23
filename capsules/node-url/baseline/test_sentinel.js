'use strict';

// Trusted per-test completion receipt for the URL test gate.
//
// The nonce arrives over a parent-written pipe that this preload drains
// before the test body (or any lazily loaded mutable module) runs, and the
// receipt leaves over a dedicated pipe whose read end only the trusted
// parent holds. The environment carries only descriptor numbers, never the
// nonce, and both numbers are removed from process.env immediately so no
// descendant the test spawns ever sees them. 'beforeExit' only fires when
// the event loop drains naturally; an early process.exit() (or a bypassed
// exit) skips it, so the trusted worker can distinguish a test body that ran
// to completion from an early termination.
const fs = require('fs');
// Capture the primitives at preload time, before candidate-reachable modules
// get a chance to replace them.
const readSync = fs.readSync;
const writeSync = fs.writeSync;
const closeSync = fs.closeSync;
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
let drained = false;
process.once('beforeExit', () => { drained = true; });
process.on('exit', (code) => {
  if (drained && code === 0 && nonce && Number.isInteger(receiptFd) && receiptFd >= 0) {
    try {
      writeSync(receiptFd, `HONE_TEST_COMPLETE ${nonce}\n`);
    } catch {
      // The trusted parent treats a missing receipt as failure.
    }
  }
});
