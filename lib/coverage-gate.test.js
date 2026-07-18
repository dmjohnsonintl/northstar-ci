'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { linePct, evaluateGate } = require('./coverage-gate');

test('linePct reads total.lines.pct', () => {
  assert.equal(linePct({ total: { lines: { pct: 81.5 } } }), 81.5);
  assert.throws(() => linePct({ total: {} }), /total\.lines\.pct/);
});

test('first run establishes baseline and passes', () => {
  const r = evaluateGate({ current: 70, baseline: null, min: 80, mode: 'no-decrease' });
  assert.equal(r.pass, true);
  assert.equal(r.newBaseline, 70);
});

test('below minimum fails and does not move baseline', () => {
  const r = evaluateGate({ current: 79, baseline: 85, min: 80, mode: 'no-decrease' });
  assert.equal(r.pass, false);
  assert.equal(r.newBaseline, 85);
  assert.match(r.reason, /below minimum/);
});

test('downward trend fails even above minimum', () => {
  const r = evaluateGate({ current: 84, baseline: 85, min: 80, mode: 'no-decrease' });
  assert.equal(r.pass, false);
  assert.match(r.reason, /dropped/);
});

test('holding or improving passes and ratchets baseline up', () => {
  assert.deepEqual(
    evaluateGate({ current: 90, baseline: 85, min: 80, mode: 'no-decrease' }),
    { pass: true, reason: 'coverage 90.00% ≥ baseline 85.00%', newBaseline: 90 },
  );
});

test('report mode never blocks', () => {
  const r = evaluateGate({ current: 10, baseline: 85, min: 80, mode: 'report' });
  assert.equal(r.pass, true);
});
