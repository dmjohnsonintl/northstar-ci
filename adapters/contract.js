'use strict';
// Shared adapter contract (conformance) suite.
//
// One set of assertions, run against EVERY language adapter. A new adapter is
// "done" when it passes these cases — see spec §9 (testing strategy, layer 2).
//
// The shipped contract (see adapters/<name>/{run,coverage}.sh):
//   run.sh      — runs NS_TEST_CMD in NS_WORKDIR; exits 0 iff tests pass and
//                 non-zero iff they fail; writes artifacts/test.log.
//   coverage.sh — runs NS_COV_CMD in NS_WORKDIR; on success prints
//                 "summary=<path>" pointing at an Istanbul-shaped
//                 coverage-summary.json ({ total: { lines: { pct: 0..100 } } });
//                 exits non-zero if the coverage command fails or the summary
//                 is missing.
//
// NOTE ON SCOPE: these cases test the ADAPTER's behavior (exit-code
// propagation, locating/emitting the summary), not the third-party coverage
// tool — that tool is consumer-supplied via NS_COV_CMD. js-ts therefore uses a
// stand-in cov command; python exercises the real coverage.py -> normalize path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(__dirname, '_contract-fixtures');

// Spawn an adapter script under the Northstar env contract. NODE_TEST_CONTEXT is
// stripped so that a `node --test` child (js-ts) is not hijacked as a subtest of
// this parent run and made to exit 0 spuriously.
function runScript(script, { workdir, testCmd, covCmd } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (workdir) env.NS_WORKDIR = workdir;
  if (testCmd !== undefined) env.NS_TEST_CMD = testCmd;
  if (covCmd !== undefined) env.NS_COV_CMD = covCmd;
  const res = spawnSync('bash', [path.join(REPO_ROOT, 'adapters', script)], {
    encoding: 'utf8',
    env,
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// Extract the path from coverage.sh's "summary=<path>" success line.
function summaryPath(stdout) {
  const m = /^summary=(.+)$/m.exec(stdout.trim());
  return m ? m[1].trim() : null;
}

// Assert an object matches the Istanbul json-summary shape the coverage gate reads.
function assertIstanbulShape(summary) {
  assert.ok(summary && typeof summary === 'object', 'summary is an object');
  assert.ok(summary.total && typeof summary.total === 'object', 'summary.total is an object');
  assert.ok(
    summary.total.lines && typeof summary.total.lines === 'object',
    'summary.total.lines is an object',
  );
  const pct = summary.total.lines.pct;
  assert.equal(typeof pct, 'number', 'total.lines.pct is a number');
  assert.ok(
    Number.isFinite(pct) && pct >= 0 && pct <= 100,
    `total.lines.pct in [0,100] (got ${pct})`,
  );
}

// Copy a checked-in fixture to a throwaway tmp dir so runs never pollute the repo
// (adapters write artifacts/, coverage/, .coverage into their workdir).
function prepareFixture(adapterName, fixtureName) {
  const src = path.join(FIXTURES_DIR, adapterName, fixtureName);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `ns-${adapterName}-${fixtureName}-`));
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

// Register the shared contract cases for one adapter definition:
//   { name, dir, available(): bool, testCmd, covFixture, covCmd }
function defineAdapterContract(adapter) {
  const skip = adapter.available() ? false : `${adapter.name}: toolchain unavailable`;

  test(`[${adapter.name}] run.sh exits 0 when the suite passes`, { skip }, () => {
    const wd = prepareFixture(adapter.name, 'pass');
    const { code } = runScript(`${adapter.dir}/run.sh`, { workdir: wd, testCmd: adapter.testCmd });
    assert.equal(code, 0);
  });

  test(`[${adapter.name}] run.sh exits non-zero when a test fails`, { skip }, () => {
    const wd = prepareFixture(adapter.name, 'fail');
    const { code } = runScript(`${adapter.dir}/run.sh`, { workdir: wd, testCmd: adapter.testCmd });
    assert.notEqual(code, 0);
  });

  test(`[${adapter.name}] run.sh writes artifacts/test.log`, { skip }, () => {
    const wd = prepareFixture(adapter.name, 'pass');
    runScript(`${adapter.dir}/run.sh`, { workdir: wd, testCmd: adapter.testCmd });
    assert.ok(fs.existsSync(path.join(wd, 'artifacts', 'test.log')));
  });

  test(`[${adapter.name}] coverage.sh emits an Istanbul-shaped summary`, { skip }, () => {
    const wd = prepareFixture(adapter.name, adapter.covFixture);
    const { code, stdout } = runScript(`${adapter.dir}/coverage.sh`, {
      workdir: wd,
      covCmd: adapter.covCmd,
    });
    assert.equal(code, 0, `coverage.sh should succeed (stdout: ${stdout})`);
    const printed = summaryPath(stdout);
    assert.ok(printed, 'coverage.sh prints summary=<path>');
    const resolved = path.isAbsolute(printed) ? printed : path.join(REPO_ROOT, printed);
    assert.ok(fs.existsSync(resolved), `summary exists at ${resolved}`);
    assertIstanbulShape(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  });

  test(`[${adapter.name}] coverage.sh fails when the coverage command fails`, { skip }, () => {
    const wd = fs.mkdtempSync(path.join(os.tmpdir(), `ns-${adapter.name}-covfail-`));
    const { code } = runScript(`${adapter.dir}/coverage.sh`, { workdir: wd, covCmd: 'exit 7' });
    assert.notEqual(code, 0);
  });
}

// True iff the given python interpreter can import pytest + coverage.
function pythonToolchainAvailable() {
  const res = spawnSync('python3', ['-c', 'import pytest, coverage'], { stdio: 'ignore' });
  return res.status === 0;
}

module.exports = {
  runScript,
  summaryPath,
  assertIstanbulShape,
  prepareFixture,
  defineAdapterContract,
  pythonToolchainAvailable,
  FIXTURES_DIR,
};
