'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sum } = require('./sum.js');

test('sum adds two numbers', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(10, 20), 30);
});
