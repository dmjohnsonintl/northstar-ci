'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('passes only after the fix-agent applies its patch', () => {
  assert.ok(fs.existsSync('northstar-stub-fix.txt'), 'source is not yet fixed');
});
