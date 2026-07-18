'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('./math.js');
test('add', () => { assert.equal(add(2, 3), 5); });
