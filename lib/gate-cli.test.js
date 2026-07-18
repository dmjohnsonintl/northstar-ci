'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(args) {
  try {
    const stdout = execFileSync('node', ['lib/gate-cli.js', ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ? e.stdout.toString() : '' };
  }
}

test('fails on a downward trend (above minimum, below baseline)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gate-'));
  const summary = path.join(dir, 'summary.json');
  const baseline = path.join(dir, 'baseline.json');
  const out = path.join(dir, 'next.json');
  // 84 is above the min (80) but below the baseline (88) → the drop branch, not below-min.
  fs.writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 84 } } }));
  fs.writeFileSync(baseline, JSON.stringify({ linePct: 88 }));
  const r = run(['--summary', summary, '--baseline', baseline, '--min', '80', '--mode', 'no-decrease', '--out', out]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /dropped/);
});

test('first run (no baseline file) passes and writes new baseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-gate-'));
  const summary = path.join(dir, 'summary.json');
  const out = path.join(dir, 'next.json');
  fs.writeFileSync(summary, JSON.stringify({ total: { lines: { pct: 73 } } }));
  const r = run(['--summary', summary, '--baseline', path.join(dir, 'missing.json'), '--min', '80', '--mode', 'no-decrease', '--out', out]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).linePct, 73);
});
