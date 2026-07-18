'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { linePct, evaluateGate } = require('./coverage-gate');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

function readBaseline(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).linePct;
  } catch {
    return null; // missing/unreadable baseline = first run
  }
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const summary = JSON.parse(fs.readFileSync(a.summary, 'utf8'));
  const current = linePct(summary);
  const baseline = readBaseline(a.baseline);
  const result = evaluateGate({
    current,
    baseline,
    min: Number(a.min),
    mode: a.mode || 'no-decrease',
  });
  const outFile = a.out || '.northstar/coverage-baseline.next.json';
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ linePct: result.newBaseline }, null, 2));
  console.log(`[northstar] coverage gate: ${result.pass ? 'PASS' : 'FAIL'} — ${result.reason}`);
  process.exit(result.pass ? 0 : 1);
}

main();
