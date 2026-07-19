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

test('stub reproduce engine commits a failing test onto the branch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-rep-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  execFileSync('git', ['checkout', '-q', '-b', 'ns/bug/1'], { cwd: dir });
  execFileSync('bash', [path.resolve('engine/stub/reproduce.sh')], {
    cwd: dir,
    env: { ...process.env, NS_FIX_WORKDIR: dir, NS_BUG_TITLE: 'x', NS_BUG_BODY: 'y' },
  });
  assert.ok(fs.existsSync(path.join(dir, 'northstar_repro.test.js')));
  // and the reproducing test genuinely fails before any fix. Run the child with a
  // clean env — inheriting NODE_TEST_CONTEXT would suppress its failure exit code.
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_TEST_CONTEXT;
  let failed = false;
  try {
    execFileSync('node', ['--test', 'northstar_repro.test.js'], { cwd: dir, stdio: 'ignore', env: cleanEnv });
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
});
