'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

test('package is CommonJS and wires node --test', () => {
  assert.equal(pkg.name, 'northstar');
  assert.equal(pkg.scripts.test, 'node --test');
});
