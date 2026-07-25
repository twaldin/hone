'use strict';

// Trusted exact-output worker. The parent pipes ONLY input identities and the
// withBase flag — never the sealed expected href/serialization. Candidate URL
// code that wraps JSON.parse/readFileSync therefore has no expected value to
// capture and echo back; it must actually construct real URL/URLSearchParams
// objects. The trusted parent holds the sealed expected outputs and byte-
// compares them against what this worker returns.
const fs = require('fs');
const common = require('/opt/node/benchmark/common.js');

function fail(detail) {
  process.stdout.write(JSON.stringify({ ok: false, detail }));
  process.stdout.write('\n');
  process.exitCode = 1;
}

try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const withBase = request.withBase === true;
  const urls = {};
  for (const row of request.urls) {
    const input = common.urls[row.id];
    if (typeof input !== 'string') throw new Error('unknown URL workload');
    const parsed = withBase ? new URL(input, 'about:blank') : new URL(input);
    urls[row.id] = parsed.href;
  }

  const searchParams = {};
  for (const row of request.searchParams) {
    const input = common.searchParams[row.id];
    if (typeof input !== 'string') throw new Error('unknown SearchParams workload');
    searchParams[row.id] = new URLSearchParams(input).toString();
  }

  process.stdout.write(JSON.stringify({ ok: true, urls, searchParams }));
  process.stdout.write('\n');
} catch (error) {
  fail(error instanceof Error ? error.message : 'exact-output gate failed');
}
