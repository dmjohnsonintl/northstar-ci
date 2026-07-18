'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('stub engine commits a fix on the target branch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-eng-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'broken.js'), 'module.exports = 0;');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  // the fix-agent action owns branch creation; the engine commits onto it
  execFileSync('git', ['checkout', '-q', '-b', 'ns/fix/x'], { cwd: dir });
  execFileSync('bash', [path.resolve('engine/stub/fix.sh')], {
    cwd: dir,
    env: { ...process.env, NS_FIX_WORKDIR: dir, NS_FIX_LOG: '/dev/null' },
  });
  const log = execFileSync('git', ['log', '--oneline', 'ns/fix/x'], { cwd: dir, encoding: 'utf8' });
  assert.match(log, /northstar-stub/);
});
