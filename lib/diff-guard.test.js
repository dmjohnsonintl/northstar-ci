'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectDiff, isTestPath } = require('./diff-guard');

const src = (over = {}) => ({ path: 'src/sum.js', status: 'modified', added: [], removed: [], ...over });
const spec = (over = {}) => ({ path: 'src/sum.test.js', status: 'modified', added: [], removed: [], ...over });

test('isTestPath covers the conventions both adapters use', () => {
  for (const p of [
    'src/sum.test.js', 'src/a.spec.ts', 'src/x.test.mjs', 'test/foo.mjs',
    'tests/test_calc.py', 'api/core/test_billing.py', 'pkg/thing_test.py',
    'e2e/regression/promoted.spec.js', '__tests__/a.js',
  ]) assert.equal(isTestPath(p), true, p);

  for (const p of ['src/sum.js', 'lib/latest.js', 'src/protest.js', 'contest/index.js']) {
    assert.equal(isTestPath(p), false, p);
  }
});

test('a source-only fix passes', () => {
  const r = inspectDiff([src({ added: ['+  return a + b;'], removed: ['-  return a - b;'] })]);
  assert.equal(r.ok, true);
});

test('deleting a test file is rejected', () => {
  const r = inspectDiff([spec({ status: 'deleted' })]);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, 'test-deleted');
});

test('adding a skip marker is rejected, across runners', () => {
  const cases = [
    '+  it.skip("adds", () => {',
    '+  test.todo("adds");',
    '+  describe.skip("sum", () => {',
    '+  xit("adds", () => {',
    '+@pytest.mark.skip(reason="flaky")',
    '+    @unittest.skip("later")',
    '+  t.skip("adds");',
    '+  test("adds", { skip: true }, () => {',
  ];
  for (const line of cases) {
    const r = inspectDiff([spec({ added: [line] })]);
    assert.equal(r.ok, false, line);
    assert.equal(r.violations[0].kind, 'test-skipped', line);
  }
});

test('REMOVING a skip marker is allowed — that re-enables a test', () => {
  const r = inspectDiff([spec({ removed: ['-  it.skip("adds", () => {'], added: ['+  it("adds", () => {'] })]);
  assert.equal(r.ok, true);
});

test('net removal of assertions is rejected', () => {
  const r = inspectDiff([spec({
    removed: ['-    expect(sum(2,3)).toBe(5);', '-    expect(sum(10,20)).toBe(30);'],
    added: ['+    expect(sum(2,3)).toBe(5);'],
  })]);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, 'assertions-removed');
  assert.match(r.violations[0].detail, /2 assertion line\(s\) removed, 1 added/);
});

test('a reformat that preserves assertion count passes', () => {
  // Counting net rather than flagging any removal is what makes the guard usable:
  // reformatting rewrites every line and must not read as weakening.
  const r = inspectDiff([spec({
    removed: ['-  expect(a).toBe(1); expect(b).toBe(2);'],
    added: ['+  expect(a).toBe(1);', '+  expect(b).toBe(2);'],
  })]);
  assert.equal(r.ok, true);
});

test('ADDING tests passes — the agent is allowed to strengthen', () => {
  const r = inspectDiff([spec({ added: ['+  expect(sum(1,1)).toBe(2);', '+  expect(sum(0,0)).toBe(0);'] })]);
  assert.equal(r.ok, true);
});

test('assertions removed from a SOURCE file are ignored', () => {
  // Source may legitimately drop an internal assert(); the guard is about tests.
  const r = inspectDiff([src({ removed: ['-  assert(x > 0);'] })]);
  assert.equal(r.ok, true);
});

test('multiple violations across files are all reported', () => {
  const r = inspectDiff([
    spec({ path: 'a.test.js', status: 'deleted' }),
    spec({ path: 'b.test.js', added: ['+  it.skip("x", () => {'] }),
    src({ added: ['+  return a + b;'] }),
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 2);
});

test('malformed input is total — never throws', () => {
  for (const bad of [null, undefined, 'nope', [null], [{}], [{ path: 'a.test.js' }]]) {
    assert.doesNotThrow(() => inspectDiff(bad));
  }
  assert.equal(inspectDiff(null).ok, true);
});

test('a one-line test losing ONE of two assertions is rejected', () => {
  // The cheat that line-counting missed: both the old and the new line "contain an
  // assertion", so a per-line count nets zero. Occurrences are what matter.
  const r = inspectDiff([spec({
    removed: ['-test("adds",()=>{expect(s(2,3)).toBe(5);expect(s(1,1)).toBe(2);});'],
    added: ['+test("adds",()=>{expect(s(2,3)).toBe(5);});'],
  })]);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, 'assertions-removed');
  assert.match(r.violations[0].detail, /2 assertion line\(s\) removed, 1 added/);
});
