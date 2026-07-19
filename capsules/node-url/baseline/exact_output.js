'use strict';

const fs = require('fs');
const common = require('/opt/node/benchmark/common.js');

function fail(detail) {
  process.stdout.write(JSON.stringify({ ok: false, detail }));
  process.stdout.write('\n');
  process.exitCode = 1;
}

try {
  const workload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const urls = {};
  for (const row of workload.urls) {
    const input = common.urls[row.id];
    if (typeof input !== 'string') throw new Error('unknown URL workload');
    const parsed = workload.withBase ? new URL(input, 'about:blank') : new URL(input);
    urls[row.id] = parsed.href;
  }

  const searchParams = {};
  for (const row of workload.searchParams) {
    const input = common.searchParams[row.id];
    if (typeof input !== 'string') throw new Error('unknown SearchParams workload');
    searchParams[row.id] = new URLSearchParams(input).toString();
  }

  process.stdout.write(JSON.stringify({ ok: true, urls, searchParams }));
  process.stdout.write('\n');
} catch (error) {
  fail(error instanceof Error ? error.message : 'exact-output gate failed');
}
