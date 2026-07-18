'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchGlob, resolveZones } = require('./zones');

test('matchGlob: ** matches any depth, * matches one segment', () => {
  assert.equal(matchGlob('frontend/src/App.tsx', 'frontend/**'), true);
  assert.equal(matchGlob('frontend/App.tsx', 'frontend/*'), true);
  assert.equal(matchGlob('frontend/src/App.tsx', 'frontend/*'), false); // * is one segment
  assert.equal(matchGlob('api/routes.py', 'frontend/**'), false);
  assert.equal(matchGlob('frontend/auth/login.ts', 'frontend/auth/**'), true);
});

test('resolveZones: most-specific-wins, one zone per file, sorted unique', () => {
  const defs = [
    { zone: 'frontend', glob: 'frontend/**' },
    { zone: 'frontend-auth', glob: 'frontend/auth/**' },
    { zone: 'api', glob: 'api/**' },
  ];
  const files = ['frontend/App.tsx', 'frontend/auth/login.ts', 'api/x.py', 'README.md'];
  assert.deepEqual(resolveZones(files, defs), ['api', 'frontend', 'frontend-auth']);
});

test('resolveZones: unmatched files contribute nothing', () => {
  assert.deepEqual(resolveZones(['docs/x.md'], [{ zone: 'frontend', glob: 'frontend/**' }]), []);
});
