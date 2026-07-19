import fs from 'node:fs';
import semver from 'semver';

function writeJSON(file, data) {
  fs.writeFileSync(new URL(file, import.meta.url), JSON.stringify(data));
}

const [ dist, schedule ] = await Promise.all([
  'https://nodejs.org/dist/index.json',
  'https://raw.githubusercontent.com/nodejs/Release/master/schedule.json'
].map(url => fetch(url).then(res => res.json())));

// Process Versions
const processed = dist
  .filter(env => semver.patch(env.version) === 0)
  .map(env => ({
    name: 'nodejs',
    version: env.version.substr(1),
    date: env.date,
    lts: env.lts,
    security: env.security,
    v8: env.v8
  }))
  .sort((a, b) => {
    if (semver.gt(a.version, b.version)) return 1;
    if (semver.lt(a.version, b.version)) return -1;
    return 0;
  });

writeJSON('../data/processed/envs.json', processed);
writeJSON('../data/release-schedule/release-schedule.json', schedule);
