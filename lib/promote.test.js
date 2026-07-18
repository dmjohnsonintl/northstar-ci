'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectPromotions } = require('./promote');

test('promotes only green staged tests, preserving subpaths', () => {
  const staged = ['tests/new/a.test.ts', 'tests/new/sub/b.test.ts', 'tests/new/c.test.ts'];
  const passed = ['tests/new/a.test.ts', 'tests/new/sub/b.test.ts'];
  const moves = selectPromotions(staged, passed, { stagingDir: 'tests/new', regressionDir: 'tests/regression' });
  assert.deepEqual(moves, [
    { from: 'tests/new/a.test.ts', to: 'tests/regression/a.test.ts' },
    { from: 'tests/new/sub/b.test.ts', to: 'tests/regression/sub/b.test.ts' },
  ]);
});

test('nothing green → no moves', () => {
  assert.deepEqual(
    selectPromotions(['tests/new/a.test.ts'], [], { stagingDir: 'tests/new', regressionDir: 'tests/regression' }),
    [],
  );
});
