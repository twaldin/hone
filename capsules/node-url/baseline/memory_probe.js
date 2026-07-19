'use strict';

const fs = require('fs');
const trustedHrtime = process.hrtime;
const trustedMemoryUsage = process.memoryUsage;
Object.defineProperty(trustedHrtime, 'bigint', {
  __proto__: null,
  configurable: false,
  enumerable: true,
  value: trustedHrtime.bigint,
  writable: false,
});
Object.defineProperty(process, 'hrtime', {
  __proto__: null,
  configurable: false,
  enumerable: true,
  value: trustedHrtime,
  writable: false,
});

process.on('exit', () => {
  const { heapUsed, rss } = trustedMemoryUsage();
  fs.writeSync(2, `HONE_MEMORY ${heapUsed} ${rss}\n`);
});
