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

// --- claude-code engine: the two silent-failure modes found live on 2026-08-05 ---
// council-principis run 30976878181: the CLI returned in ~2s with 0 tokens and a
// null model, yet the run reported "committed a fix" and the job went green. A
// fake `claude` on PATH lets us drive both branches without spending anything.

const CLAUDE_FIX = path.resolve('engine/claude-code/fix.sh');

function repoWithFakeClaude(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-cc-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'src.js'), 'module.exports = 0;\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });

  // OUTSIDE the repo under test — a harness file inside it would show up as an
  // untracked "new source file" and pollute the very signal these tests assert on.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-bin-'));
  fs.writeFileSync(path.join(bin, 'claude'), script, { mode: 0o755 });
  // `npm` is called for the idempotent global install; stub it so the test is offline.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  return { dir, bin };
}

function runEngine({ dir, bin }) {
  return execFileSync('bash', [CLAUDE_FIX], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: 'test-key-not-used',
      NS_FIX_WORKDIR: dir,
      NS_FIX_LOG: '/dev/null',
      NS_FIX_RECORD: '',
    },
  });
}

test('claude-code engine: a failed CLI invocation fails loudly, never silently', () => {
  // The real failure: exits non-zero, writes to stderr, produces no result.
  const { dir, bin } = repoWithFakeClaude('#!/usr/bin/env bash\necho "auth error: invalid api key" >&2\nexit 1\n');
  let err = null;
  try { runEngine({ dir, bin }); } catch (e) { err = e; }
  assert.ok(err, 'engine must exit non-zero when the CLI fails');
  const out = String(err.stdout || '') + String(err.stderr || '');
  assert.match(out, /engine failed \(exit 1\)/);
  assert.match(out, /auth error: invalid api key/, 'captured stderr must be surfaced, not discarded');
});

test('claude-code engine: an untracked artifact is NOT a fix', () => {
  // The CLI "succeeds" but touches no source — it only leaves a test log behind,
  // exactly what run-suite writes. This previously committed and reported a fix.
  const { dir, bin } = repoWithFakeClaude(
    '#!/usr/bin/env bash\nmkdir -p artifacts\necho "log line" > artifacts/test.log\necho \'{"is_error":false}\'\n',
  );
  let err = null;
  try { runEngine({ dir, bin }); } catch (e) { err = e; }
  assert.ok(err, 'an artifact-only change must not count as a fix');
  const out = String(err.stdout || '') + String(err.stderr || '');
  assert.match(out, /produced no source change/);
  // …and nothing was committed.
  const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
  assert.doesNotMatch(log, /fix\(northstar\)/);
});

test('claude-code engine: a real source edit IS committed', () => {
  const { dir, bin } = repoWithFakeClaude(
    '#!/usr/bin/env bash\necho "module.exports = 42;" > src.js\nmkdir -p artifacts\necho noise > artifacts/test.log\necho \'{"is_error":false}\'\n',
  );
  const out = runEngine({ dir, bin });
  assert.match(out, /committed a fix/);
  assert.match(out, /src\.js/, 'the changed file should be reported');
  const show = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.match(show, /src\.js/);
  assert.doesNotMatch(show, /artifacts/, 'the artifact must not be swept into the commit');
});

test('claude-code engine: a fix that CREATES a source file is committed', () => {
  // Previously missed: `git add -u` stages tracked modifications only, so a fix
  // that adds a new module registered as "no changes" and failed the run.
  const { dir, bin } = repoWithFakeClaude(
    '#!/usr/bin/env bash\nmkdir -p src\necho "module.exports = 1;" > src/helper.js\n' +
    'mkdir -p artifacts coverage\necho noise > artifacts/test.log\necho noise > coverage/lcov.info\n' +
    'echo \'{"is_error":false}\'\n',
  );
  const out = runEngine({ dir, bin });
  assert.match(out, /committed a fix/);
  assert.match(out, /src\/helper\.js \(new\)/);
  const show = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.match(show, /src\/helper\.js/);
  assert.doesNotMatch(show, /artifacts/, 'artifacts must still be excluded');
  assert.doesNotMatch(show, /coverage/, 'coverage output must still be excluded');
});

test('claude-code engine: new artifacts ALONE are still not a fix', () => {
  // The guard that regressed once already — generated output next to no source
  // change must not read as a fix just because new-file support now exists.
  const { dir, bin } = repoWithFakeClaude(
    '#!/usr/bin/env bash\nmkdir -p artifacts coverage node_modules/x\n' +
    'echo a > artifacts/test.log\necho b > coverage/lcov.info\necho c > node_modules/x/y.js\n' +
    'echo \'{"is_error":false}\'\n',
  );
  let err = null;
  try { runEngine({ dir, bin }); } catch (e) { err = e; }
  assert.ok(err, 'artifact-only output must not count as a fix');
  assert.match(String(err.stdout || '') + String(err.stderr || ''), /produced no source change/);
});
