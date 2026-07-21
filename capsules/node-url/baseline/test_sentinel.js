'use strict';

// Trusted per-test completion marker for the URL test gate. 'beforeExit'
// only fires when the event loop drains naturally; an early process.exit()
// (or a bypassed exit) skips it, so the trusted worker can distinguish a test
// body that ran to completion from an early termination.
const fs = require('fs');
const nonce = process.env.HONE_TEST_NONCE || '';
let drained = false;
process.once('beforeExit', () => { drained = true; });
process.on('exit', (code) => {
  if (drained && code === 0 && nonce) {
    fs.writeSync(2, `HONE_TEST_COMPLETE ${nonce}\n`);
  }
});
