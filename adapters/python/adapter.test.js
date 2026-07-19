'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('python coverage.sh normalizes coverage.py json to the gate shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-py-'));
  // Simulate `coverage run ... && coverage json`: the command writes coverage.json.
  const covJson = JSON.stringify({ totals: { covered_lines: 8, num_statements: 10, percent_covered: 80 } });
  const covCmd = `printf '%s' '${covJson}' > coverage.json`;
  const stdout = execFileSync('bash', [path.resolve('adapters/python/coverage.sh')], {
    encoding: 'utf8',
    env: { ...process.env, NS_WORKDIR: dir, NS_COV_CMD: covCmd },
  });
  assert.match(stdout, /summary=.*coverage-summary\.json/);
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'coverage-summary.json'), 'utf8'));
  assert.equal(summary.total.lines.pct, 80);
  assert.equal(summary.total.lines.total, 10);
});

test('python run.sh propagates a failing test command exit code', () => {
  let code = 0;
  try {
    execFileSync('bash', [path.resolve('adapters/python/run.sh')], {
      env: { ...process.env, NS_WORKDIR: os.tmpdir(), NS_TEST_CMD: 'false' },
    });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
});
