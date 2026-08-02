'use strict';
// Shape guards on the reusable pipeline. These are cheap text assertions, not a
// YAML parse — the package has zero runtime deps and actionlint already covers
// syntax. What it can't cover is the SEMANTIC trap below, so we pin it here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PIPELINE = path.join(__dirname, '..', '.github', 'workflows', 'northstar-pipeline.yml');
const src = fs.readFileSync(PIPELINE, 'utf8');

// Workflow-level `concurrency:` — the block at column 0, not a job-level one.
const groupLine = src.split('\n').find((l) => l.startsWith('  group:'));

test('the pipeline declares a workflow-level concurrency group', () => {
  assert.ok(groupLine, 'no workflow-level `  group:` line found');
});

test('the concurrency group is disambiguated per zone (regression: issue #12)', () => {
  // github.workflow resolves to the CALLER's name inside a reusable workflow, so
  // it is identical for every job in a multi-zone caller. Keying on
  // {workflow, ref} alone put both zones in one group; with cancel-in-progress
  // the second invocation CANCELLED the first and a zone silently vanished.
  assert.match(groupLine, /inputs\.concurrency-key/, 'group must fold in the caller-supplied key');
  assert.match(groupLine, /inputs\.workdir/, 'group must fall back to workdir when no key is given');

  // Non-vacuous: the exact pre-fix group must not be what ships.
  const expr = groupLine.slice(groupLine.indexOf(':') + 1).trim();
  assert.notEqual(expr, 'northstar-${{ github.workflow }}-${{ github.ref }}');
});

test('concurrency-key is a declared, optional workflow_call input', () => {
  assert.match(src, /^ {6}concurrency-key:$/m, 'concurrency-key must be declared under workflow_call.inputs');
  // Optional with an empty default, so `|| inputs.workdir` is what fires by
  // default. A non-empty default would defeat the zero-config fallback.
  const block = src.slice(src.indexOf('      concurrency-key:'));
  assert.match(block.slice(0, 400), /default: ''/, "concurrency-key must default to '' so workdir is the fallback");
});
