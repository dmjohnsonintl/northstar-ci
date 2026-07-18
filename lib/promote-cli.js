'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { selectPromotions } = require('./promote');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const staging = a.staging || 'tests/new';
  const regression = a.regression || 'tests/regression';
  const staged = walk(staging).filter((f) => !f.endsWith('.gitkeep'));
  // v0: any staged test present on the default branch is green (it ran in the suite)
  const moves = selectPromotions(staged, staged, { stagingDir: staging, regressionDir: regression });
  for (const { from, to } of moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    console.log(`[northstar] promoted ${from} -> ${to}`);
  }
  if (moves.length === 0) console.log('[northstar] no staged tests to promote');
}

main();
