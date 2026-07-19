'use strict';
// Contract fixture: a FAILING js-ts (node:test) suite. run.sh must exit non-zero.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('the failing fixture fails on purpose', () => {
  assert.equal(1 + 1, 3);
});
