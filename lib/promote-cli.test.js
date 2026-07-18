'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('promote-cli moves staged test files into the regression dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-prom-'));
  fs.mkdirSync(path.join(dir, 'tests', 'new', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'new', 'a.test.ts'), '// a');
  fs.writeFileSync(path.join(dir, 'tests', 'new', 'sub', 'b.test.ts'), '// b');
  execFileSync('node', [path.resolve('lib/promote-cli.js'), '--staging', 'tests/new', '--regression', 'tests/regression'], {
    cwd: dir,
  });
  assert.ok(fs.existsSync(path.join(dir, 'tests', 'regression', 'a.test.ts')));
  assert.ok(fs.existsSync(path.join(dir, 'tests', 'regression', 'sub', 'b.test.ts')));
  assert.ok(!fs.existsSync(path.join(dir, 'tests', 'new', 'a.test.ts')));
});
