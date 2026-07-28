'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { greet } = require('../src/greet');

// Reproduces the reported bug: greet() should include a comma after
// "Hello" and a trailing exclamation mark.
test("greet('World') returns 'Hello, World!'", () => {
  assert.strictEqual(greet('World'), 'Hello, World!');
});
