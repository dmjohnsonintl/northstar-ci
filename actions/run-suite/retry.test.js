'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RETRY = path.resolve(__dirname, 'retry.sh');

function runRetry(runShBody, retries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-retry-'));
  const runSh = path.join(dir, 'run.sh');
  fs.writeFileSync(runSh, runShBody);
  const out = path.join(dir, 'gh_output');
  fs.writeFileSync(out, '');
  let code = 0;
  try {
    execFileSync('bash', [RETRY], {
      env: { ...process.env, RUN_SH: runSh, RETRIES: String(retries), GITHUB_OUTPUT: out },
      stdio: 'pipe',
    });
  } catch (e) { code = e.status; }
  const gh = fs.readFileSync(out, 'utf8');
  const flaky = /flaky=(\w+)/.exec(gh)?.[1];
  const attempts = /attempts=(\d+)/.exec(gh)?.[1];
  fs.rmSync(dir, { recursive: true, force: true });
  return { code, flaky, attempts };
}

test('deterministic double-failure exits nonzero (regression: previously exited 0)', () => {
  const r = runRetry('exit 1', 1);
  assert.notEqual(r.code, 0);
  assert.equal(r.flaky, 'false');
  assert.equal(r.attempts, '2');
});

test('fail-then-pass is flaky and exits 0 (quarantined)', () => {
  const body = 'M="$(dirname "$0")/marker"; if [ -f "$M" ]; then exit 0; else touch "$M"; exit 1; fi';
  const r = runRetry(body, 1);
  assert.equal(r.code, 0);
  assert.equal(r.flaky, 'true');
  assert.equal(r.attempts, '2');
});

test('pass on first attempt exits 0, not flaky', () => {
  const r = runRetry('exit 0', 1);
  assert.equal(r.code, 0);
  assert.equal(r.flaky, 'false');
  assert.equal(r.attempts, '1');
});
