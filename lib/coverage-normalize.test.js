'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromPytestCov } = require('./coverage-normalize');

test('fromPytestCov maps coverage.py totals to the Istanbul line shape', () => {
  // shape emitted by `coverage json`
  const cov = {
    totals: { covered_lines: 100, num_statements: 120, percent_covered: 83.33, missing_lines: 20 },
  };
  const s = fromPytestCov(cov);
  assert.equal(s.total.lines.pct, 83.33);
  assert.equal(s.total.lines.total, 120);
  assert.equal(s.total.lines.covered, 100);
});

test('fromPytestCov throws on malformed input', () => {
  assert.throws(() => fromPytestCov({}), /percent_covered/);
  assert.throws(() => fromPytestCov({ totals: {} }), /percent_covered/);
});
