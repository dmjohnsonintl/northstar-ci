'use strict';
const fs = require('node:fs');
const { fromPytestCov } = require('./coverage-normalize');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const cov = JSON.parse(fs.readFileSync(a.in, 'utf8'));
  fs.writeFileSync(a.out, JSON.stringify(fromPytestCov(cov)));
}

main();
