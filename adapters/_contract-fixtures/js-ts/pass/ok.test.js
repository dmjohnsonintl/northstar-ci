'use strict';
// Contract fixture: a passing js-ts (node:test) suite. run.sh must exit 0.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('the passing fixture passes', () => {
  assert.equal(1 + 1, 2);
});
