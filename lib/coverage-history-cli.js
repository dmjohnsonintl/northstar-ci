#!/usr/bin/env node
'use strict';
// Emit [{date, linePct}] from the git history of a coverage-baseline file, for
// the observability dashboard's coverage trend. Best-effort: prints [] when the
// file has no history. Git-dependent, so not unit-tested (the pure aggregation
// that consumes this lives in metrics.js and is).
//
//   node lib/coverage-history-cli.js --path <workdir>/.northstar/coverage-baseline.json
const { execFileSync } = require('node:child_process');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
// execFile array form — the path is an argv element, never a shell string, so a
// crafted path can't inject commands.
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

const path = arg('path', '.northstar/coverage-baseline.json');
const shas = git(['log', '--format=%H', '--', path])
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const out = [];
for (const sha of shas) {
  const date = git(['show', '-s', '--format=%cI', sha]).trim();
  const blob = git(['show', `${sha}:${path}`]);
  try {
    const pct = Number(JSON.parse(blob).linePct);
    if (Number.isFinite(pct)) out.push({ date, linePct: pct });
  } catch {
    /* commit where the file was absent or malformed — skip */
  }
}
process.stdout.write(JSON.stringify(out));
