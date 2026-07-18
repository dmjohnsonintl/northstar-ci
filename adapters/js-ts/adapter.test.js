'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('coverage.sh prints the summary path when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-adp-'));
  fs.mkdirSync(path.join(dir, 'coverage'));
  fs.writeFileSync(path.join(dir, 'coverage', 'coverage-summary.json'), '{"total":{"lines":{"pct":50}}}');
  const stdout = execFileSync('bash', [path.resolve('adapters/js-ts/coverage.sh')], {
    encoding: 'utf8',
    env: { ...process.env, NS_WORKDIR: dir, NS_COV_CMD: 'true' },
  });
  assert.match(stdout, /summary=.*coverage-summary\.json/);
});

test('run.sh propagates a failing test command exit code', () => {
  let code = 0;
  try {
    execFileSync('bash', [path.resolve('adapters/js-ts/run.sh')], {
      env: { ...process.env, NS_WORKDIR: os.tmpdir(), NS_TEST_CMD: 'false' },
    });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
});
